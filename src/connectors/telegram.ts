/**
 * Telegram as a connector, over the Bot API with long polling: the plugin only
 * makes outgoing HTTPS requests and exposes nothing.
 *
 * In a forum supergroup each top-level session gets its own topic. A question
 * carries answer buttons only when it is one tap (see classify.ts); any other
 * has one button that opens it in the app, and can still be answered by
 * replying to the message with numbers or text. Only the paired chat is
 * heard; everything else is dropped unread.
 */
import { createHash, randomInt } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import {
  buildMenu,
  menuHash,
  validMenu,
  type MenuCommand,
} from "../commandmenu.ts"
import type {
  ApprovalHandler,
  ApprovalView,
  Settled,
} from "../approvals/types.ts"
import { filterSecrets } from "../filter.ts"
import { parseReply, type Question } from "../inbound.ts"
import { log } from "../logger.ts"
import type { FileJob } from "../sendfile.ts"
import type { Telemetry } from "../otel.ts"
import { traces, type Class, type Rec } from "../trace.ts"
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
import { Muted, SendBudget, VISIBLE, type Rate } from "./telegram-budget.ts"
import { Inbox } from "./telegram-inbox.ts"
import { closeFences, splitReply } from "./telegram-markdown.ts"
import {
  esc,
  keycap,
  renderApproval,
  renderApprovalCode,
  renderPush,
  renderStatus,
  renderTurnCard,
  starred,
} from "./telegram-render.ts"
import { oneTap } from "../classify.ts"
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
  stageEmoji,
  stageOf,
  type ReactionsConfig,
  type Stage,
} from "./telegram-reactions.ts"
import type {
  Capabilities,
  Connector,
  ConnectorStatus,
  ConnectorType,
  Home,
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

const REVIEW = "📱 Review & approve"

/** A message ref is "<chat>:<message id>"; an older one is the bare message id of the paired chat. */
const splitRef = (ref: string, chat?: string): [string | undefined, number] => {
  const i = ref.lastIndexOf(":")
  return i < 0
    ? [chat, Number(ref)]
    : [ref.slice(0, i), Number(ref.slice(i + 1))]
}

const MOVED = "This moved to the app: use the 📱 button."
const LABEL_MAX = 40
const POLL_SECONDS = 30
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const PAIR_TTL_MS = 10 * 60_000
const TOAST_MAX = 190
const TOPIC_RETRY_MS = 5 * 60_000
const DM_RETRY_MS = 10 * 60_000
const APP_TEXT = "📱 Open app"
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
const FINAL_RETRY_MS = 20_000
/** What a person reads of a message: its HTML without the tags. */
const plain = (html: string) => html.replace(/<[^>]*>/g, "").trimEnd()
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
  /** Where updates are written down until they are handled, so a restart or a stuck handler loses none. */
  inboxFile?: string
  /** Delays before each new try of a failed delivery, and how long one update may take; tests shorten them. */
  retryMs?: number[]
  handleMs?: number
  /** Least time between two reaction calls; tests shorten it. */
  reactGapMs?: number
  /** How long a reply that could not be posted waits before it is tried once more. */
  finalRetryMs?: number
  /** Where session topics of a forum chat are remembered across restarts. */
  topicsFile?: string
  /** The Telegram user id stored at pairing: the only person whose tap or code answers an approval. */
  operator?: string
  /** The same id from the config file, used when pairing stored none. */
  operatorFallback?: string
  /** Called with the chat id, and the id of the person who paired, once pairing succeeds, to store them. */
  onPaired?: (chatId: string, userId?: string) => void
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
  /** `project`: headless sessions of a project share one topic; `session`: a topic each. */
  topics?: { headless: "project" | "session"; closeHeadless?: boolean }
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
  /** The send budget per chat. Without it calls are not paced; the config always gives one. */
  rate?: Rate
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
  from?: { id: number }
  message_thread_id?: number
  reply_to_message?: { message_id: number }
}

type Update = {
  update_id: number
  message?: Message
  callback_query?: {
    id: string
    data?: string
    from?: { id: number }
    message?: {
      message_id: number
      message_thread_id?: number
      chat: { id: number }
    }
  }
}

/** How an update's last outcome counts: heard, turned away, or lost. */
const classOf = (outcome: string): Class =>
  outcome === "refused" || outcome === "rejected"
    ? "refused"
    : outcome === "error" || outcome === "ignored" || outcome === "failed"
      ? "dropped"
      : "delivered"

/**
 * The receive loops running in this process, by bot. A loop that replaces one
 * (a restart, a reload of the plugin) waits for the old one to end first, so
 * two never poll one bot at once.
 */
const POLLERS = new Map<string, Promise<void>>()
/** A replaced loop gets this long to end before the new one goes on. */
const HANDOVER_MS = 5_000
/** Telegram allows about one message a second per chat and 20 a minute in a group. */
const DEFAULT_RATE: Rate = { gapMs: 1100, perMinute: 18 }
/** Topic-file keys of shared topics start with this after the chat id; session ids never do. */
const SHARED = "agents/"
/** The most of a session title a tag shows. */
const TAG_MAX = 60
const SHARED_HINT =
  "This topic is shared by agents with no topic of their own. Reply to one agent's message to write to it."
const CARD_TAP = /^ctl:(resume|diff|continue|qa|update|stop)$/
/** The buttons that send the session a message: their state shows on the tapped message. */
const SENDS = /^ctl:(continue|qa|update)$/
const TAP_LABEL: Record<string, string> = {
  qa: "QA",
  update: "Update",
  continue: "Continue",
}

/** The toast of a button that sends a message, shown before its work starts. */
const tapPending = (action: string, name: string) =>
  `⏳ ${TAP_LABEL[action] ?? action} sent to ${name}`

const OWNER_ONLY = "Only the paired owner can interrupt a turn."
/** After an update from the paired chat, the connector may answer it while the person counts as present. */
const ANSWER_WINDOW_MS = 30_000

/** The handler asks for the update to be tried again. */
class RetryLater extends Error {}

/** One update must not hold its topic longer than this. */
const HANDLE_MS = 90_000
/** Delays before the tries after a failed delivery. */
const RETRY_MS = [5_000, 30_000, 120_000]
/** Telegram limits how fast a bot may change reactions: one call at least this far from the last. */
const REACT_GAP_MS = 400
/** Messages whose reaction is remembered, and messages per session waiting for a reply. */
const REACTED_MAX = 500
const AWAITING_MAX = 20

type Button =
  | { text: string; callback_data: string }
  | { text: string; url: string }
  | { text: string; web_app: { url: string } }

type Markup = { inline_keyboard: Button[][] }

