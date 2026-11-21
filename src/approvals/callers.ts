/**
 * Who may ask. Every request carries a per-caller proof, because the same user
 * also runs other processes (docs/approvals.md 7.1). The caller key is a request
 * credential only: it cannot make an answer a caller accepts.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { TrustedKey } from "./sign.ts"

export const SKEW_MS = 60_000
export const CALLER_NAME = /^[a-z0-9][-a-z0-9_]{0,31}$/

export type CallerFile = {
  name: string
  /** Hex, 32 bytes. */
  key: string
  /** Public keys the caller verifies answers with, as `TrustedKey` with an ISO `not_after`. */
  keys: Array<{ kid: string; public_key: string; not_after?: string }>
  /** Where the bridge listens. */
  socket: string
  created_at: string
}

export const trusted = (f: CallerFile): TrustedKey[] =>
  f.keys.map((k) => ({
    kid: k.kid,
    publicKey: k.public_key,
    notAfter: k.not_after ? Date.parse(k.not_after) : undefined,
  }))

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex")

export const mac = (
  key: string,
  method: string,
  path: string,
  ts: string,
  body: string | Buffer,
): string =>
  createHmac("sha256", Buffer.from(key, "hex"))
    .update(`${method}\n${path}\n${ts}\n${sha256(body)}`)
    .digest("hex")

/** The three headers a caller sends. */
export const proof = (
  f: Pick<CallerFile, "name" | "key">,
  method: string,
  path: string,
  body: string | Buffer,
  now = Date.now(),
): Record<string, string> => {
  const ts = String(Math.floor(now / 1000))
  return {
    "x-caller": f.name,
    "x-caller-ts": ts,
    "x-caller-mac": mac(f.key, method, path, ts, body),
  }
}

export type Auth =
  | { ok: true; caller: string }
  | { ok: false; reason: "unknown" | "mac" | "skew" | "replay" | "missing" }

export class CallerStore {
  private readonly dir: string
  private readonly callers = new Map<string, CallerFile>()
  private readonly seen = new Map<string, number>()

  constructor(dir: string) {
    this.dir = dir
  }

  async load(): Promise<void> {
    this.callers.clear()
    let names: string[] = []
    try {
      names = await readdir(this.dir)
    } catch {}
    for (const n of names) {
      if (!n.endsWith(".json")) continue
      try {
        const f = JSON.parse(await readFile(join(this.dir, n), "utf8")) as CallerFile
        if (CALLER_NAME.test(f.name) && /^[0-9a-f]{64}$/.test(f.key))
          this.callers.set(f.name, f)
      } catch {}
    }
  }

  names(): string[] {
    return [...this.callers.keys()].sort()
  }

  get(name: string): CallerFile | undefined {
    return this.callers.get(name)
  }

  /** Creates the caller, or replaces its key. The file is 0600 in a 0700 directory. */
  async pair(
    name: string,
    keys: CallerFile["keys"],
    socket: string,
    now = Date.now(),
  ): Promise<CallerFile> {
    if (!CALLER_NAME.test(name))
      throw new Error("a caller name is 1 to 32 of a-z, 0-9, - and _")
    const f: CallerFile = {
      name,
      key: randomBytes(32).toString("hex"),
      keys,
      socket,
      created_at: new Date(now).toISOString(),
    }
    await this.write(f)
    return f
  }

  /** Rewrites every caller with the current public keys. */
  async setKeys(keys: CallerFile["keys"]): Promise<void> {
    for (const f of this.callers.values()) await this.write({ ...f, keys })
  }

  async revoke(name: string): Promise<boolean> {
    if (!this.callers.delete(name)) return false
    await rm(join(this.dir, `${name}.json`), { force: true })
    return true
  }

  private async write(f: CallerFile): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700)
    const file = join(this.dir, `${f.name}.json`)
    await writeFile(file, JSON.stringify(f, null, 2) + "\n", { mode: 0o600 })
    await chmod(file, 0o600)
    this.callers.set(f.name, f)
  }

  /** Checks the proof of one request. A proof works once within its window. */
  verify(
    h: Record<string, string | string[] | undefined>,
    method: string,
    path: string,
    body: string | Buffer,
    now = Date.now(),
  ): Auth {
    const one = (v: string | string[] | undefined) =>
      typeof v === "string" ? v : undefined
    const name = one(h["x-caller"])
    const ts = one(h["x-caller-ts"])
    const given = one(h["x-caller-mac"])
    if (!name || !ts || !given) return { ok: false, reason: "missing" }
    const f = this.callers.get(name)
    if (!f) return { ok: false, reason: "unknown" }
    const at = Number(ts) * 1000
    if (!Number.isFinite(at) || Math.abs(now - at) > SKEW_MS)
      return { ok: false, reason: "skew" }
    const want = Buffer.from(mac(f.key, method, path, ts, body))
    const have = Buffer.from(given)
    if (want.length !== have.length || !timingSafeEqual(want, have))
      return { ok: false, reason: "mac" }
    for (const [k, t] of this.seen) if (now - t > 2 * SKEW_MS) this.seen.delete(k)
    const id = `${name}:${given}`
    if (this.seen.has(id)) return { ok: false, reason: "replay" }
    this.seen.set(id, now)
    return { ok: true, caller: name }
  }
}
