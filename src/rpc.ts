/**
 * What the server half and the TUI half say to each other. The server half
 * owns the bridge; a TUI reads a snapshot of it and sends it commands.
 */
import type { Rpc } from "@opencode/plugin"

import type { NightView } from "./overnight.ts"
import type { Afk } from "./settings.ts"

export const RPC_ID = "oob-bridge"

const json = { type: "object" } as const

export const definition = {
  id: RPC_ID,
  methods: {
    /** A TUI's heartbeat: who it is and when its operator last gave input. Answers with the snapshot. */
    status: { input: json, output: json },
    /** One command: `{ op, args }`. Answers with `OpResult`. */
    op: { input: json, output: json },
    /** A TUI finished a form reply the server asked it to make. */
    formDone: { input: json, output: json },
  },
  events: {
    /** Asks a TUI to reply to a form: the server has no form API of its own. */
    form: { schema: json },
  },
} as const satisfies Rpc.PortableDefinition

export type SessionRow = {
  id: string
  name?: string
  title?: string
  agent?: string
  project?: string
  mode: "on" | "off" | "auto"
  channel?: string
  chat: boolean
  delivery: "queue" | "steer"
  deliveryOverride?: "queue" | "steer"
  busy: boolean
  /** The channel it mirrors through: its own choice, or the default. */
  channelOf: string
  /** Why chat is denied by `chat.deny`, if it is. */
  blocked?: string
  /** A selected channel can carry a chat. */
  canChat: boolean
  /** Questions and permissions waiting for an answer. */
  prompts: Array<{
    id: string
    sessionID: string
    kind: "question" | "permission"
    title: string
    askedAt: number
  }>
}

/** A session with messages it is not working on. */
export type StuckRow = {
  id: string
  title?: string
  pending: number
  /** Epoch ms of the oldest waiting message, or of the suspension. */
  since: number
  source: "events" | "db"
  alerted: boolean
}

export type ChannelRow = {
  id: string
  enabled: boolean
  pairing: boolean
  inboundPrompt: boolean
  connected?: boolean
  lastError?: string
  warning?: string
}

export type Snapshot = {
  /** Grows with every change, so a view can tell a new snapshot from the one it has. */
  v: number
  at: number
  owner: { pid: number; startedAt: number; version: string; id?: string }
  /** What is on disk, and what each attached TUI says it runs. */
  versions: { installed?: string; tuis: string[] }
  afk: {
    mode: Afk
    away: boolean
    minutes: number
    lastInputAt: number
    tuis: number
    /** When a timed "on" ends. */
    until?: number
  }
  /** The overnight plan, once there has been one. */
  night?: NightView
  /** What happened while the operator was away, for a minute after they come back. */
  back?: { id: number; text: string; at: number }
  channels: ChannelRow[]
  pending: number
  sessions: SessionRow[]
  stuck: StuckRow[]
  events: { seen: number; lastAt?: number }
  /** The core API listener, when the controller knows of one. */
  core?: {
    state: "off" | "listening" | "refused"
    address?: string
    reason?: string
  }
  /** The relay link: not configured (absent), refused, down or up, and since when. */
  link?: {
    state: "off" | "refused" | "down" | "up"
    since?: number
    reason?: string
  }
  defaultSidebar: "full" | "compact" | "off"
  defaultChannel: string
  defaultDelivery: "queue" | "steer"
}

export type OpResult = {
  ok: boolean
  text?: string
  data?: unknown
  snapshot: Snapshot
}

export type FormRelay = {
  token: string
  sessionID: string
  formID: string
  answer: unknown
  /** `undo`: the window stages a revert to `messageID` instead of replying to a form. */
  kind?: "undo"
  messageID?: string
}
