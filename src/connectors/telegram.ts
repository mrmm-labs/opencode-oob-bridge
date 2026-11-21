/**
 * Telegram as a connector, over the Bot API with long polling: the plugin only
 * makes outgoing HTTPS requests and exposes nothing.
 *
 * In a forum supergroup each top-level session gets its own topic. Questions
 * carry inline buttons (toggles plus Done for multiple choice).
 * Several questions in one prompt, or more than MAX_BUTTONS options, are
 * answered by replying to the message with numbers or text. Only the paired
 * chat is heard; everything else is dropped unread.
 */
import { randomInt } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import {
  buildMenu,
  menuHash,
  validMenu,
  type MenuCommand,
} from "../commandmenu.ts"
import { filterSecrets } from "../filter.ts"
import { parseReply, type Question } from "../inbound.ts"
import { log } from "../logger.ts"
import type { Telemetry } from "../otel.ts"
import {
  lazyToken,
  parseTokenSource,
  TOKEN_ERROR,
  tokenWaitText,
  TokenUnavailable,
  type TokenFn,
  type TokenSource,
} from "../token.ts"
import { isObject, sleep, truncate, URL_RE } from "../util.ts"
import { globToRegExp } from "../routing.ts"
import { closeFences, splitReply } from "./telegram-markdown.ts"
import {
  esc,
  keycap,
  renderPush,
  renderStatus,
  renderStepper,
  renderTurnCard,
  starred,
} from "./telegram-render.ts"
import {
  newStepper,
  parseAct,
  step,
  type Act,
  type Stepper,
} from "../stepper.ts"
import {
  checkAnnounced,
  DEFAULT_MEDIA,
  download,
  fileName,
  mediaOf,
  MediaRejected,
  parseMedia,
  verify,
  type MediaConfig,
  type MediaMessage,
  type MediaRef,
} from "./telegram-media.ts"
import {
  parseReactions,
  reactionFor,
  type ReactionsConfig,
} from "./telegram-reactions.ts"
import type {
  Capabilities,
  Connector,
  ConnectorStatus,
  ConnectorType,
  Inbound,
  InboundFile,
  Menu,
  OnInbound,
  Outcome,
  Pairing,
  Push,
  SendStats,
  SessionState,
  TurnCard,
} from "./types.ts"

