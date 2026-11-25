/**
 * The bridge: OpenCode events in, pushes out to the enabled connectors, replies
 * back in from any of them. It reads connector capabilities, never their type.
 *
 * Questions (tier 1) can be answered from a channel. Permission prompts are
 * tier 3: push only. There is deliberately no code path that replies to one.
 */
import { basename } from "node:path"

import type {
  Card,
  CardQuestion,
  Connector,
  ConnectorStatus,
  Home,
  Inbound,
  InboundFile,
  Outcome,
  Pairing,
  Push,
  SendStats,
  SessionState,
  TurnCard,
} from "./connectors/types.ts"
import { buildMenu } from "./commandmenu.ts"
import { parseDuration, type NightSource } from "./overnight.ts"
import { DigestLog, digestText } from "./digest.ts"
import { digestDue, isQuiet } from "./quiet.ts"
import type { AgentOption } from "./agents.ts"
import { Actions, Refused, type Result } from "./core/actions.ts"
import type { Config, Delivery, SidebarMode } from "./config.ts"
import { buildPatch, drawDiff, fileList } from "./diffimage.ts"
import { filterSecrets, redact } from "./filter.ts"
import { breakdown, permissionDigest } from "./permdigest.ts"
import {
  checkAnswers,
  resolveAnswer,
  type Answer,
  type Question,
  type Reply,
} from "./inbound.ts"
import { Commands } from "./commands.ts"
import { log } from "./logger.ts"
import { format, isCustomized, type Kind, type Vars } from "./messages.ts"
import { noTelemetry, type Telemetry } from "./otel.ts"
import type { Pending, PendingStore } from "./pending.ts"
import { globToRegExp, type Router, type SessionFacts } from "./routing.ts"
import {
  delta,
  lastParagraph,
  MAX_SUMMARY,
  plain,
  shouldCard,
  stats,
  type Stats,
} from "./turncard.ts"
import { CAPTION_MAX, prepareFile, type FileOutcome } from "./sendfile.ts"
import { traces } from "./trace.ts"
import { clock, formatDuration, sleep, truncate } from "./util.ts"
import type { Gate } from "./approvals/service.ts"

export type SessionInfo = {
  id: string
  parentID?: string
  agent?: string
  directory?: string
  title?: string
  /** A viewer (a TUI) has marked an idle transition viewed: false is a headless session. Unset when the host does not say. */
  viewed?: boolean
  model?: string
  modelRef?: { providerID: string; id: string; variant?: string }
}

/** A model a chat may pick. */
export type ModelOption = {
  /** `provider/model`. */
  ref: string
  name: string
  variants: string[]
}

/** What the bridge needs from OpenCode. */
export interface Host {
  session(id: string): Promise<SessionInfo | undefined>
  root(id: string): string
  replyForm(sessionID: string, formID: string, answer: Answer): Promise<void>
  /**
   * Sends a user prompt into a session; never refused for being busy. `queue`
   * waits behind a running turn. `steer` is injected into the running turn:
   * the types describe a steered prompt as part of the turn it joined.
   */
  prompt(
    sessionID: string,
    text: string,
    delivery: Delivery,
    files?: InboundFile[],
  ): Promise<void>
  /** Whether a turn is running in the session. */
  busy(sessionID: string): boolean
  /** What is known of a session right now, without asking: for views that must not wait. */
  peek?(
    sessionID: string,
  ): { agent?: string; directory?: string; title?: string } | undefined
  /** Starts a session in a folder; the caller has checked the folder against the allowlist. */
  createSession(o: {
    directory: string
    agent?: string
    model?: { providerID: string; id: string }
  }): Promise<{ id: string }>
  /** Changes what the session's next prompts use. */
  switchModel(
    sessionID: string,
    model: { providerID: string; id: string; variant?: string },
  ): Promise<void>
  switchAgent(sessionID: string, agent: string): Promise<void>
  /** Whether a turn was running and has been stopped. */
  interrupt(sessionID: string): Promise<boolean>
  compact(sessionID: string): Promise<void>
  rename(sessionID: string, title: string): Promise<void>
  /** Stages a revert of the session's last turn through a TUI. False when there is nothing to revert. */
  undo?(sessionID: string): Promise<boolean>
  /** Whether a form reply can be delivered now (the service answers, or a TUI is attached). Unset: assume it can. */
  canReplyForm?(): boolean | Promise<boolean>
  /**
   * What OpenCode says of a form or permission request the bridge is waiting on: still `open`,
   * `answered` or `cancelled` when it says so, or `gone` when it no longer holds a form and
   * does not say why. Undefined when it cannot say. Absent when the host cannot.
   */
  requestState?(
    kind: "question" | "permission",
    sessionID: string,
    requestID: string,
  ): Promise<"open" | "answered" | "cancelled" | "gone" | undefined>
  /**
   * The ids of the forms or permission requests OpenCode holds open for a session: the list is the
   * proof that something is still asked. Undefined when it cannot say. Absent when the host cannot.
   */
  openRequests?(
    kind: "question" | "permission",
    sessionID: string,
  ): Promise<Set<string> | undefined>
  /** Answers a permission request. Absent when the host cannot. */
  replyPermission?(
    sessionID: string,
    requestID: string,
    decision: "once" | "always" | "reject",
  ): Promise<void>
  /** Wakes a session that holds messages it is not working on. Absent when the host cannot. */
  resume?(sessionID: string): Promise<void>
  /** A message the session reads as an instruction; it wakes the session when `resume` is true. */
  synthetic?(sessionID: string, text: string, resume: boolean): Promise<void>
  /** The tail of a session's conversation, oldest first. Absent when the host cannot read it. */
  messages?(
    sessionID: string,
    limit: number,
  ): Promise<Array<{ role: string; text: string; at: number }>>
  /** The working-tree changes of a folder. Absent when the host cannot read them. */
  diff?(directory: string): Promise<
    Array<{
      file: string
      status: string
      additions: number
      deletions: number
      patch: string
    }>
  >
  /** Primary agents the session can switch to: the id OpenCode takes, and the name to show. */
  agents(): Promise<AgentOption[]>
  /** Chat models of the configured providers. */
  models(): Promise<ModelOption[]>
}

type FormOption =
  | string
  | {
      value?: unknown
      label?: unknown
      title?: unknown
      name?: unknown
      description?: unknown
      detail?: unknown
    }

/** OpenCode 2.3 sends options as { value, label, description }; older or other shapes are read too. */
type FormField = {
  key?: string
  type?: string
  title?: string
  description?: string
  options?: FormOption[]
  choices?: FormOption[]
  enum?: FormOption[]
  multiple?: boolean
  custom?: boolean
}

/** The OpenCode 2 events the bridge reads; payloads per @opencode/client generated types. */
export type BridgeEvent =
  | {
      type: "form.created"
      data: {
        form: {
          id: string
          sessionID: string
          title?: string
          metadata?: { kind?: unknown }
          fields?: FormField[]
        }
      }
    }
  | {
      type: "form.replied" | "form.cancelled"
      data: {
        id: string
        sessionID: string
        /** The values given, on a reply. */
        answer?: Record<string, unknown>
      }
    }
  | {
      type: "permission.asked"
      data: {
        id: string
        sessionID: string
        action: string
        resources?: string[]
        message?: string
      }
    }
  | {
      type: "permission.replied"
      data: {
        requestID: string
        sessionID: string
        reply?: "once" | "always" | "reject"
      }
    }
  | {
      type: "session.inbox.enqueued"
      data: {
        sessionID: string
        inboxID?: string
        item?: { type?: string; payload?: { text?: string } }
      }
    }
  | {
      type:
        | "session.execution.started"
        | "session.execution.succeeded"
        | "session.execution.failed"
        | "session.execution.interrupted"
      data: { sessionID: string }
    }
  | { type: "session.renamed"; data: { sessionID: string; title: string } }
  | {
      type: "session.text.delta"
      data: {
        sessionID: string
        assistantMessageID: string
        ordinal: number
        delta: string
      }
    }
  | {
      type: "session.text.ended"
      data: {
        sessionID: string
        assistantMessageID: string
        ordinal: number
        text: string
      }
    }
  | {
      type: "session.model.selected"
      data: { sessionID: string; model: { id: string; variant?: string } }
    }
  | {
      type: "session.agent.selected"
      data: { sessionID: string; agent: string }
    }

const DETAIL_MAX = 60
const THREAD_MAX = 40
const EXPIRY_MS = 24 * 60 * 60 * 1000

const str = (v: unknown) => (typeof v === "string" ? v : undefined)

function option(o: FormOption): { label: string; detail?: string } {
  if (typeof o === "string") return { label: o }
  return {
    label: str(o.label) ?? str(o.title) ?? str(o.name) ?? String(o.value ?? ""),
    detail: str(o.description) ?? str(o.detail),
  }
}

let shapeLogged = false

export function toQuestions(fields: FormField[] = []): Question[] {
  if (!shapeLogged && fields.length) {
    shapeLogged = true
    const first = fields.map((f) => f.options ?? f.choices ?? f.enum)[0]?.[0]
    log("form_shape", {
      fields: fields.map((f) => Object.keys(f ?? {})),
      option:
        first && typeof first === "object" ? Object.keys(first) : typeof first,
    })
  }
  return fields
    .filter((f) => {
      const list = f.options ?? f.choices ?? f.enum
      return (
        f.key &&
        (f.type === "string" ||
          f.type === "multiselect" ||
          (Array.isArray(list) && list.length > 0))
      )
    })
    .map((f) => {
      const opts = (f.options ?? f.choices ?? f.enum ?? []).map(option)
      return {
        key: f.key!,
        header: f.title ?? "",
        text: f.description ?? f.title ?? "",
        options: opts.map((o) => o.label),
        details: opts.map((o) => o.detail ?? ""),
        multiple: f.type === "multiselect" || f.multiple === true,
        custom: f.custom !== false,
      }
    })
}

export function questionBody(qs: Question[]): string {
  const block = (q: Question) => {
    const lines = [q.text]
    q.options.forEach((o, i) => {
      const d = q.details?.[i]
      lines.push(`${i + 1}. ${o}${d ? ` — ${truncate(d, DETAIL_MAX)}` : ""}`)
    })
    return lines.join("\n")
  }
  if (qs.length === 1) return block(qs[0])
  return qs.map((q, i) => `${i + 1}) ${q.header}\n${block(q)}`).join("\n\n")
}

/** A title already in brackets is left as it is. */
const bracketed = (t: string) => (t.startsWith("[") ? t : `[${t}]`)

const no = (text: string): Outcome => ({ ok: false, text })
const yes = (text: string): Outcome => ({ ok: true, text })

export type BridgeStatus = {
  channels: Array<{ id: string; enabled: boolean } & ConnectorStatus>
  /** Events not sent while the person was present, and the digests sent when they went away. */
  quiet: { held: number; digests: number }
  pending: number
  /** Permissions waiting at the Mac, one line per session. */
  waiting?: string[]
}

type Patch = {
  title?: string
  model?: string
  /** "" when the variant was cleared. */
  variant?: string
  agent?: string
}

type Routed = NonNullable<Awaited<ReturnType<Bridge["routed"]>>>

/** What a session did while the person was present: sent as one digest when they go away. */
type Unsent = {
  name: string
  finished: number
  failed: number
  asks: Map<string, { kind: "question" | "permission"; sessionID: string }>
}
type UnsentKind = "finished" | "failed" | "question" | "permission"
const PRESENCE_TICK_MS = 2000
const SLEEP_GAP_MS = 30_000
const MAX_UNSENT = 200

/** How long the buttons of a turn card stay. */
export const CARD_BUTTONS_MS = 60 * 60_000
const NO_WINDOW =
  "Answer this at the Mac: no OpenCode window is open to take a reply."
const DIGEST_TICK_MS = 30_000
const HINT_EVERY_MS = 60 * 60_000
const FEED_MS = 100
/** How often prompts the bridge waits on are checked against OpenCode. */
export const RECONCILE_MS = 60_000
/** A prompt this young is not checked: OpenCode may not list it yet. */
const RECONCILE_GRACE_MS = 10_000
/** A session that fails this soon after it was created never started. */
const UNSTARTED_MS = 60_000
const PERMISSION_LABEL = {
  once: "Allow once",
  always: "Always",
  reject: "Deny",
} as const
const SENT_TTL_MS = 2 * 60_000
const MAX_MAC_PROMPT = 500
/** The shortest time between two edits of a permission digest. */
export const PERM_DIGEST_GAP_MS = 10_000

export class Bridge {
  private readonly controllers = new Map<string, AbortController>()

