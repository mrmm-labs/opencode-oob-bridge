/** Requests and their answers, kept 24 hours so an idempotency key replays (docs/approvals.md 4.1). */
import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { log } from "../logger.ts"
import type { Answer, RequestRecord } from "./sign.ts"

export const KEEP_MS = 24 * 60 * 60_000

export type State =
  | "pending"
  | "awaiting_code"
  | "approved"
  | "denied"
  | "expired"
  | "withdrawn"

export const terminal = (s: State) =>
  s === "approved" || s === "denied" || s === "expired" || s === "withdrawn"

export type Rec = {
  caller: string
  request: RequestRecord
  requestHash: string
  bodyHash: string
  scopeHash: string
  /** The level the request needs: the larger of the class minimum and what it asked. */
  level: number
  state: State
  createdAt: number
  expiresAt: number
  decidedAt?: number
  reasonCode?: string
  answer?: Answer
  channel?: { id: string; type: string; ref?: string }
}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex")

export class RecordStore {
  private readonly file?: string
  private readonly byKey = new Map<string, Rec>()
  private readonly ids = new Map<string, Rec>()
  private chain: Promise<void> = Promise.resolve()

  constructor(file?: string) {
    this.file = file
  }

  async load(now = Date.now()): Promise<void> {
    if (!this.file) return
    let text = ""
    try {
      text = await readFile(this.file, "utf8")
    } catch {}
    for (const line of text.split("\n")) {
      if (!line) continue
      try {
        const r = JSON.parse(line) as Rec
        if (now - r.createdAt <= KEEP_MS) this.index(r)
      } catch {}
    }
    await this.rewrite()
  }

  private index(r: Rec) {
    this.byKey.set(`${r.caller}\n${r.request.idempotency_key}`, r)
    this.ids.set(r.request.id, r)
  }

  get(caller: string, key: string): Rec | undefined {
    return this.byKey.get(`${caller}\n${key}`)
  }

  byId(id: string): Rec | undefined {
    return this.ids.get(id)
  }

  all(): Rec[] {
    return [...this.ids.values()]
  }

  /** Inserts or updates; the file takes one line per change. */
  put(r: Rec): void {
    this.index(r)
    if (!this.file) return
    const file = this.file
    const line = JSON.stringify(r) + "\n"
    this.chain = this.chain
      .then(async () => {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 })
        await appendFile(file, line, { mode: 0o600 })
      })
      .catch((err) => log("approvals_store_error", { message: err.message }))
  }

  private async rewrite(): Promise<void> {
    if (!this.file) return
    const file = this.file
    const body = this.all()
      .map((r) => JSON.stringify(r) + "\n")
      .join("")
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await writeFile(file, body, { mode: 0o600 })
    } catch (err) {
      log("approvals_store_error", { message: (err as Error).message })
    }
  }

  flush(): Promise<void> {
    return this.chain
  }
}
