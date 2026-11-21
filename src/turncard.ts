/** A card for a finished turn: whether to post one, and what it says. */
import type { TurnCard } from "./connectors/types.ts"

export const DEFAULT_MIN_SECONDS = 20
export const MAX_FILES = 15
export const MAX_SUMMARY = 700
export const PLAIN_SUMMARY = 300

export type FileStat = { file: string; additions: number; deletions: number }
/** File name to its line counts, as the working tree was at one moment. */
export type Stats = Map<string, string>

const key = (f: FileStat) => f.additions + "/" + f.deletions

export const stats = (files: FileStat[]): Stats =>
  new Map(files.map((f) => [f.file, key(f)]))

/** What a turn changed: the files that differ from before it, and the lines it added and removed. */
export function delta(
  before: Stats | undefined,
  after: FileStat[] | undefined,
): { files: string[]; added: number; removed: number } | undefined {
  if (!before || !after) return undefined
  const out = { files: [] as string[], added: 0, removed: 0 }
  for (const f of after) {
    const was = before.get(f.file)
    if (was === key(f)) continue
    const [a = 0, d = 0] = was ? was.split("/").map(Number) : []
    out.files.push(f.file)
    out.added += Math.max(0, f.additions - a)
    out.removed += Math.max(0, f.deletions - d)
  }
  return out
}

/** A card for a turn that changed a file, or ran at least `minSeconds`. */
export const shouldCard = (o: {
  minSeconds: number
  seconds: number
  changed?: number
}): boolean => (o.changed ?? 0) > 0 || o.seconds >= o.minSeconds

/** The last paragraph of a reply, cut at `max` characters. */
export function lastParagraph(text: string, max: number): string {
  const p =
    text
      .trim()
      .split(/\n\s*\n/)
      .at(-1)
      ?.trim() ?? ""
  return p.length > max ? p.slice(0, max - 1).trimEnd() + "…" : p
}

export function header(c: TurnCard): string {
  const parts = [c.failed ? "❌ Failed" : "✅ Done"]
  if (c.changes)
    parts.push(
      c.changes.files + (c.changes.files === 1 ? " file" : " files"),
      "+" + c.changes.added + " −" + c.changes.removed,
    )
  if (c.duration) parts.push(c.duration.replace(/ /g, ""))
  return parts.join(" · ")
}

/** For a channel that cannot fold: the header and a short summary, no file list. */
export function plain(c: TurnCard): string {
  const s = c.summary
    ? c.summary.length > PLAIN_SUMMARY
      ? c.summary.slice(0, PLAIN_SUMMARY - 1).trimEnd() + "…"
      : c.summary
    : ""
  return s ? header(c) + "\n" + s : header(c)
}