  private readonly cfg: Config
  private readonly host: Host
  private readonly channels: Connector[]
  private readonly store: PendingStore
  private readonly router: Router
  private readonly now: () => number
  private readonly tel: Telemetry
  /** The last state shown per top-level session, and when its run started. */
  /** Top-level sessions that may be chatted with from a connector. */
  private readonly chat = new Set<string>()
  /** When a session last got the "chat is off" hint. */
  private readonly hinted = new Map<string, number>()
  /** The assistant text of the turn in progress, by top-level session. */
  /** The working tree when each running turn began. */
  private readonly digestLog: DigestLog
  private digestTimer: ReturnType<typeof setInterval> | undefined
  private readonly unsent = new Map<string, Unsent>()
  private readonly quiet = { held: 0, digests: 0 }
  private wasAway: boolean | undefined
  private wasWhy: string | undefined
  private afkListener: ((mode: "on" | "off", until: number) => void) | undefined
  private tickedAt = 0
  private presenceTimer: ReturnType<typeof setInterval> | undefined
  /** Shortest time between two edits of a permission digest; tests shorten it. */
  digestGapMs = PERM_DIGEST_GAP_MS
  private reconcileTimer: ReturnType<typeof setInterval> | undefined
  private reconcileChain: Promise<unknown> = Promise.resolve()
  /** When OpenCode last confirmed each pending prompt open. */
  private readonly confirmedOpen = new Map<string, number>()
  private readonly permDigests = new Map<
    string,
    {
      refs: Record<string, string>
      at: number
      timer?: ReturnType<typeof setTimeout>
      busy?: boolean
      again?: boolean
    }
  >()
  private readonly before = new Map<string, Promise<Stats | undefined>>()
  /** The latest turn card of a session on a connector, until its buttons are removed. */
  private readonly cards = new Map<
    string,
    { ch: Connector; ref: string; timer: ReturnType<typeof setTimeout> }
  >()
  private cardTtlMs = CARD_BUTTONS_MS
  private readonly turns = new Map<
    string,
    { msg?: string; parts: Map<number, string> }
  >()
  /** Prompts this bridge sent into a session, so that their inbox events are not taken for typing at the Mac. */
  private readonly sentPrompts = new Map<
    string,
    Array<{ text: string; at: number }>
  >()
  /** Inbox ids already handled, so a repeated event is not posted twice. */
  private readonly seenInbox = new Set<string>()
  /** Where the latest prompt of a session came from. */
  private readonly origins = new Map<string, "mac" | "telegram">()
  /** Sessions whose running turn began with a prompt from a connector. */
  private readonly remote = new Set<string>()
  /** The level a phone answer to a permission needs, once approvals are on. */
  private permissionGate:
    | ((o: {
        action: string | undefined
        decision: "once" | "always" | "reject"
        channel?: Connector
        userId?: string
      }) => Gate)
    | undefined
  /** Where a running turn is shown, and the pending stream update. */
  private readonly feeds = new Map<
    string,
    {
      r?: Routed
      timer?: ReturnType<typeof setTimeout>
      streamed?: boolean
      began?: boolean
    }
  >()
  /** Per session: how prompts are delivered, when it differs from `chat.delivery`. */
  private readonly deliveries = new Map<string, Delivery>()
  /** Messages for a busy session, kept here until it is free or `chat.queueSteerSeconds` pass: by session. */
  private readonly held = new Map<
    string,
    {
      ch: Connector
      at: number
      timer: ReturnType<typeof setTimeout>
      items: Array<{ text: string; files?: InboundFile[] }>
    }
  >()
  private chatListener: ((root: string) => void) | undefined
  private readonly listeners = new Set<() => void>()
  /** What a chat command chose, until OpenCode's own copy of the session catches up. */
  private readonly chosen = new Map<
    string,
    { model?: string; variant?: string; agent?: string }
  >()
  private readonly commands: Commands
  /** Every client acts on a session through this. */
  readonly actions: Actions
  private watchListener: ((root: string) => void) | undefined
  private waitingSource: ((id: string) => number) | undefined
  private versionSource: (() => Promise<string>) | undefined
  private night: NightSource | undefined
  private readonly tally = { pushes: 0, answered: 0, finished: 0, failed: 0 }
  private resumeListener: ((root: string, outcome: string) => void) | undefined
  /** The alert sent for each stuck session, and whether its button was used. */
  private readonly alerts = new Map<
    string,
    { refs: Record<string, string>; used: boolean }
  >()
  /** How long a Resume is watched, and how often; tests shorten both. */
  private resumeWatchMs = 30_000
  private resumePollMs = 500
  private readonly watchers = new Set<AbortController>()
  private stuckSource:
    | (() => Array<{ id: string; label: string; pending: number }>)
    | undefined
  /** What each connector was last told of a session, to show a change of watch state. */
  private readonly lastStates = new Map<string, SessionState>()
  /** When each session this process created was created, and which of them failed at once. */
  private readonly createdAt = new Map<string, number>()
  private readonly unstarted = new Set<string>()
  private readonly states = new Map<
    string,
    { state: SessionState["state"]; at: number; started?: number }
  >()

  constructor(
    cfg: Config,
    host: Host,
    channels: Connector[],
    store: PendingStore,
    router: Router,
    now: () => number = Date.now,
    tel: Telemetry = noTelemetry(),
    digest: DigestLog = new DigestLog(),
  ) {
    this.digestLog = digest
    this.tel = tel
    this.cfg = cfg
    this.host = host
    this.channels = channels
    this.store = store
    this.router = router
    this.now = now
    store.onChange = () => this.notify()
    const prompt = host.prompt
    const synthetic = host.synthetic
    const sent = (sessionID: string, text: string) => {
      const list = (this.sentPrompts.get(sessionID) ?? []).filter(
        (s) => now() - s.at < SENT_TTL_MS,
      )
      this.sentPrompts.set(sessionID, [...list, { text, at: now() }])
    }
    this.actions = new Actions({
      cfg,
      host: {
        ...host,
        prompt: (sessionID, text, delivery, files) => {
          sent(sessionID, text)
          return prompt.call(host, sessionID, text, delivery, files)
        },
        ...(synthetic
          ? {
              synthetic: (sessionID: string, text: string, resume: boolean) => {
                sent(sessionID, text)
                return synthetic.call(host, sessionID, text, resume)
              },
            }
          : {}),
      },
      now,
      denial: (facts) => this.denial(facts),
      chatOn: (root) => this.chat.has(root),
      created: (root) => void this.createdAt.set(root, this.now()),
      setChat: (root, on) => this.setChat(root, on),
      setWatch: async (root, mode, channel) => {
        this.setWatch(root, mode, channel)
        return { ok: true, text: "watch: " + mode }
      },
      resume: (root) => this.resume(root),
      answer: (id, a) => this.answerFromClient(id, a),
      permissions: () => this.permissionChoices().length > 0,
      permission: (id, decision) =>
        this.answerPermissionFromClient(id, decision),
    })
    this.commands = new Commands({
      cfg,
      host,
      actions: this.actions,
      tel: this.tel,
      now,
      chatEnabled: (root) => this.chat.has(root),
      denied: (facts) => this.denied(facts),
      setChat: (root, on) => this.setChat(root, on),
      startChat: (root, ch) => this.startChat(root, ch),
      show: (root, working) =>
        this.onState(root, working ? "working" : undefined),
      sessions: () => this.activeSessions(),
      afk: () => this.afkStatus(),
      autoAll: () => this.setAllWatch("auto"),
      setAfk: (mode, span) => this.setAfkFromChat(mode, span),
      chosenCount: () => this.router.chosen().length,
      version: async () => (await this.versionSource?.()) ?? "Version: unknown",
      trace: (n) => traces.format(n),
      digest: () => this.digestNow(),
      stuck: () => this.stuckSource?.() ?? [],
      resume: (root) => this.resume(root),
      night: () => this.night?.status() ?? "Overnight: not planned",
      endNight: async () =>
        (await this.night?.end("chat"))
          ? yes("The overnight plan is ended: nothing acts automatically now.")
          : no("There is no overnight plan running."),
      remote: (root) => void this.remote.add(root),
      repost: (root) => this.repostQuestion(root),
      open: async (root) => {
        await this.reconcile(root, 0)
        return this.openPromptList(root).some((p) => p.kind === "question")
      },
    })
  }

  /** Mirrored sessions the plugin knows of: chat-enabled, or routed and seen working. */
  private async activeSessions(): Promise<
    Array<{ id: string; label: string }>
  > {
    const ids = new Set([
      ...this.chat,
      ...[...this.states.keys()].filter((id) => this.router.mode(id) === "on"),
    ])
    const out: Array<{ id: string; label: string }> = []
    for (const id of ids) {
      const s = await this.host.session(id)
      if (!s) continue
      const where = s.directory ? basename(s.directory) : "opencode"
      const title = this.cfg.redact.mode === "title" ? undefined : s.title
      out.push({
        id,
        label: truncate(
          redact(
            [where, title ?? s.agent].filter(Boolean).join(" · "),
            this.cfg.redact,
          ),
          80,
        ),
      })
    }
    return out
  }

  /** A session started from a chat: mirrored to that channel, with chat on. */
  private startChat(root: string, ch: Connector) {
    this.router.set(root, undefined, ch.id)
    this.chat.add(root)
    this.changed(root)
  }

  /** Every connector, enabled or not. */
  connectors(): readonly Connector[] {
    return this.channels
  }

  /** Starts the reply subscription of every enabled channel; returns at once. */
  /** Sessions with messages they are not working on, for `/resume`. */
  onStuck(
    fn: () => Array<{ id: string; label: string; pending: number }>,
  ): void {
    this.stuckSource = fn
  }

  /** What the bridge has done so far, to tell what happened while the operator was away. */
  counts(): {
    pushes: number
    answered: number
    finished: number
    failed: number
  } {
    return { ...this.tally }
  }

  /** Hands the bridge the overnight plan: it quiets pushes and adds the night to the digest. */
  setNight(src: NightSource): void {
    this.night = src
  }

  /** Told how each resume ended (working, drained or no_effect). */
  onResume(fn: (root: string, outcome: string) => void): void {
    this.resumeListener = fn
  }

  private nightActive(): boolean {
    return (this.night?.until() ?? 0) > this.now()
  }

  /** One message in the session's topic about the night: silent unless loud. */
  async nightNote(
    root: string,
    kind: string,
    text: string,
    loud: boolean,
  ): Promise<void> {
    const r = await this.routed(root)
    if (!r) return
    const f = this.fmt("notice", { text })
    await this.dispatch(
      "notice",
      r.to,
      (ch) => ({
        ...f,
        ...this.shape(ch, r.session),
        ...this.card(ch, "notice", r.facts, () => ({ kind: "notice", text })),
      }),
      { root, silent: !loud },
    )
    log("overnight_note", { session: root, kind, loud })
  }

  /** Sends the night report as a digest once a plan has ended. */
  async nightDigest(): Promise<void> {
    if (!this.night?.pending()) return
    const text = this.digestBody() || "Nothing to report."
    this.digestLog.append({ k: "digest", at: this.now() })
    await this.dispatch(
      "notice",
      this.active().filter((c) => c.capabilities.inboundPrompt),
      () => ({ title: "Digest", message: text, tags: ["calendar"] }),
      {},
    )
  }

  /** How many messages wait on a session, to tell a resume that took them from one that did nothing. */
  onWaiting(fn: (id: string) => number): void {
    this.waitingSource = fn
  }

  /**
   * How many questions and permission requests are open, as OpenCode confirmed it within the last two
   * checks (or as just asked), and how many it could not confirm. A host that cannot be asked
   * confirms nothing, so everything pending counts as open.
   */
  drain(): { questions: number; permissions: number; unverified: number } {
    const pending = this.store.list().filter((p) => p.state === "pending")
    const now = this.now()
    const sure = (p: Pending) =>
      !this.host.requestState ||
      now - p.askedAt < RECONCILE_GRACE_MS ||
      now - (this.confirmedOpen.get(p.id) ?? -Infinity) <= 2 * RECONCILE_MS
    const open = pending.filter(sure)
    return {
      questions: open.filter((p) => p.kind === "question").length,
      permissions: open.filter((p) => p.kind === "permission").length,
      unverified: pending.length - open.length,
    }
  }

  /** What `/version` answers in a chat. */
  onVersion(fn: () => Promise<string>): void {
    this.versionSource = fn
  }

  /** What `/afk status` answers in a chat: the state and why. */
  afkStatus(): string {
    return [
      `Routing: ${this.router.why()}`,
      this.night?.status() ?? "Overnight: not planned",
      "/afk [2h] makes you count as away, /back [2h] as here; both end by themselves.",
    ].join("\n")
  }

  /** Called after `/afk` or `/back` in a chat, to keep the mode across restarts. */
  onAfk(fn: (mode: "on" | "off", until: number) => void): void {
    this.afkListener = fn
  }

  /** `/afk` (away) or `/back` (here) from a chat, for `span` (8h, 90m) or the default time-box. */
  setAfkFromChat(mode: "on" | "off", span?: string): Outcome {
    const ms = span ? parseDuration(span) : this.router.overrideMs()
    if (!ms) return no("A time like 2h or 90m, or nothing for the default.")
    const until = this.now() + ms
    this.router.setAfk(mode, until)
    this.afkListener?.(mode, until)
    this.notify()
    void this.presenceTick()
    return yes(`Routing: ${this.router.why()}`)
  }

  start(): void {
    const list = buildMenu({
      undo: this.host.undo !== undefined,
      resume: this.host.resume !== undefined,
      digest: this.cfg.digest !== undefined,
      night: true,
    })
    const app = this.cfg.miniApp
    if (app?.url)
      for (const ch of this.channels)
        ch.launch?.({ url: app.url, link: app.link })
    for (const ch of this.channels) ch.menu?.(list)
    for (const ch of this.channels) ch.silence?.(() => this.quietNow())
    for (const ch of this.channels) ch.mute?.(() => !this.router.away())
    for (const ch of this.channels) ch.home?.((id) => this.homeOf(id))
    this.wasAway = this.router.away()
    this.wasWhy = this.router.state().reason
    this.tickedAt = this.now()
    if (!this.presenceTimer) {
      this.presenceTimer = setInterval(
        () => void this.presenceTick(),
        PRESENCE_TICK_MS,
      )
      this.presenceTimer.unref?.()
    }
    if (this.cfg.digest && !this.digestTimer) {
      this.digestTimer = setInterval(
        () => void this.digestTick(),
        DIGEST_TICK_MS,
      )
      this.digestTimer.unref?.()
    }
    for (const ch of this.channels) if (ch.enabled) this.run(ch)
    if (this.host.requestState && !this.reconcileTimer) {
      this.reconcileTimer = setInterval(
        () => void this.reconcile(),
        RECONCILE_MS,
      )
      this.reconcileTimer.unref?.()
      void this.reconcile()
    }
  }

