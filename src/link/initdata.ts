/**
 * Telegram Mini App init data: the string the app sends as
 * `Authorization: tma <init data>`. Shared by the bridge, which always checks
 * the hash, and the relay, which checks it only when it holds a verify token.
 */
import { createHmac, timingSafeEqual } from "node:crypto"

export type Parsed = {
  userId: number
  authDate: number
  hash: string
  /** The fields as sent, for the hash. */
  pairs: Array<[string, string]>
}

export function parseInitData(raw: string): Parsed | undefined {
  if (raw.length === 0 || raw.length > 4096) return undefined
  let p: URLSearchParams
  try {
    p = new URLSearchParams(raw)
  } catch {
    return undefined
  }
  const hash = p.get("hash") ?? ""
  const auth = Number(p.get("auth_date"))
  let id: unknown
  try {
    id = (JSON.parse(p.get("user") ?? "") as { id?: unknown }).id
  } catch {
    return undefined
  }
  if (
    !/^[0-9a-f]{64}$/.test(hash) ||
    !Number.isInteger(auth) ||
    auth <= 0 ||
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0
  )
    return undefined
  return {
    userId: id,
    authDate: auth,
    hash,
    pairs: [...p.entries()].filter(([k]) => k !== "hash"),
  }
}

/** The documented check: HMAC of the sorted `key=value` lines with a key derived from the bot token. */
export function hashMatches(token: string, p: Parsed): boolean {
  const secret = createHmac("sha256", "WebAppData").update(token).digest()
  const text = p.pairs
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n")
  const want = createHmac("sha256", secret).update(text).digest()
  const got = Buffer.from(p.hash, "hex")
  return got.length === want.length && timingSafeEqual(got, want)
}

export type Verdict =
  | { ok: true; userId: number }
  | { ok: false; status: 401 | 403; why: string }

export const FUTURE_SLACK_S = 60

/**
 * 401 for anything malformed, stale or wrongly signed, 403 for another user.
 * Without a token the hash is not checked: the caller must not claim it was.
 */
export function checkInitData(
  raw: string | undefined,
  o: {
    operator: number
    maxAgeSeconds: number
    token?: string
    now?: () => number
  },
): Verdict {
  const p = raw === undefined ? undefined : parseInitData(raw)
  if (!p) return { ok: false, status: 401, why: "malformed" }
  if (o.token !== undefined && !hashMatches(o.token, p))
    return { ok: false, status: 401, why: "hash" }
  if (p.userId !== o.operator) return { ok: false, status: 403, why: "user" }
  const age = Math.floor((o.now ?? Date.now)() / 1000) - p.authDate
  if (age > o.maxAgeSeconds || age < -FUTURE_SLACK_S)
    return { ok: false, status: 401, why: "age" }
  return { ok: true, userId: p.userId }
}

/** The init data in an `Authorization` header value, or undefined. */
export function fromHeader(h: string | undefined): string | undefined {
  const m = /^tma (.+)$/s.exec(h ?? "")
  return m?.[1]
}

/** Builds init data the way Telegram does, for tests and the checker. */
export function signInitData(
  token: string,
  fields: Record<string, string>,
): string {
  const secret = createHmac("sha256", "WebAppData").update(token).digest()
  const text = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n")
  const hash = createHmac("sha256", secret).update(text).digest("hex")
  return new URLSearchParams({ ...fields, hash }).toString()
}
