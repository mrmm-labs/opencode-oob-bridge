/**
 * The TUI's pilot of the bridge that runs in the server. It polls the server
 * half for a snapshot (which also tells it this window is alive and when its
 * operator last gave input), answers the views from that snapshot, and sends
 * commands. It holds no bridge logic.
 */
import { randomUUID } from "node:crypto"

import type { Delivery, SidebarMode } from "./config.ts"
import type { Pairing } from "./connectors/types.ts"
import { log } from "./logger.ts"
import type { FormRelay, OpResult, SessionRow, Snapshot } from "./rpc.ts"
import type { Afk } from "./settings.ts"
import { isObject } from "./util.ts"
import type {
  ChannelView,
  InstanceView,
  Outcome,
  Pilot,
  PromptView,
} from "./view.ts"

export type Transport = (
  method: "status" | "op" | "formDone",
  input: Record<string, unknown>,
) => Promise<unknown>

export const POLL_MS = 3000
const PAIR_POLL_MS = 500
const OFFLINE =
  "The bridge is not running in the OpenCode server. Check that the plugin is installed for the server and that oob-bridge.jsonc is valid."

export class Remote implements Pilot {
  readonly id = randomUUID().slice(0, 8)
  private readonly call: Transport
  private readonly now: () => number
  private readonly roots: () => string[]
  private readonly pollMs: number
  private snap: Snapshot | undefined
  private key = ""
  private online = false
  private lastInput: number
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly listeners = new Set<() => void>()

  constructor(o: {
    call: Transport
    now?: () => number
    roots?: () => string[]
    pollMs?: number
  }) {
    this.call = o.call
    this.now = o.now ?? Date.now
    this.roots = o.roots ?? (() => [])
    this.pollMs = o.pollMs ?? POLL_MS
    this.lastInput = this.now()
  }

  refresh(): Promise<void> {
    return this.poll()
  }

  start(): Promise<void> {
    this.timer = setInterval(() => void this.poll(), this.pollMs)
    this.timer.unref?.()
    return this.poll()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async poll(): Promise<void> {
    try {
      this.take(
        (await this.call("status", {
          tui: this.id,
          inputAt: this.lastInput,
          roots: this.roots(),
        })) as Snapshot,
      )
    } catch (err) {
      if (this.online)
        log("bridge_unreachable", { message: (err as Error).message })
      if (this.online || this.snap) {
        this.online = false
        this.emit()
      }
    }
  }

  private take(s: Snapshot | undefined): void {
    if (!isObject(s) || !Array.isArray(s.sessions)) return
    const key = JSON.stringify({ ...s, at: 0 })
    const changed = key !== this.key || !this.online
    this.snap = s
    this.key = key
    this.online = true
    if (changed) this.emit()
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch (err) {
        log("listener_error", { message: (err as Error).message })
      }
    }
  }

