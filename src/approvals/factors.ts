/**
 * The L2 factors (docs/approvals.md section 5.4): the names, the proofs the
 * bridge checks, and the enrolled devices. Pure: the Keychain, the clock and
 * the channels are the caller's.
 */
import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto"

import type { Factor } from "./sign.ts"

export type { Factor }

export const FACTORS: readonly Factor[] = ["biometric", "passkey", "totp"]
export const DEFAULT_FACTORS: Factor[] = [...FACTORS]
export const isFactor = (v: unknown): v is Factor =>
  typeof v === "string" && (FACTORS as readonly string[]).includes(v)

const BIOMETRIC_TAG = "oob-l2-biometric-v1"
const PASSKEY_TAG = "oob-l2-passkey-v1"

/** What the app and the bridge each compute: the HMAC the Mini App sends. */
export const biometricProof = (
  secret: Uint8Array,
  requestHash: string,
  challenge: string,
): string =>
  createHmac("sha256", secret)
    .update(`${BIOMETRIC_TAG}\n${requestHash}\n${challenge}`)
    .digest("hex")

/** The WebAuthn challenge for a request: bound to its hash and a single-use nonce. */
export const passkeyChallenge = (requestHash: string, nonce: string): string =>
  createHash("sha256")
    .update(`${PASSKEY_TAG}\n${requestHash}\n${nonce}`)
    .digest("base64url")

export const newNonce = (): string => randomBytes(16).toString("base64url")

export function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The Keychain item `l2-devices`. Secrets and keys are base64url. */
export type Enrolled = {
  /** Device id to its secret. */
  biometric: Record<string, string>
  /** Credential id to its public key (SPKI). */
  passkeys: Record<string, string>
}

export const emptyEnrolled = (): Enrolled => ({ biometric: {}, passkeys: {} })

const strings = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = Object.create(null)
  if (typeof v === "object" && v !== null)
    for (const [k, x] of Object.entries(v))
      if (typeof x === "string") out[k] = x
  return out
}

export function parseEnrolled(raw: string | undefined): Enrolled {
  try {
    const v = JSON.parse(raw ?? "") as Record<string, unknown>
    return { biometric: strings(v.biometric), passkeys: strings(v.passkeys) }
  } catch {
    return emptyEnrolled()
  }
}

export const has = (m: Record<string, string>, k: unknown): k is string =>
  typeof k === "string" && Object.hasOwn(m, k)

export function newDevice(): { id: string; secret: string } {
  return {
    id: "d" + randomBytes(6).toString("base64url"),
    secret: randomBytes(32).toString("base64url"),
  }
}

export type Assertion = {
  authenticatorData: string
  clientDataJSON: string
  signature: string
}

const b64 = (v: unknown): Buffer | undefined =>
  typeof v === "string" && v.length <= 8192
    ? Buffer.from(v, "base64url")
    : undefined

function clientData(
  raw: Buffer,
  type: string,
  challenge: string,
  origin: string,
): boolean {
  try {
    const c = JSON.parse(raw.toString("utf8")) as Record<string, unknown>
    return (
      c.type === type &&
      typeof c.challenge === "string" &&
      same(c.challenge, challenge) &&
      c.origin === origin &&
      c.crossOrigin !== true
    )
  } catch {
    return false
  }
}

/**
 * A WebAuthn assertion (ES256 or RS256): client data names the request's
 * challenge and our origin; the authenticator data carries the hash of the
 * relying party id and the user-verified flag; the signature covers both.
 */
export function verifyAssertion(o: {
  publicKey: string
  rpId: string
  origin: string
  challenge: string
  assertion: unknown
}): boolean {
  try {
    const a = o.assertion as Partial<Assertion> | null
    const data = b64(a?.authenticatorData)
    const client = b64(a?.clientDataJSON)
    const sig = b64(a?.signature)
    if (!data || !client || !sig || data.length < 37) return false
    if (!clientData(client, "webauthn.get", o.challenge, o.origin)) return false
    const rp = createHash("sha256").update(o.rpId).digest()
    if (!timingSafeEqual(data.subarray(0, 32), rp)) return false
    const flags = data[32]
    if ((flags & 0x01) === 0 || (flags & 0x04) === 0) return false
    const key = createPublicKey({
      key: Buffer.from(o.publicKey, "base64url"),
      format: "der",
      type: "spki",
    })
    const signed = Buffer.concat([
      data,
      createHash("sha256").update(client).digest(),
    ])
    return verify("sha256", signed, key, sig)
  } catch {
    return false
  }
}

/** A registration: the client data names our challenge and origin, and the key is a public key we can read. */
export function checkRegistration(o: {
  challenge: string
  origin: string
  credential: unknown
}): { id: string; publicKey: string } | undefined {
  try {
    const c = o.credential as Record<string, unknown> | null
    const client = b64(c?.clientDataJSON)
    const key = b64(c?.publicKey)
    const id = c?.id
    if (!client || !key || typeof id !== "string") return undefined
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(id)) return undefined
    if (!clientData(client, "webauthn.create", o.challenge, o.origin))
      return undefined
    createPublicKey({ key, format: "der", type: "spki" })
    return { id, publicKey: key.toString("base64url") }
  } catch {
    return undefined
  }
}
