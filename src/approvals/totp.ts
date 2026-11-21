/** RFC 6238 one-time codes: SHA-1, 6 digits, 30-second steps. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const STEP_SECONDS = 30
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function newSeed(): Uint8Array {
  return randomBytes(20)
}

export const step = (ms: number): number =>
  Math.floor(ms / 1000 / STEP_SECONDS)

/** The code for a time step (RFC 4226 truncation). */
export function code(seed: Uint8Array, counter: number): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac("sha1", seed).update(msg).digest()
  const o = h[h.length - 1] & 15
  const n =
    ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(n % 1_000_000).padStart(6, "0")
}

/**
 * The step a typed code matches, within one step either side of `ms`, or
 * undefined. The caller records the step and refuses it the next time.
 */
export function match(
  seed: Uint8Array,
  typed: string,
  ms: number,
): number | undefined {
  if (!/^\d{6}$/.test(typed)) return undefined
  const now = step(ms)
  const want = Buffer.from(typed)
  let hit: number | undefined
  for (const s of [now - 1, now, now + 1])
    if (timingSafeEqual(want, Buffer.from(code(seed, s)))) hit ??= s
  return hit
}

export const otpauth = (seed: Uint8Array, account: string, issuer: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${base32(seed)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`
