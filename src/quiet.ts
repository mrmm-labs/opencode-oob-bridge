/** Quiet hours: a window of the day in an IANA zone, decided for each instant. */

export const BREAKTHROUGH = ["failed", "permission", "question"] as const
export type Breakthrough = (typeof BREAKTHROUGH)[number]

/** `from` and `to` are minutes after local midnight. */
export type QuietHours = {
  from: number
  to: number
  timezone?: string
  breakthrough: Breakthrough[]
}

/** HH:MM to minutes after midnight, or undefined. */
export function parseClock(s: unknown): number | undefined {
  const m =
    typeof s === "string" ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s) : null
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined
}

export const validZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The local date (YYYY-MM-DD) and minutes after midnight of an instant. */
export function localTime(
  ms: number,
  timezone?: string,
): { date: string; minutes: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(ms)
      .map((x) => [x.type, x.value]),
  )
  return {
    date: p.year + "-" + p.month + "-" + p.day,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  }
}

/** Whether an instant falls in the window, which may cross midnight. */
export function isQuiet(q: QuietHours, ms: number): boolean {
  const { minutes } = localTime(ms, q.timezone)
  return q.from < q.to
    ? minutes >= q.from && minutes < q.to
    : minutes >= q.from || minutes < q.to
}

/** True once the local clock is past `at` on a day that has had no digest. */
export const digestDue = (o: {
  at: number
  timezone?: string
  last: number
  now: number
}): boolean => {
  const now = localTime(o.now, o.timezone)
  return (
    now.minutes >= o.at &&
    (o.last === 0 || localTime(o.last, o.timezone).date !== now.date)
  )
}