const MAX_BUTTONS = 10
const LABEL_MAX = 40
const POLL_SECONDS = 30
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const PAIR_TTL_MS = 10 * 60_000
const TOAST_MAX = 190
const TOPIC_RETRY_MS = 5 * 60_000
const TOPIC_NOTICE_MS = 60 * 60_000
const STREAM_GAP_MS = 1000
const STREAM_BUDGET = 30
/** A rate limit doubles the gap up to this, and it halves after a quiet half minute. */
const MAX_GAP_MS = 8000
const QUIET_MS = 30_000
/** A draft is a 30 second preview: it is sent again before it runs out. */
const DRAFT_REFRESH_MS = 20_000
/** After a refused draft, edits are used for this long. */
const DRAFT_BACKOFF_MS = 10 * 60_000
// Streamed text moves to a new message past this many characters of HTML.
const STREAM_CHARS = 3800
const MAX_REPLY_MESSAGES = 3
const SENT_KEEP = 1000
const RENAME_GAP_MS = 60_000
const CARD_GAP_MS = 10_000
// The six colors Telegram allows for a topic icon.
const COLORS = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047]
// Sessions of one project draw their icon from this many neighbours.
const FAMILY = 4
const MENU_PAGE = 6
const MAX_MENUS = 50
const COMMAND_RE = /^\/([A-Za-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/
const RIGHTS = /not enough rights|admin/i
const RIGHTS_NOTICE =
  "⚠️ I need the Manage Topics admin right to give each session its own topic. Posting in General until then."

export type TelegramOptions = {
  /** Instance name; defaults to "telegram". */
  name?: string
  tel?: Telemetry
  token: TokenFn
  /** The paired chat. Unset until `pair()` completes. */
  chatId?: string
  apiBase?: string
  /** Where the update offset is kept across restarts. */
  offsetFile?: string
  /** Where session topics of a forum chat are remembered across restarts. */
  topicsFile?: string
  /** Called with the chat id once pairing succeeds, to store it. */
  onPaired?: (chatId: string) => void
  /** Keeps the key of the command list last registered, across restarts. */
  menuStore?: { get(): string | undefined; set(key: string): void }
  fetch?: typeof fetch
  /** Delays in ms after a failed poll: first and cap. */
  backoff?: { min: number; max: number }
  pollSeconds?: number
  pairTtlMs?: number
  /** How long a button tap waits for its outcome before the toast goes out anyway. */
  toastAfterMs?: number
  /** One status card per session topic; on unless false. */
  statusCard?: boolean
  /** Stream a reply as a native draft in a private chat. Off until it has been checked against a live bot. */
  draft?: boolean
  /** Session-end pushes wanted; finished defaults to off while the card shows it. */
  notify?: { finished?: boolean; failed?: boolean }
  /** `agent regex or project glob` to the emoji it picks for a topic icon. */
  icons?: Record<string, string>
  /** The emoji a prompt gets as its acknowledgement; see `reactionFor`. */
  reactions?: ReactionsConfig
  /** Files accepted from the chat. */
  media?: MediaConfig
  /** How often the typing indicator is renewed while a chat session works. */
  typingMs?: number
  /** Clock, for the topic, card and streaming limits. */
  now?: () => number
  /** How often a draft is sent again while the model is silent; tests shorten it. */
  draftRefreshMs?: number
}

type Message = MediaMessage & {
  message_id: number
  date: number
  text?: string
  caption?: string
  chat: { id: number; title?: string; is_forum?: boolean }
  message_thread_id?: number
  reply_to_message?: { message_id: number }
}

type Update = {
  update_id: number
  message?: Message
  callback_query?: {
    id: string
    data?: string
    message?: {
      message_id: number
      message_thread_id?: number
      chat: { id: number }
    }
  }
}

type Markup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

const buttonable = (qs: Question[]) =>
  qs.length === 1 &&
  qs[0].options.length > 0 &&
  qs[0].options.length <= MAX_BUTTONS

type Stream = {
  session: NonNullable<Push["session"]>
  /** The reply so far, in markdown. */
  text: string
  /** HTML last shown in each message, and its message id. */
  shown: Array<{ id: number; html: string }>
  /** No edit before this time. */
  nextAt: number
  gapMs: number
  /** Most edits a minute. */
  budget: number
  /** The draft of a private chat, and the timer that keeps it alive. */
  draftId?: number
  /** What the draft last showed. */
  draftText?: string
  refresh?: ReturnType<typeof setTimeout>
  timer?: ReturnType<typeof setTimeout>
  chain: Promise<void>
  running: boolean
}

/** A 429 the caller chose not to wait for. */
class RateLimited extends Error {
  readonly retryAfter: number
  constructor(retryAfter: number) {
    super(`telegram rate limited: retry in ${retryAfter}s`)
    this.retryAfter = retryAfter
  }
}

/** What is kept of a session's topic. A bare number is the older file format. */
type Topic = {
  thread: number
  card?: number
  name?: string
  iconId?: string
  icon?: string
  /** What the card shows now; not kept across restarts. */
  cardText?: string
}

type Sticker = { emoji?: string; custom_emoji_id?: string }

/** FNV-1a: the same text always picks the same icon and color. */
export function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export class TelegramConnector implements Connector {
  readonly type = "telegram"
  readonly capabilities: Capabilities = {
    buttons: true,
    edit: true,
    multiselect: true,
    rich: true,
    threads: true,
    pairing: true,
    inboundPrompt: true,
    foldable: true,
  }
  readonly id: string
  readonly notify: { finished: boolean; failed: boolean }
  enabled: boolean

  private chatId: string | undefined
  private connected: boolean | undefined
  private lastError: string | undefined
  private onInbound: OnInbound | undefined
  private signal: AbortSignal | undefined
  private polling = false
  private offset: number | undefined
  /** Whether the paired chat is a forum; undefined until asked. */
  private forum: boolean | undefined
  private topics: Map<string, Topic> | undefined
  private readonly topicJobs = new Map<string, Promise<number | undefined>>()
  /** Topic icons the bot may use: undefined until fetched, empty when the call failed. */
  private stickers: Sticker[] | undefined
  private stickersAt = -Infinity
  /** Per session: the state to show, and when the topic and card were last edited. */
  private readonly live = new Map<
    string,
    {
      want: SessionState
      renamedAt: number
      editedAt: number
      timer?: ReturnType<typeof setTimeout>
    }
  >()
  /** No topic creation before this time, after a failure. */
  private topicRetryAt = 0
  private topicNoticeAt = -Infinity
  /** Set while topic creation is refused for missing rights. */
  private topicWarning: string | undefined
  /** Bot messages of a session by message id, so a reply to one finds its session. */
  private readonly sent = new Map<string, string>()
  /** Typing indicators running, by session. */
  private readonly pulses = new Map<string, ReturnType<typeof setInterval>>()
  /** Replies being streamed, by session. */
  private readonly streams = new Map<string, Stream>()
  /** When edits and sends were made, for the per-minute budget. */
  private readonly editTimes: number[] = []
  /** The gap a rate limit has widened to, and when it last did. */
  private boost = 0
  private boostAt = 0
  /** Edits are used instead of drafts until this time. */
  private draftOffUntil = 0
  /** Menus on screen: the choices and the page shown. */
  private readonly menus = new Map<
    string,
    { choices: Menu["choices"]; page: number }
  >()
  /** Forms answered field by field, by prompt id. */
  private readonly steppers = new Map<string, Stepper>()
  /** Force-reply questions of a command: message id to the question's id. */
  private readonly asks = new Map<string, string>()
  private botName: string | undefined
  /** Key of the command list registered in this run. */
  private commandsFor: string | undefined
  private menuList: MenuCommand[] = buildMenu({
    undo: false,
    resume: false,
    digest: false,
  })
  /** Force-reply prompts: message id to the pending prompt it collects a typed answer for. */
  private readonly typing = new Map<string, string>()
  private pairing:
    | { code: string; finish: (chatId: string | undefined) => void }
    | undefined
  /** Prompts with a keyboard: the options and what is ticked. */
  private readonly prompts = new Map<
    string,
    {
      options: string[]
      multiple: boolean
      custom: boolean
      selected: Set<number>
      ref?: string
    }
  >()

  private readonly opts: TelegramOptions
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(opts: TelegramOptions, enabled = true) {
    this.opts = opts
    this.id = opts.name ?? "telegram"
    this.enabled = enabled
    this.chatId = opts.chatId
    this.fetch = opts.fetch ?? globalThis.fetch
    this.now = opts.now ?? Date.now
    this.notify = {
      finished: opts.notify?.finished ?? opts.statusCard === false,
      failed: opts.notify?.failed ?? true,
    }
  }

  start(onInbound: OnInbound, signal: AbortSignal): void {
    this.onInbound = onInbound
    this.signal = signal
    signal.addEventListener("abort", () => {
      for (const l of this.live.values()) clearTimeout(l.timer)
      this.live.clear()
      for (const t of this.pulses.values()) clearInterval(t)
      this.pulses.clear()
      for (const st of this.streams.values()) clearTimeout(st.timer)
      this.streams.clear()
    })
    void this.register()
    this.poll()
  }

  /** Makes Telegram offer the commands after "/" in the paired chat. */
  menu(commands: MenuCommand[]): void {
    this.menuList = commands
    if (this.onInbound) void this.register()
  }

  /**
   * One list for the paired chat: Telegram has no per-topic scope. It is sent
   * only when it differs from the last one, or when the chat is paired again.
   */
  private async register(again = false): Promise<void> {
    const chat = this.chatId
    if (!chat) return
    const { ok, problems } = validMenu(this.menuList)
    for (const p of problems) log("telegram_menu_invalid", { problem: p })
    const scope = chat.startsWith("-")
      ? { type: "chat", chat_id: chat }
      : { type: "all_private_chats" }
    const key = menuHash(JSON.stringify(scope), ok)
    if (this.commandsFor === key) return
    if (!again && this.opts.menuStore?.get() === key) {
      this.commandsFor = key
      return
    }
    this.commandsFor = key
    try {
      await this.call("setMyCommands", { commands: ok, scope })
      this.opts.menuStore?.set(key)
    } catch (err) {
      this.commandsFor = undefined
      this.fail(err)
    }
  }

  paired(): boolean {
    return this.chatId !== undefined
  }

  /** Adopts a chat chosen outside this process, such as a stored setting. */
  setChat(chatId: string | undefined): void {
    this.chatId = chatId
    this.forum = undefined
    if (this.onInbound) void this.register()
  }

  status(): ConnectorStatus {
    const retryAt = this.opts.token.retryAt?.()
    return {
      connected: this.connected,
      lastError:
        (retryAt === undefined ? undefined : tokenWaitText(retryAt)) ??
        this.lastError ??
        (this.chatId ? undefined : "not paired"),
      warning: this.topicWarning,
    }
  }

  hint(id: string, qs: Question[]): string {
    if (qs.length !== 1)
      return `Reply to this message with one answer per question, separated by | (for example: 1 | yes | 2,3). Options are numbered.`
    const q = qs[0]
    const type = q.custom ? ", ✏️ to type" : ""
    if (q.multiple)
      return buttonable(qs)
        ? `Tick options${type}, then tap Done. Or reply with numbers, like 1,3.`
        : `Reply to this message with numbers, like 1,3.`
    if (buttonable(qs)) return `Tap a button${type}, or reply.`
    return `Reply to this message with a number or text (or send "#${id} <answer>").`
  }

  async send(push: Push): Promise<string | undefined> {
    if (!this.chatId) return undefined
    const q = push.prompt
    const live = q && buttonable(q.questions) ? q : undefined
    const one = live?.questions[0]
    const form =
      q && q.questions.length > 1
        ? newStepper(q.id, q.questions, push.title ?? "Question")
        : undefined
    if (q && form) this.steppers.set(q.id, form)
    const view = form && renderStepper(form)
    if (live && one)
      this.prompts.set(live.id, {
        options: one.options,
        multiple: one.multiple,
        custom: one.custom,
        selected: new Set(),
      })
    try {
      for (let attempt = 0; ; attempt++) {
        const thread = await this.thread(push.session)
        try {
          const m = await this.call<{ message_id: number }>(
            "sendMessage",
            {
              chat_id: this.chatId,
              message_thread_id: thread,
              text:
                view?.text ??
                renderPush(push, {
                  inTopic: thread !== undefined,
                  footer:
                    q && push.card?.kind === "question"
                      ? this.hint(q.id, q.questions)
                      : push.permission
                        ? "Tap a button to answer. Each answer is logged."
                        : undefined,
                }),
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              // A failure needs attention: it is the one push that may make a sound.
              disable_notification:
                push.silent ??
                (push.card?.kind === "failed"
                  ? false
                  : (push.priority ?? 3) <= 2),
              reply_markup: view
                ? { inline_keyboard: view.rows }
                : live && one
                  ? this.keyboard(
                      live.id,
                      one.options,
                      one.multiple,
                      one.custom,
                      new Set(),
                    )
                  : push.permission
                    ? { inline_keyboard: [this.decisions(push.permission)] }
                    : push.action
                      ? {
                          inline_keyboard: [
                            [
                              {
                                text: push.action.label,
                                callback_data: "ctl:" + push.action.control,
                              },
                            ],
                          ],
                        }
                      : undefined,
            },
            undefined,
            undefined,
            push.stats,
          )
          const ref = String(m.message_id)
          if (form) form.msg = m.message_id
          const p = live && this.prompts.get(live.id)
          if (p) p.ref = ref
          if (push.session) this.remember(ref, push.session.id)
          return ref
        } catch (err) {
          // The topic was deleted in Telegram: make a new one once.
          if (
            thread === undefined ||
            attempt > 0 ||
            !/thread/i.test((err as Error).message)
          )
            throw err
          this.topics?.delete(this.topicKey(push.session!.id))
          await this.saveTopics()
        }
      }
    } catch (err) {
      if (push.prompt) {
        this.prompts.delete(push.prompt.id)
        this.steppers.delete(push.prompt.id)
      }
      this.fail(err)
      return undefined
    }
  }

  private remember(ref: string | number, sessionID: string) {
    this.sent.set(String(ref), sessionID)
    if (this.sent.size > SENT_KEEP)
      this.sent.delete(this.sent.keys().next().value!)
  }

  /** The session of a forum topic, or of a message of the bot's. */
  private async sessionAt(
    thread?: number,
    replyTo?: string,
  ): Promise<string | undefined> {
    const via = replyTo === undefined ? undefined : this.sent.get(replyTo)
    if (via) return via
    if (thread === undefined || !this.chatId) return undefined
    this.topics ??= await this.loadTopics()
    const prefix = `${this.chatId}:`
    for (const [k, t] of this.topics)
      if (t.thread === thread && k.startsWith(prefix))
        return k.slice(prefix.length)
    return undefined
  }

  private topicKey(sessionID: string) {
    return `${this.chatId}:${sessionID}`
  }

  /** The forum topic of a session, created on first use; undefined outside a forum. */
  private async thread(session: Push["session"]): Promise<number | undefined> {
    if (!session || !this.chatId) return undefined
    if (this.forum === undefined) {
      try {
        const chat = await this.call<{ is_forum?: boolean }>("getChat", {
          chat_id: this.chatId,
        })
        this.forum = chat.is_forum === true
      } catch (err) {
        this.fail(err)
        return undefined
      }
    }
    if (!this.forum) return undefined
    this.topics ??= await this.loadTopics()
    const key = this.topicKey(session.id)
    const known = this.topics.get(key)
    if (known !== undefined) return known.thread
    // After a failure the main chat is used, and creation is tried again later.
    if (this.now() < this.topicRetryAt) return undefined
    let job = this.topicJobs.get(key)
    if (!job) {
      job = this.createTopic(key, session).finally(() =>
        this.topicJobs.delete(key),
      )
      this.topicJobs.set(key, job)
    }
    return job
  }

  private async createTopic(
    key: string,
    session: NonNullable<Push["session"]>,
  ): Promise<number | undefined> {
    try {
      const name = truncate(filterSecrets(session.name), 128)
      const icon = await this.pickIcon(session)
      const t = await this.call<{ message_thread_id: number }>(
        "createForumTopic",
        {
          chat_id: this.chatId,
          name,
          icon_color:
            COLORS[hash(session.project ?? session.id) % COLORS.length],
          icon_custom_emoji_id: icon?.custom_emoji_id,
        },
      )
      this.topicWarning = undefined
      this.topics!.set(key, {
        thread: t.message_thread_id,
        name,
        iconId: icon?.custom_emoji_id,
        icon: icon?.emoji,
      })
      await this.saveTopics()
      return t.message_thread_id
    } catch (err) {
      // The main chat still works. Another session must not retry at once.
      this.topicRetryAt = this.now() + TOPIC_RETRY_MS
      this.fail(err)
      if (RIGHTS.test((err as Error).message)) await this.rightsMissing()
      return undefined
    }
  }

  /** The icons a bot may use, fetched once; a failed call is retried after a while and meanwhile only the color is set. */
  private async icons(): Promise<Sticker[]> {
    if (this.stickers?.length || this.now() - this.stickersAt < TOPIC_RETRY_MS)
      return this.stickers ?? []
    this.stickersAt = this.now()
    try {
      this.stickers = await this.call<Sticker[]>(
        "getForumTopicIconStickers",
        {},
      )
    } catch (err) {
      this.stickers = []
      this.fail(err)
    }
    return this.stickers
  }

  /**
   * The icon of a session's topic, the same every time: the configured emoji
   * for its agent or project, else one of a few neighbours picked by the
   * project, chosen between by the session.
   */
  private async pickIcon(
    session: NonNullable<Push["session"]>,
  ): Promise<Sticker | undefined> {
    const list = (await this.icons()).filter((i) => i.custom_emoji_id)
    if (list.length === 0) return undefined
    for (const [pattern, emoji] of Object.entries(this.opts.icons ?? {})) {
      let hit = false
      try {
        hit =
          new RegExp(pattern).test(session.agent ?? "") ||
          globToRegExp(pattern).test(session.project ?? "")
      } catch {}
      const sticker = hit && list.find((i) => i.emoji === emoji)
      if (sticker) return sticker
    }
    const base = hash(session.project ?? session.id)
    return list[(base + (hash(session.id) % FAMILY)) % list.length]
  }

  /** Missing "Manage Topics": a standing warning, and one notice an hour in the chat. */
  private async rightsMissing(): Promise<void> {
    this.topicWarning =
      "topics: the bot needs the Manage Topics admin right; posting in General"
    const now = this.now()
    if (now - this.topicNoticeAt < TOPIC_NOTICE_MS) return
    this.topicNoticeAt = now
    try {
      await this.call("sendMessage", {
        chat_id: this.chatId,
        text: RIGHTS_NOTICE,
        link_preview_options: { is_disabled: true },
      })
    } catch (err) {
      this.fail(err)
    }
  }

  private async loadTopics(): Promise<Map<string, Topic>> {
    const file = this.opts.topicsFile
    const out = new Map<string, Topic>()
    if (!file) return out
    try {
      const v = JSON.parse(await readFile(file, "utf8")) as Record<
        string,
        unknown
      >
      for (const [k, t] of Object.entries(v)) {
        if (typeof t === "number") out.set(k, { thread: t })
        else if (
          typeof t === "object" &&
          t !== null &&
          typeof (t as Topic).thread === "number"
        )
          out.set(k, t as Topic)
      }
    } catch {}
    return out
  }

  private async saveTopics(): Promise<void> {
    const file = this.opts.topicsFile
    if (!file || !this.topics) return
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(
        file,
        JSON.stringify(
          Object.fromEntries(
            [...this.topics].map(([k, { cardText: _, ...t }]) => [k, t]),
          ),
        ),
      )
    } catch (err) {
      log("telegram_topics_error", { message: (err as Error).message })
    }
  }

  /**
   * Shows a session's state: renames its topic when the title changed (at most
   * once a minute) and keeps one pinned status card current (at most one edit
   * every ten seconds). A change that comes too soon is applied later.
   */
  async track(state: SessionState): Promise<void> {
    try {
      const session = {
        id: state.id,
        name: state.name,
        project: state.project,
        agent: state.agent,
      }
      // Switching a session off does not open a topic for it.
      if (state.watch?.mode === "off") {
        this.topics ??= await this.loadTopics()
        if (!this.topics.has(this.topicKey(state.id))) return
      }
      const thread = await this.thread(session)
      if (thread === undefined) return
      this.pulse(state.id, thread, !!state.chat && state.state === "working")
      const key = this.topicKey(state.id)
      const live = this.live.get(key) ?? {
        want: state,
        renamedAt: -Infinity,
        editedAt: -Infinity,
      }
      // The Stop button appears and goes away at once.
      if (
        !!live.want.chat !== !!state.chat ||
        JSON.stringify(live.want.watch) !== JSON.stringify(state.watch)
      )
        live.editedAt = -Infinity
      live.want = state
      this.live.set(key, live)
      await this.flush(key)
    } catch (err) {
      this.fail(err)
    }
  }

  /** The typing indicator of a topic, renewed until it is switched off. */
  private pulse(sessionID: string, thread: number, on: boolean): void {
    const cur = this.pulses.get(sessionID)
    if (!on) {
      if (cur) clearInterval(cur)
      this.pulses.delete(sessionID)
      return
    }
    if (cur) return
    const tick = () =>
      void this.call("sendChatAction", {
        chat_id: this.chatId,
        message_thread_id: thread,
        action: "typing",
      }).catch(() => {})
    tick()
    const t = setInterval(tick, this.opts.typingMs ?? 5000)
    t.unref?.()
    this.pulses.set(sessionID, t)
  }

  private async flush(key: string): Promise<void> {
    const live = this.live.get(key)
    const topic = this.topics?.get(key)
    if (!live || !topic || !this.chatId) return
    clearTimeout(live.timer)
    const s = live.want
    const name = truncate(filterSecrets(s.name), 128)
    const now = this.now()
    let wait = Infinity
    const due = (last: number, gap: number) => {
      if (last + gap <= now) return true
      wait = Math.min(wait, last + gap - now)
      return false
    }

    const icon = await this.pickIcon(s)
    const newIcon =
      icon && icon.custom_emoji_id !== topic.iconId ? icon : undefined
    if (
      (topic.name !== name || newIcon) &&
      due(live.renamedAt, RENAME_GAP_MS)
    ) {
      live.renamedAt = now
      try {
        await this.call("editForumTopic", {
          chat_id: this.chatId,
          message_thread_id: topic.thread,
          name: topic.name !== name ? name : undefined,
          icon_custom_emoji_id: newIcon?.custom_emoji_id,
        })
        topic.name = name
        if (newIcon) {
          topic.iconId = newIcon.custom_emoji_id
          topic.icon = newIcon.emoji
        }
        await this.saveTopics()
      } catch (err) {
        this.fail(err)
      }
    }

    if (this.opts.statusCard !== false) {
      const text = renderStatus(s, topic.icon)
      if (topic.cardText !== text && due(live.editedAt, CARD_GAP_MS)) {
        live.editedAt = now
        await this.card(topic, text, !!s.chat, s.id)
      }
    }
    if (wait < Infinity) {
      live.timer = setTimeout(() => void this.flush(key), wait)
      live.timer.unref?.()
    }
  }

  /** Creates, pins or edits the status card of a topic. */
  private async card(
    topic: Topic,
    text: string,
    chat: boolean,
    sessionID: string,
  ): Promise<void> {
    // Always sent: an edit without it would keep the old button.
    const reply_markup = {
      inline_keyboard: chat
        ? [[{ text: "🛑 Stop chat", callback_data: "chatoff" }]]
        : [],
    }
    try {
      if (topic.card === undefined) {
        const m = await this.call<{ message_id: number }>("sendMessage", {
          chat_id: this.chatId,
          message_thread_id: topic.thread,
          text,
          parse_mode: "HTML",
          disable_notification: true,
          reply_markup,
        })
        topic.card = m.message_id
        this.remember(m.message_id, sessionID)
        await this.saveTopics()
        // A card that cannot be pinned is still a card.
        await this.call("pinChatMessage", {
          chat_id: this.chatId,
          message_id: m.message_id,
          disable_notification: true,
        }).catch((err) => this.fail(err))
      } else {
        await this.call("editMessageText", {
          chat_id: this.chatId,
          message_id: topic.card,
          text,
          parse_mode: "HTML",
          reply_markup,
        })
      }
      topic.cardText = text
    } catch (err) {
      const m = (err as Error).message
      if (/not modified/i.test(m)) topic.cardText = text
      // Deleted in Telegram: the next change makes a new one.
      else if (/not found/i.test(m)) {
        topic.card = undefined
        await this.saveTopics()
      }
      this.fail(err)
    }
  }

  async update(ref: string, push: Push): Promise<boolean> {
    if (!this.chatId) return false
    for (const [id, s] of this.steppers)
      if (String(s.msg) === ref) {
        this.steppers.delete(id)
        for (const [m, to] of this.typing)
          if (to === "s:" + id) this.typing.delete(m)
      }
    for (const [id, p] of this.prompts)
      if (p.ref === ref) {
        this.prompts.delete(id)
        for (const [m, to] of this.typing) if (to === id) this.typing.delete(m)
      }
    try {
      await this.call(
        "editMessageText",
        {
          chat_id: this.chatId,
          message_id: Number(ref),
          text: renderPush(push),
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        },
        undefined,
        undefined,
        push.stats,
      )
      return true
    } catch (err) {
      this.fail(err)
      return false
    }
  }

  /**
   * Starts pairing: the bot waits for the one-time code to be sent to it, and
   * the chat that sends it becomes the paired chat. The bot takes the code
   * typed as a message or arriving as `/start <code>` from the deep link.
   */
  async pair(): Promise<Pairing> {
    this.pairing?.finish(undefined)
    let code = ""
    for (let i = 0; i < 6; i++)
      code += PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)]
    let finish!: (chatId: string | undefined) => void
    const done = new Promise<string | undefined>((r) => (finish = r))
    const ttl = this.opts.pairTtlMs ?? PAIR_TTL_MS
    const timer = setTimeout(
      () => this.pairing?.code === code && this.pairing.finish(undefined),
      ttl,
    )
    timer.unref?.()
    const entry = {
      code,
      finish: (chatId: string | undefined) => {
        clearTimeout(timer)
        if (this.pairing === entry) this.pairing = undefined
        finish(chatId)
      },
    }
    this.pairing = entry
    this.poll()
    let username: string | undefined
    try {
      username = (await this.call<{ username?: string }>("getMe", {})).username
    } catch (err) {
      this.fail(err)
    }
    return {
      code,
      link: username ? `https://t.me/${username}?start=${code}` : undefined,
      links: username
        ? [
            {
              label:
                "Or add it to a group (a group with Topics gives each session its own)",
              url: `https://t.me/${username}?startgroup=${code}`,
            },
          ]
        : undefined,
      expiresAt: Date.now() + ttl,
      hint: username
        ? `Open @${username} in Telegram and press Start.`
        : "The bot could not be reached: check the token with /oob status.",
      done: done.then((chat) => chat !== undefined),
    }
  }

  /** A message or tap from a chat that is not the paired one. Only its kind is recorded. */
  private rejected(kind: string): void {
    const attrs = { "connector.type": "telegram", reason: "chat" }
    this.opts.tel?.count("oob.inbound.rejected", attrs)
    this.opts.tel
      ?.begin("oob.inbound", {
        attrs: {
          ...attrs,
          kind: "answer",
          source: kind,
          outcome: "rejected-chat",
        },
      })
      .end({ ok: false })
  }

  private fail(err: unknown): void {
    // Logged once, by the token, when its retry step began.
    if (err instanceof TokenUnavailable) return
    this.lastError = filterSecrets((err as Error).message)
    log("telegram_error", { message: this.lastError })
  }

  private keyboard(
    id: string,
    options: string[],
    multiple: boolean,
    custom: boolean,
    selected: Set<number>,
  ): Markup {
    const rows = options.map((label, i) => [
      {
        text: truncate(
          `${multiple && selected.has(i + 1) ? "✓ " : ""}${keycap(i + 1)} ${starred(label)}`,
          LABEL_MAX,
        ),
        callback_data: `${id}:${multiple ? "t" : ""}${i + 1}`,
      },
    ])
    if (custom)
      rows.push([{ text: "✏️ Type an answer", callback_data: `${id}:x` }])
    if (multiple) rows.push([{ text: "Done", callback_data: `${id}:d` }])
    return { inline_keyboard: rows }
  }

  /** One Bot API call. Honours 429 `retry_after`; throws on any other failure. */
  /** Asks whether it is quiet hours. */
  private quiet: (() => boolean) | undefined

  silence(isQuiet: () => boolean): void {
    this.quiet = isQuiet
  }

  private async call<T>(
    method: string,
    body: unknown,
    timeoutMs = 10_000,
    signal?: AbortSignal,
    stats?: SendStats,
    retry = true,
  ): Promise<T> {
    if (
      method === "sendMessage" &&
      this.quiet?.() &&
      (body as { disable_notification?: boolean }).disable_notification ===
        undefined
    )
      body = { ...(body as object), disable_notification: true }
    const token = await this.opts.token()
    if (!token) throw new Error("no Telegram token")
    const base = this.opts.apiBase ?? "https://api.telegram.org"
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(timeoutMs)
      const res = await this.fetch(`${base}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: false,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (stats) stats.httpStatus = res.status
      const json = (await res.json().catch(() => undefined)) as
        | {
            ok?: boolean
            result?: T
            description?: string
            parameters?: { retry_after?: number }
          }
        | undefined
      if (json?.ok) return json.result as T
      const wait = json?.parameters?.retry_after
      if (res.status === 429 && wait !== undefined && !retry)
        throw new RateLimited(wait)
      if (res.status === 429 && wait !== undefined && attempt < 2) {
        if (stats) stats.retries = attempt + 1
        await sleep(Math.min(wait, 60) * 1000, signal)
        continue
      }
      throw new Error(
        `telegram ${method} failed: HTTP ${res.status} ${json?.description ?? ""}`.trim(),
      )
    }
  }

  private poll(): void {
    const signal = this.signal
    if (this.polling || !signal || signal.aborted) return
    this.polling = true
    void this.loop(signal).finally(() => (this.polling = false))
  }

  private async loop(signal: AbortSignal): Promise<void> {
    const { min, max } = this.opts.backoff ?? { min: 1000, max: 60_000 }
    const seconds = this.opts.pollSeconds ?? POLL_SECONDS
    let delay = min
    this.offset ??= await this.loadOffset()
    while (!signal.aborted && (this.chatId || this.pairing)) {
      try {
        const updates = await this.call<Update[]>(
          "getUpdates",
          {
            offset: this.offset,
            timeout: seconds,
            allowed_updates: ["message", "callback_query"],
          },
          (seconds + 10) * 1000,
          signal,
        )
        delay = min
        this.connected = true
        this.lastError = undefined
        for (const u of updates) {
          this.offset = u.update_id + 1
          try {
            await this.onUpdate(u)
          } catch (err) {
            log("telegram_update_error", {
              message: filterSecrets((err as Error).message),
            })
          }
        }
        if (updates.length) await this.saveOffset()
      } catch (err) {
        if (signal.aborted) return
        this.connected = false
        if (err instanceof TokenUnavailable) {
          // No fast retries: wait for the time the token will be asked for again.
          await sleep(Math.max(0, err.retryAt - Date.now()), signal)
          continue
        }
        this.fail(err)
        this.opts.tel?.count("oob.reconnects", { "connector.type": "telegram" })
        this.opts.tel
          ?.begin("oob.reconnect", {
            attrs: { "connector.type": "telegram", reason: "error" },
          })
          .end({ delay_ms: delay })
        await sleep(delay, signal)
        delay = Math.min(max, delay * 2)
      }
    }
  }

  private async loadOffset(): Promise<number | undefined> {
    if (!this.opts.offsetFile) return undefined
    try {
      const v = JSON.parse(await readFile(this.opts.offsetFile, "utf8")) as {
        offset?: unknown
      }
      return typeof v.offset === "number" ? v.offset : undefined
    } catch {
      return undefined
    }
  }

  private async saveOffset(): Promise<void> {
    const file = this.opts.offsetFile
    if (!file) return
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify({ offset: this.offset }))
    } catch (err) {
      log("telegram_offset_error", { message: (err as Error).message })
    }
  }

  private async onUpdate(u: Update): Promise<void> {
    if (u.callback_query) return this.onCallback(u.callback_query)
    const m = u.message
    if (!m) return
    const media = mediaOf(m)
    if (media) return this.onMedia(u, m, media)
    const text = m.text?.trim()
    if (!text) return
    if (await this.tryPair(m.chat, text)) return
    if (String(m.chat.id) !== this.chatId) {
      this.rejected("message")
      return log("telegram_ignored", { kind: "message" })
    }
    const base = {
      kind: "answer",
      id: String(u.update_id),
      time: m.date,
      from: { connector: this.id, chat: String(m.chat.id) },
    } as const
    // A reply to a "Type your answer" prompt is a free-text answer for its prompt.
    const asked = m.reply_to_message
      ? this.typing.get(String(m.reply_to_message.message_id))
      : undefined
    if (asked?.startsWith("s:")) return this.stepText(asked.slice(2), text, m)
    if (asked)
      return void (await this.onInbound?.({
        ...base,
        pendingId: asked,
        text,
        literal: true,
      }))
    // The reply to a question a command asked, such as the prompt of /new.
    const ask = m.reply_to_message
      ? this.asks.get(String(m.reply_to_message.message_id))
      : undefined
    if (ask) {
      const out = await this.onInbound?.({
        ...base,
        kind: "command",
        text,
        token: ask,
        command: { name: "reply", args: text },
      })
      if (out?.ok) this.asks.delete(String(m.reply_to_message!.message_id))
      if (out) await this.deliver(m.message_thread_id, out)
      return
    }
    const cmd = COMMAND_RE.exec(text)
    if (cmd) return this.command(m, base, cmd[1], cmd[2], cmd[3] ?? "")
    // An explicit "#id answer" wins over the message replied to.
    const reply = parseReply(text)
    if (reply)
      return void (await this.onInbound?.(
        "choice" in reply
          ? { ...base, pendingId: reply.id, choice: reply.choice, text }
          : { ...base, pendingId: reply.id, text: reply.text },
      ))
    // In a topic, a plain message "replies" to the topic's first message.
    const to =
      m.reply_to_message &&
      m.reply_to_message.message_id !== m.message_thread_id
        ? String(m.reply_to_message.message_id)
        : undefined
    const sessionKey = await this.sessionAt(m.message_thread_id, to)
    // A reply is an answer if it replies to a question; the core decides, and
    // takes anything else as text for the session.
    const inbound: Inbound | undefined = to
      ? { ...base, replyTo: to, sessionKey, text }
      : sessionKey
        ? { ...base, kind: "prompt", sessionKey, text }
        : undefined
    if (!inbound) return
    const out = await this.onInbound?.(inbound)
    if (out?.sent) await this.acknowledge(m, out)
  }

  /**
   * A prompt reached its session: one reaction on the message, which agent
   * got it, or that it waited or was steered in. If the reaction cannot be set,
   * the old line says it instead, so the sender still learns where it went.
   */
  private async acknowledge(m: Message, out: Outcome): Promise<void> {
    const emoji = reactionFor(this.opts.reactions, out.delivered, (bad) =>
      this.warnReaction(bad),
    )
    try {
      await this.call("setMessageReaction", {
        chat_id: this.chatId,
        message_id: m.message_id,
        reaction: [{ type: "emoji", emoji }],
      })
    } catch (err) {
      this.fail(err)
      await this.deliver(m.message_thread_id, { ok: true, text: out.text })
    }
  }

  private badReactions = new Set<string>()

  private warnReaction(emoji: string): void {
    if (this.badReactions.has(emoji)) return
    this.badReactions.add(emoji)
    log("telegram_reaction_invalid", { emoji })
  }

  /** A photo or document, with its caption as the prompt; voice and video are turned away. */
  private async onMedia(u: Update, m: Message, ref: MediaRef): Promise<void> {
    if (String(m.chat.id) !== this.chatId) {
      this.rejected("message")
      return log("telegram_ignored", { kind: "media" })
    }
    const to =
      m.reply_to_message &&
      m.reply_to_message.message_id !== m.message_thread_id
        ? String(m.reply_to_message.message_id)
        : undefined
    const sessionKey = await this.sessionAt(m.message_thread_id, to)
    if (!sessionKey) return
    const notice = (text: string) =>
      this.deliver(m.message_thread_id, { ok: false, text })
    if (ref.kind === "unsupported")
      return notice(
        "Voice and video messages are not supported. Send text, a photo or a document.",
      )
    const cfg = this.opts.media ?? DEFAULT_MEDIA
    let file: InboundFile
    try {
      file = await this.fetchMedia(u, ref, cfg)
    } catch (err) {
      if (err instanceof MediaRejected) return notice(err.message)
      this.fail(err)
      return notice("Could not download that file from Telegram.")
    }
    const out = await this.onInbound?.({
      kind: "prompt",
      id: String(u.update_id),
      time: m.date,
      from: { connector: this.id, chat: String(m.chat.id) },
      sessionKey,
      text: (m.caption ?? "").trim(),
      files: [file],
    })
    if (out?.sent) await this.acknowledge(m, out)
  }

  private async fetchMedia(
    u: Update,
    ref: Extract<MediaRef, { kind: "photo" | "document" }>,
    cfg: MediaConfig,
  ): Promise<InboundFile> {
    checkAnnounced(ref, cfg)
    const info = await this.call<{ file_path?: string; file_size?: number }>(
      "getFile",
      { file_id: ref.fileId },
    )
    if (!info.file_path) throw new Error("telegram getFile gave no path")
    if (info.file_size !== undefined && info.file_size > cfg.maxBytes)
      checkAnnounced({ ...ref, size: info.file_size }, cfg)
    const token = await this.opts.token()
    if (!token) throw new Error("no Telegram token")
    const bytes = await download({
      fetch: this.fetch,
      base: this.opts.apiBase ?? "https://api.telegram.org",
      token,
      filePath: info.file_path,
      maxBytes: cfg.maxBytes,
      signal: this.signal,
    })
    const mime = verify(ref, bytes, cfg)
    return {
      name: fileName(ref, mime, String(u.update_id)),
      mime,
      data: Buffer.from(bytes).toString("base64"),
    }
  }

  /**
   * The one-time code, typed or sent as `/start <code>` (`/start@bot <code>` in
   * a group), from a private chat or a group.
   */
  private async tryPair(
    chat: NonNullable<Update["message"]>["chat"],
    text: string,
  ): Promise<boolean> {
    const pr = this.pairing
    const code = /^(?:\/start(?:@\w+)?\s+)?([A-Za-z0-9]{6})$/.exec(text)?.[1]
    if (!pr || code?.toUpperCase() !== pr.code) return false
    const id = String(chat.id)
    this.chatId = id
    this.forum = chat.is_forum === true ? true : undefined
    this.opts.onPaired?.(id)
    pr.finish(id)
    void this.register(true)
    const what = chat.title
      ? `Paired with ${esc(chat.title)}.${chat.is_forum ? " One topic per session." : ""}`
      : "Paired. Questions and notices of your OpenCode sessions arrive here."
    try {
      await this.call("sendMessage", {
        chat_id: id,
        text: what,
        parse_mode: "HTML",
      })
    } catch (err) {
      this.fail(err)
    }
    return true
  }

  private async onCallback(
    cb: NonNullable<Update["callback_query"]>,
  ): Promise<void> {
    if (!cb.message || String(cb.message.chat.id) !== this.chatId) {
      this.rejected("callback")
      return log("telegram_ignored", { kind: "callback" })
    }
    if (cb.data === "chatoff") {
      const sessionKey = await this.sessionAt(cb.message.message_thread_id)
      if (!sessionKey) return this.toast(cb.id, "Unknown session.")
      return this.answer(cb.id, {
        kind: "control",
        id: `cb${cb.id}`,
        time: Math.floor(Date.now() / 1000),
        sessionKey,
        text: "chat off",
        from: { connector: this.id, chat: String(cb.message.chat.id) },
        inline: true,
      })
    }
    const ctl = /^ctl:(resume|diff|continue|stop)$/.exec(cb.data ?? "")
    if (ctl) {
      const sessionKey = await this.sessionAt(cb.message.message_thread_id)
      if (!sessionKey) return this.toast(cb.id, "Unknown session.")
      return this.answer(cb.id, {
        kind: "control",
        id: "cb" + cb.id,
        time: Math.floor(Date.now() / 1000),
        sessionKey,
        text: ctl[1],
        from: { connector: this.id, chat: String(cb.message.chat.id) },
        inline: true,
      })
    }
    const st = parseAct(cb.data ?? "")
    if (st) return this.onStep(cb, st.id, st.act)
    const perm = /^p:([A-Za-z0-9]+):(o|a|r)$/.exec(cb.data ?? "")
    if (perm) {
      const decision = { o: "once", a: "always", r: "reject" }[perm[2]] as
        | "once"
        | "always"
        | "reject"
      return this.answer(cb.id, {
        kind: "answer",
        id: "cb" + cb.id,
        time: Math.floor(Date.now() / 1000),
        pendingId: perm[1],
        decision,
        text: decision,
        from: { connector: this.id, chat: String(cb.message.chat.id) },
        inline: true,
      })
    }
    const menu = /^m:([A-Za-z0-9]+):(p?\d+|n)$/.exec(cb.data ?? "")
    if (menu) return this.onMenu(cb, menu[1], menu[2])
    const m = /^([A-Za-z0-9]+):(t?\d+|d|x)$/.exec(cb.data ?? "")
    if (!m) return this.toast(cb.id, "Unknown button.")
    const [, id, act] = m
    const message_id = cb.message.message_id
    const time = Math.floor(Date.now() / 1000)
    const reply = (r: Pick<Inbound, "choice" | "text">) =>
      this.answer(cb.id, {
        kind: "answer",
        id: `cb${cb.id}`,
        time,
        pendingId: id,
        from: { connector: this.id, chat: String(cb.message!.chat.id) },
        inline: true,
        ...r,
      })

    if (/^\d+$/.test(act)) return reply({ choice: Number(act), text: act })
    if (act === "x") return this.askTyped(cb.id, id, cb.message)

    const p = this.prompts.get(id)
    if (!p)
      return this.toast(
        cb.id,
        `No longer active here: answer in the TUI, or send "#${id} 1,3".`,
      )
    if (act === "d") {
      if (p.selected.size === 0)
        return this.toast(cb.id, "Tick at least one option.")
      return reply({
        text: [...p.selected].sort((a, b) => a - b).join(","),
      })
    }
    const n = Number(act.slice(1))
    if (n < 1 || n > p.options.length)
      return this.toast(cb.id, "Unknown button.")
    if (!p.selected.delete(n)) p.selected.add(n)
    await this.toast(cb.id)
    try {
      await this.call("editMessageReplyMarkup", {
        chat_id: this.chatId,
        message_id,
        reply_markup: this.keyboard(id, p.options, true, p.custom, p.selected),
      })
    } catch (err) {
      this.fail(err)
    }
  }

  private decisions(p: NonNullable<Push["permission"]>) {
    const names = {
      once: ["Allow once", "o"],
      always: ["Always", "a"],
      reject: ["Deny", "r"],
    } as const
    return p.choices.map((c) => ({
      text: names[c][0],
      callback_data: "p:" + p.id + ":" + names[c][1],
    }))
  }

  /** Shows the stepper's current state in its message. */
  private async redraw(s: Stepper, message_id: number) {
    const v = renderStepper(s)
    try {
      await this.call("editMessageText", {
        chat_id: this.chatId,
        message_id,
        text: v.text,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: v.rows },
      })
    } catch (err) {
      if (!/not modified/i.test((err as Error).message)) this.fail(err)
    }
  }

  /** A button of a form stepper. */
  private async onStep(
    cb: NonNullable<Update["callback_query"]>,
    id: string,
    act: Act | "write",
  ): Promise<void> {
    const s = this.steppers.get(id)
    if (!s)
      return this.toast(
        cb.id,
        `No longer active here: answer in the TUI, or send "#${id} 1 | 2".`,
      )
    s.msg = cb.message!.message_id
    if (act === "write") {
      await this.toast(cb.id)
      try {
        const m = await this.call<{ message_id: number }>("sendMessage", {
          chat_id: this.chatId,
          message_thread_id: cb.message!.message_thread_id,
          text: `Type your answer for question ${s.at + 1} of #${id}`,
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "Your answer",
          },
        })
        this.typing.set(String(m.message_id), "s:" + id)
      } catch (err) {
        this.fail(err)
      }
      return
    }
    const out = step(s, act)
    if (out.cancel) {
      this.steppers.delete(id)
      await this.toast(cb.id, "Cancelled")
      await this.call("editMessageText", {
        chat_id: this.chatId,
        message_id: s.msg,
        text: "Cancelled here: nothing was sent. The question is still open, answer it in the TUI.",
        reply_markup: { inline_keyboard: [] },
      }).catch((err) => this.fail(err))
      return
    }
    if (out.reply !== undefined)
      return this.answer(cb.id, {
        kind: "answer",
        id: "cb" + cb.id,
        time: Math.floor(Date.now() / 1000),
        pendingId: id,
        text: out.reply,
        from: { connector: this.id, chat: String(cb.message!.chat.id) },
        inline: true,
      })
    await this.toast(cb.id, out.toast)
    if (!out.toast) await this.redraw(s, s.msg)
  }

  /** A typed answer for the field the stepper is on. */
  private async stepText(
    id: string,
    text: string,
    m: NonNullable<Update["message"]>,
  ): Promise<void> {
    const s = this.steppers.get(id)
    if (!s) return
    const out = step(s, { t: "text", text })
    if (out.toast) {
      await this.deliver(m.message_thread_id, { ok: false, text: out.toast })
      return
    }
    if (s.msg !== undefined) await this.redraw(s, s.msg)
  }

  /** "✏️ Type an answer": the bot asks for it, and a reply to that message is the answer. */
  private async askTyped(
    callbackID: string,
    id: string,
    at: NonNullable<NonNullable<Update["callback_query"]>["message"]>,
  ): Promise<void> {
    await this.toast(callbackID)
    try {
      const m = await this.call<{ message_id: number }>("sendMessage", {
        chat_id: this.chatId,
        message_thread_id: at.message_thread_id,
        text: `Type your answer for #${id}`,
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "Your answer",
        },
      })
      this.typing.set(String(m.message_id), id)
    } catch (err) {
      this.fail(err)
    }
  }

  /** A slash command, from a topic (acts on its session) or from General. */
  private async command(
    m: NonNullable<Update["message"]>,
    base: { id: string; time: number; from: Inbound["from"] },
    name: string,
    to: string | undefined,
    args: string,
  ): Promise<void> {
    // "/cmd@otherbot" is for another bot sharing the group.
    if (to && !(await this.isMe(to))) return
    const sessionKey = await this.sessionAt(m.message_thread_id)
    const out = await this.onInbound?.({
      ...base,
      kind: "command",
      sessionKey,
      text: m.text ?? "",
      command: { name, args },
    })
    if (out) await this.deliver(m.message_thread_id, out)
  }

  private async isMe(name: string): Promise<boolean> {
    try {
      this.botName ??= (
        await this.call<{ username?: string }>("getMe", {})
      ).username
    } catch (err) {
      this.fail(err)
    }
    return !this.botName || this.botName.toLowerCase() === name.toLowerCase()
  }

  /** A link that opens a session's topic, in a supergroup. */
  topicLink(sessionID: string): string | undefined {
    const topic = this.topics?.get(this.topicKey(sessionID))
    const m = /^-100(\d+)$/.exec(this.chatId ?? "")
    return topic && m ? `https://t.me/c/${m[1]}/${topic.thread}` : undefined
  }

  /** Redraws a session's status card and pins it again. */
  async refresh(sessionID: string): Promise<boolean> {
    try {
      const key = this.topicKey(sessionID)
      const topic = this.topics?.get(key)
      const live = this.live.get(key)
      if (!topic || !live || this.opts.statusCard === false) return false
      const text = renderStatus(live.want, topic.icon)
      topic.cardText = undefined
      live.editedAt = this.now()
      await this.card(topic, text, !!live.want.chat, sessionID)
      // A card gone from Telegram was made again, and pinned, by the call above.
      if (topic.card === undefined)
        await this.card(topic, text, !!live.want.chat, sessionID)
      else
        await this.call("pinChatMessage", {
          chat_id: this.chatId,
          message_id: topic.card,
          disable_notification: true,
        }).catch((err) => this.fail(err))
      return topic.card !== undefined
    } catch (err) {
      this.fail(err)
      return false
    }
  }

  private bound(map: Map<string, unknown>): void {
    while (map.size >= MAX_MENUS) map.delete(map.keys().next().value!)
  }

  /** The text of an outcome, with `{topic:<id>}` turned into a link. */
  private rich(text: string): string {
    return esc(text).replace(/\{topic:([^}]+)\}/g, (_, id: string) => {
      const link = this.topicLink(id)
      return link ? `<a href="${link}">topic</a>` : "topic"
    })
  }

  private menuKeyboard(id: string, choices: Menu["choices"], page: number) {
    const pages = Math.ceil(choices.length / MENU_PAGE)
    const rows = choices
      .map((c, i) => ({ c, i }))
      .slice(page * MENU_PAGE, (page + 1) * MENU_PAGE)
      .map(({ c, i }) => [
        {
          text: truncate(`${c.current ? "✓ " : ""}${c.label}`, LABEL_MAX),
          callback_data: `m:${id}:${i}`,
        },
      ])
    if (pages > 1)
      rows.push([
        ...(page > 0
          ? [{ text: "‹ Prev", callback_data: `m:${id}:p${page - 1}` }]
          : []),
        { text: `${page + 1}/${pages}`, callback_data: `m:${id}:n` },
        ...(page < pages - 1
          ? [{ text: "Next ›", callback_data: `m:${id}:p${page + 1}` }]
          : []),
      ])
    return { inline_keyboard: rows }
  }

  /** What a command answered: text, a menu to tap, or a question to reply to. */
  private async deliver(
    thread: number | undefined,
    out: Outcome,
  ): Promise<void> {
    try {
      this.topics ??= await this.loadTopics()
      const msg = {
        chat_id: this.chatId,
        // Telegram's General topic is thread 1: it is addressed by leaving it out.
        message_thread_id: thread === 1 ? undefined : thread,
        text: this.rich(out.text),
        parse_mode: "HTML",
        disable_notification: true,
        link_preview_options: { is_disabled: true },
      }
      if (out.menu) {
        this.bound(this.menus)
        this.menus.set(out.menu.id, { choices: out.menu.choices, page: 0 })
        await this.call("sendMessage", {
          ...msg,
          reply_markup: this.menuKeyboard(out.menu.id, out.menu.choices, 0),
        })
      } else if (out.ask) {
        const sent = await this.call<{ message_id: number }>("sendMessage", {
          ...msg,
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "Your prompt",
          },
        })
        this.bound(this.asks)
        this.asks.set(String(sent.message_id), out.ask.id)
      } else await this.call("sendMessage", msg)
    } catch (err) {
      this.fail(err)
    }
  }

  /** A tap in a menu: a page change, or a choice (always one of those offered). */
  private async onMenu(
    cb: NonNullable<Update["callback_query"]>,
    id: string,
    act: string,
  ): Promise<void> {
    const message = cb.message!
    const menu = this.menus.get(id)
    const clear = () =>
      this.call("editMessageReplyMarkup", {
        chat_id: this.chatId,
        message_id: message.message_id,
        reply_markup: { inline_keyboard: [] },
      }).catch((err) => this.fail(err))
    if (!menu) {
      await this.toast(cb.id, "That menu expired: send the command again.")
      await clear()
      return
    }
    if (act === "n") return this.toast(cb.id)
    if (act.startsWith("p")) {
      const page = Number(act.slice(1))
      if (page < 0 || page * MENU_PAGE >= menu.choices.length)
        return this.toast(cb.id, "Unknown button.")
      menu.page = page
      await this.toast(cb.id)
      await this.call("editMessageReplyMarkup", {
        chat_id: this.chatId,
        message_id: message.message_id,
        reply_markup: this.menuKeyboard(id, menu.choices, page),
      }).catch((err) => this.fail(err))
      return
    }
    const choice = menu.choices[Number(act)]
    if (!choice) return this.toast(cb.id, "Unknown button.")
    this.menus.delete(id)
    await this.toast(cb.id)
    await clear()
    const out = await this.onInbound?.({
      kind: "command",
      id: `cb${cb.id}`,
      time: Math.floor(Date.now() / 1000),
      sessionKey: await this.sessionAt(message.message_thread_id),
      text: choice.label,
      token: id,
      command: { name: "pick", args: choice.value },
      from: { connector: this.id, chat: String(message.chat.id) },
      inline: true,
    })
    if (out) await this.deliver(message.message_thread_id, out)
  }

  /** Applies a tap, and clears the button's spinner with the outcome. */
  private async answer(callbackID: string, m: Inbound): Promise<void> {
    const done = this.onInbound?.(m)
    const out = await Promise.race<Outcome | undefined | "late">([
      done ?? Promise.resolve(undefined),
      sleep(this.opts.toastAfterMs ?? 1000).then(() => "late" as const),
    ])
    await this.toast(
      callbackID,
      out === "late" ? "Sending…" : (out?.text ?? "Done."),
    )
    await done
  }

  /** Multipart upload: a text file with a caption. */
  private async upload(
    method: string,
    fields: Record<string, string | number | undefined>,
    file: { field: string; name: string; data: string },
  ): Promise<void> {
    const token = await this.opts.token()
    if (!token) throw new Error("no Telegram token")
    const form = new FormData()
    for (const [k, v] of Object.entries({
      ...fields,
      disable_notification: this.quiet?.() ? true : undefined,
    }))
      if (v !== undefined) form.append(k, String(v))
    form.append(
      file.field,
      new Blob([file.data], { type: "text/markdown" }),
      file.name,
    )
    const base = this.opts.apiBase ?? "https://api.telegram.org"
    const res = await this.fetch(`${base}/bot${token}/${method}`, {
      method: "POST",
      body: form,
      keepalive: false,
      signal: AbortSignal.timeout(30_000),
    })
    const json = (await res.json().catch(() => undefined)) as
      | { ok?: boolean; description?: string }
      | undefined
    if (!json?.ok)
      throw new Error(
        `telegram ${method} failed: HTTP ${res.status} ${json?.description ?? ""}`.trim(),
      )
  }

  /**
   * Shows the reply being written, in one message that is edited as it grows
   * (and in up to three). `text` is all of it so far, in markdown. Edits are
   * at most one every `gapMs`, and wait out a 429. The first message goes out at once.
   */
  stream(
    session: NonNullable<Push["session"]>,
    text: string,
    gapMs = STREAM_GAP_MS,
    budget = STREAM_BUDGET,
  ): void {
    if (!this.chatId || !text.trim()) return
    let st = this.streams.get(session.id)
    if (!st) {
      st = {
        session,
        text,
        shown: [],
        nextAt: 0,
        gapMs,
        budget,
        chain: Promise.resolve(),
        running: false,
      }
      this.streams.set(session.id, st)
    }
    st.text = text
    st.gapMs = gapMs
    st.budget = budget
    this.pump(st)
  }

  private pump(st: Stream, refresh = false): void {
    if (st.running) return
    const wait = refresh ? 0 : st.nextAt - this.now()
    // The gap has passed (the timer has not fired yet): go now.
    if (st.timer && wait <= 0) {
      clearTimeout(st.timer)
      st.timer = undefined
    }
    if (st.timer) return
    if (wait > 0) {
      this.opts.tel?.count("oob.stream.throttled", {
        "connector.type": "telegram",
      })
      st.timer = setTimeout(() => {
        st.timer = undefined
        this.pump(st)
      }, wait)
      st.timer.unref?.()
      return
    }
    st.running = true
    st.chain = st.chain
      .then(() => this.paint(st))
      .catch((err) => this.fail(err))
      .finally(() => {
        st.running = false
        // More text arrived while this edit was in flight.
        if (this.streams.get(st.session.id) === st && this.dirty(st))
          this.pump(st)
      })
  }

  private shownText(st: Stream): string[] {
    return splitReply(closeFences(st.text), MAX_REPLY_MESSAGES, STREAM_CHARS)
      .messages
  }

  private dirty(st: Stream): boolean {
    const now = this.shownText(st)
    if (this.draftable()) return now.at(-1) !== st.draftText
    return now.some((h, i) => st.shown[i]?.html !== h)
  }

  /** Native partial streaming exists only in a private chat; a refusal turns it off for a while. */
  private draftable(): boolean {
    return (
      this.opts.draft === true &&
      this.chatId !== undefined &&
      !this.chatId.startsWith("-") &&
      this.now() >= this.draftOffUntil
    )
  }

  /** The preview of the reply: the whole text so far, sent again every 20 s while the model is silent. */
  private async paintDraft(st: Stream): Promise<boolean> {
    const thread = await this.thread(st.session)
    const text = this.shownText(st).at(-1)
    if (!text?.trim()) return true
    try {
      await this.call(
        "sendMessageDraft",
        {
          chat_id: this.chatId,
          message_thread_id: thread,
          draft_id: (st.draftId ??=
            1 + Math.floor(Math.random() * 2_000_000_000)),
          text,
          parse_mode: "HTML",
        },
        undefined,
        undefined,
        undefined,
        false,
      )
    } catch (err) {
      if (err instanceof RateLimited) {
        st.nextAt = this.now() + Math.min(err.retryAfter, 60) * 1000
        return true
      }
      this.draftOffUntil = this.now() + DRAFT_BACKOFF_MS
      log("telegram_draft_off", {
        message: filterSecrets((err as Error).message),
      })
      return false
    }
    st.draftText = text
    this.opts.tel?.count("oob.stream.drafts", { "connector.type": "telegram" })
    st.nextAt = this.now() + st.gapMs
    clearTimeout(st.refresh)
    st.refresh = setTimeout(() => {
      if (this.streams.get(st.session.id) === st) this.pump(st, true)
    }, this.opts.draftRefreshMs ?? DRAFT_REFRESH_MS)
    st.refresh.unref?.()
    return true
  }

  /** Whether another edit fits in the minute's budget; otherwise when the oldest one leaves it. */
  private budgetWait(st: Stream): number {
    const now = this.now()
    while (this.editTimes.length && now - this.editTimes[0] >= 60_000)
      this.editTimes.shift()
    return this.editTimes.length >= st.budget
      ? this.editTimes[0] + 60_000 - now
      : 0
  }

  /** The gap between edits: the configured one, doubled by a rate limit and halved after a quiet half minute. */
  private gap(st: Stream): number {
    const now = this.now()
    if (this.boost && now - this.boostAt >= QUIET_MS) {
      this.boost = this.boost / 2 < st.gapMs ? 0 : this.boost / 2
      this.boostAt = now
    }
    return Math.max(st.gapMs, this.boost)
  }

  /** Sends or edits the messages of a stream so they show its text. */
  private async paint(st: Stream): Promise<void> {
    if (this.draftable() && (await this.paintDraft(st))) return
    const wait = this.budgetWait(st)
    if (wait > 0) {
      st.nextAt = this.now() + wait
      this.opts.tel?.count("oob.stream.throttled", {
        "connector.type": "telegram",
      })
      return
    }
    const thread = await this.thread(st.session)
    const html = this.shownText(st)
    for (const [i, h] of html.entries()) {
      if (!h.trim()) continue
      const had = st.shown[i]
      if (had?.html === h) continue
      try {
        if (had) {
          await this.call(
            "editMessageText",
            {
              chat_id: this.chatId,
              message_id: had.id,
              text: h,
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
            },
            undefined,
            undefined,
            undefined,
            false,
          )
          this.opts.tel?.count("oob.stream.edits", {
            "connector.type": "telegram",
          })
          this.editTimes.push(this.now())
          had.html = h
        } else {
          const m = await this.call<{ message_id: number }>("sendMessage", {
            chat_id: this.chatId,
            message_thread_id: thread,
            text: h,
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            disable_notification: true,
          })
          this.editTimes.push(this.now())
          st.shown[i] = { id: m.message_id, html: h }
          this.remember(m.message_id, st.session.id)
          this.opts.tel?.count("oob.stream.edits", {
            "connector.type": "telegram",
          })
        }
      } catch (err) {
        if (err instanceof RateLimited) {
          // Back off for as long as Telegram asks, then carry on from the same text.
          this.boost = Math.min(MAX_GAP_MS, Math.max(st.gapMs, this.boost) * 2)
          this.boostAt = this.now()
          st.nextAt = this.now() + Math.min(err.retryAfter, 60) * 1000
          this.opts.tel?.count("oob.stream.throttled", {
            "connector.type": "telegram",
          })
          return
        }
        if (/not modified/i.test((err as Error).message) && had) had.html = h
        else this.fail(err)
      }
    }
    st.nextAt = this.now() + this.gap(st)
  }

  /**
   * Posts the final text of a turn: up to three messages split between
   * blocks, the rest as a markdown document. A stream's messages are edited
   * into place, so nothing appears twice.
   */
  async reply(
    session: NonNullable<Push["session"]>,
    text: string,
  ): Promise<{ parts: number; documents: number } | undefined> {
    if (!this.chatId) return undefined
    const st = this.streams.get(session.id)
    this.streams.delete(session.id)
    if (st) {
      clearTimeout(st.timer)
      clearTimeout(st.refresh)
      await st.chain.catch(() => {})
    }
    try {
      const thread = await this.thread(session)
      const { messages, rest } = splitReply(text, MAX_REPLY_MESSAGES)
      const shown = st?.shown ?? []
      for (const [i, html] of messages.entries()) {
        const had = shown[i]
        if (had?.html === html) continue
        if (had) {
          try {
            await this.call("editMessageText", {
              chat_id: this.chatId,
              message_id: had.id,
              text: html,
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
            })
            continue
          } catch (err) {
            if (/not modified/i.test((err as Error).message)) continue
            this.fail(err)
          }
        }
        const m = await this.call<{ message_id: number }>("sendMessage", {
          chat_id: this.chatId,
          message_thread_id: thread,
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        })
        this.remember(m.message_id, session.id)
      }
      // Streamed text of an earlier step that the final text no longer needs.
      for (const extra of shown.slice(messages.length))
        await this.call("deleteMessage", {
          chat_id: this.chatId,
          message_id: extra.id,
        }).catch((err) => this.fail(err))
      if (rest)
        await this.upload(
          "sendDocument",
          {
            chat_id: this.chatId,
            message_thread_id: thread,
            caption: "📄 Full reply",
          },
          { field: "document", name: "reply.md", data: text },
        )
      return { parts: messages.length, documents: rest ? 1 : 0 }
    } catch (err) {
      this.fail(err)
      return undefined
    }
  }

  async turnCard(
    session: NonNullable<Push["session"]>,
    card: TurnCard,
    o: { chat: boolean },
  ): Promise<string | undefined> {
    if (!this.chatId) return undefined
    try {
      const thread = await this.thread(session)
      const m = await this.call<{ message_id: number }>("sendMessage", {
        chat_id: this.chatId,
        message_thread_id: thread,
        text: renderTurnCard(card),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        disable_notification: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Diff", callback_data: "ctl:diff" },
              ...(o.chat
                ? [{ text: "Continue", callback_data: "ctl:continue" }]
                : []),
              { text: "Stop", callback_data: "ctl:stop" },
            ],
          ],
        },
      })
      this.remember(m.message_id, session.id)
      return String(m.message_id)
    } catch (err) {
      this.fail(err)
      return undefined
    }
  }

  async unbutton(ref: string): Promise<void> {
    if (!this.chatId) return
    try {
      await this.call("editMessageReplyMarkup", {
        chat_id: this.chatId,
        message_id: Number(ref),
        reply_markup: { inline_keyboard: [] },
      })
    } catch (err) {
      if (!/not modified|not found/i.test((err as Error).message))
        this.fail(err)
    }
  }

  async document(
    session: NonNullable<Push["session"]>,
    name: string,
    data: string,
    caption: string,
  ): Promise<boolean> {
    if (!this.chatId) return false
    try {
      const thread = await this.thread(session)
      await this.upload(
        "sendDocument",
        { chat_id: this.chatId, message_thread_id: thread, caption },
        { field: "document", name, data },
      )
      return true
    } catch (err) {
      this.fail(err)
      return false
    }
  }

  private async toast(callbackID: string, text?: string): Promise<void> {
    try {
      await this.call("answerCallbackQuery", {
        callback_query_id: callbackID,
        text: text ? truncate(filterSecrets(text), TOAST_MAX) : undefined,
      })
    } catch (err) {
      this.fail(err)
    }
  }
}

