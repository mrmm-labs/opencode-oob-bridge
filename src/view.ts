/**
 * What the TUI shows and does, as an interface. The remote pilot (src/remote.ts)
 * implements it from the server half's snapshot; the menu and the sidebar read
 * only this.
 */
import type { Pairing } from "./connectors/types.ts"
import type { Delivery, SidebarMode } from "./config.ts"
import type { OpResult, Snapshot } from "./rpc.ts"
import type { NightView } from "./overnight.ts"
import type { Afk } from "./settings.ts"

export type ChannelView = {
  id: string
  enabled: boolean
  capabilities: { pairing: boolean; inboundPrompt: boolean }
  /** Set when the channel can be paired. */
  pair?: unknown
}

export type PromptView = {
  id: string
  /** The session that asked: the root, or a subagent. */
  sessionID: string
  kind: "question" | "permission"
  title: string
  askedAt: number
}

export type Outcome = { ok: boolean; text: string }

export interface Pilot {
  /** Records input in this window. */
  touch(): void
  /** Calls `fn` when something a view shows may have changed. */
  subscribe(fn: () => void): () => void
  /** Asks the server half for a fresh snapshot now. */
  refresh(): Promise<void>
  /** Something local changed: tell the subscribers. */
  notify(): void

  connectors(): readonly ChannelView[]
  status(): {
    channels: Array<{
      id: string
      enabled: boolean
      connected?: boolean
      lastError?: string
      warning?: string
    }>
    pending: number
  }
  defaultChannel(): string
  defaultDelivery(): Delivery
  defaultSidebar(): SidebarMode
  awayMinutes(): number

  mode(root: string): "on" | "off" | "auto"
  channel(root: string): string | undefined
  channelOf(root: string): string
  chatEnabled(root: string): boolean
  chatBlocked(root: string): string | undefined
  canChat(root: string): boolean
  delivery(root: string): Delivery
  deliveryOverride(root: string): Delivery | undefined
  openPromptList(root: string): PromptView[]

  route(
    root: string,
    mode: "on" | "off" | "auto",
    channel?: string,
  ): Promise<Outcome>
  setChat(root: string, on: boolean): Promise<Outcome>
  setDelivery(root: string, d: Delivery | undefined): Promise<Outcome>
  setEnabled(id: string, on: boolean): Promise<Outcome>
  test(): Promise<Array<{ id: string; ok: boolean }>>
  pair(id: string): Promise<Pairing | undefined>

  /** The bridge's own state: who runs it, how the operator counts as away, which sessions are stuck, which are watched. */
  instance(): InstanceView | undefined
  /** `span` (8h) limits a forced `on`. */
  setAfk(mode: Afk, span?: string): Promise<Outcome>
  /** The overnight plan: add a brief, start, end, clear or status. The TUI only: a chat can end a plan, never start one. */
  overnight(args: Record<string, unknown>): Promise<Outcome>
  resume(root: string): Promise<Outcome>
  restart(): Promise<Outcome>
  /** The core API: its state, or a new token. */
  core(action: "status" | "rotate"): Promise<OpResult | undefined>
  /** One line for each place two versions differ; empty when all match. */
  versionWarnings(): string[]
  /** The `/oob version` lines; undefined when the bridge does not answer. */
  versionLines(): Promise<string[] | undefined>
}

export type InstanceView = {
  online: boolean
  owner?: { pid: number; startedAt: number; version: string }
  versions?: { installed?: string; tuis: string[] }
  afk?: {
    mode: Afk
    away: boolean
    minutes: number
    tuis: number
    lastInputAt: number
    until?: number
  }
  night?: NightView
  core?: Snapshot["core"]
  eventsSeen?: number
  lastEventAt?: number
  sessions: Array<{
    id: string
    name?: string
    title?: string
    mode: "on" | "off" | "auto"
    channel?: string
    chat: boolean
    busy: boolean
  }>
  stuck: Array<{
    id: string
    title?: string
    pending: number
    since: number
    source: "events" | "db"
  }>
}
