/** Prompts pushed to the channels, in memory and in an append-only JSONL file for restarts. */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { Question } from "./inbound.ts"
import { log } from "./logger.ts"

export type PendingState = "pending" | "answered" | "cancelled" | "failed"

export type Pending = {
  /** Short id used in pushes and replies. */
  id: string
  kind: "question" | "permission"
  /** OpenCode form or permission request id. */
  requestID: string
  sessionID: string
  rootSessionID: string
  title: string
  /** The permission asked for. */
  action?: string
  /** The agent that asked, which may be a subagent. */
  agent?: string
  questions?: Question[]
  /** Message reference per channel id, to update the message later. */
  refs?: Record<string, string>
  askedAt: number
  state: PendingState
  answeredBy?: "tui" | "phone"
  /** Channel id that carried the phone answer. */
  answeredVia?: string
  answeredAt?: number
  /** Transport id of the reply that answered it, to ignore its replay after a restart. */
  replyID?: string
}

const TTL_MS = 24 * 60 * 60 * 1000

export class PendingStore {
  private readonly items = new Map<string, Pending>()
  private chain: Promise<void> = Promise.resolve()

  private readonly file?: string
  /** Called after an entry is added or changed. */
  onChange?: () => void

  constructor(file?: string) {
    this.file = file
  }

  /** Reloads entries younger than a day and compacts the file. */
  async load(now = Date.now()): Promise<void> {
    if (!this.file) return
    let text = ""
    try {
      text = await readFile(this.file, "utf8")
    } catch {
      return
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const p = JSON.parse(line) as Pending & { ntfyMessageID?: string }
        if (typeof p.id === "string" && now - p.askedAt < TTL_MS) {
          // Written before channels existed.
          if (p.ntfyMessageID) p.refs ??= { ntfy: p.ntfyMessageID }
          delete p.ntfyMessageID
          this.items.set(p.id, p)
        }
      } catch {}
    }
    const body = [...this.items.values()]
      .map((p) => JSON.stringify(p))
      .join("\n")
    this.write(() => writeFile(this.file!, body ? `${body}\n` : ""))
  }

  get(id: string): Pending | undefined {
    return this.items.get(id)
  }

  byRequest(requestID: string): Pending | undefined {
    for (const p of this.items.values()) if (p.requestID === requestID) return p
    return undefined
  }

  byRef(channel: string, ref: string): Pending | undefined {
    for (const p of this.items.values()) if (p.refs?.[channel] === ref) return p
    return undefined
  }

  list(): Pending[] {
    return [...this.items.values()]
  }

  newId(): string {
    for (;;) {
      const id = Math.random().toString(36).slice(2, 6)
      if (id.length === 4 && !this.items.has(id)) return id
    }
  }

  put(p: Pending): Pending {
    this.items.set(p.id, p)
    this.persist(p)
    this.onChange?.()
    return p
  }

  update(id: string, patch: Partial<Pending>): Pending | undefined {
    const p = this.items.get(id)
    if (!p) return undefined
    Object.assign(p, patch)
    this.persist(p)
    this.onChange?.()
    return p
  }

  flush(): Promise<void> {
    return this.chain
  }

  private persist(p: Pending): void {
    if (!this.file) return
    const line = `${JSON.stringify(p)}\n`
    this.write(() => appendFile(this.file!, line))
  }

  private write(op: () => Promise<void>): void {
    const file = this.file!
    this.chain = this.chain
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        await op()
      })
      .catch((err) => log("pending_write_error", { message: err.message }))
  }
}
