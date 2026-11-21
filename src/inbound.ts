/**
 * Reply grammar on the in topic:
 *   {"id":"ab12","choice":2}   button tap (choice is 1-based)
 *   #ab12 2                    option number
 *   #ab12 some text            free text (a custom answer)
 *   #ab12 1 | yes | 2,3        one part per question when a prompt has several
 */
import { isObject } from "./util.ts"

export type Reply =
  | { id: string; choice: number }
  | {
      id: string
      text: string
      /** A free-text answer: a number is not an option selector. */
      literal?: boolean
    }

export function parseReply(message: string): Reply | undefined {
  const s = message.trim()
  if (s.startsWith("{")) {
    try {
      const v = JSON.parse(s) as { id?: unknown; choice?: unknown }
      if (
        typeof v.id === "string" &&
        typeof v.choice === "number" &&
        Number.isInteger(v.choice)
      )
        return { id: v.id, choice: v.choice }
    } catch {}
    return undefined
  }
  const m = /^#([A-Za-z0-9]+)\s+([\s\S]+)$/.exec(s)
  return m ? { id: m[1], text: m[2].trim() } : undefined
}

export type Question = {
  key: string
  header: string
  text: string
  options: string[]
  /** Per-option description, same order as options. */
  details?: string[]
  multiple: boolean
  custom: boolean
}

export type Answer = Record<string, string | string[]>

function one(q: Question, part: string, literal = false): string | undefined {
  const n = !literal && /^\d+$/.test(part) ? Number(part) : NaN
  if (n >= 1 && n <= q.options.length) return q.options[n - 1]
  const exact = q.options.find((o) => o.toLowerCase() === part.toLowerCase())
  if (exact) return exact
  return q.custom && part ? part : undefined
}

/** Maps a reply onto the prompt's questions; undefined when it does not fit. */
export function resolveAnswer(
  questions: Question[],
  reply: Reply,
): Answer | undefined {
  if (questions.length === 0) return undefined
  if ("choice" in reply) {
    const q = questions[0]
    if (questions.length !== 1) return undefined
    const v = one(q, String(reply.choice))
    if (v === undefined || !q.options.includes(v)) return undefined
    return { [q.key]: q.multiple ? [v] : v }
  }
  const parts =
    questions.length === 1
      ? [reply.text]
      : reply.text.split("|").map((p) => p.trim())
  if (parts.length !== questions.length) return undefined
  const answer: Answer = {}
  for (const [i, q] of questions.entries()) {
    if (q.multiple) {
      const values = parts[i]
        .split(",")
        .map((p) => one(q, p.trim(), reply.literal))
      if (values.length === 0 || values.some((v) => v === undefined))
        return undefined
      answer[q.key] = values as string[]
    } else {
      const v = one(q, parts[i], reply.literal)
      if (v === undefined) return undefined
      answer[q.key] = v
    }
  }
  return answer
}

const MAX_TYPED = 2000

/**
 * An answer given as one value per field, as a client that has the fields on
 * screen sends it: every field answered, a single-select with one value, a
 * value that is an option or, where typing is allowed, any text. No guessing
 * from numbers: undefined when it does not fit.
 */
export function checkAnswers(
  questions: Question[],
  given: unknown,
): Answer | undefined {
  if (!isObject(given) || questions.length === 0) return undefined
  if (Object.keys(given).length !== questions.length) return undefined
  const out: Answer = {}
  for (const q of questions) {
    const v = given[q.key]
    const values = q.multiple ? v : [v]
    if (!Array.isArray(values) || values.length === 0) return undefined
    for (const x of values)
      if (
        typeof x !== "string" ||
        !(
          q.options.includes(x) ||
          (q.custom && x.trim() && x.length <= MAX_TYPED)
        )
      )
        return undefined
    out[q.key] = q.multiple ? (values as string[]) : (values[0] as string)
  }
  return out
}
