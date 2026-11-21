/**
 * A multi-field form answered one field at a time on a phone. The choices stay here
 * until Submit: nothing reaches the host before it.
 */
import type { Question } from "./inbound.ts"

export const PAGE = 8

export type Stepper = {
  id: string
  /** The title line of the message. */
  head: string
  questions: Question[]
  /** The field shown; equal to the number of fields on the review step. */
  at: number
  page: number
  chosen: string[][]
  /** The message that shows it. */
  msg?: number
}

export type Act =
  | { t: "pick" | "toggle" | "page"; n: number }
  | { t: "done" | "back" | "edit" | "submit" | "cancel" }
  | { t: "text"; text: string }

/** What a step asks of the caller. */
export type Effect = { toast?: string; reply?: string; cancel?: boolean }

export const newStepper = (
  id: string,
  questions: Question[],
  head: string,
): Stepper => ({
  id,
  head,
  questions,
  at: 0,
  page: 0,
  chosen: questions.map(() => []),
})

export const reviewing = (s: Stepper): boolean => s.at >= s.questions.length

const advance = (s: Stepper) => {
  s.at++
  s.page = 0
}

const clean = (t: string) => t.replace(/[|,]/g, " ").replace(/\s+/g, " ").trim()

/** The reply the bridge reads: one part per field, option numbers or typed text. */
export function replyText(s: Stepper): string {
  return s.questions
    .map((q, i) =>
      s.chosen[i]
        .map((v) => {
          const k = q.options.indexOf(v)
          return k >= 0 ? String(k + 1) : v
        })
        .join(","),
    )
    .join(" | ")
}

export function step(s: Stepper, a: Act): Effect {
  const q = s.questions[s.at]
  const last = Math.max(0, Math.ceil((q?.options.length ?? 0) / PAGE) - 1)
  switch (a.t) {
    case "pick":
      if (!q || a.n < 1 || a.n > q.options.length)
        return { toast: "Unknown button." }
      s.chosen[s.at] = [q.options[a.n - 1]]
      advance(s)
      return {}
    case "toggle": {
      if (!q || a.n < 1 || a.n > q.options.length)
        return { toast: "Unknown button." }
      const v = q.options[a.n - 1]
      const c = s.chosen[s.at]
      s.chosen[s.at] = c.includes(v) ? c.filter((x) => x !== v) : [...c, v]
      return {}
    }
    case "done":
      if (!q) return {}
      if (s.chosen[s.at].length === 0)
        return { toast: "Tick at least one option." }
      advance(s)
      return {}
    case "text": {
      const t = clean(a.text)
      if (!q || !q.custom || !t)
        return { toast: "This field takes one of the options." }
      if (q.multiple) s.chosen[s.at] = [...s.chosen[s.at], t]
      else {
        s.chosen[s.at] = [t]
        advance(s)
      }
      return {}
    }
    case "back":
      if (s.at > 0) {
        s.at--
        s.page = 0
      }
      return {}
    case "edit":
      s.at = 0
      s.page = 0
      return {}
    case "page":
      s.page = Math.min(last, Math.max(0, a.n))
      return {}
    case "submit":
      return reviewing(s)
        ? { reply: replyText(s) }
        : { toast: "Finish the fields first." }
    case "cancel":
      return { cancel: true }
  }
}

/** Callback data of a button: `s:<id>:<act>`. */
export function parseAct(
  data: string,
): { id: string; act: Act | "write" } | undefined {
  const m = /^s:([A-Za-z0-9]+):(o\d+|t\d+|p\d+|d|b|e|ok|x|w)$/.exec(data)
  if (!m) return undefined
  const [, id, a] = m
  const n = Number(a.slice(1))
  const act: Act | "write" =
    a[0] === "o" && a.length > 1 && a !== "ok"
      ? { t: "pick", n }
      : a === "ok"
        ? { t: "submit" }
        : a[0] === "t"
          ? { t: "toggle", n }
          : a[0] === "p"
            ? { t: "page", n }
            : a === "d"
              ? { t: "done" }
              : a === "b"
                ? { t: "back" }
                : a === "e"
                  ? { t: "edit" }
                  : a === "x"
                    ? { t: "cancel" }
                    : "write"
  return { id, act }
}
