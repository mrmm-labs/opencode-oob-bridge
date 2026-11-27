import { formatDuration, truncate } from "./util.ts"

export type SubStatus = "running" | "waiting" | "done" | "idle" | "error"

export type SubView = {
  agent: string
  desc: string
  /** Parents up to the root: 1 is a child of the root, 2 a grandchild. */
  depth: number
  status: SubStatus
  /** How long it has run (to its end when it has one). */
  ms: number
  last?: string
}

const ICON: Record<SubStatus, string> = {
  running: "🟢",
  waiting: "⏳",
  done: "✅",
  idle: "💤",
  error: "❌",
}
const WORD: Record<SubStatus, string> = {
  running: "running",
  waiting: "waiting for an answer",
  done: "done",
  idle: "idle",
  error: "error",
}

export const isFinal = (s: SubStatus) =>
  s === "done" || s === "idle" || s === "error"

/** A running card's time changes the text once a minute at most; a finished one shows its exact time. */
const elapsed = (v: SubView) =>
  isFinal(v.status)
    ? formatDuration(v.ms)
    : v.ms < 60_000
      ? "under 1 min"
      : `${Math.floor(v.ms / 60_000)} min`

export function renderSub(v: SubView): { title: string; message: string } {
  const lead = v.depth > 1 ? `${"↳".repeat(v.depth - 1)} ` : ""
  const head = `${ICON[v.status]} ${WORD[v.status]} · ${elapsed(v)}`
  return {
    title: `${lead}🤖 ${v.agent}${v.desc ? `: ${truncate(v.desc, 80)}` : ""}`,
    message: v.last ? `${head}\n${truncate(v.last, 160)}` : head,
  }
}

/** The title OpenCode gives a subagent session is the task description plus a trailing "(@agent subagent)". */
export const subDescription = (title: string | undefined): string =>
  (title ?? "").replace(/\s*\(@[^)]*subagent\)\s*$/, "").trim()

/** The last non-empty line of a text, without list or heading marks. */
export const lastLine = (text: string): string =>
  text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[#>*-]+|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .at(-1) ?? ""
