/**
 * Signed answers. The bridge signs with Ed25519; a caller holds only the public
 * key, so nothing it can read lets it forge an approval. `verifyAnswer` is the
 * caller-side check of docs/approvals.md section 7.2, and is meant to be copied.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto"

export const SIGN_VERSION = "oob-approval-v1"

export type Decision = "approve" | "deny" | "expired"
export type Mode = "afk" | "present"

/** What a caller sent, plus what the bridge assigned (id, caller, mode, created_at). Hashed as is. */
export type RequestRecord = {
  id: string
  caller: string
  mode: Mode
  created_at: string
  idempotency_key: string
  requester: { session_id?: string; agent?: string; tool?: string }
  action_class: string
  scope_summary: string
  reason: string
  ttl: number
  required_level: number | null
}

export type Answer = {
  id: string
  decision: Decision
  approver: string
  level: number
  decided_at: string
  mode: Mode
  channel?: { type: string; message_ref?: string }
  reason_code?: string
  kid: string
  request_hash: string
  sig: string
}

/** Sorted keys, no spaces; a key holding undefined is left out. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`
  if (typeof v === "object" && v !== null)
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`
  return JSON.stringify(v)
}

export const requestHash = (r: RequestRecord): string =>
  createHash("sha256").update(canonical(r)).digest("hex")

export const signedString = (
  a: Pick<
    Answer,
    | "id"
    | "request_hash"
    | "decision"
    | "level"
    | "mode"
    | "approver"
    | "decided_at"
  >,
): string =>
  [
    SIGN_VERSION,
    a.id,
    a.request_hash,
    a.decision,
    String(a.level),
    a.mode,
    a.approver,
    a.decided_at,
  ].join("\n")

export type SigningKey = { kid: string; privateKey: string; publicKey: string }

/** PKCS8 for the private half (stored in the Keychain), SPKI PEM for the public half. */
export function newSigningKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const pub = publicKey.export({ type: "spki", format: "pem" }) as string
  return {
    kid: kidOf(pub),
    privateKey: (
      privateKey.export({ type: "pkcs8", format: "der" }) as Buffer
    ).toString("base64"),
    publicKey: pub,
  }
}

export const kidOf = (publicPem: string): string =>
  createHash("sha256")
    .update(createPublicKey(publicPem).export({ type: "spki", format: "der" }))
    .digest("hex")
    .slice(0, 16)

/** Fills `sig` and `kid`. */
export function signAnswer(
  key: SigningKey,
  a: Omit<Answer, "sig" | "kid">,
): Answer {
  const pk = createPrivateKey({
    key: Buffer.from(key.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  })
  const sig = sign(null, Buffer.from(signedString(a)), pk).toString("base64")
  return { ...a, kid: key.kid, sig }
}

export type TrustedKey = {
  kid: string
  publicKey: string
  /** Epoch ms: the key still verifies until then (a rotation overlap). */
  notAfter?: number
}

export type Check =
  | { ok: true }
  | {
      ok: false
      reason:
        | "unknown_kid"
        | "bad_signature"
        | "unknown_id"
        | "request_mismatch"
        | "time"
        | "level"
        | "mode"
        | "spent"
    }

/**
 * The caller's checks, in order: signature with the key named by `kid`; the id
 * is one it created; the request hash matches its own copy; `decided_at` lies
 * between its send time and now (with the skew); the level is enough; the mode
 * is `afk`; the id is not spent. Any failure is a refusal.
 */
export function verifyAnswer(o: {
  answer: Answer
  keys: TrustedKey[]
  /** The caller's own copy of the request, as it hashes. */
  request: RequestRecord
  sentAt: number
  now: number
  minLevel: number
  knownId?: (id: string) => boolean
  spent?: (id: string) => boolean
  mode?: Mode
  skewMs?: number
}): Check {
  const { answer: a } = o
  const skew = o.skewMs ?? 60_000
  const key = o.keys.find(
    (k) => k.kid === a.kid && (k.notAfter === undefined || o.now <= k.notAfter),
  )
  if (!key) return { ok: false, reason: "unknown_kid" }
  let good = false
  try {
    good = verify(
      null,
      Buffer.from(signedString(a)),
      createPublicKey(key.publicKey),
      Buffer.from(a.sig, "base64"),
    )
  } catch {}
  if (!good) return { ok: false, reason: "bad_signature" }
  if (o.knownId && !o.knownId(a.id)) return { ok: false, reason: "unknown_id" }
  if (a.id !== o.request.id || a.request_hash !== requestHash(o.request))
    return { ok: false, reason: "request_mismatch" }
  const at = Date.parse(a.decided_at)
  if (!(at >= o.sentAt - skew && at <= o.now + skew))
    return { ok: false, reason: "time" }
  if (a.decision === "approve" && a.level < o.minLevel)
    return { ok: false, reason: "level" }
  if (a.mode !== (o.mode ?? "afk")) return { ok: false, reason: "mode" }
  if (o.spent?.(a.id)) return { ok: false, reason: "spent" }
  return { ok: true }
}
