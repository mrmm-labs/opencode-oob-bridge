/**
 * The dead-man receiver. It judges silence with its own clock, from heartbeats
 * that arrive on the link or on POST /beat, and talks to Telegram through
 * `sendMessage` only. After a restart it says nothing until the first beat.
 */
import { log } from "./log.ts"

export type Beat = {
  state: "up" | "degraded" | "stopping"
  reasons: string[]
  seq?: number
}

const REASON = /^[A-Za-z0-9_:.-]{1,64}$/

/** The fields the receiver reads from a heartbeat, or undefined when it is not one. */
export function parseBeat(x: unknown): Beat | undefined {
  if (typeof x !== "object" || x === null) return undefined
  const b = x as Record<string, unknown>
  if (b.state !== "up" && b.state !== "degraded" && b.state !== "stopping")
    return undefined
  const reasons = Array.isArray(b.reasons)
    ? b.reasons
        .filter((r): r is string => typeof r === "string" && REASON.test(r))
        .slice(0, 8)
    : []
  return {
    state: b.state,
    reasons,
    seq:
      typeof b.seq === "number" && Number.isFinite(b.seq) ? b.seq : undefined,
  }
}

export type Sender = (text: string) => Promise<boolean>

export type Shown = "unknown" | "up" | "degraded" | "stopping" | "silent"
export const SHOWN: readonly Shown[] = [
  "unknown",
  "up",
  "degraded",
  "stopping",
  "silent",
]

const RETRY_MS = 30_000
const MAX_TRIES = 10

type Options = {
  now: () => number
  send: Sender
  intervalMs: number
  missed: number
  stoppingMs: number
  reminderMs: number
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000))

export class Deadman {
  private readonly o: Options
  private lastAt: number | undefined
  private last: Beat["state"] | undefined
  private windowMs: number
  private streak = 0
  private reasons: string[] = []
  private outage: { kind: "silent" | "degraded"; at: number } | undefined
  private queue: Array<{ text: string; tries: number }> = []
  private lastTry = 0
  private flushing = false
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(o: Options) {
    this.o = o
    this.windowMs = o.missed * o.intervalMs
  }

  start(everyMs = 1000): void {
    this.timer = setInterval(() => void this.tick(), everyMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  beat(b: Beat): void {
    const t = this.o.now()
    this.lastAt = t
    this.last = b.state
    this.windowMs =
      b.state === "stopping"
        ? this.o.stoppingMs
        : this.o.missed * this.o.intervalMs
    this.reasons = b.reasons
    if (b.state === "up") {
      this.streak = 0
      if (this.outage) {
        this.outage = undefined
        this.say("Recovered: the bridge is sending heartbeats again.")
      }
    } else if (b.state === "degraded") {
      this.streak++
      if (this.streak >= 2) {
        if (!this.outage) {
          this.outage = { kind: "degraded", at: t }
          this.say(
            "Bridge degraded: " +
              (this.reasons.join(", ") || "no reason given"),
          )
        } else if (this.outage.kind === "silent")
          this.outage = { kind: "degraded", at: this.outage.at }
      }
    } else this.streak = 0
  }

  async tick(): Promise<void> {
    const t = this.o.now()
    if (this.lastAt !== undefined) {
      if (t - this.lastAt > this.windowMs) {
        if (!this.outage) {
          this.outage = { kind: "silent", at: t }
          this.say(
            this.last === "stopping"
              ? `The bridge stopped on purpose and did not come back within ${minutes(this.windowMs)} min.`
              : `No heartbeat from the bridge for ${minutes(t - this.lastAt)} min.`,
          )
        } else if (this.outage.kind === "degraded") {
          this.outage = { kind: "silent", at: t }
          this.say(
            `No heartbeat from the bridge any more (it was degraded: ${this.reasons.join(", ") || "no reason given"}).`,
          )
        }
      }
      if (this.outage && t - this.outage.at >= this.o.reminderMs) {
        this.outage.at = t
        this.say(
          this.outage.kind === "silent"
            ? "Still down: no heartbeat."
            : "Still degraded: " +
                (this.reasons.join(", ") || "no reason given") +
                ".",
        )
      }
    }
    await this.flush()
  }

  shown(): Shown {
    const t = this.o.now()
    if (this.lastAt === undefined || this.last === undefined) return "unknown"
    if (t - this.lastAt > this.windowMs) return "silent"
    return this.last
  }

  lastBeatAt(): number | undefined {
    return this.lastAt
  }

  consecutiveMissed(): number {
    if (this.lastAt === undefined) return 0
    return Math.max(
      0,
      Math.floor((this.o.now() - this.lastAt) / this.o.intervalMs),
    )
  }

  private say(text: string): void {
    log("alert", { kind: this.outage?.kind ?? "recovered" })
    this.queue.push({ text, tries: 0 })
    void this.flush()
  }

  /** Sends in order; a message that fails is tried again every 30 seconds, ten times at most. */
  private async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return
    const t = this.o.now()
    if (this.queue[0].tries > 0 && t - this.lastTry < RETRY_MS) return
    this.flushing = true
    try {
      while (this.queue.length) {
        const m = this.queue[0]
        this.lastTry = this.o.now()
        m.tries++
        const ok = await this.o.send(m.text).catch(() => false)
        if (ok || m.tries >= MAX_TRIES) {
          if (!ok) log("alert_dropped")
          this.queue.shift()
        } else break
      }
    } finally {
      this.flushing = false
    }
  }
}

/**
 * Alerts through the Bot API's `sendMessage` and nothing else. The token is in
 * the URL, so a failure logs the status or the error name, never the URL.
 */
export function telegramSender(o: {
  token?: string
  chatId?: string
  apiBase: string
  fetch?: typeof fetch
}): Sender {
  const { token, chatId } = o
  if (!token || !chatId) {
    return async () => {
      log("alert_unsent", { why: "no alert bot configured" })
      return true
    }
  }
  return async (text) => {
    try {
      const res = await (o.fetch ?? fetch)(
        `${o.apiBase}/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      )
      await res.body?.cancel()
      if (!res.ok) log("alert_send_failed", { status: res.status })
      return res.ok
    } catch (err) {
      log("alert_send_failed", { error: (err as Error).name || "error" })
      return false
    }
  }
}