  private run(ch: Connector): void {
    if (this.controllers.has(ch.id)) return
    const open = this.store.list().filter((p) => p.state === "pending")
    const ac = new AbortController()
    this.controllers.set(ch.id, ac)
    ch.start(
      (m) => this.onInbound(ch, m),
      ac.signal,
      open.length ? Math.min(...open.map((p) => p.askedAt)) : undefined,
    )
  }

  /** Turns a channel on or off now. False when there is no such channel. */
  setEnabled(id: string, on: boolean): boolean {
    const ch = this.channels.find((c) => c.id === id)
    if (!ch) return false
    ch.enabled = on
    if (on) this.run(ch)
    else {
      this.controllers.get(id)?.abort()
      this.controllers.delete(id)
    }
    return true
  }

  status(): BridgeStatus {
    return {
      channels: this.channels.map((c) => ({
        id: c.id,
        enabled: c.enabled,
        ...c.status(),
      })),
      quiet: { ...this.quiet },
      pending: this.store.list().filter((p) => p.state === "pending").length,
      waiting: this.waitingLines(),
    }
  }

  private waitingLines(): string[] {
    const roots = new Set(
      this.store
        .list()
        .filter((p) => p.kind === "permission" && p.state === "pending")
        .map((p) => p.rootSessionID),
    )
    return [...roots].map((root) => {
      const w = this.waitingPermissions(root)
      const name = this.lastStates.get(root)?.name ?? root
      return `${name}: ${w.length} permission${w.length === 1 ? "" : "s"} waiting (${breakdown(w)})`
    })
  }

  /** A notice to every enabled channel; which of them took it. */
  async test(): Promise<Array<{ id: string; ok: boolean }>> {
    const text = "Test push: this channel works."
    const f = this.fmt("notice", { text })
    const to = this.active()
    const { ok } = await this.dispatch(
      "notice",
      to,
      (ch) => ({
        ...f,
        explicit: true,
        ...this.card(ch, "notice", undefined, () => ({ kind: "notice", text })),
      }),
      {},
    )
    return to.map((c) => ({ id: c.id, ok: ok[c.id] === true }))
  }

  /** Starts pairing a connector; the span lasts until it is paired or the code expires. */
  async pair(c: Connector): Promise<Pairing | undefined> {
    if (!c.capabilities.pairing || !c.pair) return undefined
    const span = this.tel.begin("oob.pair", {
      attrs: { "connector.type": c.type },
    })
    try {
      const p = await c.pair()
      void p.done.then((ok) => span.end({ ok }, ok ? undefined : "expired"))
      return p
    } catch (err) {
      span.end({ ok: false }, (err as Error).name)
      log("pair_error", { channel: c.id, message: (err as Error).message })
      return undefined
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.presenceTimer)
    this.presenceTimer = undefined
    clearInterval(this.reconcileTimer)
    this.reconcileTimer = undefined
    for (const ac of this.controllers.values()) ac.abort()
    this.controllers.clear()
    // What waits here is handed to the session's own queue, never dropped.
    await Promise.allSettled(
      [...this.held.keys()].map((root) => this.release(root, "free")),
    )
    for (const f of this.feeds.values()) clearTimeout(f.timer)
    this.feeds.clear()
    for (const d of this.permDigests.values()) clearTimeout(d.timer)
    this.permDigests.clear()
    for (const c of this.cards.values()) clearTimeout(c.timer)
    this.cards.clear()
    for (const ac of this.watchers) ac.abort()
    this.watchers.clear()
    clearInterval(this.digestTimer)
    this.digestTimer = undefined
    await this.store.flush()
    await this.digestLog.flush()
  }

  async onEvent(e: BridgeEvent): Promise<void> {
    try {
      switch (e.type) {
        case "form.created":
          return await this.onForm(e.data.form)
        case "form.replied":
        case "form.cancelled":
          return await this.closed(
            e.data.id,
            e.type === "form.replied" ? "Answered in the TUI" : "Cancelled",
            e.type === "form.replied"
              ? Object.values(e.data.answer ?? {})
                  .flat()
                  .join(" | ")
              : undefined,
          )
        case "permission.asked":
          return await this.onPermission(e.data)
        case "permission.replied":
          return await this.closed(
            e.data.requestID,
            "Answered in the TUI",
            e.data.reply && PERMISSION_LABEL[e.data.reply],
          )
        case "session.inbox.enqueued":
          if (e.data.item?.type === "user") {
            this.router.touch()
            return await this.onUserPrompt(e.data)
          }
          return
        case "session.execution.started":
          this.turns.delete(e.data.sessionID)
          return await this.onState(e.data.sessionID, "working")
        case "session.execution.interrupted":
          void this.release(e.data.sessionID, "free")
          await this.endTurn(e.data.sessionID)
          return await this.onState(e.data.sessionID, "idle")
        case "session.text.delta":
          return await this.onText(e.data, e.data.delta)
        case "session.text.ended":
          return await this.onText(e.data, undefined, e.data.text)
        case "session.execution.succeeded":
        case "session.execution.failed":
          void this.release(e.data.sessionID, "free")
          return await this.onFinished(
            e.data.sessionID,
            e.type === "session.execution.failed",
          )
        case "session.renamed":
          return await this.onState(e.data.sessionID, undefined, {
            title: e.data.title,
          })
        case "session.model.selected":
          return await this.onState(e.data.sessionID, undefined, {
            model: e.data.model.id,
            variant: e.data.model.variant ?? "",
          })
        case "session.agent.selected":
          return await this.onState(e.data.sessionID, undefined, {
            agent: e.data.agent,
          })
      }
    } catch (err) {
      log("event_error", { type: e.type, message: (err as Error).message })
    }
  }

  private active(): Connector[] {
    return this.channels.filter((c) => c.enabled)
  }

