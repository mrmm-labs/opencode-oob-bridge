/**
 * What the core needs from a delivery connector (ntfy, Telegram, Matrix, ...).
 *
 * The core never branches on a connector's type. It reads `capabilities` and
 * degrades: no buttons, numbered text; no edit, a follow-up message; no
 * pairing, no pairing menu item.
 */
import type {
  ApprovalHandler,
  ApprovalView,
  ChannelCaps,
  Settled,
} from "../approvals/types.ts"
import type { Question } from "../inbound.ts"
import type { FileJob } from "../sendfile.ts"
import type { Telemetry } from "../otel.ts"

export type Capabilities = {
  /** Answer buttons on a question. Without them the question is numbered text. */
  buttons: boolean
  /** An earlier message can be rewritten. Without it the outcome is a new message. */
  edit: boolean
  /** Toggle-and-confirm buttons for a multiple-choice question. */
  multiselect: boolean
  /** Can render a structured `card` itself (the push's plain text is then a fallback). */
  rich: boolean
  /** Messages are grouped per session (threads, topics, rooms). */
  threads: boolean
  /** The connector can bind itself to a chat through `pair()`. */
  pairing: boolean
  /** Messages typed in a session's thread may be sent to the session, and its replies are posted back (`reply`). */
  inboundPrompt: boolean
  /** Keeps an inbound message the core could not deliver and tries it again, saying so in the thread (see `Outcome.retry`). */
  retriesInbound?: boolean
  /** Can show part of a message collapsed (`turnCard`). Without it a turn card is a header and a short summary. */
  foldable?: boolean
  /** What the connector can prove for an approval: buttons, who answered, typed text. Absent: it carries none. */
  approvals?: ChannelCaps
}

export type CardQuestion = {
  header?: string
  text: string
  /** Empty when the question's details are hidden by `redact`. */
  options: Array<{ label: string; detail?: string }>
  multiple: boolean
  custom: boolean
}

/**
 * Structured content of a push, for connectors with `rich`. Already redacted;
 * the connector chooses the markup. Absent when the user overrode that kind's
 * text in `messages` or `profiles`: the configured title and message win.
 */
/** What a finished turn did. Already redacted. */
export type TurnCard = {
  failed: boolean
  /** Where the prompt of the turn came from, when known. */
  origin?: "mac" | "telegram"
  /** e.g. "3m 12s" */
  duration?: string
  /** Absent when the changes cannot be read: no number is made up. */
  changes?: { files: number; added: number; removed: number }
  summary?: string
  files: string[]
}

export type Card =
  | {
      kind: "question"
      agent: string
      project: string
      session?: string
      questions: CardQuestion[]
      /** Why the question cannot be answered here, when it cannot. */
      note?: string
    }
  | {
      kind: "permission"
      agent: string
      project: string
      session?: string
      detail: string
    }
  | {
      kind: "finished" | "failed"
      project: string
      session?: string
      /** e.g. "3m 12s" */
      duration?: string
    }
  | {
      kind: "closed"
      outcome: "answered" | "cancelled" | "withdrawn"
      /** Unknown when the prompt was answered in the TUI. */
      answer?: string
      /** Where it was answered: a connector name, or "TUI". */
      via: string
      /** At the Mac (the TUI) or in Telegram, when it is one of those. */
      origin?: "mac" | "telegram"
      /** OpenCode no longer held it when the bridge looked, so nobody saw it answered. */
      reconciled?: boolean
      /** hh:mm, local time. */
      time: string
      /** What was asked, to keep on the message. */
      quote?: string
    }
  | { kind: "notice"; text: string }

/** What a connector may show about a top-level session. */
export type SessionState = {
  id: string
  /** `<project> · <title>`, or the project alone when titles are redacted. */
  name: string
  project: string
  title?: string
  agent?: string
  model?: string
  /** The model's effort variant, when it has one chosen. */
  variant?: string
  state: "working" | "idle" | "failed"
  /** Epoch ms of the last change. */
  at: number
  /** Chatting with this session from the connector is on. */
  chat?: boolean
  /** Whether the session is mirrored: forced on through a channel, by the away rule, or off. */
  watch?: { mode: "on" | "off" | "auto"; channel: string; minutes: number }
}

/** Filled in by the connector during `send`/`update`, for the trace. */
export type SendStats = { httpStatus?: number; retries?: number }

export type Push = {
  title?: string
  message: string
  tags?: string[]
  priority?: 1 | 2 | 3 | 4 | 5
  /** The top-level session this push is about. Only set for connectors with `threads`. */
  session?: { id: string; name: string; project?: string; agent?: string }
  /** A question to offer answer buttons for. Only set for connectors with `buttons`. */
  prompt?: { id: string; questions: Question[] }
  /** Set only for connectors with `rich`. */
  card?: Card
  /** Permission buttons, only for connectors with `buttons`: the choices the policy allows (`decision` comes back on an inbound of kind `answer`). */
  permission?: { id: string; choices: Array<"once" | "always" | "reject"> }
  /** One button of the connector's own (`control` comes back as an inbound of kind `control`). Only for connectors with `buttons`. */
  action?: { label: string; control: string }
  /** Quiet hours: true delivers without a sound or notification, false makes one regardless. Unset: the connector decides. */
  silent?: boolean
  /** The connector may record transport facts here; it is never shown to anyone. */
  stats?: SendStats
}

