/**
 * A reference receiver: the contract a real one follows. It judges silence with
 * its own clock and talks to Telegram through `sendMessage` only.
 */
import type { Heartbeat } from "./deadman.ts"

export type Telegram = { sendMessage(text: string): void }

const REMINDER_MS = 30 * 60_000
const STOPPING_MS = 5 * 60_000

export class Receiver {
  private readonly tg: Telegram
  private readonly now: () => number
  private readonly windowMs: number
  private lastAt: number
  private window: number
  private streak = 0
  private alertedAt: number | undefined
  private reasons: string[] = []

  constructor(o: {
    telegram: Telegram
    now: () => number
    intervalMs?: number
    missed?: number
  }) {
    this.tg = o.telegram
    this.now = o.now
    this.windowMs = (o.missed ?? 3) * (o.intervalMs ?? 30_000)
    this.window = this.windowMs
    this.lastAt = o.now()
  }

  beat(p: Heartbeat): void {
    this.lastAt = this.now()
    this.window = p.state === "stopping" ? STOPPING_MS : this.windowMs
    this.reasons = p.reasons
    if (p.state === "up") {
      this.streak = 0
      if (this.alertedAt !== undefined) {
        this.alertedAt = undefined
        this.tg.sendMessage(
          "Recovered: the bridge is sending heartbeats again.",
        )
      }
      return
    }
    if (p.state === "degraded") {
      this.streak++
      if (this.streak >= 2 && this.alertedAt === undefined) {
        this.alertedAt = this.now()
        this.tg.sendMessage("Bridge degraded: " + p.reasons.join(", "))
      }
    }
  }

  /** Called on a timer by the receiver. */
  tick(): void {
    const t = this.now()
    if (this.alertedAt === undefined) {
      if (t - this.lastAt > this.window) {
        this.alertedAt = t
        this.tg.sendMessage("No heartbeat from the bridge.")
      }
    } else if (t - this.alertedAt >= REMINDER_MS) {
      this.alertedAt = t
      this.tg.sendMessage(
        "Still down: " + (this.reasons.join(", ") || "no heartbeat") + ".",
      )
    }
  }
}