  private async op(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<OpResult | undefined> {
    try {
      const r = (await this.call("op", { op: name, args })) as OpResult
      this.take(r.snapshot)
      return r
    } catch (err) {
      log("op_unreachable", { op: name, message: (err as Error).message })
      return undefined
    }
  }

  private async act(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<Outcome> {
    const r = await this.op(name, args)
    return r ? { ok: r.ok, text: r.text ?? "" } : { ok: false, text: OFFLINE }
  }

  private row(root: string): SessionRow | undefined {
    return this.snap?.sessions.find((s) => s.id === root)
  }

  touch(): void {
    this.lastInput = this.now()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /** Something local changed (the sidebar size): redraw. */
  notify(): void {
    this.emit()
  }

  connectors(): readonly ChannelView[] {
    return (this.snap?.channels ?? []).map((c) => ({
      id: c.id,
      enabled: c.enabled,
      capabilities: { pairing: c.pairing, inboundPrompt: c.inboundPrompt },
      pair: c.pairing ? true : undefined,
    }))
  }

  status() {
    return {
      channels: this.snap?.channels ?? [],
      pending: this.snap?.pending ?? 0,
    }
  }

  defaultChannel = () => this.snap?.defaultChannel ?? "all"
  defaultDelivery = (): Delivery => this.snap?.defaultDelivery ?? "queue"
  defaultSidebar = (): SidebarMode => this.snap?.defaultSidebar ?? "full"
  awayMinutes = () => this.snap?.afk.minutes ?? 10

  mode = (root: string) => this.row(root)?.mode ?? "auto"
  channel = (root: string) => this.row(root)?.channel
  channelOf = (root: string) =>
    this.row(root)?.channelOf ?? this.defaultChannel()
  chatEnabled = (root: string) => this.row(root)?.chat ?? false
  chatBlocked = (root: string) => this.row(root)?.blocked
  canChat = (root: string) => this.row(root)?.canChat ?? false
  delivery = (root: string): Delivery =>
    this.row(root)?.delivery ?? this.defaultDelivery()
  deliveryOverride = (root: string) => this.row(root)?.deliveryOverride
  openPromptList = (root: string): PromptView[] => this.row(root)?.prompts ?? []

  route(root: string, mode: "on" | "off" | "auto", channel?: string) {
    return this.act("route", { root, mode, channel })
  }
  setChat(root: string, on: boolean) {
    return this.act("chat", { root, on })
  }
  setDelivery(root: string, d: Delivery | undefined) {
    return this.act("delivery", { root, delivery: d })
  }
  setEnabled(id: string, on: boolean) {
    return this.act("enable", { id, on })
  }
  setAfk(mode: Afk) {
    return this.act("afk", { mode })
  }
  resume(root: string) {
    return this.act("resume", { root })
  }
  restart() {
    return this.act("restart")
  }
  /** The core API: its state, or a new token. */
  core(action: "status" | "rotate") {
    return this.op("core", { action })
  }

  async test(): Promise<Array<{ id: string; ok: boolean }>> {
    const r = await this.op("test")
    return Array.isArray(r?.data)
      ? (r.data as Array<{ id: string; ok: boolean }>)
      : []
  }

  async pair(id: string): Promise<Pairing | undefined> {
    const r = await this.op("pair", { id })
    if (!r?.ok || !isObject(r.data)) return undefined
    const p = r.data as Omit<Pairing, "done">
    const done = (async () => {
      while (this.now() < p.expiresAt + 5000) {
        await new Promise((res) => setTimeout(res, PAIR_POLL_MS).unref?.())
        const d = await this.op("pairDone", { id })
        const v = isObject(d?.data) ? d.data.done : undefined
        if (typeof v === "boolean") return v
      }
      return false
    })()
    return { ...p, done }
  }

  instance(): InstanceView | undefined {
    const s = this.snap
    if (!s) return { online: false, sessions: [], stuck: [] }
    return {
      online: this.online,
      owner: s.owner,
      afk: s.afk,
      core: s.core,
      eventsSeen: s.events.seen,
      lastEventAt: s.events.lastAt,
      sessions: s.sessions.map((x) => ({
        id: x.id,
        name: x.name,
        title: x.title,
        mode: x.mode,
        channel: x.channel,
        chat: x.chat,
        busy: x.busy,
      })),
      stuck: s.stuck,
    }
  }
}

/**
 * The server has no form-reply call; it asks a window to make it. This handles
 * that request for the window it names, and says how it went.
 */
export function formRelay(o: {
  id: string
  call: Transport
  reply: (r: {
    sessionID: string
    formID: string
    answer: never
  }) => Promise<void>
  undo?: (r: { sessionID: string; messageID: string }) => Promise<void>
}): (event: { data?: unknown }) => void {
  // The server emits through every location of the process; a window acts once.
  const seen = new Set<string>()
  return (event) => {
    const d = event.data
    if (!isObject(d) || d.to !== o.id) return
    const r = d as unknown as FormRelay
    if (seen.has(r.token)) return
    seen.add(r.token)
    const act =
      r.kind === "undo" && o.undo
        ? o.undo({ sessionID: r.sessionID, messageID: r.messageID ?? "" })
        : o.reply({
            sessionID: r.sessionID,
            formID: r.formID,
            answer: r.answer as never,
          })
    void act
      .then(
        () => o.call("formDone", { token: r.token, ok: true }),
        (err: Error) =>
          o.call("formDone", { token: r.token, ok: false, error: err.message }),
      )
      .catch((err: Error) => log("form_relay_error", { message: err.message }))
  }
}
