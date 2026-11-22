/** A diagnostic line the app sends: a short event name and a few short fields, never a credential. */

const NAME = /^[a-z0-9_]{1,40}$/
const KEY = /^[a-z0-9_]{1,24}$/
const MAX_FIELDS = 12
const MAX_TEXT = 200
const INIT_DATA = /hash=|auth_date|query_id=/i

/** The text with each control character turned into a space. */
const plain = (s: string) =>
  [...s]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
    .join("")

export type AppLine = {
  event: string
  data: Record<string, string | number | boolean>
}

/** The line to log, or undefined when the body is not one. Odd fields are dropped, not rejected. */
export function appLine(body: Record<string, unknown>): AppLine | undefined {
  const { event, data } = body
  if (typeof event !== "string" || !NAME.test(event)) return undefined
  const out: AppLine["data"] = {}
  if (data !== undefined) {
    if (typeof data !== "object" || data === null || Array.isArray(data))
      return undefined
    for (const [k, v] of Object.entries(data)) {
      if (Object.keys(out).length >= MAX_FIELDS) break
      if (!KEY.test(k)) continue
      if (typeof v === "boolean") out[k] = v
      else if (typeof v === "number" && Number.isFinite(v)) out[k] = v
      else if (typeof v === "string" && !INIT_DATA.test(v))
        out[k] = plain(v).slice(0, MAX_TEXT)
    }
  }
  return { event, data: out }
}

/** At most `limit` lines in any `windowMs`. */
export class LineGate {
  private readonly at: number[] = []
  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(limit = 30, windowMs = 60_000, now: () => number = Date.now) {
    this.limit = limit
    this.windowMs = windowMs
    this.now = now
  }

  take(): boolean {
    const t = this.now()
    while (this.at.length > 0 && t - this.at[0] >= this.windowMs)
      this.at.shift()
    if (this.at.length >= this.limit) return false
    this.at.push(t)
    return true
  }
}
