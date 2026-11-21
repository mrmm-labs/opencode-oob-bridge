/** The bearer token of the core API: created once, kept at mode 0600, replaceable. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { registerSecret } from "../filter.ts"

const MIN_LENGTH = 43 // 256 bits as base64url

/** Constant-time comparison: both sides are hashed first, so length does not leak. */
export function safeEqual(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest()
  return timingSafeEqual(h(a), h(b))
}

/** Ten failed authentications a minute from one client address block it for five minutes. */
export class FailLimiter {
  private readonly fails = new Map<string, number[]>()
  private readonly until = new Map<string, number>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  blocked(key: string): boolean {
    const t = this.now()
    const u = this.until.get(key)
    if (u === undefined) return false
    if (t < u) return true
    this.until.delete(key)
    return false
  }

  fail(key: string): void {
    const t = this.now()
    if (this.fails.size > 5000) this.fails.clear()
    const recent = (this.fails.get(key) ?? []).filter((x) => t - x < 60_000)
    recent.push(t)
    this.fails.set(key, recent)
    if (recent.length >= 10) {
      this.until.set(key, t + 5 * 60_000)
      this.fails.delete(key)
    }
  }
}

export class TokenStore {
  private token = ""
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  /** Reads the token, or creates one when there is none or it is too short to trust. */
  async load(): Promise<void> {
    const have = await readFile(this.file, "utf8").then(
      (t) => t.trim(),
      () => "",
    )
    if (have.length >= MIN_LENGTH) {
      this.set(have)
      await chmod(this.file, 0o600)
    } else await this.rotate()
  }

  /** Replaces the token: the old one stops working at once. Returns the new one. */
  async rotate(): Promise<string> {
    const t = randomBytes(32).toString("base64url")
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, t + "\n", { mode: 0o600 })
    await chmod(this.file, 0o600)
    this.set(t)
    return t
  }

  private set(t: string) {
    this.token = t
    registerSecret(t)
  }

  /** `Authorization` header value, or undefined. */
  check(header: string | undefined): boolean {
    const m = /^Bearer (\S+)$/.exec(header ?? "")
    return m !== null && this.token !== "" && safeEqual(m[1], this.token)
  }
}