  /** A channel never throws by contract; a bug in one must not stop the others. */
  private async safely<T>(
    ch: Connector,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await fn()
    } catch (err) {
      log("channel_error", { channel: ch.id, message: (err as Error).message })
      return undefined
    }
  }

  private holdUnsent(
    root: string,
    name: string,
    kind: UnsentKind,
    ask?: { requestID: string; sessionID: string },
  ): void {
    const u = this.unsent.get(root) ?? {
      name,
      finished: 0,
      failed: 0,
      asks: new Map(),
    }
    u.name = name
    if (kind === "finished" || kind === "failed") u[kind]++
    else if (ask) u.asks.set(ask.requestID, { kind, sessionID: ask.sessionID })
    this.unsent.delete(root)
    this.unsent.set(root, u)
    for (const old of this.unsent.keys()) {
      if (this.unsent.size <= MAX_UNSENT) break
      this.unsent.delete(old)
    }
    this.quiet.held++
  }

  /** Edge work when the person goes away (one digest) or comes back (drop what is queued). */
  async presenceTick(): Promise<void> {
    const now = this.now()
    // A gap far longer than the tick means the machine slept.
    if (this.tickedAt && now - this.tickedAt > SLEEP_GAP_MS)
      this.router.slept(this.tickedAt)
    this.tickedAt = now
    const st = this.router.state()
    const changed = st.away !== this.wasAway || st.reason !== this.wasWhy
    if (!changed) return
    const was = this.wasAway
    this.wasAway = st.away
    this.wasWhy = st.reason
    if (!st.away) {
      for (const ch of this.channels) ch.hush?.()
      return
    }
    // One line says why routing is on; never sent while present.
    await this.stateLine()
    if (was !== true) await this.awayDigest()
  }

  private async stateLine(): Promise<void> {
    const text = `📡 Routing on · ${this.router.why()}`
    const f = this.fmt("notice", { text })
    await this.dispatch(
      "notice",
      this.active().filter((c) => c.capabilities.inboundPrompt),
      (ch) => ({
        ...f,
        ...this.card(ch, "notice", undefined, () => ({ kind: "notice", text })),
      }),
      {},
    )
  }

  /** What was held while present, one message per topic (one in all for channels without topics). */
  private async awayDigest(): Promise<void> {
    const held = [...this.unsent]
    this.unsent.clear()
    const noTopics = new Map<string, Connector>()
    const lines: string[] = []
    for (const [root, u] of held) {
      const open = await this.stillOpen(u)
      const text = [
        u.finished && `✅ ${u.finished} finished`,
        u.failed && `❌ ${u.failed} failed`,
        open.question &&
          `❓ ${open.question} question${open.question === 1 ? "" : "s"} waiting`,
        open.permission &&
          `🔐 ${open.permission} approval${open.permission === 1 ? "" : "s"} waiting`,
      ]
        .filter(Boolean)
        .join(" · ")
      if (!text) continue
      const r = await this.routed(root)
      if (!r) continue
      const note = "While you were at the Mac: " + text
      const f = this.fmt("notice", { text: note })
      const threaded = r.to.filter((c) => c.capabilities.threads)
      for (const c of r.to) if (!c.capabilities.threads) noTopics.set(c.id, c)
      lines.push(`${u.name}: ${text}`)
      await this.dispatch(
        "notice",
        threaded,
        (ch) => ({
          ...f,
          ...this.shape(ch, r.session),
          ...this.card(ch, "notice", r.facts, () => ({
            kind: "notice",
            text: note,
          })),
        }),
        { root },
      )
      if (threaded.length > 0) this.quiet.digests++
    }
    if (noTopics.size === 0 || lines.length === 0) return
    const text = "While you were at the Mac:\n" + lines.join("\n")
    const f = this.fmt("notice", { text })
    await this.dispatch(
      "notice",
      [...noTopics.values()],
      (ch) => ({
        ...f,
        ...this.card(ch, "notice", undefined, () => ({ kind: "notice", text })),
      }),
      {},
    )
    this.quiet.digests++
  }

  /** The questions and approvals held for a session that OpenCode still lists as open. */
  private async stillOpen(u: Unsent) {
    const out = { question: 0, permission: 0 }
    const listed = new Map<string, Set<string> | undefined>()
    for (const [requestID, a] of u.asks) {
      const k = `${a.kind}\0${a.sessionID}`
      if (!listed.has(k))
        listed.set(
          k,
          await this.host
            .openRequests?.(a.kind, a.sessionID)
            .catch(() => undefined),
        )
      const ids = listed.get(k)
      if (ids && !ids.has(requestID)) continue
      out[a.kind]++
    }
    return out
  }

  /** Root facts when the session routes, else undefined. */
  private async routed(
    sessionID: string,
    held?: { kind: UnsentKind; requestID?: string },
  ) {
    const rootID = this.host.root(sessionID)
    const [root, asking] = await Promise.all([
      this.host.session(rootID),
      rootID === sessionID ? undefined : this.host.session(sessionID),
    ])
    const facts = {
      id: rootID,
      agent: root?.agent,
      directory: root?.directory,
      chat: this.chat.has(rootID),
    }
    const decision = await this.router.decide(facts)
    const to = decision.routes ? this.targets(rootID) : []
    this.tel
      .begin("oob.route", {
        session: rootID,
        attrs: {
          mode: decision.mode,
          reason: decision.reason,
          routes: decision.routes,
          channel: this.router.channel(rootID) ?? this.cfg.defaultChannel,
          targets: to.length,
        },
      })
      .end()
    const project = root?.directory ? basename(root.directory) : "opencode"
    if (!decision.routes) {
      if (held && decision.reason === "present")
        this.holdUnsent(
          rootID,
          this.cfg.redact.mode === "title"
            ? project
            : `${project} · ${redact(root?.title ?? rootID, this.cfg.redact)}`,
          held.kind,
          held.requestID === undefined
            ? undefined
            : { requestID: held.requestID, sessionID },
        )
      return undefined
    }
    const who = asking ?? root
    const vars: Vars = {
      project,
      agent: who?.agent ?? "agent",
      subagent: rootID === sessionID ? "" : (who?.agent ?? "agent"),
      session: redact(root?.title ?? rootID, this.cfg.redact),
      sessionID: rootID,
      directory: root?.directory ?? "",
    }
    const session = {
      id: rootID,
      project,
      agent: root?.agent,
      name:
        this.cfg.redact.mode === "title"
          ? project
          : `${project} · ${vars.session}`,
    }
    const title =
      this.cfg.redact.mode === "title"
        ? undefined
        : redact(root?.title ?? "", this.cfg.redact)
    return { rootID, root, facts, vars, session, to, project, title }
  }

  /**
   * Where a headless session posts instead of a topic of its own: a top-level
   * session no TUI has viewed and that has no chat. Nothing for any other.
   */
  private async homeOf(sessionID: string): Promise<Home | undefined> {
    const rootID = this.host.root(sessionID)
    if (this.chat.has(rootID)) return undefined
    const root = await this.host.session(rootID)
    if (!root || root.parentID || root.viewed !== false) return undefined
    const project = root.directory ? basename(root.directory) : "opencode"
    const title =
      this.cfg.redact.mode === "title"
        ? ""
        : redact(root.title ?? "", this.cfg.redact)
    return {
      key: project,
      name: `${project} · agents`,
      tag: title || rootID.slice(-6),
    }
  }

  /** Enabled channels a session's pushes go to: its own choice, else the default. */
  private targets(rootID: string): Connector[] {
    const pick = this.router.channel(rootID) ?? this.cfg.defaultChannel
    return this.active().filter((c) => pick === "all" || c.id === pick)
  }

  /** What a connector can use of the session and the question: the rest is dropped, so it degrades to plain text. */
  private shape(
    ch: Connector,
    session: NonNullable<Push["session"]>,
    prompt?: NonNullable<Push["prompt"]>,
  ): Pick<Push, "session" | "prompt"> {
    const cap = ch.capabilities
    const buttons =
      prompt &&
      cap.buttons &&
      prompt.questions.every((q) => !q.multiple || cap.multiselect)
    return {
      session: cap.threads ? session : undefined,
      prompt: buttons ? prompt : undefined,
    }
  }

  /**
   * Sends one push to the given connectors under an `oob.push` span, one child
   * span per connector. With `refs` it marks earlier messages instead: edited
   * where the connector can, a follow-up message where it cannot.
   */
  private async dispatch(
    kind: Kind,
    to: Connector[],
    build: (ch: Connector) => Push,
    o: {
      root?: string
      pending?: string
      refs?: Record<string, string>
      /** Overrides quiet hours: silent, or with sound. */
      silent?: boolean
      /** Where a follow-up goes when an edit fails. */
      session?: { id: string; name: string }
    },
  ): Promise<{ refs: Record<string, string>; ok: Record<string, boolean> }> {
    const span = this.tel.begin("oob.push", {
      session: o.root,
      attrs: { "push.kind": kind, "pending.id": o.pending },
    })
    const refs: Record<string, string> = {}
    const ok: Record<string, boolean> = {}
    await Promise.all(
      to.map(async (ch) => {
        const old = o.refs?.[ch.id]
        // Nothing reached that connector, so there is nothing to mark.
        if (o.refs && old === undefined) return
        const edit = old !== undefined && ch.capabilities.edit && ch.update
        const stats: SendStats = {}
        const attrs = { "connector.type": ch.type, "push.kind": kind }
        const child = this.tel.begin(edit ? "oob.update" : "oob.send", {
          session: o.root,
          parent: span.id,
          attrs: { ...attrs, "pending.id": o.pending },
        })
        const push = {
          ...build(ch),
          stats,
          ...(o.silent !== undefined
            ? { silent: o.silent }
            : this.silence(kind)),
        }
        let res = await traces.out(
          `push:${kind}`,
          { session: o.root },
          () =>
            this.safely(ch, async () =>
              edit ? ch.update!(old, push) : ch.send(push),
            ),
          (v) => (v === undefined || v === false ? "failed" : "sent"),
        )
        if (edit && res === false) {
          // The message could not be rewritten: say it in a new one.
          log("edit_failed", { channel: ch.id, pending: o.pending })
          res = await this.safely(ch, () =>
            ch.send({
              ...push,
              session: ch.capabilities.threads ? o.session : undefined,
            }),
          )
        }
        const sent = res !== undefined && res !== false
        if (sent) this.tally.pushes++
        ok[ch.id] = sent
        if (typeof res === "string") refs[ch.id] = res
        this.tel.count(sent ? "oob.pushes" : "oob.push.errors", attrs)
        child.end(
          { ok: sent, http_status: stats.httpStatus, retries: stats.retries },
          sent ? undefined : "send-failed",
        )
      }),
    )
    span.end({ targets: to.length })
    return { refs, ok }
  }

  /** Records where a prompt's messages went. */
  private remember(p: Pending, refs: Record<string, string>) {
    if (Object.keys(refs).length)
      this.store.update(p.id, {
        refs: { ...this.store.get(p.id)?.refs, ...refs },
      })
  }

  private pendingGauge() {
    this.tel.gauge(
      "oob.pending",
      {},
      this.store.list().filter((p) => p.state === "pending").length,
    )
  }

  /** Structured content for a connector that can render it itself, unless the user wrote that kind's text. */
  private card(
    ch: Connector,
    kind: Kind,
    facts: SessionFacts | undefined,
    build: () => Card,
  ): Pick<Push, "card"> {
    if (
      !ch.capabilities.rich ||
      isCustomized(kind, this.cfg.messages, this.cfg.profiles, facts)
    )
      return {}
    return { card: build() }
  }

  private cardQuestions(qs: Question[]): CardQuestion[] {
    const hidden = this.cfg.redact.mode === "title"
    const r = (t: string) => redact(t, this.cfg.redact)
    return qs.map((q) => ({
      header: q.header ? r(q.header) : undefined,
      text: r(q.text),
      options: hidden
        ? []
        : q.options.map((label, i) => ({
            label,
            detail: q.details?.[i]
              ? truncate(r(q.details[i]), DETAIL_MAX)
              : undefined,
          })),
      multiple: q.multiple,
      custom: q.custom,
    }))
  }

  private async onForm(
    form: Extract<BridgeEvent, { type: "form.created" }>["data"]["form"],
  ) {
    if (form.metadata?.kind !== "question") return
    const questions = toQuestions(form.fields)
    if (questions.length === 0) return
    const r = await this.routed(form.sessionID, {
      kind: "question",
      requestID: form.id,
    })
    if (!r) return
    const reachable = (await this.host.canReplyForm?.()) ?? true
    const id = this.store.newId()
    const qvars = (hint: string): Vars => ({
      ...r.vars,
      id,
      thread: r.title ? `${bracketed(truncate(r.title, THREAD_MAX))}\n` : "",
      body: redact(questionBody(questions), this.cfg.redact),
      hint,
    })
    const p = this.store.put({
      id,
      kind: "question",
      requestID: form.id,
      sessionID: form.sessionID,
      rootSessionID: r.rootID,
      title: this.fmt("question", qvars(""), r.facts).title,
      questions,
      askedAt: this.now(),
      state: "pending",
    })
    this.pendingGauge()
    await this.pushQuestion(p, r, qvars, reachable)
    // Answered in the TUI while the message was still being sent.
    const now = this.store.get(id)
    if (now && now.state !== "pending" && now.answeredBy === "tui")
      await this.markAnswered(now, {
        outcome: now.state === "cancelled" ? "cancelled" : "answered",
        via: "TUI",
      })
  }

  private async pushQuestion(
    p: Pending,
    r: NonNullable<Awaited<ReturnType<Bridge["routed"]>>>,
    qvars: (hint: string) => Vars,
    reachable: boolean,
  ) {
    const questions = p.questions ?? []
    const sent = await this.dispatch(
      "question",
      r.to,
      (ch) => ({
        ...this.fmt(
          "question",
          qvars(reachable ? ch.hint(p.id, questions) : NO_WINDOW),
          r.facts,
        ),
        ...this.shape(
          ch,
          r.session,
          reachable ? { id: p.id, questions } : undefined,
        ),
        ...this.card(ch, "question", r.facts, () => ({
          kind: "question",
          agent: r.vars.agent ?? "agent",
          project: r.project,
          session: r.title,
          questions: this.cardQuestions(questions),
          note: reachable ? undefined : NO_WINDOW,
        })),
      }),
      { root: r.rootID, pending: p.id },
    )
    this.remember(p, sent.refs)
  }

  /**
   * Checks the prompts this bridge waits on against OpenCode, for one session or all. One OpenCode no
   * longer holds (answered or cancelled while the bridge was away or not told) is closed here the way an
   * answer at the Mac is, and what waited behind a question is sent. Returns how many it closed.
   */
  reconcile(root?: string, graceMs = RECONCILE_GRACE_MS): Promise<number> {
    if (!this.host.requestState) return Promise.resolve(0)
    const run = async (): Promise<number> => {
      let closed = 0
      let checked = 0
      let open = 0
      let withdrawn = 0
      let unverified = 0
      const touched = new Set<string>()
      const listed = new Map<string, Set<string> | undefined>()
      const list = async (kind: Pending["kind"], sessionID: string) => {
        const k = kind + ":" + sessionID
        if (!listed.has(k))
          listed.set(
            k,
            await this.host
              .openRequests?.(kind, sessionID)
              .catch(() => undefined),
          )
        return listed.get(k)
      }
      try {
        for (const p of this.store.list()) {
          if (p.state !== "pending") continue
          if (root !== undefined && p.rootSessionID !== root) continue
          if (this.now() - p.askedAt < graceMs) continue
          checked++
          let s = await this.host.requestState!(
            p.kind,
            p.sessionID,
            p.requestID,
          ).catch(() => undefined)
          // What OpenCode lists as open is the proof: a request it does not list is not asked.
          const ids = await list(p.kind, p.sessionID)
          if (ids && !ids.has(p.requestID) && (s === undefined || s === "open"))
            s = "gone"
          if (s === undefined) {
            unverified++
            continue
          }
          if (s === "open") {
            open++
            this.confirmedOpen.set(p.id, this.now())
            continue
          }
          // An answer may have arrived while OpenCode was asked.
          const now = this.store.get(p.id)
          if (now?.state !== "pending") continue
          await this.settleStale(now, s === "gone" ? "withdrawn" : s)
          touched.add(now.rootSessionID)
          if (s === "gone") withdrawn++
          closed++
        }
        if (checked > 0)
          log("reconcile", { checked, open, closed, withdrawn, unverified })
        for (const r of touched)
          if (!this.openPromptList(r).some((p) => p.kind === "question"))
            await this.releaseHeld(r)
      } catch (err) {
        log("reconcile_error", { message: (err as Error).message })
      }
      return closed
    }
    const next = this.reconcileChain.then(run, run)
    this.reconcileChain = next.catch(() => undefined)
    return next
  }

  /**
   * Closes a prompt OpenCode no longer holds. One it says was answered or cancelled is closed as an
   * answer at the Mac; a form it dropped without saying is withdrawn.
   */
  private async settleStale(
    p: Pending,
    state: "answered" | "cancelled" | "withdrawn",
  ) {
    this.confirmedOpen.delete(p.id)
    this.store.update(p.id, {
      state,
      answeredBy: state === "withdrawn" ? undefined : "unknown (reconciled)",
      answeredAt: this.now(),
    })
    this.pendingGauge()
    log("prompt_reconciled", {
      id: p.id,
      kind: p.kind,
      session: p.rootSessionID,
      state,
    })
    await this.markAnswered(p, {
      outcome: state,
      via: "TUI",
      reconciled: true,
    })
  }

  /** Sends what waited behind a question that is no longer open, and says so on its messages. */
  private async releaseHeld(root: string): Promise<void> {
    for (const { id, held } of this.commands.takeHeld(root)) {
      const busy = this.host.busy(root)
      const delivery: Delivery =
        busy && this.delivery(root) === "steer" ? "steer" : "queue"
      let shown: Parameters<NonNullable<Connector["heldReleased"]>>[1]
      try {
        await this.actions.prompt(root, held.text, delivery, held.files)
        this.remote.add(root)
        shown = {
          how: !busy ? "sent" : delivery === "steer" ? "steered" : "queued",
          agent: (await this.host.session(root))?.agent,
          text: "✅ That question is no longer open: your message was sent.",
        }
      } catch (err) {
        log("held_send_error", {
          session: root,
          message: (err as Error).message,
        })
        shown = {
          how: "failed",
          text:
            "⚠ Could not send your waiting message: " +
            truncate((err as Error).message || "unknown error", 120),
        }
      }
      for (const ch of this.channels)
        if (ch.heldReleased)
          await this.safely(ch, () => ch.heldReleased!(id, shown))
    }
  }

  /** The oldest open question of a session, posted again with its buttons. */
  async repostQuestion(root: string): Promise<Outcome> {
    // Only a question OpenCode still holds is posted again.
    await this.reconcile(root, 0)
    const p = this.openPromptList(root).find((x) => x.kind === "question")
    if (!p)
      return no(
        "That question was answered meanwhile: send your message again.",
      )
    const r = await this.routed(root)
    if (!r) return no("This session is not routed to a channel.")
    const reachable = (await this.host.canReplyForm?.()) ?? true
    const questions = p.questions ?? []
    await this.pushQuestion(
      p,
      r,
      (hint) => ({
        ...r.vars,
        id: p.id,
        thread: r.title ? `${bracketed(truncate(r.title, THREAD_MAX))}\n` : "",
        body: redact(questionBody(questions), this.cfg.redact),
        hint,
      }),
      reachable,
    )
    return yes("Question posted again below. Your message was not sent.")
  }

  private async onPermission(
    d: Extract<BridgeEvent, { type: "permission.asked" }>["data"],
  ) {
    const r = await this.routed(d.sessionID, {
      kind: "permission",
      requestID: d.id,
    })
    if (!r) return
    const id = this.store.newId()
    const detail = [`${d.action}: ${(d.resources ?? []).join(", ")}`, d.message]
      .filter(Boolean)
      .join("\n")
    const f = this.fmt(
      "permission",
      {
        ...r.vars,
        id,
        action: d.action,
        resources: (d.resources ?? []).join(", "),
        detail: redact(detail, this.cfg.redact),
      },
      r.facts,
    )
    const p = this.store.put({
      id,
      kind: "permission",
      requestID: d.id,
      sessionID: d.sessionID,
      rootSessionID: r.rootID,
      title: f.title,
      action: d.action,
      agent: r.vars.agent,
      askedAt: this.now(),
      state: "pending",
    })
    this.pendingGauge()
    // A permission a chat can answer is always posted with its buttons; the rest follow `permissions.notify`.
    const mode = this.permissionChoices().length
      ? "all"
      : this.cfg.permissions.notify
    const to =
      mode === "all" ? r.to : r.to.filter((c) => !c.capabilities.inboundPrompt)
    const sent =
      to.length === 0
        ? { refs: {} }
        : await this.dispatch(
            "permission",
            to,
            (ch) => ({
              ...f,
              ...this.shape(ch, r.session),
              permission:
                ch.capabilities.buttons && this.permissionChoices().length
                  ? { id, choices: this.permissionChoices() }
                  : undefined,
              ...this.card(ch, "permission", r.facts, () => ({
                kind: "permission",
                agent: r.vars.agent ?? "agent",
                project: r.project,
                session: r.title,
                detail: redact(detail, this.cfg.redact),
              })),
            }),
            { root: r.rootID, pending: id },
          )
    this.remember(p, sent.refs)
    if (mode === "digest") this.permDigestTouch(r.rootID)
  }

  private waitingPermissions(root: string): Pending[] {
    return this.store
      .list()
      .filter(
        (p) =>
          p.kind === "permission" &&
          p.state === "pending" &&
          p.rootSessionID === root,
      )
  }

  /** Schedules the session's digest: the first goes out at once, later edits at most one per `digestGapMs`. */
  private permDigestTouch(root: string) {
    const d = this.permDigests.get(root) ?? { refs: {}, at: 0 }
    this.permDigests.set(root, d)
    if (d.timer) return
    const wait = Math.max(0, d.at + this.digestGapMs - this.now())
    d.timer = setTimeout(() => {
      d.timer = undefined
      void this.permDigestFlush(root)
    }, wait)
    d.timer.unref?.()
  }

  private async permDigestFlush(root: string) {
    const d = this.permDigests.get(root)
    if (!d) return
    if (d.busy) {
      d.again = true
      return
    }
    d.busy = true
    try {
      d.at = this.now()
      const waiting = this.waitingPermissions(root)
      const first = Object.keys(d.refs).length === 0
      if (waiting.length === 0 && first)
        return void this.permDigests.delete(root)
      const r = await this.routed(root)
      if (!r) return
      const text = permissionDigest(waiting)
      const to = r.to.filter((c) => c.capabilities.inboundPrompt)
      const { refs } = await this.dispatch(
        "permission",
        to,
        (ch) => ({ ...text, ...this.shape(ch, r.session) }),
        {
          root,
          refs: first ? undefined : d.refs,
          session: r.session,
        },
      )
      Object.assign(d.refs, refs)
      if (waiting.length === 0) this.permDigests.delete(root)
    } catch (err) {
      log("permission_digest_error", { message: (err as Error).message })
    } finally {
      d.busy = false
      if (d.again) {
        d.again = false
        this.permDigestTouch(root)
      }
    }
  }

  /** Shows a session's state on the connectors that keep a live view of it. */
  private async track(
    r: NonNullable<Awaited<ReturnType<Bridge["routed"]>>>,
    state: SessionState["state"] | undefined,
    patch: Patch = {},
  ) {
    const prev = this.states.get(r.rootID)
    const now = this.now()
    if (state === "working") this.unstarted.delete(r.rootID)
    const next = {
      state: state ?? prev?.state ?? "idle",
      at: state ? now : (prev?.at ?? now),
      started: state === "working" ? now : prev?.started,
    }
    this.states.set(r.rootID, next)
    const { title: _title, ...chose } = patch
    const pick = { ...this.chosen.get(r.rootID), ...chose }
    if (Object.keys(chose).length) this.chosen.set(r.rootID, pick)
    const title =
      patch.title === undefined
        ? r.title
        : this.cfg.redact.mode === "title"
          ? undefined
          : redact(patch.title, this.cfg.redact)
    const s: SessionState = {
      id: r.rootID,
      name: title ? `${r.project} · ${title}` : r.session.name,
      project: r.project,
      title,
      agent: pick.agent ?? r.root?.agent,
      model: pick.model ?? r.root?.model,
      variant: (pick.variant ?? r.root?.modelRef?.variant) || undefined,
      state: next.state,
      ...(this.unstarted.has(r.rootID) ? { unstarted: true } : {}),
      at: next.at,
      chat: this.chat.has(r.rootID),
      watch: this.watchOf(r.rootID),
    }
    this.lastStates.set(r.rootID, s)
    await Promise.all(
      r.to.map((c) =>
        c.track ? this.safely(c, () => c.track!(s)) : undefined,
      ),
    )
    return next
  }

  /** How a session is watched: forced on through a channel, by the away rule, or not at all. */
  watchOf(root: string): NonNullable<SessionState["watch"]> {
    return {
      mode: this.router.mode(root),
      channel: this.channelOf(root),
      minutes: this.cfg.away.minutes,
    }
  }

  /**
   * Routing or chat changed: tells the connectors that already show the session
   * (a topic, a card). A session never shown has nothing to update.
   */
  async retrack(root: string): Promise<void> {
    const last = this.lastStates.get(root)
    if (!last) return
    const s: SessionState = {
      ...last,
      chat: this.chat.has(root),
      watch: this.watchOf(root),
    }
    this.lastStates.set(root, s)
    await Promise.all(
      this.targets(root).map((c) =>
        c.track ? this.safely(c, () => c.track!(s)) : undefined,
      ),
    )
  }

  chatEnabled(root: string): boolean {
    return this.chat.has(root)
  }

  /** Called after the watch mode of a session changes, to keep it across restarts. */
  onWatch(fn: (root: string) => void): void {
    this.watchListener = fn
  }

  /** Sets whether a session is mirrored, and through which channel. */
  setWatch(
    root: string,
    mode: "on" | "off" | "auto",
    channel?: string,
    awayMinutes?: number,
  ): void {
    this.router.set(
      root,
      mode === "auto" ? undefined : mode === "on",
      channel,
      awayMinutes ?? this.router.awayMinutesOf(root),
    )
    this.watchListener?.(root)
    void this.retrack(root)
    this.notify()
  }

  /** Sets the mode of every known top-level session; the sessions it reached. */
  setAllWatch(mode: "on" | "off" | "auto"): number {
    const roots = new Set([...this.router.chosen(), ...this.lastStates.keys()])
    for (const root of roots)
      this.setWatch(root, mode, this.router.channel(root))
    return roots.size
  }

  /** Called after chat is switched on or off for a session, to keep it across restarts. */
  onChat(fn: (root: string) => void): void {
    this.chatListener = fn
  }

  /** How a prompt from a connector reaches the session: its own choice, or `chat.delivery`. */
  delivery(root: string): Delivery {
    return this.deliveries.get(root) ?? this.cfg.chat.delivery
  }

  /** The session's own choice, if it has one. */
  deliveryOverride(root: string): Delivery | undefined {
    return this.deliveries.get(root)
  }

  /** `undefined` goes back to `chat.delivery`. */
  setDelivery(root: string, d: Delivery | undefined): void {
    if (d === undefined) this.deliveries.delete(root)
    else this.deliveries.set(root, d)
    void this.onState(root)
    this.changed(root)
  }

  restoreDelivery(root: string, d: Delivery): void {
    this.deliveries.set(root, d)
  }

  /** Puts chat back on for a session from the stored settings. Whether it is allowed is checked at each prompt. */
  restoreChat(root: string): void {
    this.chat.add(root)
  }

  /** A choice for the session changed: stored by the listener, and shown by the views. */
  private changed(root: string): void {
    this.chatListener?.(root)
    this.notify()
  }

  /** Calls `fn` when what a view of a session shows may have changed. Returns the way to stop. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  notify(): void {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch (err) {
        log("listener_error", { message: (err as Error).message })
      }
    }
  }

  /** The channel a session mirrors through: its own choice, or the default. */
  channelOf(root: string): string {
    return this.router.channel(root) ?? this.cfg.defaultChannel
  }

  /** Whether a channel that can carry a chat is selected for the session. */
  canChat(root: string): boolean {
    return this.targets(root).some((c) => c.capabilities.inboundPrompt)
  }

  defaultChannel(): string {
    return this.cfg.defaultChannel
  }

  awayMinutes(): number {
    return this.cfg.away.minutes
  }

  defaultSidebar(): SidebarMode {
    return this.cfg.sidebar
  }

  defaultDelivery(): Delivery {
    return this.cfg.chat.delivery
  }

  /** Prompts of the session that wait for an answer, oldest first. */
  /** One pending entry by its short id, in any state. */
  promptEntry(id: string): Pending | undefined {
    return this.store.get(id)
  }

  openPromptList(root: string): Pending[] {
    return this.store
      .list()
      .filter((p) => p.state === "pending" && p.rootSessionID === root)
      .sort((a, b) => a.askedAt - b.askedAt)
  }

  openPrompts(root: string): number {
    return this.openPromptList(root).length
  }

  /** The `chat.deny` rule that blocks chat, in words, or undefined. */
  private denial(
    facts: { agent?: string; directory?: string } | undefined,
  ): string | undefined {
    for (const d of this.cfg.chat.deny)
      if (
        (!d.agent || d.agent.test(facts?.agent ?? "")) &&
        (!d.directory || globToRegExp(d.directory).test(facts?.directory ?? ""))
      )
        return [
          d.agent && `agent ${d.agent.source}`,
          d.directory && `directory ${d.directory}`,
        ]
          .filter(Boolean)
          .join(" and ")
    return undefined
  }

  private denied(facts: { agent?: string; directory?: string } | undefined) {
    return this.denial(facts) !== undefined
  }

  /** Why chat is blocked for the session by `chat.deny`, from what is known without asking. */
  chatBlocked(root: string): string | undefined {
    return this.denial(this.host.peek?.(root))
  }

  /** Switches chat from a connector on or off for a top-level session. */
  async setChat(root: string, on: boolean): Promise<Outcome> {
    if (!on) {
      this.chat.delete(root)
      await this.onState(root)
      this.changed(root)
      return { ok: true, text: "Chat is off for this session." }
    }
    const why = this.denial(await this.host.session(root))
    if (why)
      return no(
        `Chat is blocked for this session by chat.deny in the config (${why}).`,
      )
    if (!this.targets(root).some((c) => c.capabilities.inboundPrompt))
      return no(
        "No channel that can chat is selected for this session: use /oob on telegram first.",
      )
    // The session's topic is where the chat happens: with chat on it routes when away, whatever the rules say.
    this.chat.add(root)
    await this.onState(root)
    this.changed(root)
    return { ok: true, text: "Chat is on for this session." }
  }

  private joined(root: string): string {
    const parts = this.turns.get(root)?.parts
    return parts
      ? [...parts.entries()]
          .sort((a, b) => a[0] - b[0])
          .map((e) => e[1])
          .join("\n\n")
      : ""
  }

  /** Text of the turn's assistant message, as it arrives. */
  private async onText(
    d: { sessionID: string; assistantMessageID: string; ordinal: number },
    delta?: string,
    full?: string,
  ) {
    const root = this.host.root(d.sessionID)
    if (root !== d.sessionID || !this.chat.has(root)) return
    let buf = this.turns.get(root)
    if (!buf) this.turns.set(root, (buf = { parts: new Map() }))
    // A new assistant message (a later step) replaces what was shown.
    if (buf.msg !== d.assistantMessageID) {
      buf.msg = d.assistantMessageID
      buf.parts = new Map()
    }
    buf.parts.set(
      d.ordinal,
      full ?? (buf.parts.get(d.ordinal) ?? "") + (delta ?? ""),
    )
    if (!this.cfg.chat.stream) return
    if (this.cfg.chat.mirror === "remote-only" && !this.remote.has(root)) return
    const feed = this.feeds.get(root) ?? {}
    this.feeds.set(root, feed)
    // The first text of a turn is shown at once; later text is coalesced briefly.
    if (!feed.began) {
      feed.began = true
      void this.feed(root)
      return
    }
    if (feed.timer) return
    feed.timer = setTimeout(() => {
      feed.timer = undefined
      void this.feed(root)
    }, FEED_MS)
    ;(feed.timer as { unref?: () => void }).unref?.()
  }

  private async feed(root: string) {
    try {
      const feed = this.feeds.get(root)
      if (!feed || !this.chat.has(root)) return
      const r = (feed.r ??= await this.routed(root))
      const text = this.joined(root).trim()
      if (!r || !text) return
      feed.streamed = true
      const clean = redact(text, this.cfg.chat.redact)
      for (const c of r.to)
        if (c.capabilities.inboundPrompt && c.stream)
          c.stream(
            r.session,
            clean,
            this.cfg.chat.streamMs,
            this.cfg.chat.streamBudget,
            this.turns.get(root)?.msg,
          )
    } catch (err) {
      log("stream_error", { message: (err as Error).message })
    }
  }

  /**
   * A turn ended. Posts its final assistant text when chat is on, or settles a
   * stream that was cut short (`final` false: nothing is posted unless one ran).
   */
  private async endTurn(sessionID: string, r?: Routed, final = false) {
    if (this.host.root(sessionID) !== sessionID) return
    const feed = this.feeds.get(sessionID)
    clearTimeout(feed?.timer)
    this.feeds.delete(sessionID)
    const remote = this.remote.delete(sessionID)
    const text = this.joined(sessionID).trim()
    this.turns.delete(sessionID)
    if (!this.chat.has(sessionID) || !text) return
    if (!final && !feed?.streamed) return
    if (this.cfg.chat.mirror === "remote-only" && !remote) return
    r ??= feed?.r ?? (await this.routed(sessionID))
    if (r) await this.postReply(r, text)
  }

  /**
   * The `oob_send_file` tool: sends a local file to the Telegram topic the calling session's root already has.
   * The caption is redacted like a chat reply. Contents and file names are never logged.
   */
  async sendFile(
    sessionID: string,
    input: { path?: unknown; caption?: unknown; as?: unknown },
  ): Promise<FileOutcome> {
    const r = await this.routed(sessionID)
    if (!r) return { ok: false, error: "this session is not routed to a chat" }
    const ch = r.to.find((c) => c.file)
    if (!ch)
      return { ok: false, error: "no chat channel of this session takes files" }
    const prep = await prepareFile({
      path: input.path,
      as: input.as,
      cwd: r.root?.directory,
    })
    if (!prep.ok) return prep
    const caption =
      typeof input.caption === "string"
        ? redact(input.caption, this.cfg.chat.redact).slice(0, CAPTION_MAX)
        : ""
    const file = prep.file
    const res = await traces.out(
      "file",
      { session: r.rootID, agent: r.facts?.agent },
      async () => {
        const out = await this.safely(ch, () =>
          ch.file!(r.session, file, caption),
        )
        const id = traces.current()?.id
        if (out?.ok)
          log("file_sent", {
            size: file.size,
            kind: file.kind,
            session: r.rootID,
            trace_id: id,
          })
        else
          log("file_failed", {
            size: file.size,
            kind: file.kind,
            session: r.rootID,
            trace_id: id,
            reason: out?.error,
          })
        return out
      },
      (v) => (v?.ok ? "sent" : "failed"),
    )
    return res?.ok
      ? { ok: true, message: `sent ${file.kind} to the Telegram topic` }
      : { ok: false, error: res?.error ?? "could not send the file" }
  }

  private async postReply(r: Routed, text: string) {
    const clean = redact(text, this.cfg.chat.redact)
    await Promise.all(
      r.to
        .filter((c) => c.capabilities.inboundPrompt && c.reply)
        .map(async (c) => {
          const attrs = { "connector.type": c.type }
          const span = this.tel.begin("oob.reply", {
            session: r.rootID,
            attrs,
          })
          const res = await traces.out(
            "reply",
            { session: r.rootID, agent: r.facts?.agent },
            () => this.safely(c, () => c.reply!(r.session, clean)),
            (v) => (v ? "sent" : "failed"),
          )
          this.tel.count(res ? "oob.replies" : "oob.reply.errors", attrs)
          span.end(
            {
              ok: res !== undefined,
              parts: res?.parts,
              chars: clean.length,
              documents: res?.documents,
            },
            res ? undefined : "send-failed",
          )
        }),
    )
  }

  private async onState(
    sessionID: string,
    state?: SessionState["state"],
    patch?: Patch,
  ) {
    if (this.host.root(sessionID) !== sessionID) return
    const r = await this.routed(sessionID)
    if (!r) return
    if (state === "working") {
      this.feeds.set(sessionID, { r })
      this.snapshot(r)
    }
    await this.track(r, state, patch)
  }

  private async onFinished(sessionID: string, failed: boolean) {
    if (this.host.root(sessionID) !== sessionID) return
    const kind = failed ? "failed" : "finished"
    const r = await this.routed(sessionID, { kind })
    if (!r) return
    const final = this.joined(sessionID).trim()
    const born = this.createdAt.get(sessionID)
    if (failed && born !== undefined && this.now() - born < UNSTARTED_MS) {
      this.unstarted.add(sessionID)
      log("session_unstarted", { session: sessionID })
    }
    const st = await this.track(r, failed ? "failed" : "idle")
    await this.endTurn(sessionID, r, !failed)
    const duration =
      st.started === undefined
        ? undefined
        : formatDuration(this.now() - st.started)
    const f = this.fmt(kind, r.vars, r.facts)
    this.record(failed ? "failed" : "finished", r.session.name)
    await this.postTurnCard(r, failed, st.started, final)
    await this.dispatch(
      kind,
      r.to.filter((c) => c.notify?.[kind] ?? true),
      (c) => ({
        ...f,
        ...this.shape(c, r.session),
        ...this.card(c, kind, r.facts, () => ({
          kind,
          project: r.project,
          session: r.title,
          duration,
        })),
      }),
      { root: r.rootID },
    )
  }

  private quietNow(): boolean {
    return (
      this.nightActive() ||
      (this.cfg.quiet !== undefined && isQuiet(this.cfg.quiet, this.now()))
    )
  }

  /** Quiet hours: every push is silent unless its kind is on the break-through list. */
  private silence(kind: Kind): { silent?: boolean } {
    if (this.nightActive())
      return { silent: !(this.cfg.overnight.wake as string[]).includes(kind) }
    const q = this.cfg.quiet
    if (!q || !this.quietNow()) return {}
    return { silent: !(q.breakthrough as string[]).includes(kind) }
  }

  private record(k: "finished" | "failed", title: string) {
    this.tally[k]++
    if (this.cfg.digest || this.nightActive())
      this.digestLog.append({ k, at: this.now(), title })
  }

  /** The digest for the period since the last one, and whether it holds anything. */
  private digestBody(peek = false): string {
    const waiting = [
      ...this.store
        .list()
        .filter((p) => p.state === "pending")
        .map((p) => p.kind + ": " + redact(p.title, this.cfg.redact)),
      ...(this.stuckSource?.() ?? []).map(
        (s) =>
          "stuck: " +
          redact(s.label, this.cfg.redact) +
          " (" +
          s.pending +
          " waiting)",
      ),
    ]
    const night = this.night?.pending() ? this.night.report() : []
    if (night.length && !peek) void this.night?.done()
    return digestText({ records: this.digestLog.pending(), waiting, night })
  }

  /** The digest as it would be sent now, without covering its period. */
  digestPreview(): { enabled: boolean; text: string } {
    return {
      enabled: this.cfg.digest !== undefined,
      text: this.digestBody(true),
    }
  }

  /** `/digest`: the text now, and the period counts as covered. */
  async digestNow(): Promise<Outcome> {
    if (!this.cfg.digest) return no("The digest is not enabled.")
    const body = this.digestBody()
    this.digestLog.append({ k: "digest", at: this.now() })
    return yes(
      body ? "Digest\n" + body : "Nothing to report since the last digest.",
    )
  }

  /** Sends the day's digest once, when the clock passes `digest.at`. */
  async digestTick(): Promise<void> {
    const d = this.cfg.digest
    if (!d) return
    if (
      !digestDue({
        at: d.at,
        timezone: this.cfg.quiet?.timezone,
        last: this.digestLog.lastDigest(),
        now: this.now(),
      })
    )
      return
    const body = this.digestBody()
    this.digestLog.append({ k: "digest", at: this.now() })
    if (!body && !d.empty) return
    const text = body || "Nothing to report."
    await this.dispatch(
      "notice",
      this.active().filter((c) => c.capabilities.inboundPrompt),
      () => ({
        title: "Digest",
        message: text,
        tags: ["calendar"],
      }),
      {},
    )
  }

  /** Notes the working tree as a turn begins, to tell later what the turn changed. */
  private snapshot(r: Routed) {
    const dir = r.facts.directory
    if (!this.cfg.turnCard.enabled || !dir || !this.host.diff) return
    this.before.set(
      r.rootID,
      this.host
        .diff(dir)
        .then(stats)
        .catch(() => undefined),
    )
  }

  /** One card for a turn that changed files or ran long; the previous card loses its buttons. */
  private async postTurnCard(
    r: Routed,
    failed: boolean,
    started: number | undefined,
    final: string,
  ) {
    const cfg = this.cfg.turnCard
    const before = await this.before.get(r.rootID)
    this.before.delete(r.rootID)
    if (!cfg.enabled) return
    const dir = r.facts.directory
    const after = dir
      ? await this.host.diff?.(dir).catch(() => undefined)
      : undefined
    const d = delta(before, after)
    const seconds = started === undefined ? 0 : (this.now() - started) / 1000
    if (
      !shouldCard({
        minSeconds: cfg.minSeconds,
        seconds,
        changed: d?.files.length,
      })
    )
      return
    const hide = this.cfg.chat.redact.mode === "title"
    const card: TurnCard = {
      failed,
      origin: this.origins.get(r.rootID),
      duration:
        started === undefined
          ? undefined
          : formatDuration(this.now() - started),
      changes:
        d && d.files.length > 0
          ? { files: d.files.length, added: d.added, removed: d.removed }
          : undefined,
      summary: final
        ? redact(lastParagraph(final, MAX_SUMMARY), this.cfg.chat.redact)
        : undefined,
      files: hide ? [] : (d?.files ?? []).map(filterSecrets),
    }
    await Promise.all(
      r.to
        .filter((c) => c.capabilities.threads)
        .map(async (c) => {
          const k = r.rootID + "|" + c.id
          const prev = this.cards.get(k)
          if (prev) {
            clearTimeout(prev.timer)
            this.cards.delete(k)
            await this.safely(c, async () => c.unbutton?.(prev.ref))
          }
          const ref =
            c.capabilities.foldable && c.turnCard
              ? await this.safely(c, () =>
                  c.turnCard!(r.session, card, {
                    chat: this.chat.has(r.rootID),
                  }),
                )
              : await this.safely(c, () =>
                  c.send({
                    message: plain(card),
                    session: r.session,
                    priority: 2,
                  }),
                )
          if (!ref || !c.unbutton) return
          const timer = setTimeout(() => {
            this.cards.delete(k)
            void this.safely(c, async () => c.unbutton!(ref))
          }, this.cardTtlMs)
          timer.unref?.()
          this.cards.set(k, { ch: c, ref, timer })
        }),
    )
  }

  /** Draws the diff; a test replaces it to force a failure. */
  private drawer: typeof drawDiff = drawDiff

  /** A turn card's button: Diff, Continue, QA, Update or Stop. */
  private async cardButton(
    ch: Connector,
    root: string,
    what: string,
  ): Promise<Outcome> {
    try {
      if (what === "stop")
        return (await this.actions.stop(root))
          ? yes("⏹ Stopped the running turn.")
          : no("Nothing is running.")
      if (what === "continue") {
        if (!this.chat.has(root)) return no("Chat is off for this session.")
        await this.actions.prompt(root, "continue", this.delivery(root))
        return yes("Sent: continue.")
      }
      if (what === "qa" || what === "update") {
        const r = await this.actions.run(what, root, {})
        if (r.ok) this.remote.add(root)
        return r
      }
      const files = await this.actions.diffFiles(root)
      if (files === undefined)
        return no("This OpenCode cannot read the changes from here.")
      if (!files.some((f) => f.patch.trim() || f.additions || f.deletions))
        return no("No changes to show.")
      const r = await this.routed(root)
      if (!r) return no("Could not send the diff.")
      const mode = this.cfg.chat.redact
      const o = {
        exclude: this.cfg.diff.exclude,
        theme: this.cfg.diff.theme,
        name: (f: string) => redact(f, mode),
      }
      let drawn: Awaited<ReturnType<typeof drawDiff>> | undefined
      if (ch.photos && mode.mode !== "title")
        try {
          drawn = await this.drawer(files, o)
        } catch (err) {
          log("diff_draw_failed", {
            message: filterSecrets((err as Error).message),
          })
        }
      const total = files.reduce(
        (n, f) => ({ a: n.a + f.additions, d: n.d + f.deletions }),
        { a: 0, d: 0 },
      )
      const head = `📄 Diff · ${files.length} file${files.length === 1 ? "" : "s"} +${total.a} -${total.d}`
      if (drawn?.images.length)
        await this.safely(ch, async () =>
          ch.photos?.(
            r.session,
            drawn.images,
            drawn.omitted
              ? `${head}\n${drawn.omitted} more lines are only in the patch.`
              : head,
          ),
        )
      const patch =
        mode.mode === "title"
          ? redact(files.map((f) => f.patch).join("\n"), mode)
          : buildPatch(files, o)
      const caption =
        ch.photos && !drawn && mode.mode !== "title"
          ? truncate(
              `${head}, images unavailable: ${fileList(files, o).join(", ")}`,
              900,
            )
          : drawn
            ? "📄 Patch"
            : head
      const sent = await this.safely(ch, async () =>
        ch.document?.(r.session, "changes.patch", patch, caption),
      )
      return sent ? yes("Diff sent.") : no("Could not send the diff.")
    } catch (err) {
      if (err instanceof Refused) return no(err.message)
      throw err
    }
  }

  /** A prompt was answered or cancelled in OpenCode. */
  private async closed(requestID: string, note: string, choice?: string) {
    for (const u of this.unsent.values()) u.asks.delete(requestID)
    const p = this.store.byRequest(requestID)
    if (!p) return this.router.touch()
    if (p.state !== "pending") return
    this.router.touch()
    const cancelled = note === "Cancelled"
    this.store.update(p.id, {
      state: cancelled ? "cancelled" : "answered",
      answeredBy: "tui",
      answeredAt: this.now(),
    })
    this.pendingGauge()
    if (!cancelled) this.answered(p, "tui")
    await this.markAnswered(p, {
      outcome: cancelled ? "cancelled" : "answered",
      via: "TUI",
      answer: choice
        ? truncate(redact(choice, this.cfg.redact), 200)
        : undefined,
    })
  }

  /** A prompt entered a session: one typed at the Mac is shown in the topic, one this bridge sent is not. */
  private async onUserPrompt(
    d: Extract<BridgeEvent, { type: "session.inbox.enqueued" }>["data"],
  ) {
    const root = this.host.root(d.sessionID)
    if (root !== d.sessionID) return
    if (d.inboxID) {
      if (this.seenInbox.has(d.inboxID)) return
      this.seenInbox.add(d.inboxID)
      if (this.seenInbox.size > 500)
        this.seenInbox.delete(this.seenInbox.values().next().value!)
    }
    const text = d.item?.payload?.text ?? ""
    const list = this.sentPrompts.get(root) ?? []
    const at = list.findIndex(
      (s) => s.text === text && this.now() - s.at < SENT_TTL_MS,
    )
    if (at >= 0) {
      list.splice(at, 1)
      this.origins.set(root, "telegram")
      return
    }
    this.origins.set(root, "mac")
    if (!text.trim() || this.cfg.chat.mirror === "remote-only") return
    const r = await this.routed(root)
    if (!r) return
    const to = r.to.filter((c) => c.capabilities.inboundPrompt)
    if (to.length === 0) return
    const message = `🖥 You at the Mac: ${truncate(redact(text, this.cfg.chat.redact), MAX_MAC_PROMPT)}`
    await this.dispatch(
      "notice",
      to,
      (ch) => ({ message, ...this.shape(ch, r.session) }),
      { root, silent: true },
    )
  }

  /** Counts an answer and how long the prompt waited for it. */
  private answered(p: Pending, by: "phone" | "tui", ch?: Connector) {
    if (by === "phone") this.tally.answered++
    const attrs = { answered_by: by, "connector.type": ch?.type }
    this.tel.count("oob.answers", attrs)
    this.tel.record("oob.answer.latency_ms", attrs, this.now() - p.askedAt)
  }

  /** Marks the prompt's message on every connector that carries it. */
  private async markAnswered(
    p: Pending,
    o: {
      outcome: "answered" | "cancelled" | "withdrawn"
      via: string
      answer?: string
      reconciled?: boolean
    },
  ) {
    const note =
      o.outcome === "withdrawn"
        ? "Withdrawn: the session stopped asking"
        : o.outcome === "cancelled"
          ? "Cancelled"
          : o.reconciled
            ? "Already answered at the Mac"
            : o.via === "TUI"
              ? "Answered in the TUI"
              : `Answered from ${o.via}: ${o.answer}`
    if (p.kind === "permission" && this.cfg.permissions.notify === "digest")
      this.permDigestTouch(p.rootSessionID)
    const f = this.fmt("closed", { id: p.id, title: p.title, note })
    const time = clock(this.now())
    const quote = redact(
      (p.questions ?? []).map((q) => q.text).join(" / ") || p.title,
      this.cfg.redact,
    )
    await this.dispatch(
      "closed",
      this.active(),
      (ch) => ({
        ...f,
        ...this.card(ch, "closed", undefined, () => ({
          kind: "closed",
          outcome: o.outcome,
          answer: o.answer,
          via: o.via,
          reconciled: o.reconciled,
          origin:
            o.via === "TUI"
              ? "mac"
              : o.via === "api"
                ? "app"
                : this.channels.find((c) => c.id === o.via)?.type === "telegram"
                  ? "telegram"
                  : undefined,
          time,
          quote,
        })),
      }),
      {
        root: p.rootSessionID,
        pending: p.id,
        refs: p.refs ?? {},
        session: { id: p.rootSessionID, name: p.title },
      },
    )
  }

  private fmt(kind: Kind, vars: Vars, facts?: SessionFacts) {
    return format(kind, vars, this.cfg.messages, this.cfg.profiles, facts)
  }

  private async onInbound(
    ch: Connector,
    m: Inbound,
  ): Promise<Outcome | undefined> {
    const kind = this.inboundKind(ch, m)
    this.router.phone()
    const span = this.tel.begin("oob.inbound", {
      attrs: { kind, "connector.type": ch.type },
    })
    const info: { outcome: string; pending?: Pending; root?: string } = {
      outcome: "ignored",
    }
    try {
      const out = await this.apply(ch, m, info)
      // A connector answers its own commands.
      if (out && !out.ok && !out.retry && !m.inline && m.kind !== "command") {
        const f = this.fmt("notice", { text: out.text })
        await this.dispatch(
          "notice",
          [ch],
          () => ({
            ...f,
            ...this.card(ch, "notice", undefined, () => ({
              kind: "notice",
              text: out.text,
            })),
            // A notice about a session's chat belongs in its topic.
            ...(info.root && ch.capabilities.threads
              ? { session: { id: info.root, name: info.root } }
              : {}),
          }),
          {
            root: info.pending?.rootSessionID,
            pending: info.pending?.id,
          },
        )
      }
      if (kind === "prompt")
        this.tel.count("oob.prompts", {
          "connector.type": ch.type,
          outcome: info.outcome,
        })
      if (
        kind !== "command" &&
        !["applied", "ignored", "sent", "queued", "steered"].includes(
          info.outcome,
        )
      )
        this.tel.count("oob.inbound.rejected", {
          "connector.type": ch.type,
          reason: info.outcome,
        })
      span.setSession(info.pending?.rootSessionID ?? info.root)
      span.end(
        { outcome: info.outcome, "pending.id": info.pending?.id },
        out && !out.ok ? info.outcome : undefined,
      )
      log("inbound", {
        connector: ch.id,
        kind,
        id: m.id,
        outcome: info.outcome,
        session: info.pending?.rootSessionID ?? info.root,
        ok: out?.ok,
      })
      return out
    } catch (err) {
      log("inbound_error", { message: (err as Error).message })
      span.end({ outcome: "error" }, "error")
      return undefined
    }
  }

  /** A reply that answers no question we track is text for the session. */
  private inboundKind(ch: Connector, m: Inbound): Inbound["kind"] {
    return m.kind === "answer" &&
      !m.pendingId &&
      m.replyTo &&
      m.sessionKey &&
      ch.capabilities.inboundPrompt &&
      !this.store.byRef(ch.id, m.replyTo)
      ? "prompt"
      : m.kind
  }

  /** Rate-limited: a session hears the same hint once an hour. */
  private hint(root: string, text: string): Outcome | undefined {
    const last = this.hinted.get(root)
    if (last !== undefined && this.now() - last < HINT_EVERY_MS)
      return undefined
    this.hinted.set(root, this.now())
    return no(text)
  }

  /** Text from a connector for a session. */
  private async prompt(
    ch: Connector,
    m: Inbound,
    info: { outcome: string; root?: string },
  ): Promise<Outcome | undefined> {
    const root = m.sessionKey
    let text = m.text.trim()
    // "!text" is always steered into the running turn.
    const bang = text.startsWith("!")
    if (bang) text = text.slice(1).trim()
    if (
      !ch.capabilities.inboundPrompt ||
      !root ||
      (!text && !m.files?.length) ||
      this.host.root(root) !== root
    ) {
      log("inbound_ignored", { connector: ch.id, kind: m.kind })
      return undefined
    }
    // A file with no caption still needs some text for the prompt.
    if (!text) text = `Attached: ${m.files!.map((f) => f.name).join(", ")}`
    info.root = root
    if (!this.chat.has(root)) {
      info.outcome = "off"
      return this.hint(
        root,
        "Chat is off for this session: run /oob chat on in the TUI.",
      )
    }
    const facts = await this.host.session(root)
    if (this.denied(facts)) {
      info.outcome = "denied"
      return this.hint(root, "Chat is blocked for this session by chat.deny.")
    }
    // A session that waits on a question does not take a message behind it: keep it and ask.
    const open = () =>
      this.openPromptList(root).filter((p) => p.kind === "question")
    let asking = open()
    // Ask OpenCode before holding: a question answered at the Mac while the bridge was away is not open.
    if (asking.length && !bang && (await this.reconcile(root, 0)))
      asking = open()
    if (asking.length && !bang) {
      info.outcome = "held"
      return this.commands.hold(root, { text, files: m.files }, asking.length)
    }
    const busy = this.host.busy(root)
    // "!" always steers. The configured default steers only a running turn;
    // an idle session takes the plain path.
    const delivery: Delivery =
      bang || (busy && this.delivery(root) === "steer") ? "steer" : "queue"
    const holding =
      busy && delivery === "queue" && this.cfg.chat.queueSteerSeconds > 0
    try {
      if (holding) this.hold(ch, root, { text, files: m.files })
      else await this.actions.prompt(root, text, delivery, m.files)
    } catch (err) {
      log("prompt_error", { message: (err as Error).message })
      info.outcome = "failed"
      return {
        ...no(
          "Could not send that to the session: " +
            truncate((err as Error).message || "unknown error", 120),
        ),
        retry: ch.capabilities.retriesInbound,
      }
    }
    this.remote.add(root)
    const where = `${facts?.agent ?? "agent"} · ${facts?.directory ? basename(facts.directory) : "opencode"}`
    info.outcome = !busy ? "sent" : delivery === "steer" ? "steered" : "queued"
    return {
      ok: true,
      sent: true,
      delivered: {
        agent: facts?.agent,
        how: info.outcome as "sent" | "queued" | "steered",
      },
      text: !busy
        ? `→ sent to ${where}`
        : delivery === "steer"
          ? `⚡ steered in · ${where}`
          : `→ queued for ${where} (busy${holding ? `, steered in after ${this.cfg.chat.queueSteerSeconds}s if still waiting` : ""})`,
    }
  }

  /** Keeps a message for a busy session; `release` sends it. */
  private hold(
    ch: Connector,
    root: string,
    item: { text: string; files?: InboundFile[] },
  ): void {
    const h = this.held.get(root)
    if (h) return void h.items.push(item)
    const timer = setTimeout(
      () => void this.release(root, "steer"),
      this.cfg.chat.queueSteerSeconds * 1000,
    )
    ;(timer as { unref?: () => void }).unref?.()
    this.held.set(root, { ch, at: this.now(), timer, items: [item] })
  }

  /**
   * Sends what waits for a session, in order: steered into the running turn when
   * the time is up, or as normal prompts when the session has become free.
   */
  private async release(root: string, why: "free" | "steer"): Promise<void> {
    const h = this.held.get(root)
    if (!h) return
    clearTimeout(h.timer)
    this.held.delete(root)
    const waited = Math.round((this.now() - h.at) / 1000)
    const steer = why === "steer" && this.host.busy(root)
    try {
      for (const it of h.items)
        await this.actions.prompt(
          root,
          it.text,
          steer ? "steer" : "queue",
          it.files,
        )
    } catch (err) {
      log("held_send_error", {
        session: root,
        message: (err as Error).message,
      })
      return void (await this.tell(
        h.ch,
        root,
        "⚠ Could not send your waiting message: " +
          truncate((err as Error).message || "unknown error", 120),
      ))
    }
    const outcome = steer ? "steered" : "free"
    log("held_released", {
      session: root,
      outcome,
      count: h.items.length,
      waited_s: waited,
    })
    this.tel.count("oob.held.released", {
      "connector.type": h.ch.type,
      outcome,
    })
    if (steer) await this.tell(h.ch, root, `→ steered in after ${waited}s`)
  }

  /** A short notice in the session's thread. */
  private async tell(ch: Connector, root: string, text: string): Promise<void> {
    const f = this.fmt("notice", { text })
    await this.dispatch(
      "notice",
      [ch],
      () => ({
        ...f,
        ...this.card(ch, "notice", undefined, () => ({ kind: "notice", text })),
        ...(ch.capabilities.threads
          ? { session: { id: root, name: root } }
          : {}),
      }),
      { root },
    )
  }

  /** A connector's own button. The only one is turning chat off: chat is never switched on from a chat. */
  private async control(
    ch: Connector,
    m: Inbound,
    info: { outcome: string; root?: string },
  ): Promise<Outcome | undefined> {
    const root = m.sessionKey
    if (!ch.capabilities.inboundPrompt || !root) return undefined
    if (m.text === "resume") {
      info.root = root
      info.outcome = "applied"
      return this.resume(root, "button")
    }
    if (
      m.text === "diff" ||
      m.text === "continue" ||
      m.text === "stop" ||
      m.text === "qa" ||
      m.text === "update"
    ) {
      info.root = root
      info.outcome = "applied"
      return this.cardButton(ch, root, m.text)
    }
    if (m.text !== "chat off") return undefined
    info.root = root
    info.outcome = "applied"
    return this.setChat(root, false)
  }

  /**
   * Wakes a session and answers at once; whether it started is watched and
   * reported afterwards, on the alert when there is one.
   */
  async resume(
    root: string,
    source: "button" | "command" | "sidebar" | "overnight" = "command",
  ): Promise<Outcome> {
    const where = "Open it at the Mac to resume it."
    if (!this.host.resume)
      return no("This OpenCode cannot resume a session from here. " + where)
    const alert = this.alerts.get(root)
    if (source === "button" && alert?.used)
      return no("That alert was already used. Send /resume to try again.")
    const before = this.waitingSource?.(root)
    if (before === 0 && !this.host.busy(root))
      return no(
        "Nothing is waiting on this session, so there is nothing to wake.",
      )
    const at = Date.now()
    if (alert) alert.used = true
    try {
      await this.actions.wake(root)
    } catch (err) {
      if (alert) alert.used = false
      log("resume", { session: root, source, outcome: "refused", at })
      log("resume_error", { message: (err as Error).message })
      return no("Could not resume it. " + where)
    }
    void this.watchResume(root, source, before, at)
    return {
      ok: true,
      text: "▶ Waking it. I will say whether it started.",
    }
  }

  /** Watches a woken session and reports what happened: working, drained or no_effect. */
  private async watchResume(
    root: string,
    source: string,
    before: number | undefined,
    at: number,
  ): Promise<void> {
    const ac = new AbortController()
    this.watchers.add(ac)
    let outcome: "working" | "drained" | "no_effect" = "no_effect"
    try {
      while (!ac.signal.aborted && Date.now() - at < this.resumeWatchMs) {
        if (this.host.busy(root)) {
          outcome = "working"
          break
        }
        if (before && this.waitingSource?.(root) === 0) {
          outcome = "drained"
          break
        }
        await sleep(this.resumePollMs, ac.signal)
      }
      if (ac.signal.aborted) return
    } finally {
      this.watchers.delete(ac)
    }
    log("resume", { session: root, source, outcome, at })
    this.resumeListener?.(root, outcome)
    const text = {
      working: "▶ Resumed: the session is working again.",
      drained: "▶ Resumed: the session took its waiting messages.",
      no_effect:
        "▶ The wake was accepted but nothing changed in " +
        Math.round(this.resumeWatchMs / 1000) +
        " seconds. Open the session at the Mac.",
    }[outcome]
    await this.tellAlert(root, text)
  }

  /** Rewrites the session's alert without its button; a notice when there is no alert. */
  private async tellAlert(root: string, text: string): Promise<void> {
    const r = await this.routed(root)
    if (!r) return
    const alert = this.alerts.get(root)
    const f = this.fmt("notice", { text })
    await this.dispatch(
      "notice",
      r.to,
      (ch) => ({
        ...f,
        ...this.shape(ch, r.session),
        ...this.card(ch, "notice", r.facts, () => ({ kind: "notice", text })),
      }),
      { root, refs: alert?.refs, session: r.session },
    )
  }

  /** The session woke by some other route: its alert says so and loses its button. */
  async alertGone(root: string): Promise<void> {
    const alert = this.alerts.get(root)
    if (!alert || alert.used) return
    alert.used = true
    await this.tellAlert(
      root,
      "▶ This session resumed on its own. Nothing to do.",
    )
  }

  /**
   * A message has waited on a session that is not working on it. Told to the
   * session's channels, with a button that wakes it where the channel has buttons.
   */
  async stalled(
    root: string,
    o: { pending: number; minutes: number },
  ): Promise<boolean> {
    const r = await this.routed(root)
    if (!r) return false
    const text =
      (o.pending === 1 ? "A message" : o.pending + " messages") +
      " to this session " +
      (o.pending === 1 ? "has" : "have") +
      " waited " +
      o.minutes +
      " min and it is not working on " +
      (o.pending === 1 ? "it" : "them") +
      ". Resume wakes it, or open it at the Mac."
    const f = this.fmt("notice", { text })
    const { ok, refs } = await this.dispatch(
      "notice",
      r.to,
      (ch) => ({
        ...f,
        ...this.shape(ch, r.session),
        ...this.card(ch, "notice", r.facts, () => ({ kind: "notice", text })),
        action:
          ch.capabilities.buttons && this.host.resume
            ? { label: "▶ Resume", control: "resume" }
            : undefined,
      }),
      { root },
    )
    const old = this.alerts.get(root)
    if (old && !old.used)
      for (const ch of this.active())
        if (old.refs[ch.id]) await ch.unbutton?.(old.refs[ch.id])
    this.alerts.set(root, { refs, used: false })
    return Object.values(ok).some(Boolean)
  }

  /** Top-level sessions shown to a channel, newest first, with what was last shown. */
  known(): Array<{ id: string; state?: SessionState }> {
    const ids = new Set<string>([...this.lastStates.keys(), ...this.chat])
    return [...ids]
      .map((id) => ({ id, state: this.lastStates.get(id) }))
      .sort((a, b) => (b.state?.at ?? 0) - (a.state?.at ?? 0))
  }

  private async apply(
    ch: Connector,
    m: Inbound,
    info: { outcome: string; pending?: Pending; root?: string },
  ): Promise<Outcome | undefined> {
    if (m.kind === "command") return this.commands.run(ch, m, info)
    if (m.kind === "control") return this.control(ch, m, info)
    if (m.kind === "prompt") return this.prompt(ch, m, info)
    if (m.kind !== "answer") {
      log("inbound_ignored", { connector: ch.id, kind: m.kind })
      return undefined
    }
    let id: string
    let reply: Reply
    if (m.pendingId) {
      id = m.pendingId
      reply =
        m.choice !== undefined
          ? { id, choice: m.choice }
          : { id, text: m.text, literal: m.literal }
    } else if (m.replyTo) {
      // A reply to the message itself; one that answers nothing we track is not ours.
      const target = this.store.byRef(ch.id, m.replyTo)
      if (!target)
        return m.sessionKey && ch.capabilities.inboundPrompt
          ? this.prompt(ch, m, info)
          : undefined
      id = target.id
      reply = { id, text: m.text }
    } else return undefined
    const p = this.store.get(id)
    info.pending = p
    if (!p || this.now() - p.askedAt > EXPIRY_MS) {
      info.outcome = "expired"
      return no(`#${id}: unknown or expired id, not applied.`)
    }
    if (p.state !== "pending") {
      // A reply older than the answer is a replay after reconnect, not a second answer.
      if (m.id === p.replyID) return undefined
      if (
        p.answeredAt !== undefined &&
        m.time < Math.floor(p.answeredAt / 1000)
      )
        return undefined
      info.outcome = "duplicate"
      return no(`#${p.id}: already answered, not applied.`)
    }
    if (p.kind === "permission") {
      if (m.decision) {
        const done = await this.decide(
          p,
          m.decision,
          { id: ch.id, replyID: m.id },
          ch,
          m.userId,
        )
        info.outcome = done.outcome
        return done.out
      }
      info.outcome = "permission-refused"
      return no(
        `#${p.id}: ${this.permissionChoices().length ? "use the buttons on the message" : "permissions can only be answered in the OpenCode TUI"}.`,
      )
    }
    const answer = resolveAnswer(p.questions ?? [], reply)
    if (!answer) {
      info.outcome = "unreadable"
      log("form_reply_failed", { id: p.id, via: ch.id, reason: "unreadable" })
      return no(
        `#${p.id}: could not read that answer. ${ch.hint(p.id, p.questions ?? [])}`,
      )
    }
    const done = await this.commit(p, answer, { id: ch.id, replyID: m.id }, ch)
    info.outcome = done.outcome
    return done.out
  }

  /**
   * Applies an answer to a prompt: claimed before the await, so the first
   * answer wins, from either side.
   */
  private async commit(
    p: Pending,
    answer: Answer,
    via: { id: string; replyID?: string },
    ch?: Connector,
  ): Promise<{ out: Outcome; outcome: "applied" | "failed" }> {
    this.store.update(p.id, {
      state: "answered",
      answeredBy: "phone",
      answeredVia: via.id,
      answeredAt: this.now(),
      replyID: via.replyID,
    })
    this.pendingGauge()
    try {
      await this.actions.answerForm(p.sessionID, p.requestID, answer)
    } catch (err) {
      log("reply_error", { id: p.id, message: (err as Error).message })
      const gone = /not found/i.test((err as Error).message)
      log("form_reply_failed", {
        id: p.id,
        via: via.id,
        reason: gone ? "not-found" : "error",
      })
      if (gone) {
        // OpenCode no longer has it, and nothing says it was answered.
        await this.settleStale(this.store.get(p.id)!, "withdrawn")
        if (
          !this.openPromptList(p.rootSessionID).some(
            (x) => x.kind === "question",
          )
        )
          await this.releaseHeld(p.rootSessionID)
        return {
          outcome: "failed",
          out: no(`#${p.id}: the session no longer asks this.`),
        }
      }
      this.store.update(p.id, { state: "failed" })
      this.pendingGauge()
      return {
        outcome: "failed",
        out: no(`#${p.id}: not applied (already answered or expired).`),
      }
    }
    log("form_reply_ok", {
      id: p.id,
      via: via.id,
      fields: Object.keys(answer).length,
    })
    const given = redact(
      Object.values(answer).flat().join(" | "),
      this.cfg.redact,
    )
    this.answered(p, "phone", ch)
    await this.markAnswered(p, {
      outcome: "answered",
      via: via.id,
      answer:
        via.id === "api"
          ? truncate(
              redact(
                Object.values(answer)
                  .flat()
                  .map((a) => a.replace(/\s*\(recommended\)\s*/i, " ").trim())
                  .join(" · "),
                this.cfg.redact,
              ),
              120,
            )
          : given,
    })
    return { outcome: "applied", out: { ok: true, text: `Answered: ${given}` } }
  }

  /** What a channel may answer to a permission, by `permissions.remote`. */
  private permissionChoices(): Array<"once" | "always" | "reject"> {
    if (!this.host.replyPermission) return []
    const m = this.cfg.permissions.remote
    return m === "off"
      ? []
      : m === "once"
        ? ["once", "reject"]
        : ["once", "always", "reject"]
  }

  /** Sets the rule that decides what a phone answer to a permission needs (approvals levels). */
  setPermissionGate(g: Bridge["permissionGate"]): void {
    this.permissionGate = g
  }

  /** Answers a permission from a channel when the policy allows it; the first answer wins. */
  private async decide(
    p: Pending,
    decision: "once" | "always" | "reject",
    via: { id: string; replyID?: string },
    ch?: Connector,
    userId?: string,
    gated = false,
  ): Promise<{ out: Outcome; outcome: "applied" | "failed" | "refused" }> {
    if (!this.permissionChoices().includes(decision))
      return {
        outcome: "refused",
        out: no(
          `#${p.id}: ${decision === "always" ? "Always needs permissions.remote: all" : "permissions can only be answered in the OpenCode TUI"}.`,
        ),
      }
    const gate =
      gated || !this.permissionGate
        ? ({ kind: "allow" } as const)
        : this.permissionGate({
            action: p.action,
            decision,
            channel: ch,
            userId,
          })
    if (gate.kind === "refuse")
      return { outcome: "refused", out: no(`#${p.id}: ${gate.text}`) }
    if (gate.kind === "code") {
      // The poll loop waits for this call: the code is typed in a later update, so the wait runs on its own.
      void gate.wait.then(async (r) => {
        if (r === "approved" && this.store.get(p.id)?.state === "pending")
          await this.decide(p, decision, via, ch, userId, true)
        else if (ch)
          await ch.send({
            message: `#${p.id}: ${r === "approved" ? "already answered" : "no valid code, not applied. Tap the button again to retry"}.`,
            silent: true,
          })
      })
      return {
        outcome: "applied",
        out: { ok: true, text: "Type the 6-digit code in the chat." },
      }
    }
    this.store.update(p.id, {
      state: "answered",
      answeredBy: "phone",
      answeredVia: via.id,
      answeredAt: this.now(),
      replyID: via.replyID,
    })
    this.pendingGauge()
    try {
      await this.actions.replyPermission(p.sessionID, p.requestID, decision)
    } catch (err) {
      log("reply_error", { id: p.id, message: (err as Error).message })
      this.store.update(p.id, { state: "failed" })
      this.pendingGauge()
      return {
        outcome: "failed",
        out: no(`#${p.id}: not applied (already answered or expired).`),
      }
    }
    const given = {
      once: "Allowed once",
      always: "Allowed always",
      reject: "Denied",
    }[decision]
    log("permission_answered", {
      session: p.rootSessionID,
      action: p.action,
      decision,
      channel: via.id,
      at: new Date(this.now()).toISOString(),
    })
    this.answered(p, "phone", ch)
    await this.markAnswered(p, {
      outcome: "answered",
      via: via.id,
      answer: given,
    })
    return { outcome: "applied", out: { ok: true, text: given } }
  }

  async answerPermissionFromClient(
    id: string,
    decision: "once" | "always" | "reject",
  ): Promise<Result> {
    const p = this.store.get(id)
    if (!p || this.now() - p.askedAt > EXPIRY_MS)
      return no(`#${id}: unknown or expired id, not applied.`)
    if (p.state !== "pending")
      return no(`#${p.id}: already answered, not applied.`)
    if (p.kind !== "permission")
      return no(`#${p.id}: that is a question, not a permission.`)
    return (await this.decide(p, decision, { id: "api" })).out
  }

  /** An answer from a client other than a chat: the same rules, the same single winner. */
  async answerFromClient(
    id: string,
    a: { choice?: number; text?: string; answers?: unknown },
  ): Promise<Result> {
    const p = this.store.get(id)
    if (!p || this.now() - p.askedAt > EXPIRY_MS)
      return no(`#${id}: unknown or expired id, not applied.`)
    if (p.state !== "pending")
      return no(`#${p.id}: already answered, not applied.`)
    if (p.kind === "permission")
      return no(
        `#${p.id}: permissions can only be answered in the OpenCode TUI.`,
      )
    const answer =
      a.answers !== undefined
        ? checkAnswers(p.questions ?? [], a.answers)
        : resolveAnswer(
            p.questions ?? [],
            a.choice !== undefined
              ? { id, choice: a.choice }
              : { id, text: a.text ?? "" },
          )
    if (!answer) return no(`#${p.id}: could not read that answer.`)
    return (await this.commit(p, answer, { id: "api" })).out
  }
}