export type TelegramConfig = {
  token: TokenSource
  chatId?: string
  /** Bot API base URL; the public API unless a local Bot API server is used. */
  apiBase: string
  statusCard: boolean
  draft: boolean
  notify: { finished?: boolean; failed?: boolean }
  icons: Record<string, string>
  reactions: ReactionsConfig
  media: MediaConfig
}

export const telegramType: ConnectorType<TelegramConfig> = {
  parse(raw, at) {
    const token = parseTokenSource(raw.token)
    if (!token) return { error: `${at}${TOKEN_ERROR}` }

    let chatId: string | undefined
    if (raw.chatId !== undefined) {
      if (
        !(typeof raw.chatId === "number" && Number.isInteger(raw.chatId)) &&
        !(typeof raw.chatId === "string" && /^-?\d+$/.test(raw.chatId))
      )
        return { error: `${at}chatId must be a numeric chat id` }
      chatId = String(raw.chatId)
    }

    const apiBase = raw.apiBase ?? "https://api.telegram.org"
    if (typeof apiBase !== "string" || !URL_RE.test(apiBase))
      return { error: `${at}apiBase must be an http(s) URL` }

    const statusCard = raw.statusCard ?? true
    if (typeof statusCard !== "boolean")
      return { error: `${at}statusCard must be true or false` }

    const draft = raw.draft ?? false
    if (typeof draft !== "boolean")
      return { error: `${at}draft must be true or false` }

    const notify: TelegramConfig["notify"] = {}
    if (raw.notify !== undefined) {
      if (!isObject(raw.notify))
        return { error: `${at}notify must be an object` }
      for (const k of ["finished", "failed"] as const) {
        const v = raw.notify[k]
        if (v !== undefined && typeof v !== "boolean")
          return { error: `${at}notify.${k} must be true or false` }
        notify[k] = v
      }
    }

    const icons: Record<string, string> = {}
    if (raw.icons !== undefined) {
      if (!isObject(raw.icons))
        return { error: `${at}icons must map patterns to emoji` }
      for (const [k, v] of Object.entries(raw.icons)) {
        if (typeof v !== "string" || !v)
          return { error: `${at}icons.${k} must be an emoji` }
        icons[k] = v
      }
    }

    const reactions = parseReactions(raw.reactions, at)
    if ("error" in reactions) return reactions
    const media = parseMedia(raw.media, at)
    if ("error" in media) return media

    return {
      token,
      chatId,
      apiBase: apiBase.replace(/\/+$/, ""),
      statusCard,
      draft,
      notify,
      icons,
      reactions: reactions.reactions,
      media: media.media,
    }
  },

  create(env, o) {
    const stored = env.settings.get().chatId
    return new TelegramConnector({
      name: env.name,
      token: lazyToken(o.token),
      tel: env.tel,
      // A chat paired in the TUI wins over the file.
      chatId: typeof stored === "string" ? stored : o.chatId,
      apiBase: o.apiBase,
      statusCard: o.statusCard,
      draft: o.draft,
      notify: o.notify,
      icons: o.icons,
      reactions: o.reactions,
      media: o.media,
      offsetFile: join(env.dir, `${env.name}-offset.json`),
      topicsFile: join(env.dir, `${env.name}-topics.json`),
      onPaired: (chatId) => env.settings.set({ chatId }),
      menuStore: {
        get: () => {
          const k = env.settings.get().menu
          return typeof k === "string" ? k : undefined
        },
        set: (menu) => env.settings.set({ menu }),
      },
    })
  },
}
