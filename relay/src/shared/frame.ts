/**
 * The link's wire format, shared by the bridge and the relay. A message is a
 * JSON envelope `{ ts, nonce, mac, body }` where `body` is the JSON text of a
 * payload and `mac` is the HMAC-SHA256, with the shared secret, of the
 * direction, the time stamp, the nonce and the body. The direction stops a
 * frame being reflected: `up` is sent by the bridge, `down` by the relay.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export type Dir = "up" | "down"

export const SKEW_MS = 60_000
export const MAX_FRAME_BYTES = 1024 * 1024
export const MAX_CHUNK_BYTES = 48 * 1024
export const LINK_PATH = "/link"

/** The headers that carry the same proof on the HTTP upgrade. */
export const H_TS = "x-link-ts"
export const H_NONCE = "x-link-nonce"
export const H_MAC = "x-link-mac"

export type Headers = Record<string, string>

/** Relay to bridge. */
export type Down =
  | {
      t: "req"
      id: string
      method: string
      path: string
      headers: Headers
      /** base64 */
      body?: string
      client: string
    }
  | { t: "close"; id: string }
  | { t: "ack"; seq: number }

/** Bridge to relay. */
export type Up =
  | { t: "res"; id: string; status: number; headers: Headers }
  | { t: "chunk"; id: string; n: number; data: string }
  | { t: "end"; id: string }
  | { t: "beat"; beat: unknown }

const sign = (
  secret: string,
  dir: Dir,
  ts: number,
  nonce: string,
  body: string,
) =>
  createHmac("sha256", secret)
    .update(`${dir}\n${ts}\n${nonce}\n${body}`)
    .digest("hex")

const same = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function seal(
  secret: string,
  dir: Dir,
  payload: Down | Up,
  now = Date.now(),
): string {
  const body = JSON.stringify(payload)
  const nonce = randomBytes(12).toString("hex")
  return JSON.stringify({
    ts: now,
    nonce,
    mac: sign(secret, dir, now, nonce, body),
    body,
  })
}

/** The proof for the upgrade request: a MAC over the method and path as the body. */
export function sealUpgrade(
  secret: string,
  now = Date.now(),
): Record<string, string> {
  const nonce = randomBytes(12).toString("hex")
  return {
    "X-Link-Ts": String(now),
    "X-Link-Nonce": nonce,
    "X-Link-Mac": sign(secret, "up", now, nonce, "GET " + LINK_PATH),
  }
}

export type Refusal = "format" | "mac" | "skew" | "replay"
export type Opened<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: Refusal; skewMs?: number }

/** Remembers nonces for twice the window, so a replay inside it is always seen. */
export class NonceCache {
  private readonly seen = new Map<string, number>()
  private readonly now: () => number
  private readonly keepMs: number
  private readonly max: number

  constructor(
    now: () => number = Date.now,
    keepMs = 2 * SKEW_MS,
    max = 50_000,
  ) {
    this.now = now
    this.keepMs = keepMs
    this.max = max
  }

  /** True the first time a nonce is offered. */
  fresh(nonce: string): boolean {
    const t = this.now()
    for (const [k, at] of this.seen) {
      if (t - at <= this.keepMs && this.seen.size <= this.max) break
      this.seen.delete(k)
    }
    if (this.seen.has(nonce)) return false
    this.seen.set(nonce, t)
    return true
  }
}

/** Checks what arrives in one direction. */
export class Verifier {
  readonly nonces: NonceCache
  private readonly secret: string
  /** The direction the sender uses: a receiver of `up` frames passes `up`. */
  private readonly dir: Dir
  private readonly now: () => number
  private readonly skewMs: number

  constructor(
    secret: string,
    dir: Dir,
    now: () => number = Date.now,
    skewMs = SKEW_MS,
    nonces?: NonceCache,
  ) {
    this.secret = secret
    this.dir = dir
    this.now = now
    this.skewMs = skewMs
    this.nonces = nonces ?? new NonceCache(now)
  }

  private check(
    ts: unknown,
    nonce: unknown,
    mac: unknown,
    body: string,
  ): Refusal | { skewMs: number } | undefined {
    if (
      typeof ts !== "number" ||
      !Number.isFinite(ts) ||
      typeof nonce !== "string" ||
      !/^[0-9a-f]{8,64}$/.test(nonce) ||
      typeof mac !== "string"
    )
      return "format"
    if (!same(mac, sign(this.secret, this.dir, ts, nonce, body))) return "mac"
    const skew = this.now() - ts
    if (Math.abs(skew) > this.skewMs) return { skewMs: skew }
    if (!this.nonces.fresh(nonce)) return "replay"
    return undefined
  }

  private refusal<T>(r: Refusal | { skewMs: number }): Opened<T> {
    return typeof r === "string"
      ? { ok: false, reason: r }
      : { ok: false, reason: "skew", skewMs: r.skewMs }
  }

  open<T = Down | Up>(text: string): Opened<T> {
    if (text.length > MAX_FRAME_BYTES) return { ok: false, reason: "format" }
    let env: { ts?: unknown; nonce?: unknown; mac?: unknown; body?: unknown }
    try {
      env = JSON.parse(text)
    } catch {
      return { ok: false, reason: "format" }
    }
    if (typeof env !== "object" || env === null || typeof env.body !== "string")
      return { ok: false, reason: "format" }
    const bad = this.check(env.ts, env.nonce, env.mac, env.body)
    if (bad) return this.refusal(bad)
    try {
      const payload = JSON.parse(env.body)
      if (typeof payload !== "object" || payload === null)
        return { ok: false, reason: "format" }
      return { ok: true, payload: payload as T }
    } catch {
      return { ok: false, reason: "format" }
    }
  }

  /** The upgrade request's headers (lower-case names, as Node gives them). */
  openUpgrade(h: Record<string, string | string[] | undefined>): Opened<true> {
    const one = (v: string | string[] | undefined) =>
      typeof v === "string" ? v : undefined
    const ts = Number(one(h[H_TS]))
    const bad = this.check(
      one(h[H_TS]) === undefined ? undefined : ts,
      one(h[H_NONCE]),
      one(h[H_MAC]),
      "GET " + LINK_PATH,
    )
    return bad ? this.refusal(bad) : { ok: true, payload: true }
  }
}

/** A sentence for the log that names the refusal and, for skew, the amount. */
export function describe(r: Extract<Opened<unknown>, { ok: false }>): string {
  return r.reason === "skew"
    ? `clock skew of ${Math.round((r.skewMs ?? 0) / 1000)}s`
    : r.reason
}