/** A file a person sent: base64 bytes, a checked mime type, and the name to show. */
export type InboundFile = { name: string; mime: string; data: string }

/** Something a person sent through a connector. */
export type Inbound = {
  /**
   * `answer` replies to a pending question; `prompt` is text for a session;
   * `control` is a button of the connector's own (`text` is "chat off");
   * `command` is a slash command, or the pick of a menu or the reply to a question asked for one.
   */
  kind: "answer" | "prompt" | "control" | "command"
  /** Transport message id, to tell a replay from a second answer. */
  id: string
  /** Seconds since the epoch. */
  time: number
  /** The pending prompt this answers, when the sender named it (a button, `#id answer`). */
  pendingId?: string
  /** Reference of the message replied to, when the sender replied to one. */
  replyTo?: string
  /** The top-level session whose thread it was sent in, or whose message it replies to, as `push.session.id`. */
  sessionKey?: string
  text: string
  /** A permission button: what was chosen. */
  decision?: "once" | "always" | "reject"
  /** 1-based option from a button tap. */
  choice?: number
  /** `chat` identifies the sender's conversation; the connector has checked it is allowed. */
  from: { connector: string; chat: string }
  /** The sender's own id on the connector (a Telegram user id), when it is known. Set on permission buttons. */
  userId?: string
  /** The connector shows the outcome itself (a button toast): no notice message. */
  inline?: boolean
  /** `text` is a free-text answer: a number is not an option selector. */
  literal?: boolean
  /** Files sent with the message (`prompt` only), already downloaded and checked by the connector. */
  files?: InboundFile[]
  /** For `command`: the name without the slash, and the rest of the line. `pick` and `reply` are not typed: `token` names the menu or question they answer. */
  command?: { name: string; args: string }
  token?: string
}

/** Choices to tap. The connector pages them; what comes back is always one of `choices`. */
export type Menu = {
  id: string
  choices: Array<{ label: string; value: string; current?: boolean }>
}

export type Outcome = {
  ok: boolean
  /** May hold `{topic:<session id>}`, which the connector turns into a link to that session's topic. */
  text: string
  /** Show these choices; the tap comes back as a `pick` command with this id. */
  menu?: Menu
  /** Ask for text; the reply comes back as a `reply` command with this id. */
  ask?: { id: string }
  /** The text of a message was sent to a session: the connector may acknowledge it. */
  sent?: boolean
  /** The message could not be delivered now and may be again: the connector keeps it and tries later. */
  retry?: boolean
  /** With `sent`: which agent got it, and whether it went in at once, waited or was steered in. */
  delivered?: { agent?: string; how: "sent" | "queued" | "steered" }
}

/** Resolves undefined for input that is silently ignored. */
export type OnInbound = (m: Inbound) => Promise<Outcome | undefined>

export type ConnectorStatus = {
  connected?: boolean
  lastError?: string
  /** Epoch ms of the last answer from the channel to a poll, and of the last message or edit it accepted. */
  pollOkAt?: number
  sendOkAt?: number
  /** How long the receive loop has made no progress, while it is running and not waiting for a token. */
  silentMs?: number
  /** A standing condition worth showing, such as a missing permission. */
  warning?: string
}

export type Pairing = {
  /** One-time code the person gives the connector. */
  code: string
  /** Opens the connector with the code applied; the TUI renders it as a QR code. */
  link?: string
  /** Other ways in, shown as links beside `link` (for example "add to a group"). */
  links?: Array<{ label: string; url: string }>
  /** Epoch ms. */
  expiresAt: number
  /** Short instruction for the dialog. */
  hint?: string
  /** True once paired, false when the code expired or was replaced. */
  done: Promise<boolean>
}

