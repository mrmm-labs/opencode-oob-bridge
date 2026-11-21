/** Per-client request rate and in-flight counts. */

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  private readonly perSecond: number
  private readonly burst: number
  private readonly now: () => number

  constructor(perSecond: number, burst: number, now: () => number = Date.now) {
    this.perSecond = perSecond
    this.burst = burst
    this.now = now
  }

  /** True when the client may go on. */
  take(key: string): boolean {
    const t = this.now()
    if (this.buckets.size > 10_000) this.prune(t)
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: t }
    b.tokens = Math.min(
      this.burst,
      b.tokens + ((t - b.at) / 1000) * this.perSecond,
    )
    b.at = t
    const ok = b.tokens >= 1
    if (ok) b.tokens -= 1
    this.buckets.set(key, b)
    return ok
  }

  private prune(t: number) {
    for (const [k, b] of this.buckets)
      if (t - b.at > 60_000) this.buckets.delete(k)
  }
}

/** Counts requests being served, per client and in total. */
export class InFlight {
  private readonly per = new Map<string, number>()
  private all = 0
  private readonly perClient: number
  private readonly total: number

  constructor(perClient: number, total: number) {
    this.perClient = perClient
    this.total = total
  }

  /** "client", "total", or a release function. */
  enter(key: string): "client" | "total" | (() => void) {
    const n = this.per.get(key) ?? 0
    if (n >= this.perClient) return "client"
    if (this.all >= this.total) return "total"
    this.per.set(key, n + 1)
    this.all++
    let done = false
    return () => {
      if (done) return
      done = true
      this.all--
      const m = (this.per.get(key) ?? 1) - 1
      if (m <= 0) this.per.delete(key)
      else this.per.set(key, m)
    }
  }

  count(): number {
    return this.all
  }
}
