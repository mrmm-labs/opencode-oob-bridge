/**
 * The inbound journal: an update is written here before Telegram is told it
 * was received (the offset moves), and marked done when it was handled. A
 * crash or a stuck handler between the two loses nothing: what is not done is
 * handled again at the next start.
 */
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

/** The journal is emptied once everything in it is done and it holds this many lines. */
const COMPACT_LINES = 100
/** Ids remembered after they are done, to drop an update Telegram sends twice. */
const REMEMBER = 500

export class Inbox<T extends { update_id: number }> {
  private readonly file: string | undefined
  private readonly open = new Map<number, T>()
  private readonly recent = new Set<number>()
  private lines = 0
  private chain: Promise<unknown> = Promise.resolve()

  constructor(file?: string) {
    this.file = file
  }

  /** Updates a previous run did not finish, oldest first. */
  async load(): Promise<T[]> {
    if (!this.file) return []
    let text = ""
    try {
      text = await readFile(this.file, "utf8")
    } catch {
      return []
    }
    for (const line of text.split("\n")) {
      if (!line) continue
      try {
        const v = JSON.parse(line) as { add?: T; done?: number }
        this.lines++
        if (v.add) this.open.set(v.add.update_id, v.add)
        if (typeof v.done === "number") this.finish(v.done)
      } catch {}
    }
    return [...this.open.values()].sort((a, b) => a.update_id - b.update_id)
  }

  /** True for an id that is open or was done lately. */
  has(id: number): boolean {
    return this.open.has(id) || this.recent.has(id)
  }

  /**
   * Writes the updates down and returns the new ones. Throws when it cannot:
   * the caller must then not move the offset.
   */
  async add(updates: T[]): Promise<T[]> {
    const fresh = updates.filter((u) => !this.has(u.update_id))
    for (const u of fresh) this.open.set(u.update_id, u)
    try {
      await this.write(
        fresh.map((u) => JSON.stringify({ add: u })),
        true,
      )
    } catch (err) {
      for (const u of fresh) this.open.delete(u.update_id)
      throw err
    }
    return fresh
  }

  /** Marks one handled. A write failure is not fatal: the update is handled again, once, at the next start. */
  async done(id: number): Promise<void> {
    this.finish(id)
    await this.write([JSON.stringify({ done: id })], false).catch(() => {})
    if (this.open.size === 0 && this.lines >= COMPACT_LINES && this.file) {
      const file = this.file
      this.lines = 0
      this.chain = this.chain
        .then(() => writeFile(file, "", { mode: 0o600 }))
        .catch(() => {})
    }
  }

  pending(): number {
    return this.open.size
  }

  private finish(id: number) {
    this.open.delete(id)
    this.recent.add(id)
    if (this.recent.size > REMEMBER)
      this.recent.delete(this.recent.values().next().value as number)
  }

  private write(lines: string[], strict: boolean): Promise<void> {
    const file = this.file
    if (!file || !lines.length) return Promise.resolve()
    const run = async () => {
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, lines.join("\n") + "\n", { mode: 0o600 })
      await chmod(file, 0o600).catch(() => {})
      this.lines += lines.length
    }
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => {})
    return strict ? next : next.catch(() => {})
  }
}