export interface Connector {
  /** Instance name, from the config key. */
  readonly id: string
  readonly type: string
  readonly capabilities: Capabilities
  enabled: boolean
  /** Starts receiving; returns at once. `openSince` is the ms time of the oldest unanswered prompt. */
  start(onInbound: OnInbound, signal: AbortSignal, openSince?: number): void
  /** How to answer this question here, for the `{{hint}}` placeholder. */
  hint(id: string, questions: Question[]): string
  /** Which of the session-end pushes this connector wants. Both when unset. */
  readonly notify?: { finished: boolean; failed: boolean }
  /** Shows the reply being written: all of its text so far. Only with `inboundPrompt`; never throws. */
  stream?(
    session: NonNullable<Push["session"]>,
    text: string,
    /** Shortest time between two edits, in ms. */
    gapMs?: number,
    /** Most edits a minute. */
    budget?: number,
    /** The assistant message the text belongs to. A different one is a later step: what was shown stays, and the new text goes in new messages. */
    step?: string,
  ): void
  /** Posts the final text of a turn to the session's thread. Only with `inboundPrompt`; never throws. */
  reply?(
    session: NonNullable<Push["session"]>,
    text: string,
  ): Promise<{ parts: number; documents: number } | undefined>
  /** A link that opens the session's topic, when it has one. */
  topicLink?(sessionID: string): string | undefined
  /** Redraws the session's status card now and pins it again. Never throws. */
  refresh?(sessionID: string): Promise<boolean>
  /** Keeps a live view of a session (a status card, a topic title). Never throws. */
  track?(state: SessionState): Promise<void>
  /** Returns a reference to the sent message; never throws. */
  send(push: Push): Promise<string | undefined>
  /** Rewrites an earlier message; true when it did. Never throws. Required when `capabilities.edit`. */
  update?(ref: string, push: Push): Promise<boolean>
  /** Posts a turn card with Diff, Continue (when `chat`) and Stop buttons. Only with `foldable`; never throws. */
  turnCard?(
    session: NonNullable<Push["session"]>,
    card: TurnCard,
    o: { chat: boolean },
  ): Promise<string | undefined>
  /**
   * A message that waited behind a question was sent after all (or could not be): shows it on the
   * message and on the menu that held it. Ignores a menu it does not know. Never throws.
   */
  heldReleased?(
    menuId: string,
    o: {
      how: "sent" | "queued" | "steered" | "failed"
      agent?: string
      text: string
    },
  ): Promise<void>
  /** Removes the buttons of an earlier message. Never throws. */
  unbutton?(ref: string): Promise<void>
  /** Sends a file to the session's thread; true when it did. Never throws. */
  document?(
    session: NonNullable<Push["session"]>,
    name: string,
    data: string,
    caption: string,
  ): Promise<boolean>
  /**
   * Sends a file the agent asked for to the thread this session already has, never creating one and never
   * falling back to the main chat. Never throws; `error` is short and safe to show the agent.
   */
  file?(
    session: NonNullable<Push["session"]>,
    file: FileJob,
    caption: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>
  /** Sends images as one album (one image alone as a photo) with a caption; true when it did. Never throws. */
  photos?(
    session: NonNullable<Push["session"]>,
    images: Uint8Array[],
    caption: string,
  ): Promise<boolean>
  /** Tells the connector how to ask whether it is quiet hours, for messages that are not pushes (replies, files). */
  silence?(isQuiet: () => boolean): void
  /** Sets the commands the chat offers after "/". Registered when it differs from the last list. */
  menu?(commands: MenuCommand[]): void
  /** The user id stored at pairing: the only person whose tap or code answers an approval. Undefined until known. */
  operator?(): string | undefined
  /** Tells the connector where the Mini App is, so it can offer it. Called once at start. */
  launch?(app: { url: string; link?: string }): void
  /** Whether the Mini App can be opened from this chat, so a second factor can be asked there. */
  appOpen?(): boolean
  /** Where the taps and typed codes of approvals go. Only with `capabilities.approvals`. */
  onApproval?(h: ApprovalHandler): void
  /** Posts an approval request with Approve and Deny; the reference of the message. Never throws. */
  approvalRequest?(v: ApprovalView): Promise<string | undefined>
  /** Asks, in the same chat, for the one-time code; the reference of the prompt. Never throws. */
  approvalCode?(v: ApprovalView): Promise<string | undefined>
  /** Rewrites an approval message to its final state and removes the buttons. Never throws. */
  approvalSettle?(ref: string, v: ApprovalView, s: Settled): Promise<void>
  /** Deletes one message, best effort. Never throws. */
  deleteMessage?(ref: string): Promise<void>
  /** Required when `capabilities.pairing`. */
  pair?(): Promise<Pairing>
  status(): ConnectorStatus
}

export type { MenuCommand } from "../commandmenu.ts"
import type { MenuCommand } from "../commandmenu.ts"

/** Per-connector state kept in the data directory, layered over the config file. */
export type ConnectorSettings = { enabled?: boolean } & Record<string, unknown>

export type ConnectorEnv = {
  /** Instance name. */
  name: string
  /** The data directory, for files of the connector's own. */
  dir: string
  tel: Telemetry
  settings: {
    get(): ConnectorSettings
    set(patch: ConnectorSettings): void
  }
}

/** A connector type: how to validate its options and how to build it. */
export interface ConnectorType<O = unknown> {
  /** Top-level config keys that mean this type's options in the pre-`channels` config form. */
  legacyKeys?: readonly string[]
  /** `raw` is the config object of one instance, including `type` and `enabled`. */
  parse(raw: Record<string, unknown>, at: string): O | { error: string }
  create(env: ConnectorEnv, options: O): Connector
}
