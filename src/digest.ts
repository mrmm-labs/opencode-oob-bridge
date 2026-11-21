/**
 * What happened while the operator was away: the records behind the digest, and
 * its text. The file is derived data: losing it loses only the next digest's detail.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export type DigestRecord = {
  k: "finished" | "failed" | "digest"
  at: number
  title?: string
}

export const KEEP_MS = 7 * 24 * 60 * 60_000

export class DigestLog {
  private items: DigestRecord[] = []
  private chain: Promise<void> = Promise.resolve()
  private readonly file?: string

  constructor(file?: string) {
    this.file = file
  }

  /** Reloads the records of the last seven days and rewrites the file without the rest. */
  async load(now = Date.now()): Promise<void> {
    if (!this.file) return
    let text = ""
    try {
      text = await readFile(this.file, "utf8")
    } catch {
      return
    }
    for (const line of text.split("\n")) {
      try {
        const r = JSON.parse(line) as DigestRecord
        if (typeof r.at === "number" && now - r.at < KEEP_MS) this.items.push(r)
      } catch {}
    }
    const body = this.items.map((r) => JSON.stringify(r)).join("\n")
    this.write(() => writeFile(this.file!, body ? body + "\n" : ""))
    await this.chain
  }

  append(r: DigestRecord): void {
    this.items.push(r)
    if (!this.file) return
    const line = JSON.stringify(r) + "\n"
    this.write(async () => {
      await mkdir(dirname(this.file!), { recursive: true })
      await appendFile(this.file!, line)
    })
  }

  /** When the last digest covered up to; 0 when there was none. */
  lastDigest(): number {
    return this.items.reduce(
      (m, r) => (r.k === "digest" ? Math.max(m, r.at) : m),
      0,
    )
  }

  /** Records after the last digest. */
  pending(): DigestRecord[] {
    const last = this.lastDigest()
    return this.items.filter((r) => r.k !== "digest" && r.at > last)
  }

  async flush(): Promise<void> {
    await this.chain
  }

  private write(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch(() => {})
  }
}

const group = (titles: string[]): string[] => {
  const n = new Map<string, number>()
  for (const t of titles) n.set(t, (n.get(t) ?? 0) + 1)
  return [...n].map(([t, c]) => "• " + t + (c > 1 ? " ×" + c : ""))
}

/** The digest: finished, failed, and what waits for the operator. Empty when there is nothing. */
export function digestText(o: {
  records: DigestRecord[]
  waiting: string[]
  /** The night section of an overnight plan. */
  night?: string[]
}): string {
  const of = (k: DigestRecord["k"]) =>
    o.records.filter((r) => r.k === k).map((r) => r.title ?? "a session")
  const section = (head: string, lines: string[]) =>
    lines.length ? [head + " (" + lines.length + ")", ...group(lines)] : []
  const finished = of("finished")
  const failed = of("failed")
  const out = [
    ...section("✅ Finished", finished),
    ...section("❌ Failed", failed),
    ...(o.waiting.length
      ? [
          "⏳ Waiting on you (" + o.waiting.length + ")",
          ...o.waiting.map((w) => "• " + w),
        ]
      : []),
    ...(o.night ?? []),
  ]
  return out.join("\n")
}