type Stream = {
  session: NonNullable<Push["session"]>
  /** The assistant message the text belongs to. */
  step?: string
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

type UploadFile = {
  field: string
  name: string
  data: string | Uint8Array
  type?: string
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
  /** The pinned "Open app" message, and whether it is pinned. */
  app?: number
  appPinned?: boolean
  name?: string
  iconId?: string
  icon?: string
  /** What the card shows now; not kept across restarts. */
  cardText?: string
  /** The bridge closed this topic (its session is headless and idle); it is reopened when used. */
  closed?: boolean
}

type Sticker = { emoji?: string; custom_emoji_id?: string }

/** The tag line of a message in a shared topic, as HTML; nothing without a tag. */
const tagHtml = (tag?: string) => (tag ? `🏷 <i>${esc(tag)}</i>\n` : "")

/** The tag of a message in a shared topic ahead of a plain caption (at most 1024 characters). */
const tagCaption = (tag: string | undefined, caption: string) =>
  tag ? truncate(`🏷 ${tag}\n${caption}`, 1024) : caption

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
    retriesInbound: true,
    foldable: true,
    approvals: { buttons: true, approver: "verified", replyText: true },
  }
  readonly id: string
  readonly notify: { finished: boolean; failed: boolean }
  enabled: boolean

  private chatId: string | undefined
  private userId: string | undefined
  private approvals: ApprovalHandler | undefined
  private connected: boolean | undefined
  private lastError: string | undefined
  private onInbound: OnInbound | undefined
  private signal: AbortSignal | undefined
  private polling = false
  private pollOkAt: number | undefined
  private sendOkAt: number | undefined
  private loopBeatAt: number | undefined
  private offset: number | undefined
  private readonly inbox: Inbox<Update>
  private restored: Promise<void> | undefined
  /** Per chat and topic: updates are handled in order, and one stuck topic does not hold up another. */
  private readonly lanes = new Map<string, Promise<void>>()
  /** The trace of each update that is not finished. */
  private readonly recs = new Map<number, Rec>()
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
  /** Topics whose app message was seen to this run, and whether the startup sweep ran. */
  private readonly appDone = new Set<string>()
  private appSwept = false
  /** When the operator's private chat last refused an approval message. */
  private dmFailedAt = -Infinity
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
    { choices: Menu["choices"]; page: number; owner?: boolean }
  >()
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
  private pairing:
    | { code: string; finish: (chatId: string | undefined) => void }
    | undefined
  private readonly opts: TelegramOptions
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly budget: SendBudget | undefined
  private isMuted: (() => boolean) | undefined
  private homeOf: ((id: string) => Promise<Home | undefined>) | undefined
  /** The shared topic a session last posted to, for what is sync: its link and the tag of an edit. */
  private readonly homes = new Map<string, Home>()
  /** The tag a message carries in a shared topic, by message, so an edit keeps it. */
  private readonly tags = new Map<string, string>()
  /** When the paired chat last sent an update: what is sent in answer is not unsolicited. */
  private inboundAt = -Infinity
  private readonly out = { sent: 0, suppressed: 0, rateLimited: 0 }

  constructor(opts: TelegramOptions, enabled = true) {
    this.opts = opts
    this.inbox = new Inbox(opts.inboxFile)
    this.id = opts.name ?? "telegram"
    this.enabled = enabled
    this.chatId = opts.chatId
    this.userId = opts.operator ?? opts.operatorFallback
    this.fetch = opts.fetch ?? globalThis.fetch
    this.now = opts.now ?? Date.now
    if (opts.rate)
      this.budget = new SendBudget(opts.rate, this.now, () => this.muteNow())
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
    void this.sweepApps()
    this.poll()
  }

  private app: { url: string; link?: string } | undefined
  private buttonFor: string | undefined

  launch(app: { url: string; link?: string }): void {
    this.app = app
    if (this.onInbound) void this.register()
    void this.sweepApps()
  }

  /** A private chat opens the app in place; a group takes the direct link, because web_app buttons work only in private chats. */
  private openButton(
    sessionID: string,
    text = "📱 Open",
    dm = false,
  ): Button | undefined {
    const app = this.app
    if (!app) return undefined
    // An approval is already "a_<id>" and a question "f_<id>"; a session gets "s_", so none can be taken for an enrolment code.
    const arg = /^[af]_/.test(sessionID) ? sessionID : "s_" + sessionID
    const id = /^[A-Za-z0-9_-]{1,64}$/.test(arg) ? arg : undefined
    if (dm || (this.chatId && Number(this.chatId) > 0))
      return {
        text,
        web_app: { url: app.url + (id ? "?s=" + id : "") },
      }
    return app.link && id
      ? { text, url: app.link + "?startapp=" + id }
      : undefined
  }

  appOpen(): boolean {
    return this.openButton("a_0", undefined, true) !== undefined
  }

  private withOpen(push: Push, markup: Markup | undefined): Markup | undefined {
    const q = push.prompt
    const asks = push.card?.kind === "question" || push.permission
    const b =
      q && (!oneTap(q.questions) || q.questions[0].custom)
        ? this.openButton("f_" + q.id, "📱 Answer in app")
        : asks && push.session
          ? this.openButton(push.session.id)
          : undefined
    return b
      ? { inline_keyboard: [...(markup?.inline_keyboard ?? []), [b]] }
      : markup
  }

  /**
   * The menu button opens the app. The Bot API sets it per private chat, so a group-paired bridge
   * sets it in the operator's own chat with the bot, when the operator's id is known.
   */
  private async menuButton(): Promise<void> {
    const url = this.app?.url
    const chat = this.chatId
    if (!url || !chat) return
    const target = Number(chat) > 0 ? Number(chat) : Number(this.userId)
    if (!Number.isSafeInteger(target) || target <= 0) return
    if (this.buttonFor === url + target) return
    this.buttonFor = url + target
    try {
      await this.call("setChatMenuButton", {
        chat_id: target,
        menu_button: { type: "web_app", text: "Open", web_app: { url } },
      })
    } catch (err) {
      this.buttonFor = undefined
      this.fail(err)
    }
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
    void this.menuButton()
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
      pollOkAt: this.pollOkAt,
      sendOkAt: this.sendOkAt,
      silentMs:
        this.polling && this.loopBeatAt !== undefined && retryAt === undefined
          ? this.now() - this.loopBeatAt
          : undefined,
      lastError:
        (retryAt === undefined ? undefined : tokenWaitText(retryAt)) ??
        this.lastError ??
        (this.chatId ? undefined : "not paired"),
      warning: this.topicWarning,
      out: { ...this.out, coalesced: this.budget?.stats.coalesced ?? 0 },
    }
  }

  home(of: (sessionID: string) => Promise<Home | undefined>): void {
    this.homeOf = of
  }

  mute(isMuted: () => boolean): void {
    this.isMuted = isMuted
  }

  hush(): void {
    for (const t of this.pulses.values()) clearInterval(t)
    this.pulses.clear()
    this.budget?.drop()
  }

  /** Present, and not answering what the person just did in the chat. */
  private muteNow(): boolean {
    return (
      this.isMuted?.() === true &&
      this.now() - this.inboundAt >= ANSWER_WINDOW_MS
    )
  }

  hint(id: string, qs: Question[]): string {
    if (oneTap(qs))
      return qs[0].custom && this.app
        ? "Tap a button, or 📱 Answer in app to type, or reply."
        : "Tap a button, or reply."
    const lead = this.app ? "Tap 📱 Answer in app, or reply" : "Reply"
    if (qs.length !== 1)
      return `${lead} to this message with one answer per question, separated by | (for example: 1 | yes | 2,3). Options are numbered.`
    if (qs[0].multiple) return `${lead} to this message with numbers, like 1,3.`
    return `${lead} to this message with a number or text (or send "#${id} <answer>").`
  }

  async send(push: Push): Promise<string | undefined> {
    if (!this.chatId) return undefined
    if (push.explicit) this.inboundAt = this.now()
    const q = push.prompt
    const live = q && oneTap(q.questions) ? q : undefined
    const one = live?.questions[0]
    try {
      for (let attempt = 0; ; attempt++) {
        const thread = await this.thread(push.session)
        const tag = push.session && this.tagOf(push.session.id)
        try {
          const m = await this.call<{ message_id: number }>(
            "sendMessage",
            {
              chat_id: this.chatId,
              message_thread_id: thread,
              text:
                (tag ? tagHtml(tag) : "") +
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
              reply_markup: this.withOpen(
                push,
                live && one
                  ? this.keyboard(live.id, one.options)
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
              ),
            },
            undefined,
            undefined,
            push.stats,
          )
          const ref = String(m.message_id)
          if (push.session) this.remember(ref, push.session.id)
          if (tag) this.tagged(ref, tag)
          return ref
        } catch (err) {
          // The topic was deleted in Telegram: make a new one once.
          if (
            thread === undefined ||
            attempt > 0 ||
            !/thread/i.test((err as Error).message)
          )
            throw err
          const home = this.homes.get(push.session!.id)
          this.topics?.delete(
            this.topicKey(home ? SHARED + home.key : push.session!.id),
          )
          await this.saveTopics()
        }
      }
    } catch (err) {
      this.fail(err)
      return undefined
    }
  }

  private tagged(ref: string, tag: string) {
    this.tags.set(ref, tag)
    if (this.tags.size > SENT_KEEP)
      this.tags.delete(this.tags.keys().next().value!)
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
      if (
        t.thread === thread &&
        k.startsWith(prefix) &&
        !k.startsWith(prefix + SHARED)
      )
        return k.slice(prefix.length)
    return undefined
  }

  /** Whether a topic is one several headless sessions share, where only a reply names the session. */
  private async isShared(thread?: number): Promise<boolean> {
    if (thread === undefined || !this.chatId) return false
    this.topics ??= await this.loadTopics()
    const prefix = `${this.chatId}:${SHARED}`
    for (const [k, t] of this.topics)
      if (t.thread === thread && k.startsWith(prefix)) return true
    return false
  }

  private topicKey(sessionID: string) {
    return `${this.chatId}:${sessionID}`
  }

  private async isForum(): Promise<boolean> {
    if (this.forum === undefined) {
      try {
        const chat = await this.call<{ is_forum?: boolean }>("getChat", {
          chat_id: this.chatId,
        })
        this.forum = chat.is_forum === true
      } catch (err) {
        this.fail(err)
        return false
      }
    }
    return this.forum
  }

  /** The "Approvals" topic of the paired forum chat, created on first use; never General. */
  private async approvalsTopic(): Promise<number | undefined> {
    if (!this.chatId || !(await this.isForum())) return undefined
    this.topics ??= await this.loadTopics()
    const key = this.topicKey("approvals")
    const known = this.topics.get(key)
    if (known) return known.thread
    if (this.now() < this.topicRetryAt) return undefined
    try {
      const t = await this.call<{ message_thread_id: number }>(
        "createForumTopic",
        { chat_id: this.chatId, name: "Approvals" },
      )
      this.topics.set(key, { thread: t.message_thread_id, name: "Approvals" })
      await this.saveTopics()
      return t.message_thread_id
    } catch (err) {
      this.topicRetryAt = this.now() + TOPIC_RETRY_MS
      this.fail(err)
      return undefined
    }
  }

  /** The forum topic of a session, created on first use; undefined outside a forum. */
  private async thread(
    session: Push["session"],
    reopen = true,
  ): Promise<number | undefined> {
    if (!session || !this.chatId) return undefined
    if (!(await this.isForum())) return undefined
    this.topics ??= await this.loadTopics()
    // A session that has a topic keeps it; only one without gets the shared one.
    const own = this.topics.get(this.topicKey(session.id))
    if (own !== undefined) {
      this.homes.delete(session.id)
      if (own.closed && reopen) await this.reopenTopic(session.id, own)
      return own.thread
    }
    const home = await this.homeFor(session.id)
    const key = home
      ? this.topicKey(SHARED + home.key)
      : this.topicKey(session.id)
    const known = this.topics.get(key)
    if (known !== undefined) return known.thread
    // After a failure the main chat is used, and creation is tried again later.
    if (this.now() < this.topicRetryAt) return undefined
    let job = this.topicJobs.get(key)
    if (!job) {
      job = this.createTopic(
        key,
        home ? { id: key, name: home.name, project: session.project } : session,
      ).finally(() => this.topicJobs.delete(key))
      this.topicJobs.set(key, job)
    }
    return job
  }

  /** The shared topic a session belongs in, when it has none of its own and the setting allows it. */
  private async homeFor(sessionID: string): Promise<Home | undefined> {
    if (!this.homeOf || this.opts.topics?.headless === "session") return
    let home: Home | undefined
    try {
      home = await this.homeOf(sessionID)
    } catch (err) {
      log("telegram_home_error", { message: (err as Error).message })
    }
    if (home) this.homes.set(sessionID, home)
    else this.homes.delete(sessionID)
    return home
  }

  /** What starts a message of a session that posts in a shared topic; nothing for any other. */
  private tagOf(sessionID: string): string | undefined {
    const tag = this.homes.get(sessionID)?.tag
    return tag ? truncate(filterSecrets(tag), TAG_MAX) : undefined
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

  /** The sessions that have an open topic of their own, when closing is on. */
  async topicSessions(): Promise<string[]> {
    if (this.opts.topics?.closeHeadless === false || !this.chatId) return []
    this.topics ??= await this.loadTopics()
    const prefix = `${this.chatId}:`
    const out: string[] = []
    for (const [k, t] of this.topics) {
      const id = k.slice(prefix.length)
      if (k.startsWith(prefix) && id.startsWith("ses_") && !t.closed)
        out.push(id)
    }
    return out
  }

  /** Closes the session's topic. Never deletes it; a failure is logged and left for the next end. */
  async closeTopic(
    sessionID: string,
    why: "start" | "ended",
  ): Promise<boolean> {
    if (this.opts.topics?.closeHeadless === false || !this.chatId) return false
    this.topics ??= await this.loadTopics()
    const t = this.topics.get(this.topicKey(sessionID))
    if (!t || t.closed || !(await this.isForum())) return false
    try {
      await this.call("closeForumTopic", {
        chat_id: this.chatId,
        message_thread_id: t.thread,
      })
    } catch (err) {
      if (!/TOPIC_NOT_MODIFIED/.test((err as Error).message)) {
        log("telegram_topic_close_failed", {
          session: sessionID,
          thread: t.thread,
          message: filterSecrets((err as Error).message),
        })
        return false
      }
    }
    t.closed = true
    await this.saveTopics()
    log("telegram_topic_closed", { session: sessionID, thread: t.thread, why })
    return true
  }

  private readonly reopening = new Map<string, Promise<void>>()

  /** Reopens a topic the bridge closed, before something is posted to it. */
  private reopenTopic(sessionID: string, t: Topic): Promise<void> {
    let job = this.reopening.get(sessionID)
    if (!job) {
      job = (async () => {
        try {
          await this.call("reopenForumTopic", {
            chat_id: this.chatId,
            message_thread_id: t.thread,
          })
        } catch (err) {
          if (!/TOPIC_NOT_MODIFIED/.test((err as Error).message)) {
            log("telegram_topic_reopen_failed", {
              session: sessionID,
              thread: t.thread,
              message: filterSecrets((err as Error).message),
            })
            return
          }
        }
        t.closed = undefined
        await this.saveTopics()
        log("telegram_topic_reopened", { session: sessionID, thread: t.thread })
      })().finally(() => this.reopening.delete(sessionID))
      this.reopening.set(sessionID, job)
    }
    return job
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

  private saveChain: Promise<void> = Promise.resolve()

  /** Resolves when the saves started so far have been written. */
  settled(): Promise<void> {
    return this.saveChain
  }

  /** Saves one after the other: two writes of the file at once interleave and corrupt it. */
  private saveTopics(): Promise<void> {
    const run = this.saveChain.then(() => this.writeTopics())
    this.saveChain = run
    return run
  }

  private async writeTopics(): Promise<void> {
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
      // A session in a shared topic has no card, name or typing indicator of its own.
      this.topics ??= await this.loadTopics()
      if (
        !this.topics.has(this.topicKey(state.id)) &&
        (await this.homeFor(state.id))
      )
        return
      // The card of a session that is not working is edited in a closed topic without reopening it.
      const thread = await this.thread(
        session,
        state.state !== "idle" && state.state !== "failed",
      )
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
        (!!live.want.chat && live.want.state === "working") !==
          (!!state.chat && state.state === "working") ||
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
      !this.muteNow() &&
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
    const name = truncate(
      (s.unstarted ? "⚪ " : "") + filterSecrets(s.name),
      128,
    )
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
        await this.card(topic, text, !!s.chat, s.id, s.state === "working")
      }
    }
    await this.appMessage(key, s.id)
    if (wait < Infinity) {
      live.timer = setTimeout(() => void this.flush(key), wait)
      live.timer.unref?.()
    }
  }

  /** Once per run, the app message of every topic already bound to a session. */
  private async sweepApps(): Promise<void> {
    if (this.appSwept || !this.app || !this.onInbound || !this.chatId) return
    this.appSwept = true
    try {
      this.topics ??= await this.loadTopics()
      const prefix = `${this.chatId}:`
      const bound = [...this.topics.keys()].filter(
        (k) =>
          k.startsWith(prefix) &&
          k !== this.topicKey("approvals") &&
          !k.startsWith(prefix + SHARED),
      )
      if (bound.length === 0 || !(await this.isForum())) return
      for (const key of bound)
        await this.appMessage(key, key.slice(prefix.length))
    } catch (err) {
      this.fail(err)
    }
  }

  /**
   * The "📱 Open app" message of a bound topic: posted and pinned once, then edited in place. A
   * message Telegram no longer has is posted and pinned again; a pin the bot may not make leaves it
   * unpinned. Runs once per topic and run.
   */
  private async appMessage(key: string, sessionID: string): Promise<void> {
    const topic = this.topics?.get(key)
    const open = this.openButton(sessionID)
    if (!topic || !open || !this.chatId || this.appDone.has(key)) return
    this.appDone.add(key)
    const thread = topic.thread
    const reply_markup = { inline_keyboard: [[open]] }
    let posted = false
    let recreated = false
    try {
      if (topic.app !== undefined) {
        try {
          await this.call("editMessageText", {
            chat_id: this.chatId,
            message_id: topic.app,
            text: APP_TEXT,
            reply_markup,
          })
        } catch (err) {
          const m = (err as Error).message
          if (/not modified/i.test(m)) {
            // Already as it should be.
          } else if (/not found/i.test(m)) {
            topic.app = undefined
            recreated = true
          } else throw err
        }
      }
      if (topic.app === undefined) {
        const m = await this.call<{ message_id: number }>("sendMessage", {
          chat_id: this.chatId,
          message_thread_id: thread,
          text: APP_TEXT,
          disable_notification: true,
          reply_markup,
        })
        topic.app = m.message_id
        topic.appPinned = false
        posted = true
        await this.saveTopics()
      }
    } catch (err) {
      this.fail(err)
      log("topic_pin", { thread, outcome: "failed" })
      return
    }
    let pinned = topic.appPinned === true
    let outcome = recreated ? "recreated" : posted ? "pinned" : "edited"
    if (!pinned) {
      try {
        await this.call("pinChatMessage", {
          chat_id: this.chatId,
          message_id: topic.app,
          disable_notification: true,
        })
        topic.appPinned = pinned = true
        await this.saveTopics()
        if (!recreated && !posted) outcome = "pinned"
        // The bar shows the latest pin: the status card takes it back.
        if (topic.card !== undefined && this.opts.statusCard !== false)
          await this.call("pinChatMessage", {
            chat_id: this.chatId,
            message_id: topic.card,
            disable_notification: true,
          }).catch((err) => this.fail(err))
      } catch (err) {
        const m = (err as Error).message
        outcome = "unpinned"
        log("topic_pin_failed", {
          thread,
          reason: RIGHTS.test(m) ? "no_pin_right" : filterSecrets(m),
        })
      }
    }
    log("topic_pin", { thread, outcome })
  }

  /** Creates, pins or edits the status card of a topic. */
  private async card(
    topic: Topic,
    text: string,
    chat: boolean,
    sessionID: string,
    busy = false,
  ): Promise<void> {
    // Always sent: an edit without it would keep the old button.
    const open = this.openButton(sessionID)
    const reply_markup = {
      inline_keyboard: [
        ...(busy && chat
          ? [
              [
                { text: "⏹ Interrupt", callback_data: "ctl:interrupt" },
              ] as Button[],
            ]
          : []),
        ...(chat
          ? [
              [
                { text: "QA", callback_data: "ctl:qa" },
                { text: "Update", callback_data: "ctl:update" },
              ] as Button[],
              [{ text: "🛑 Stop chat", callback_data: "chatoff" } as Button],
            ]
          : []),
        ...(open ? [[open]] : []),
      ],
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
    try {
      await this.call(
        "editMessageText",
        {
          chat_id: this.chatId,
          message_id: Number(ref),
          text: tagHtml(this.tags.get(ref)) + renderPush(push),
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
    if (err instanceof TokenUnavailable || err instanceof Muted) return
    this.lastError = filterSecrets((err as Error).message)
    log("telegram_error", { message: this.lastError })
  }

  private keyboard(id: string, options: string[]): Markup {
    return {
      inline_keyboard: options.map((label, i) => [
        {
          text: truncate(`${keycap(i + 1)} ${starred(label)}`, LABEL_MAX),
          callback_data: `${id}:${i + 1}`,
        },
      ]),
    }
  }

  /** One Bot API call. Honours 429 `retry_after`; throws on any other failure. */
  /** Asks whether it is quiet hours. */
  private quiet: (() => boolean) | undefined

  silence(isQuiet: () => boolean): void {
    this.quiet = isQuiet
  }

  private call<T>(
    method: string,
    body: unknown,
    timeoutMs = 10_000,
    signal?: AbortSignal,
    stats?: SendStats,
    retry = true,
  ): Promise<T> {
    const raw = (b: unknown) =>
      this.rawCall<T>(method, b, timeoutMs, signal, stats, retry)
    if (this.budget && SendBudget.paced(method, body))
      return this.budget
        .run<T>(method, body as Record<string, unknown>, raw)
        .catch((err) => {
          if (err instanceof Muted && !err.counted) {
            err.counted = true
            this.out.suppressed++
          }
          throw err
        })
    return raw(body)
  }

  private async rawCall<T>(
    method: string,
    body: unknown,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    stats: SendStats | undefined,
    retry: boolean,
  ): Promise<T> {
    if (VISIBLE.test(method) && this.muteNow()) {
      const m = new Muted()
      m.counted = true
      this.out.suppressed++
      throw m
    }
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
      const t0 = this.now()
      let res: Response
      try {
        res = await this.fetch(`${base}/bot${token}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          keepalive: false,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
      } catch (err) {
        if (!signal?.aborted)
          traces.api(method, {
            ms: this.now() - t0,
            ok: false,
            code: timeout.aborted ? "timeout" : "network",
          })
        // A call that hung on a dead connection is tried once more, on a new one.
        if (!signal?.aborted && method !== "getUpdates" && attempt < 1) {
          log("telegram_call_retry", {
            method,
            message: (err as Error).message,
          })
          continue
        }
        throw err
      }
      if (stats) stats.httpStatus = res.status
      const json = (await res.json().catch(() => undefined)) as
        | {
            ok?: boolean
            result?: T
            description?: string
            parameters?: { retry_after?: number }
          }
        | undefined
      traces.api(method, {
        ms: this.now() - t0,
        ok: json?.ok === true,
        code: res.status,
        text: filterSecrets(json?.description ?? ""),
      })
      if (json?.ok) {
        if (method !== "getUpdates") this.sendOkAt = this.now()
        if (VISIBLE.test(method)) this.out.sent++
        return json.result as T
      }
      const wait = json?.parameters?.retry_after
      if (res.status === 429) {
        this.out.rateLimited++
        if (wait !== undefined)
          this.budget?.cool((body as { chat_id?: unknown })?.chat_id, wait)
      }
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
    void this.loop(signal).finally(() => {
      this.polling = false
      this.loopBeatAt = undefined
    })
  }

  /** One receive loop per bot in this process: wait for the one this replaces. */
  private async loop(signal: AbortSignal): Promise<void> {
    const key = await this.opts.token().then(
      (t) =>
        createHash("sha256")
          .update(t ?? "")
          .digest("hex")
          .slice(0, 16),
      () => "name:" + this.id,
    )
    const prev = POLLERS.get(key)
    let release!: () => void
    const mine = new Promise<void>((r) => (release = r))
    POLLERS.set(key, mine)
    try {
      if (prev) {
        const waited = this.now()
        await Promise.race([prev, sleep(HANDOVER_MS, signal)])
        log("telegram_poll_handover", { waited_ms: this.now() - waited })
      }
      await this.receive(signal)
    } finally {
      release()
      if (POLLERS.get(key) === mine) POLLERS.delete(key)
    }
  }

  private conflicted = false

  private async receive(signal: AbortSignal): Promise<void> {
    const { min, max } = this.opts.backoff ?? { min: 1000, max: 60_000 }
    const seconds = this.opts.pollSeconds ?? POLL_SECONDS
    let delay = min
    this.offset ??= await this.loadOffset()
    await this.restore()
    while (!signal.aborted && (this.chatId || this.pairing)) {
      this.loopBeatAt = this.now()
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
        this.conflicted = false
        this.pollOkAt = this.now()
        if (updates.length) {
          // Written down before Telegram is told they arrived: the offset moves only once they are safe.
          const fresh = await this.inbox.add(updates)
          this.offset = Math.max(...updates.map((u) => u.update_id)) + 1
          await this.saveOffset()
          for (const u of fresh) {
            traces.bump("inbound", "received")
            this.begin(u)
            this.dispatch(u, 0)
          }
          traces.setQueue(this.inbox.size)
        }
      } catch (err) {
        if (signal.aborted) return
        this.connected = false
        if (err instanceof TokenUnavailable) {
          // No fast retries: wait for the time the token will be asked for again.
          await sleep(Math.max(0, err.retryAt - Date.now()), signal)
          continue
        }
        if (/HTTP 409/.test((err as Error).message)) {
          // Another getUpdates for this bot is live: say so once, and let the backoff wait it out.
          this.lastError = "another process is polling this bot (HTTP 409)"
          if (!this.conflicted)
            log("telegram_poll_conflict", { message: this.lastError })
          this.conflicted = true
        } else this.fail(err)
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

  /** Handles what a previous run wrote down and did not finish, once. */
  private restore(): Promise<void> {
    this.restored ??= this.inbox.load().then((left) => {
      for (const u of left) {
        log("telegram_inbound_replay", { update_id: u.update_id })
        this.dispatch(u, 0)
      }
    })
    return this.restored
  }

  private begin(u: Update): Rec {
    const m = u.message ?? u.callback_query?.message
    const rec = traces.start("in", this.kindOf(u), {
      event: "telegram_inbound",
      update_id: u.update_id,
      message_id: m?.message_id,
      thread: m?.message_thread_id,
    })
    this.recs.set(u.update_id, rec)
    return rec
  }

  /** Taps and messages of a topic have lanes of their own: a tap never waits for a message. */
  private laneOf(u: Update): string {
    const m = u.message ?? u.callback_query?.message
    return `${m?.chat.id}:${m?.message_thread_id ?? 0}${u.callback_query ? ":tap" : ""}`
  }

  /** Runs the update after the ones before it in its topic; the poll loop never waits for it. */
  private dispatch(u: Update, attempt: number): void {
    const ack = attempt === 0 ? this.earlyAck(u) : undefined
    const lane = this.laneOf(u)
    const next = (this.lanes.get(lane) ?? Promise.resolve())
      .then(() => ack)
      .then(() => this.handle(u, attempt))
      .catch((err) =>
        log("telegram_update_error", {
          update_id: u.update_id,
          message: filterSecrets((err as Error).message),
        }),
      )
      .finally(() => {
        if (this.lanes.get(lane) === next) this.lanes.delete(lane)
      })
    this.lanes.set(lane, next)
  }

  /** A card button is answered the moment it arrives, before it waits in its lane or does any work. */
  private async earlyAck(u: Update): Promise<void> {
    const cb = u.callback_query
    const action = SENDS.exec(cb?.data ?? "")?.[1]
    if (!cb?.message || !action || String(cb.message.chat.id) !== this.chatId)
      return
    try {
      // An unknown topic is left to the handler, which says so.
      if (!(await this.sessionAt(cb.message.message_thread_id))) return
      const name = await this.topicName(cb.message.message_thread_id)
      await this.toast(cb.id, tapPending(action, name))
      const rec = this.recs.get(u.update_id) ?? this.begin(u)
      traces.annotate({ extra: { ack_ms: this.now() - rec.startedAt } }, rec)
    } catch (err) {
      this.fail(err)
    }
  }

  /** The name of the session's topic, from the local map only. */
  private async topicName(thread?: number): Promise<string> {
    if (thread === undefined || !this.chatId) return "the session"
    this.topics ??= await this.loadTopics()
    const prefix = `${this.chatId}:`
    for (const [k, t] of this.topics)
      if (
        t.thread === thread &&
        k.startsWith(prefix) &&
        !k.startsWith(prefix + SHARED)
      )
        return t.name ?? "the session"
    return "the session"
  }

  /** What a card button did: its state on the tapped message, a line in the topic when it failed, and the log. */
  private async tapped(
    cb: NonNullable<Update["callback_query"]>,
    action: string,
    out: Outcome | undefined,
  ): Promise<void> {
    const failed = out?.ok === false
    const result = failed
      ? "failed"
      : (out?.delivered?.how ?? (out?.sent ? "sent" : "done"))
    traces.annotate({
      extra: { action, result },
      ...(failed
        ? { outcome: "failed", reason: truncate(filterSecrets(out.text), 200) }
        : {}),
    })
    const id = cb.message?.message_id
    if (id !== undefined) void this.react(id, result)
    if (failed)
      await this.deliver(cb.message?.message_thread_id, {
        ok: false,
        text: `⚠ ${TAP_LABEL[action] ?? action} not delivered: ${out.text}`,
      })
  }

  private kindOf(u: Update): string {
    if (u.callback_query) return "callback"
    const m = u.message
    if (!m) return "other"
    if (mediaOf(m)) return "media"
    return m.text?.trim().startsWith("/") ? "command" : "text"
  }

  /** Records what became of the update being handled. */
  private note(outcome: string, reason?: string): void {
    traces.annotate({ outcome, reason })
  }

  /** One update, start to end: its outcome is always logged, a failed delivery is retried and said so. */
  private async handle(u: Update, attempt: number): Promise<void> {
    const t0 = this.now()
    const chat = u.message?.chat.id ?? u.callback_query?.message?.chat.id
    if (chat !== undefined && String(chat) === this.chatId) this.inboundAt = t0
    const delays = this.opts.retryMs ?? RETRY_MS
    const limit = this.opts.handleMs ?? HANDLE_MS
    const rec = this.recs.get(u.update_id) ?? this.begin(u)
    rec.outcome = "handled"
    rec.reason = undefined
    if (attempt === 0) traces.step("queued", { ms: t0 - rec.startedAt }, rec)
    let retry = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        traces.run(rec, () => this.onUpdate(u)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timed out after " + limit / 1000 + "s")),
            limit,
          )
          timer.unref?.()
        }),
      ])
    } catch (err) {
      retry = err instanceof RetryLater
      rec.outcome = retry ? "failed" : "error"
      rec.reason = filterSecrets((err as Error).message)
    } finally {
      clearTimeout(timer)
    }
    traces.step(
      "handle",
      { ms: this.now() - t0, ok: !["error", "failed"].includes(rec.outcome) },
      rec,
    )
    const again = retry && attempt < delays.length && !this.signal?.aborted
    traces.line(rec, {
      attempt,
      retry_in_s: again ? delays[attempt] / 1000 : undefined,
    })
    if (rec.outcome === "error" && u.message && rec.kind !== "command")
      void this.react(u.message.message_id, "failed")
    if (rec.outcome === "error" && u.message)
      await traces
        .run(rec, () =>
          this.deliver(u.message!.message_thread_id, {
            ok: false,
            text: "⚠ Could not handle that message: " + rec.reason,
          }),
        )
        .catch(() => {})
    if (retry && u.message)
      await traces
        .run(rec, () =>
          this.deliver(u.message!.message_thread_id, {
            ok: false,
            text: again
              ? `⚠ Not delivered (${rec.reason}). Trying again in ${delays[attempt] / 1000}s.`
              : `⚠ Not delivered after ${attempt + 1} tries (${rec.reason}). Send it again when the session is back.`,
          }),
        )
        .catch(() => {})
    // Stopping: what is not done stays in the journal for the next start.
    if (retry && !again && this.signal?.aborted) return
    if (again) {
      traces.bump("inbound", "retried")
      traces.step("retry", { ms: delays[attempt] }, rec)
      const wait = setTimeout(
        () => this.dispatch(u, attempt + 1),
        delays[attempt],
      )
      wait.unref?.()
      return
    }
    await this.inbox.done(u.update_id)
    this.recs.delete(u.update_id)
    traces.setQueue(this.inbox.size)
    traces.finish(rec, { cls: classOf(rec.outcome), line: false })
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
    if (!m) return this.note("ignored", "not a message")
    const media = mediaOf(m)
    if (media) return this.onMedia(u, m, media)
    const text = m.text?.trim()
    if (!text) return this.note("ignored", "no text")
    if (await this.tryPair(m.chat, text, m.from?.id)) return this.note("paired")
    if (String(m.chat.id) !== this.chatId) {
      this.rejected("message")
      this.note("rejected", "chat is not the paired one")
      return log("telegram_ignored", { kind: "message" })
    }
    // A code typed for an approval is the operator's alone and never reaches a session.
    if (this.approvals && m.from && /^\d{6}$/.test(text)) {
      const r = await this.approvals.typed({
        channel: this.id,
        userId: String(m.from.id),
        text,
        messageRef: String(m.message_id),
        replyTo: m.reply_to_message
          ? String(m.reply_to_message.message_id)
          : undefined,
      })
      if (r === "consumed") return this.note("approval")
    }
    const base = {
      kind: "answer",
      id: String(u.update_id),
      time: m.date,
      from: { connector: this.id, chat: String(m.chat.id) },
    } as const
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
    if (cmd) {
      this.note("command", cmd[1])
      return this.command(m, base, cmd[1], cmd[2], cmd[3] ?? "")
    }
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
    const routed0 = this.now()
    const sessionKey = await this.sessionAt(m.message_thread_id, to)
    traces.step("route", { ms: this.now() - routed0, ok: !!sessionKey })
    // A reply is an answer if it replies to a question; the core decides, and
    // takes anything else as text for the session.
    const inbound: Inbound | undefined = to
      ? { ...base, replyTo: to, sessionKey, text }
      : sessionKey
        ? { ...base, kind: "prompt", sessionKey, text }
        : undefined
    if (!inbound) return this.unbound(m)
    if (inbound.kind === "prompt") void this.react(m.message_id, "received")
    const sent0 = this.now()
    const out = await this.onInbound?.(inbound)
    // A reply to a message nobody tracks, in a topic that names no session.
    if (!sessionKey && !out && (await this.isShared(m.message_thread_id)))
      return this.unbound(m)
    traces.step("deliver", { ms: this.now() - sent0, ok: out?.ok !== false })
    await this.settle(m, out, sessionKey)
  }

  /** A message in a topic no session owns (such as General): 🙈 and one line saying where to write. */
  private async unbound(m: Message): Promise<void> {
    void this.react(m.message_id, "ignored")
    this.note("ignored", "no session is bound to this topic")
    await this.deliver(m.message_thread_id, {
      ok: false,
      text: (await this.isShared(m.message_thread_id))
        ? SHARED_HINT
        : "No session here; write in a session topic",
    })
  }

  /** What the core said of a message for a session: acknowledged, refused, or tried again later. */
  private async settle(
    m: Message,
    out: Outcome | undefined,
    session?: string,
  ): Promise<void> {
    if (out?.sent) {
      this.note("delivered", out.delivered?.how)
      traces.annotate({
        session,
        agent: out.delivered?.agent,
        state: out.delivered?.how,
      })
      if (session) traces.follow(session, traces.current())
      return this.acknowledge(m, out, session)
    }
    if (out?.retry) {
      this.note("failed", out.text)
      void this.react(m.message_id, "failed")
      throw new RetryLater(out.text)
    }
    if (out?.menu) {
      this.note("held", "waiting on a question")
      void this.react(m.message_id, "held")
      const menuRef = await this.deliver(m.message_thread_id, out)
      if (menuRef !== undefined) {
        this.bound(this.heldMenus)
        this.heldMenus.set(out.menu.id, {
          messageId: m.message_id,
          thread: m.message_thread_id,
          menuRef,
          session,
        })
      }
      return
    }
    if (out) {
      void this.react(m.message_id, "ignored")
      return this.note("refused", out.text)
    }
    this.note("ignored", "the core had nothing to do with it")
  }

  /**
   * A prompt reached its session: one reaction on the message, which agent
   * got it, or that it waited or was steered in. If the reaction cannot be set,
   * the old line says it instead, so the sender still learns where it went.
   */
  private async acknowledge(
    m: Message,
    out: Outcome,
    session?: string,
  ): Promise<void> {
    const set = await this.react(
      m.message_id,
      stageOf(out.delivered),
      out.delivered?.agent,
    )
    if (!set)
      return void (await this.deliver(m.message_thread_id, {
        ok: true,
        text: out.text,
      }))
    // The session's reply turns this into 👌.
    if (session) {
      const ids = this.awaiting.get(session) ?? []
      this.awaiting.delete(session)
      this.awaiting.set(session, [...ids, m.message_id].slice(-AWAITING_MAX))
      while (this.awaiting.size > AWAITING_MAX)
        this.awaiting.delete(this.awaiting.keys().next().value!)
    }
  }

  /** The reaction each message wears now, so one is not set twice. */
  private readonly reacted = new Map<number, string>()
  private reactChain: Promise<unknown> = Promise.resolve()
  private lastReactAt = 0
  /** Messages whose session has not replied yet, by session. */
  private readonly awaiting = new Map<string, number[]>()

  /**
   * Puts the stage's reaction on a message, spaced from the one before. Best
   * effort: a failure is logged and the answer is false, nothing is thrown.
   */
  private react(
    messageId: number,
    stage: Stage,
    agent?: string,
  ): Promise<boolean> {
    const emoji = stageEmoji(
      this.opts.reactions,
      stage,
      (bad) => this.warnReaction(bad),
      agent,
    )
    const run = this.reactChain.then(async () => {
      if (this.reacted.get(messageId) === emoji) return true
      const gap = this.opts.reactGapMs ?? REACT_GAP_MS
      const wait = gap - (this.now() - this.lastReactAt)
      if (wait > 0) await sleep(wait, this.signal)
      this.lastReactAt = this.now()
      try {
        await this.call(
          "setMessageReaction",
          {
            chat_id: this.chatId,
            message_id: messageId,
            reaction: [{ type: "emoji", emoji }],
          },
          10_000,
          undefined,
          undefined,
          false,
        )
        log("telegram_reaction", { message_id: messageId, stage, ok: true })
        this.reacted.delete(messageId)
        this.reacted.set(messageId, emoji)
        while (this.reacted.size > REACTED_MAX)
          this.reacted.delete(this.reacted.keys().next().value!)
        return true
      } catch (err) {
        log("telegram_reaction_failed", {
          message_id: messageId,
          stage,
          message: filterSecrets((err as Error).message),
        })
        return false
      }
    })
    this.reactChain = run
    return run
  }

  /** The session replied: every message of it that waits becomes 👌, or 💔 when the reply could not be sent. */
  private replied(session: string, stage: Stage = "done"): void {
    for (const id of this.awaiting.get(session) ?? [])
      void this.react(id, stage)
    this.awaiting.delete(session)
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
    if (!sessionKey) return this.unbound(m)
    const notice = async (text: string): Promise<void> => {
      await this.deliver(m.message_thread_id, { ok: false, text })
    }
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
    void this.react(m.message_id, "received")
    const out = await this.onInbound?.({
      kind: "prompt",
      id: String(u.update_id),
      time: m.date,
      from: { connector: this.id, chat: String(m.chat.id) },
      sessionKey,
      text: (m.caption ?? "").trim(),
      files: [file],
    })
    await this.settle(m, out, sessionKey)
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
    from?: number,
  ): Promise<boolean> {
    const pr = this.pairing
    const code = /^(?:\/start(?:@\w+)?\s+)?([A-Za-z0-9]{6})$/.exec(text)?.[1]
    if (!pr || code?.toUpperCase() !== pr.code) return false
    const id = String(chat.id)
    this.chatId = id
    this.forum = chat.is_forum === true ? true : undefined
    this.userId = from === undefined ? undefined : String(from)
    this.opts.onPaired?.(id, this.userId)
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

  /** Whether a Telegram user is the paired owner. Nobody is when the owner is not known. */
  private isOwner(from?: { id: number }): boolean {
    const op = this.operator()
    return op !== undefined && from !== undefined && String(from.id) === op
  }

  operator(): string | undefined {
    if (this.userId !== undefined) return this.userId
    // The id of a private chat is the id of its person.
    return this.chatId && Number(this.chatId) > 0 ? this.chatId : undefined
  }

  onApproval(h: ApprovalHandler): void {
    this.approvals = h
  }

  async approvalRequest(v: ApprovalView): Promise<string | undefined> {
    if (!this.chatId) return undefined
    const text = renderApproval(v, undefined, this.now())
    const send = async (
      chat: string,
      button: Button,
      thread?: number,
    ): Promise<string> => {
      const m = await this.call<{ message_id: number }>("sendMessage", {
        chat_id: chat,
        message_thread_id: thread,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [[button]] },
      })
      return `${chat}:${m.message_id}`
    }
    const paired = Number(this.chatId) > 0
    const op = this.operator()
    const dm = this.openButton("a_" + v.id, REVIEW, true)
    if (op && dm && (paired || this.now() - this.dmFailedAt >= DM_RETRY_MS)) {
      try {
        return await send(op, dm)
      } catch (err) {
        this.dmFailedAt = this.now()
        log("telegram_approval_dm_failed", {
          message: filterSecrets((err as Error).message),
        })
        if (paired) return undefined
      }
    }
    const group = this.openButton("a_" + v.id, REVIEW)
    const thread = group ? await this.approvalsTopic() : undefined
    if (!group || thread === undefined) return undefined
    try {
      return await send(this.chatId, group, thread)
    } catch (err) {
      this.fail(err)
      return undefined
    }
  }

  async approvalCode(v: ApprovalView): Promise<string | undefined> {
    if (!this.chatId) return undefined
    const open = v.factors?.some((f) => f !== "totp")
      ? this.openButton("a_" + v.id, "🔐 Verify")
      : undefined
    try {
      const m = await this.call<{ message_id: number }>("sendMessage", {
        chat_id: this.chatId,
        text: renderApprovalCode(v),
        parse_mode: "HTML",
        reply_markup: open
          ? { inline_keyboard: [[open]] }
          : { force_reply: true, input_field_placeholder: "123456" },
      })
      return String(m.message_id)
    } catch (err) {
      this.fail(err)
      return undefined
    }
  }

  async approvalSettle(
    ref: string,
    v: ApprovalView,
    s: Settled,
  ): Promise<void> {
    const [chat, id] = splitRef(ref, this.chatId)
    if (!chat) return
    try {
      await this.call("editMessageText", {
        chat_id: chat,
        message_id: id,
        text: renderApproval(v, s, this.now()),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [] },
      })
    } catch (err) {
      if (!/not modified|not found/i.test((err as Error).message))
        this.fail(err)
    }
  }

  async deleteMessage(ref: string): Promise<void> {
    const [chat, id] = splitRef(ref, this.chatId)
    if (!chat) return
    try {
      await this.call("deleteMessage", {
        chat_id: chat,
        message_id: id,
      })
    } catch (err) {
      log("telegram_delete_failed", { message: (err as Error).message })
    }
  }

  private async onCallback(
    cb: NonNullable<Update["callback_query"]>,
  ): Promise<void> {
    if (!cb.message || String(cb.message.chat.id) !== this.chatId) {
      this.note("rejected", "chat is not the paired one")
      this.rejected("callback")
      return log("telegram_ignored", { kind: "callback" })
    }
    if (cb.data?.startsWith("ap:")) return this.toast(cb.id, MOVED)
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
    if (cb.data === "ctl:interrupt") {
      if (!this.isOwner(cb.from)) {
        this.note("refused", "interrupt: not the owner")
        return this.toast(cb.id, OWNER_ONLY)
      }
      const sessionKey = await this.sessionAt(cb.message.message_thread_id)
      if (!sessionKey) return this.toast(cb.id, "Unknown session.")
      await this.toast(cb.id)
      const out = await this.onInbound?.({
        kind: "command",
        id: "cb" + cb.id,
        time: Math.floor(Date.now() / 1000),
        sessionKey,
        text: "/interrupt",
        command: { name: "interrupt", args: "" },
        from: { connector: this.id, chat: String(cb.message.chat.id) },
        inline: true,
      })
      if (out) await this.deliver(cb.message.message_thread_id, out)
      return
    }
    const ctl = CARD_TAP.exec(cb.data ?? "")
    if (ctl) {
      const sessionKey = await this.sessionAt(cb.message.message_thread_id)
      if (!sessionKey) return this.toast(cb.id, "Unknown session.")
      const inbound: Inbound = {
        kind: "control",
        id: "cb" + cb.id,
        time: Math.floor(Date.now() / 1000),
        sessionKey,
        text: ctl[1],
        from: { connector: this.id, chat: String(cb.message.chat.id) },
        inline: true,
      }
      if (!SENDS.test(cb.data ?? "")) return this.answer(cb.id, inbound)
      // Already answered on arrival; this answers a tap that was not.
      await this.toast(
        cb.id,
        tapPending(ctl[1], await this.topicName(cb.message.message_thread_id)),
      )
      return this.tapped(cb, ctl[1], await this.onInbound?.(inbound))
    }
    if (/^s:[A-Za-z0-9]+:/.test(cb.data ?? "")) {
      log("form_select", { outcome: "moved" })
      return this.toast(cb.id, MOVED)
    }
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
        userId: cb.from ? String(cb.from.id) : undefined,
        inline: true,
      })
    }
    const menu = /^m:([A-Za-z0-9]+):(p?\d+|n)$/.exec(cb.data ?? "")
    if (menu) return this.onMenu(cb, menu[1], menu[2])
    const m = /^([A-Za-z0-9]+):(\d+|t\d+|d|x)$/.exec(cb.data ?? "")
    if (!m) return this.toast(cb.id, "Unknown button.")
    const [, id, act] = m
    if (!/^\d+$/.test(act)) {
      log("form_select", { id, outcome: "moved" })
      return this.toast(cb.id, MOVED)
    }
    log("form_select", { id, act: "pick", outcome: "ok" })
    return this.answer(cb.id, {
      kind: "answer",
      id: `cb${cb.id}`,
      time: Math.floor(Date.now() / 1000),
      pendingId: id,
      choice: Number(act),
      text: act,
      from: { connector: this.id, chat: String(cb.message.chat.id) },
      inline: true,
    })
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
    if (name.toLowerCase() === "interrupt" && !this.isOwner(m.from)) {
      this.note("refused", "interrupt: not the owner")
      await this.deliver(m.message_thread_id, { ok: false, text: OWNER_ONLY })
      return
    }
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
    const home = this.homes.get(sessionID)
    const topic =
      this.topics?.get(this.topicKey(sessionID)) ??
      (home && this.topics?.get(this.topicKey(SHARED + home.key)))
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
      const busy = live.want.state === "working"
      await this.card(topic, text, !!live.want.chat, sessionID, busy)
      // A card gone from Telegram was made again, and pinned, by the call above.
      if (topic.card === undefined)
        await this.card(topic, text, !!live.want.chat, sessionID, busy)
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
  ): Promise<number | undefined> {
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
        this.menus.set(out.menu.id, {
          choices: out.menu.choices,
          page: 0,
          owner: out.menu.owner,
        })
        const sent = await this.call<{ message_id: number }>("sendMessage", {
          ...msg,
          reply_markup: this.menuKeyboard(out.menu.id, out.menu.choices, 0),
        })
        return sent.message_id
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
    return undefined
  }

  /** The message and menu of each held message, to settle them when the question is no longer open. */
  private readonly heldMenus = new Map<
    string,
    { messageId: number; thread?: number; menuRef: number; session?: string }
  >()

  async heldReleased(
    menuId: string,
    o: {
      how: "sent" | "queued" | "steered" | "failed"
      agent?: string
      text: string
    },
  ): Promise<void> {
    const h = this.heldMenus.get(menuId)
    if (!h || !this.chatId) return
    this.heldMenus.delete(menuId)
    this.menus.delete(menuId)
    try {
      await this.call("editMessageText", {
        chat_id: this.chatId,
        message_id: h.menuRef,
        text: this.rich(o.text),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [] },
      })
    } catch (err) {
      if (!/not modified|not found/i.test((err as Error).message))
        this.fail(err)
    }
    if (o.how === "failed")
      return void (await this.react(h.messageId, "failed"))
    await this.acknowledge(
      { message_id: h.messageId, message_thread_id: h.thread } as Message,
      {
        ok: true,
        sent: true,
        text: o.text,
        delivered: { how: o.how, agent: o.agent },
      },
      h.session,
    )
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
    if (menu.owner && !this.isOwner(cb.from)) {
      this.note("refused", "interrupt: not the owner")
      return this.toast(cb.id, OWNER_ONLY)
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

  /** Multipart upload: one or more files, with fields. */
  private async upload(
    method: string,
    fields: Record<string, string | number | undefined>,
    file: UploadFile | UploadFile[],
    timeoutMs = 30_000,
  ): Promise<void> {
    if (this.muteNow()) {
      this.out.suppressed++
      throw Object.assign(new Muted(), { counted: true })
    }
    const token = await this.opts.token()
    if (!token) throw new Error("no Telegram token")
    const form = new FormData()
    for (const [k, v] of Object.entries({
      ...fields,
      disable_notification: this.quiet?.() ? true : undefined,
    }))
      if (v !== undefined) form.append(k, String(v))
    for (const f of Array.isArray(file) ? file : [file])
      form.append(
        f.field,
        new Blob([f.data as never], { type: f.type ?? "text/markdown" }),
        f.name,
      )
    const base = this.opts.apiBase ?? "https://api.telegram.org"
    const res = await this.fetch(`${base}/bot${token}/${method}`, {
      method: "POST",
      body: form,
      keepalive: false,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const json = (await res.json().catch(() => undefined)) as
      | { ok?: boolean; description?: string }
      | undefined
    if (!json?.ok)
      throw Object.assign(
        new Error(
          `telegram ${method} failed: HTTP ${res.status} ${json?.description ?? ""}`.trim(),
        ),
        { status: res.status },
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
    step?: string,
  ): void {
    if (!this.chatId || !text.trim()) return
    let st = this.streams.get(session.id)
    // A later step: what was shown of the earlier one stays, and this text goes in new messages.
    if (st && step !== undefined && st.step !== undefined && st.step !== step)
      st = this.seal(st)
    if (!st) {
      st = {
        session,
        step,
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
    st.step ??= step
    st.gapMs = gapMs
    st.budget = budget
    this.pump(st)
  }

  /** Ends a stream without touching its messages, and starts the next one after it. */
  private seal(old: Stream): Stream {
    clearTimeout(old.timer)
    clearTimeout(old.refresh)
    old.timer = undefined
    const next: Stream = {
      session: old.session,
      text: "",
      shown: [],
      nextAt: 0,
      gapMs: old.gapMs,
      budget: old.budget,
      chain: old.chain
        .then(() => this.settleSealed(old))
        .catch((err) => this.fail(err)),
      running: false,
    }
    this.streams.set(old.session.id, next)
    return next
  }

  /** Shows the last text of a sealed stream, so what the person reads of that step is all of it. */
  private async settleSealed(old: Stream): Promise<void> {
    if (old.draftId !== undefined) {
      // A draft is a preview, not a message: its text is posted so that it stays.
      const thread = await this.thread(old.session)
      for (const html of this.shownText(old)) {
        if (!html.trim()) continue
        const m = await this.call<{ message_id: number }>("sendMessage", {
          chat_id: this.chatId,
          message_thread_id: thread,
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          disable_notification: true,
        })
        this.remember(m.message_id, old.session.id)
      }
      return
    }
    for (let i = 0; i < 3 && this.dirty(old); i++) {
      old.nextAt = 0
      await this.paint(old, true)
      const wait = old.nextAt - this.now()
      if (this.dirty(old) && wait > 0) await sleep(Math.min(wait, 5000))
    }
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
  private async paint(st: Stream, force = false): Promise<void> {
    if (!force && this.draftable() && (await this.paintDraft(st))) return
    const wait = force ? 0 : this.budgetWait(st)
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
   * blocks, the rest as a markdown document. A streamed message is edited
   * into place only when the final text extends what it showed. Text a person
   * has read is never rewritten or deleted: anything else goes in a new message.
   * A reply that could not be posted is tried once more after a while.
   */
  async reply(
    session: NonNullable<Push["session"]>,
    text: string,
    retry = true,
    kept?: Stream["shown"],
    waiting?: number[],
  ): Promise<{ parts: number; documents: number } | undefined> {
    if (!this.chatId) return undefined
    const st = this.streams.get(session.id)
    this.streams.delete(session.id)
    if (st) {
      clearTimeout(st.timer)
      clearTimeout(st.refresh)
      await st.chain.catch(() => {})
    }
    const shown = kept ?? st?.shown ?? []
    const ids = waiting ?? [...(this.awaiting.get(session.id) ?? [])]
    try {
      const thread = await this.thread(session)
      const { messages, rest } = splitReply(text, MAX_REPLY_MESSAGES)
      for (const [i, html] of messages.entries()) {
        const had = shown[i]
        if (had?.html === html) continue
        if (had && plain(html).startsWith(plain(had.html))) {
          try {
            await this.call("editMessageText", {
              chat_id: this.chatId,
              message_id: had.id,
              text: html,
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
            })
            had.html = html
            continue
          } catch (err) {
            if (/not modified/i.test((err as Error).message)) {
              had.html = html
              continue
            }
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
        shown[i] = { id: m.message_id, html }
        this.remember(m.message_id, session.id)
      }
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
      if (kept) for (const id of ids) void this.react(id, "done")
      else this.replied(session.id)
      return { parts: messages.length, documents: rest ? 1 : 0 }
    } catch (err) {
      this.fail(err)
      if (!kept) this.replied(session.id, "failed")
      if (retry) {
        const timer = setTimeout(() => {
          void this.reply(session, text, false, shown, ids)
        }, this.opts.finalRetryMs ?? FINAL_RETRY_MS)
        timer.unref?.()
      }
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
      const tag = this.tagOf(session.id)
      const m = await this.call<{ message_id: number }>("sendMessage", {
        chat_id: this.chatId,
        message_thread_id: thread,
        text: (tag ? tagHtml(tag) : "") + renderTurnCard(card),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        disable_notification: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Diff", callback_data: "ctl:diff" },
              ...(o.chat
                ? [
                    { text: "Continue", callback_data: "ctl:continue" },
                    { text: "QA", callback_data: "ctl:qa" },
                    { text: "Update", callback_data: "ctl:update" },
                  ]
                : []),
              { text: "Stop", callback_data: "ctl:stop" },
            ],
          ],
        },
      })
      this.remember(m.message_id, session.id)
      if (tag) this.tagged(String(m.message_id), tag)
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

  async photos(
    session: NonNullable<Push["session"]>,
    images: Uint8Array[],
    caption: string,
  ): Promise<boolean> {
    if (!this.chatId || images.length === 0) return false
    try {
      const thread = await this.thread(session)
      caption = tagCaption(this.tagOf(session.id), caption)
      const files = images.map((data, i) => ({
        field: `p${i}`,
        name: `diff-${i + 1}.png`,
        data,
        type: "image/png",
      }))
      const base = { chat_id: this.chatId, message_thread_id: thread }
      if (files.length === 1)
        await this.upload(
          "sendPhoto",
          { ...base, caption },
          { ...files[0], field: "photo" },
        )
      else
        await this.upload(
          "sendMediaGroup",
          {
            ...base,
            media: JSON.stringify(
              files.map((f, i) => ({
                type: "photo",
                media: `attach://${f.field}`,
                ...(i === 0 ? { caption } : {}),
              })),
            ),
          },
          files,
        )
      return true
    } catch (err) {
      this.fail(err)
      return false
    }
  }

  async file(
    session: NonNullable<Push["session"]>,
    f: FileJob,
    caption: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.chatId)
      return { ok: false, error: "Telegram is not paired to a chat" }
    try {
      this.topics ??= await this.loadTopics()
      const known = this.topics.get(this.topicKey(session.id))
      if (!known || known.thread === 1)
        return {
          ok: false,
          error:
            "this session has no Telegram topic: turn chat on for it first",
        }
      const method = f.kind === "photo" ? "sendPhoto" : "sendDocument"
      const data = await f.read()
      for (let attempt = 0; ; attempt++)
        try {
          await this.upload(
            method,
            {
              chat_id: this.chatId,
              message_thread_id: known.thread,
              caption: caption || undefined,
            },
            { field: f.kind, name: f.name, data, type: f.type },
            120_000,
          )
          return { ok: true }
        } catch (err) {
          const status = (err as { status?: number }).status
          if (attempt === 0 && status !== undefined && status >= 500) {
            log("telegram_call_retry", {
              method,
              message: (err as Error).message,
            })
            continue
          }
          throw err
        }
    } catch (err) {
      this.fail(err)
      return {
        ok: false,
        error: truncate(filterSecrets((err as Error).message), 200),
      }
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
      caption = tagCaption(this.tagOf(session.id), caption)
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

  private readonly answered = new Set<string>()

  private async toast(callbackID: string, text?: string): Promise<void> {
    if (this.answered.has(callbackID)) return
    this.answered.add(callbackID)
    while (this.answered.size > 200)
      this.answered.delete(this.answered.values().next().value!)
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
  /** The operator's Telegram user id, for when pairing stored none. */
  operator?: string
  /** Bot API base URL; the public API unless a local Bot API server is used. */
  apiBase: string
  statusCard: boolean
  rate: Rate
  topics: { headless: "project" | "session"; closeHeadless: boolean }
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

    let operator: string | undefined
    if (raw.operator !== undefined) {
      if (
        !(typeof raw.operator === "number" && Number.isInteger(raw.operator)) &&
        !(typeof raw.operator === "string" && /^\d+$/.test(raw.operator))
      )
        return { error: `${at}operator must be a numeric Telegram user id` }
      operator = String(raw.operator)
    }

    const apiBase = raw.apiBase ?? "https://api.telegram.org"
    if (typeof apiBase !== "string" || !URL_RE.test(apiBase))
      return { error: `${at}apiBase must be an http(s) URL` }

    const statusCard = raw.statusCard ?? true
    if (typeof statusCard !== "boolean")
      return { error: `${at}statusCard must be true or false` }

    const rate = { ...DEFAULT_RATE }
    if (raw.rate !== undefined) {
      if (!isObject(raw.rate)) return { error: `${at}rate must be an object` }
      for (const [k, lo, hi] of [
        ["gapMs", 0, 60_000],
        ["perMinute", 1, 600],
      ] as const) {
        const v = raw.rate[k]
        if (v === undefined) continue
        if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi)
          return {
            error: `${at}rate.${k} must be a whole number from ${lo} to ${hi}`,
          }
        rate[k] = v
      }
    }

    const topics: { headless: "project" | "session"; closeHeadless: boolean } =
      { headless: "project", closeHeadless: true }
    if (raw.topics !== undefined) {
      if (!isObject(raw.topics))
        return { error: `${at}topics must be an object` }
      const h = raw.topics.headless
      if (h !== undefined && h !== "project" && h !== "session")
        return { error: `${at}topics.headless must be "project" or "session"` }
      if (h) topics.headless = h
      const c = raw.topics.closeHeadless
      if (c !== undefined && typeof c !== "boolean")
        return { error: `${at}topics.closeHeadless must be true or false` }
      if (c !== undefined) topics.closeHeadless = c
    }

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
      operator,
      apiBase: apiBase.replace(/\/+$/, ""),
      statusCard,
      rate,
      topics,
      draft,
      notify,
      icons,
      reactions: reactions.reactions,
      media: media.media,
    }
  },

  create(env, o) {
    const stored = env.settings.get().chatId
    const operator = env.settings.get().userId
    return new TelegramConnector({
      name: env.name,
      token: lazyToken(o.token),
      tel: env.tel,
      // A chat paired in the TUI wins over the file.
      chatId: typeof stored === "string" ? stored : o.chatId,
      apiBase: o.apiBase,
      statusCard: o.statusCard,
      rate: o.rate,
      topics: o.topics,
      draft: o.draft,
      notify: o.notify,
      icons: o.icons,
      reactions: o.reactions,
      media: o.media,
      offsetFile: join(env.dir, `${env.name}-offset.json`),
      inboxFile: join(env.dir, `${env.name}-inbox.jsonl`),
      topicsFile: join(env.dir, `${env.name}-topics.json`),
      operator: typeof operator === "string" ? operator : undefined,
      operatorFallback: o.operator,
      onPaired: (chatId, userId) => env.settings.set({ chatId, userId }),
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
