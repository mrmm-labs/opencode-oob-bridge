/**
 * The dead-man's switch: the owning bridge tells a receiver it is alive, every
 * few seconds. The receiver, not the bridge, notices silence. Nothing here
 * waits on anything else in the bridge, and a failed send is only logged.
 */
import { randomUUID } from "node:crypto"

import { log } from "./logger.ts"

export const DEFAULT_INTERVAL_S = 30
const SEND_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 3_000

export type State = "up" | "degraded" | "stopping"

export type Health = {
  state: "up" | "degraded"
  reasons: string[]
  channels: Record<string, boolean>
}

/** Everything a heartbeat says: no titles, paths, chat ids, usernames or text. */
export type Heartbeat = {
  v: 1
  id: string
  seq: number
  /** For display only: the receiver judges silence with its own clock. */
  at: number
  state: State
  reasons: string[]
  version: string
  pid: number
  channels: Record<string, boolean>
}

/** Why a URL cannot be used for heartbeats, or undefined when it can: https, or http on loopback. */
export function urlProblem(url: string): string | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return "not a URL"
  }
  if (u.protocol === "https:") return undefined
  const host = u.hostname.replace(/^\[|\]$/g, "")
  const loopback =
    host === "localhost" || host === "::1" || /^127(\.\d+){3}$/.test(host)
  if (u.protocol === "http:" && loopback) return undefined
  return "must be https (http is allowed on loopback only)"
}

/** True when the value holds only what JSON can carry: the host refuses an `undefined` key. */
export function jsonOnly(v: unknown, seen = new Set<unknown>()): boolean {
  if (v === null) return true
  switch (typeof v) {
    case "string":
    case "boolean":
      return true
    case "number":
      return Number.isFinite(v)
    case "object": {
      if (seen.has(v)) return false
      seen.add(v)
      const ok = Array.isArray(v)
        ? v.every((x) => jsonOnly(x, seen))
        : Object.values(v as object).every((x) => jsonOnly(x, seen))
      seen.delete(v)
      return ok
    }
    default:
      return false
  }
}

export type CheckInput = {
  /** The answer the TUI's status call gives, from the same code path. */
  snapshot(): unknown
  rpcRegistered(): boolean
  lockHeld(): Promise<boolean>
  channels(): Array<{ id: string; enabled: boolean; connected?: boolean }>
}

/** Runs the checks; any failure is a reason code. A check that throws is `check_failed`. */
export async function selfCheck(i: CheckInput): Promise<Health> {
  const reasons: string[] = []
  const channels: Record<string, boolean> = {}
  try {
    try {
      if (!jsonOnly(i.snapshot())) reasons.push("snapshot_invalid")
    } catch {
      reasons.push("snapshot_invalid")
    }
    if (!i.rpcRegistered()) reasons.push("rpc_missing")
    if (!(await i.lockHeld())) reasons.push("lock_lost")
    for (const c of i.channels()) {
      if (!c.enabled) continue
      // A channel that has no notion of being connected counts as connected.
      channels[c.id] = c.connected !== false
      if (!channels[c.id]) reasons.push("channel_down:" + c.id)
    }
  } catch {
    return { state: "degraded", reasons: ["check_failed"], channels }
  }
  return { state: reasons.length ? "degraded" : "up", reasons, channels }
}

export type DeadmanOptions = {
  url: string
  token: string
  intervalMs: number
  version: string
  check(): Promise<Health>
  fetch?: typeof fetch
  now?: () => number
}

export class Deadman {
  private readonly o: DeadmanOptions
  private readonly id = randomUUID()
  private seq = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private inflight = false
  private outcome = ""

  constructor(o: DeadmanOptions) {
    this.o = o
  }

  /** Whether the receiver took the last heartbeat. */
  acknowledged(): boolean {
    return this.outcome === "ok"
  }

  start(): void {
    if (this.timer) return
    void this.beat()
    this.timer = setInterval(() => void this.beat(), this.o.intervalMs)
    this.timer.unref?.()
  }

  /** Says `stopping`, so a planned stop is not an outage. Waits a few seconds at most. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.beat("stopping", STOP_TIMEOUT_MS)
  }

  /** One heartbeat. A send still in flight is not queued behind: its successor is skipped. */
  async beat(state?: "stopping", timeoutMs = SEND_TIMEOUT_MS): Promise<void> {
    if (this.inflight && !state) return
    this.inflight = true
    try {
      let h: Health
      try {
        h = state
          ? { state: "up", reasons: [], channels: {} }
          : await this.o.check()
      } catch {
        h = { state: "degraded", reasons: ["check_failed"], channels: {} }
      }
      const beat: Heartbeat = {
        v: 1,
        id: this.id,
        seq: ++this.seq,
        at: (this.o.now ?? Date.now)(),
        state: state ?? h.state,
        reasons: h.reasons,
        version: this.o.version,
        pid: process.pid,
        channels: h.channels,
      }
      await this.send(beat, timeoutMs)
    } finally {
      this.inflight = false
    }
  }

  private async send(beat: Heartbeat, timeoutMs: number): Promise<void> {
    let outcome: string
    try {
      const res = await (this.o.fetch ?? fetch)(this.o.url, {
        method: "POST",
        headers: {
          authorization: "Bearer " + this.o.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(beat),
        signal: AbortSignal.timeout(timeoutMs),
      })
      await res.body?.cancel()
      outcome = res.ok ? "ok" : "http_" + res.status
    } catch (err) {
      outcome = "error_" + ((err as Error).name || "unknown")
    }
    if (outcome !== this.outcome) {
      this.outcome = outcome
      log("deadman", { outcome, state: beat.state, seq: beat.seq })
    }
  }
}
