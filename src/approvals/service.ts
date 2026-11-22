/**
 * The approvals service of one server: the engine, the socket, the keys, the
 * callers and the connectors, wired together (docs/approvals.md section 4.3).
 * Everything that creates, replaces or deletes a key is a method here that only
 * the TUI reaches; neither the socket nor a chat can call them.
 */
import { createHash, randomBytes } from "node:crypto"
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"

import { filterSecrets } from "../filter.ts"
import { log } from "../logger.ts"
import type { Connector } from "../connectors/types.ts"
import { CallerStore } from "./callers.ts"
import type { ApprovalsConfig } from "./config.ts"
import { Approvals, type ChannelPort, type Res } from "./engine.ts"
import {
  checkRegistration,
  emptyEnrolled,
  newDevice,
  newNonce,
  parseEnrolled,
  same,
  type Enrolled,
  type Factor,
} from "./factors.ts"
import { KeyStoreUnavailable, type KeyStore } from "./keystore.ts"
import {
  kidOf,
  newSigningKey,
  signAnswer,
  type Mode,
  type SigningKey,
} from "./sign.ts"
import { startEndpoint, type Endpoint } from "./socket.ts"
import { RecordStore } from "./store.ts"
import { base32, newSeed, otpauth } from "./totp.ts"
import type { AppApprovals } from "./types.ts"

const SIGNING = "signing-key"
const SEED = "totp-seed"
const DEVICES = "l2-devices"
const ENROL_MS = 5 * 60_000
const ENROL_TRIES = 5

/** Actions that only read: a tap is enough by default. Everything else asks for a code. */
export const READ_LIKE = new Set([
  "read",
  "list",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "codesearch",
  "lsp",
  "skill",
])

export type Gate =
  | { kind: "allow" }
  | { kind: "refuse"; text: string }
  | {
      kind: "code"
      wait: Promise<"approved" | "denied" | "expired" | "unavailable">
    }

export type ServiceOptions = {
  cfg: () => ApprovalsConfig
  dir: string
  keys: KeyStore
  connectors: () => readonly Connector[]
  /** True when the operator counts as away from the machine. */
  away: () => boolean
  now?: () => number
  /** Every second; tests turn it off. */
  sweepMs?: number
  /** The public address of the Mini App (`miniApp.url`): the relying party of passkeys. */
  app?: () => string | undefined
}

type PublicKeys = Array<{ kid: string; public_key: string; not_after?: string }>

export type ServiceStatus = {
  state: "off" | "listening" | "refused"
  reason?: string
  socket: string
  signing: boolean
  totp: boolean
  factors: Factor[]
  /** Enrolled Face ID devices and passkeys. */
  biometric: number
  passkeys: number
  callers: string[]
  pending: number
  mode: Mode
  keychain?: string
}

const adapt = (c: Connector): ChannelPort | undefined => {
  const caps = c.capabilities.approvals
  if (!caps || !c.approvalRequest || !c.approvalCode || !c.approvalSettle)
    return undefined
  return {
    id: c.id,
    type: c.type,
    caps,
    up: () => c.enabled && c.status().connected === true,
    operator: () => c.operator?.(),
    request: (v) => c.approvalRequest!(v),
    askCode: (v) => c.approvalCode!(v),
    settle: (ref, v, s) => c.approvalSettle!(ref, v, s),
    remove: async (ref) => void (await c.deleteMessage?.(ref)),
    app: () => c.appOpen?.() === true,
  }
}

const fail = (status: number, text: string): Res => ({
  status,
  body: { ok: false, text },
})

/** Kept in a file of the data directory, so the instance that serves the phone sees what the TUI's instance opened. The code is stored salted and hashed. */
type Enrolment = {
  kind: "biometric" | "passkey"
  salt: string
  hash: string
  expiresAt: number
  tries: number
  challenge?: string
  by: string
}

const codeHash = (salt: string, code: string) =>
  createHash("sha256").update(salt).update(code).digest("hex")

export class ApprovalService implements AppApprovals {
  readonly engine: Approvals
  readonly callers: CallerStore
  readonly socket: string
  private readonly o: ServiceOptions
  private readonly store: RecordStore
  private endpoint: Endpoint | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private state: Pick<ServiceStatus, "state" | "reason"> = {
    state: "off",
    reason: "approvals.enabled is not true",
  }
  private keychain: string | undefined
  private enrolQueue: Promise<unknown> = Promise.resolve()
  private readonly id = randomBytes(3).toString("hex")

  constructor(o: ServiceOptions) {
    this.o = o
    this.socket = join(o.dir, "approvals.sock")
    this.callers = new CallerStore(join(o.dir, "callers"))
    this.store = new RecordStore(join(o.dir, "approvals.jsonl"))
    this.engine = new Approvals({
      cfg: o.cfg,
      now: o.now ?? Date.now,
      mode: () => (o.away() ? "afk" : "present"),
      channels: () =>
        o
          .connectors()
          .map(adapt)
          .filter((p): p is ChannelPort => p !== undefined),
      sign: async (a) => signAnswer(await this.signingKey(), a),
      signingReady: () => this.signingReady(),
      seed: () => this.seed(),
      enrolled: () => this.enrolled(),
      rp: () => this.rp(),
      store: this.store,
      mask: filterSecrets,
      log,
    })
  }

  async start(): Promise<void> {
    if (!this.o.cfg().enabled) return
    for (const c of this.o.connectors()) c.onApproval?.(this.engine)
    await this.store.load(this.o.now?.() ?? Date.now())
    await this.callers.load()
    try {
      this.endpoint = await startEndpoint({
        path: this.socket,
        engine: this.engine,
        callers: this.callers,
        now: this.o.now,
      })
      this.state = { state: "listening" }
      log("approvals_listening", {})
    } catch (err) {
      const reason = (err as Error).message
      this.state = { state: "refused", reason }
      log("approvals_refused", { reason })
      return
    }
    await this.engine.recover()
    this.timer = setInterval(
      () =>
        void this.engine
          .sweep()
          .catch((e: Error) =>
            log("approvals_sweep_error", { message: e.message }),
          ),
      this.o.sweepMs ?? 1000,
    )
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.endpoint?.close()
    this.endpoint = undefined
    await this.store.flush()
  }

  // ----- keys -----

  private async signingKey(): Promise<SigningKey> {
    const raw = await this.o.keys.get(SIGNING)
    if (!raw)
      throw new KeyStoreUnavailable(
        "no signing key: pair a caller from the TUI first",
      )
    return JSON.parse(raw) as SigningKey
  }

  private async signingReady(): Promise<boolean> {
    try {
      this.keychain = undefined
      return (await this.o.keys.get(SIGNING)) !== undefined
    } catch (err) {
      this.keychain = (err as Error).message
      return false
    }
  }

  private async seed(): Promise<Uint8Array | undefined> {
    try {
      const raw = await this.o.keys.get(SEED)
      return raw ? new Uint8Array(Buffer.from(raw, "base64")) : undefined
    } catch {
      return undefined
    }
  }

  private async enrolled(): Promise<Enrolled> {
    try {
      return parseEnrolled(await this.o.keys.get(DEVICES))
    } catch {
      return emptyEnrolled()
    }
  }

  private rp(): { id: string; origin: string } | undefined {
    try {
      const u = new URL(this.o.app?.() ?? "")
      return u.protocol === "https:"
        ? { id: u.hostname, origin: u.origin }
        : undefined
    } catch {
      return undefined
    }
  }

  /** Opens an enrolment of a phone: a code for 5 minutes, shown at the Mac. Only the TUI reaches it. */
  async openEnrolment(
    kind: Enrolment["kind"],
  ): Promise<{ code: string; expiresAt: number }> {
    const code = base32(randomBytes(5))
    const expiresAt = (this.o.now?.() ?? Date.now()) + ENROL_MS
    const salt = randomBytes(8).toString("hex")
    await this.saveEnrolment({
      kind,
      salt,
      hash: codeHash(salt, code),
      expiresAt,
      tries: 0,
      by: this.id,
    })
    log("enrol_opened", { kind, instance: this.id })
    return { code, expiresAt }
  }

  private enrolFile(): string {
    return join(this.o.dir, "approvals-enrolment.json")
  }

  private async loadEnrolment(): Promise<Enrolment | undefined> {
    try {
      const v = JSON.parse(
        await readFile(this.enrolFile(), "utf8"),
      ) as Enrolment
      return (v.kind === "biometric" || v.kind === "passkey") &&
        typeof v.salt === "string" &&
        typeof v.hash === "string" &&
        typeof v.expiresAt === "number" &&
        typeof v.tries === "number"
        ? v
        : undefined
    } catch {
      return undefined
    }
  }

  private async saveEnrolment(e: Enrolment | undefined): Promise<void> {
    if (!e) {
      await unlink(this.enrolFile()).catch(() => {})
      return
    }
    await mkdir(this.o.dir, { recursive: true, mode: 0o700 })
    const tmp = this.enrolFile() + "." + this.id + ".tmp"
    await writeFile(tmp, JSON.stringify(e), { mode: 0o600 })
    await rename(tmp, this.enrolFile())
  }

  /** What the Mini App sends to enrol: the code from the Mac, and for a passkey the credential in a second call. */
  enrol(b: Record<string, unknown>): Promise<Res> {
    const run = this.enrolQueue.then(() => this.enrolNow(b))
    this.enrolQueue = run.catch(() => {})
    return run
  }

  private async enrolNow(b: Record<string, unknown>): Promise<Res> {
    const res = await this.enrolStep(b)
    const body = res.body as { ok?: boolean }
    log("enrol_result", {
      kind: typeof b.kind === "string" ? b.kind : "",
      outcome: res.status === 200 ? "ok" : "refused",
      status: res.status,
      reason: this.enrolReason,
      instance: this.id,
      opened_by: this.enrolOpenedBy,
      step: body.ok && b.credential === undefined ? "begin" : "done",
    })
    return res
  }

  private enrolReason = ""
  private enrolOpenedBy = ""

  private async enrolStep(b: Record<string, unknown>): Promise<Res> {
    const e = await this.loadEnrolment()
    const now = this.o.now?.() ?? Date.now()
    this.enrolOpenedBy = e?.by ?? ""
    if (!e || now >= e.expiresAt) {
      this.enrolReason = e ? "expired" : "none-open"
      if (e) await this.saveEnrolment(undefined)
      return fail(409, "Nothing to enrol: open it at the Mac first.")
    }
    this.enrolReason = "ok"
    const typed =
      typeof b.code === "string"
        ? b.code.toUpperCase().replace(/[^A-Z2-7]/g, "")
        : ""
    if (b.kind !== e.kind || !same(codeHash(e.salt, typed), e.hash)) {
      this.enrolReason = b.kind !== e.kind ? "wrong-kind" : "wrong-code"
      if (++e.tries >= ENROL_TRIES) {
        this.enrolReason = "too-many-tries"
        await this.saveEnrolment(undefined)
      } else await this.saveEnrolment(e)
      return fail(403, "That code is not right.")
    }
    const en = await this.enrolled()
    if (e.kind === "biometric") {
      const d = newDevice()
      en.biometric[d.id] = d.secret
      try {
        await this.saveEnrolled(en)
      } catch {
        this.enrolReason = "keychain-refused"
        return fail(
          503,
          "The Keychain refused: answer its prompt at the Mac and try again.",
        )
      }
      await this.saveEnrolment(undefined)
      return {
        status: 200,
        body: { ok: true, device: d.id, token: d.id + "." + d.secret },
      }
    }
    const rp = this.rp()
    if (!rp) {
      this.enrolReason = "no-miniapp-url"
      return fail(409, "miniApp.url is not set: a passkey needs its address.")
    }
    if (b.credential === undefined) {
      e.challenge ??= newNonce()
      await this.saveEnrolment(e)
      return {
        status: 200,
        body: {
          ok: true,
          challenge: e.challenge,
          rp: { id: rp.id, name: "OpenCode approvals" },
          user: { id: newNonce(), name: "operator" },
        },
      }
    }
    const c = e.challenge
      ? checkRegistration({
          challenge: e.challenge,
          origin: rp.origin,
          credential: b.credential,
        })
      : undefined
    if (!c) {
      this.enrolReason = "passkey-rejected"
      return fail(422, "The passkey was not accepted.")
    }
    en.passkeys[c.id] = c.publicKey
    try {
      await this.saveEnrolled(en)
    } catch {
      this.enrolReason = "keychain-refused"
      return fail(
        503,
        "The Keychain refused: answer its prompt at the Mac and try again.",
      )
    }
    await this.saveEnrolment(undefined)
    return { status: 200, body: { ok: true } }
  }

  private async saveEnrolled(en: Enrolled): Promise<void> {
    await this.o.keys.set(DEVICES, JSON.stringify(en))
  }

  async devices(): Promise<{ biometric: string[]; passkeys: string[] }> {
    const en = await this.enrolled()
    return {
      biometric: Object.keys(en.biometric),
      passkeys: Object.keys(en.passkeys),
    }
  }

  /** Removes a Face ID device or a passkey: its proofs fail from then on. */
  async revokeDevice(id: string): Promise<boolean> {
    const en = await this.enrolled()
    const had =
      Object.hasOwn(en.biometric, id) || Object.hasOwn(en.passkeys, id)
    if (!had) return false
    delete en.biometric[id]
    delete en.passkeys[id]
    await this.saveEnrolled(en)
    return true
  }

  appView(id: string): Promise<Res> {
    return this.engine.appView(id)
  }

  appProof(id: string, body: Record<string, unknown>): Promise<Res> {
    return this.engine.appProof(id, body)
  }

  private publicFile(): string {
    return join(this.o.dir, "approvals-keys.json")
  }

  private async publicKeys(): Promise<PublicKeys> {
    try {
      const v = JSON.parse(
        await readFile(this.publicFile(), "utf8"),
      ) as PublicKeys
      const now = this.o.now?.() ?? Date.now()
      return v.filter((k) => !k.not_after || Date.parse(k.not_after) > now)
    } catch {
      return []
    }
  }

  private async savePublicKeys(keys: PublicKeys): Promise<void> {
    await mkdir(this.o.dir, { recursive: true, mode: 0o700 })
    await writeFile(this.publicFile(), JSON.stringify(keys, null, 2) + "\n", {
      mode: 0o600,
    })
    await chmod(this.publicFile(), 0o600)
  }

  /** Creates the signing key when there is none. Reaches the Keychain with user presence, from the TUI. */
  private async ensureKey(): Promise<PublicKeys> {
    const have = await this.o.keys.get(SIGNING)
    const known = await this.publicKeys()
    if (have) {
      const k = JSON.parse(have) as SigningKey
      if (known.some((x) => x.kid === k.kid)) return known
      const next = [{ kid: k.kid, public_key: k.publicKey }, ...known]
      await this.savePublicKeys(next)
      return next
    }
    const k = newSigningKey()
    await this.o.keys.set(SIGNING, JSON.stringify(k))
    const next = [{ kid: k.kid, public_key: k.publicKey }, ...known]
    await this.savePublicKeys(next)
    return next
  }

  async pairCaller(name: string): Promise<{ file: string; listed: boolean }> {
    await this.callers.load()
    const keys = await this.ensureKey()
    const f = await this.callers.pair(
      name,
      keys,
      this.socket,
      this.o.now?.() ?? Date.now(),
    )
    return {
      file: join(this.o.dir, "callers", `${f.name}.json`),
      listed: this.o.cfg().callers[name] !== undefined,
    }
  }

  async revokeCaller(name: string): Promise<boolean> {
    await this.callers.load()
    return this.callers.revoke(name)
  }

  /** A new seed, shown once. Refuses to replace one unless `replace` is set. */
  async enrollTotp(
    replace = false,
  ): Promise<{ secret: string; uri: string } | "exists"> {
    if (!replace && (await this.o.keys.get(SEED)) !== undefined) return "exists"
    const seed = newSeed()
    await this.o.keys.set(SEED, Buffer.from(seed).toString("base64"))
    return {
      secret: base32(seed),
      uri: otpauth(seed, "operator", "OpenCode approvals"),
    }
  }

  /** A new signing key; the old one still verifies for `overlapMs`. Every caller file gets the new list. */
  async rotateKey(
    overlapMs: number,
  ): Promise<{ kid: string; oldKid?: string }> {
    const raw = await this.o.keys.get(SIGNING)
    const old = raw ? (JSON.parse(raw) as SigningKey) : undefined
    const now = this.o.now?.() ?? Date.now()
    const k = newSigningKey()
    const kept = (await this.publicKeys()).map((x) =>
      old && x.kid === old.kid
        ? { ...x, not_after: new Date(now + overlapMs).toISOString() }
        : x,
    )
    await this.o.keys.set(SIGNING, JSON.stringify(k))
    const keys = [{ kid: k.kid, public_key: k.publicKey }, ...kept]
    await this.savePublicKeys(keys)
    await this.callers.load()
    await this.callers.setKeys(keys)
    return { kid: kidOf(k.publicKey), oldKid: old?.kid }
  }

  /** Reads both items once so macOS can ask at the Mac after a host upgrade. */
  async unlock(): Promise<{ signing: boolean; totp: boolean }> {
    const prompt = { prompt: true }
    const signing = (await this.o.keys.get(SIGNING, prompt)) !== undefined
    const totp = (await this.o.keys.get(SEED, prompt)) !== undefined
    return { signing, totp }
  }

  async status(): Promise<ServiceStatus> {
    const ready = await this.signingReady()
    const en = await this.enrolled()
    return {
      ...this.state,
      socket: this.socket,
      signing: ready,
      totp: (await this.seed()) !== undefined,
      factors: this.o.cfg().l2.factors,
      biometric: Object.keys(en.biometric).length,
      passkeys: Object.keys(en.passkeys).length,
      callers: this.callers.names(),
      pending: this.engine.pending(),
      mode: this.o.away() ? "afk" : "present",
      keychain: this.keychain,
    }
  }

  // ----- phone permission replies (task 3.4) -----

  /** What a phone answer to a permission needs: the paired operator, then a level. */
  gate(o: {
    action: string | undefined
    decision: "once" | "always" | "reject"
    channel?: Connector
    userId?: string
  }): Gate {
    const cfg = this.o.cfg()
    if (!cfg.enabled || o.decision === "reject") return { kind: "allow" }
    if (
      o.channel &&
      (o.channel.operator?.() === undefined ||
        o.channel.operator() !== o.userId)
    )
      return {
        kind: "refuse",
        text: "Only the paired operator can answer a permission.",
      }
    const cls = cfg.classes[`permission.${o.action ?? ""}`]
    const base = cls?.level ?? (READ_LIKE.has(o.action ?? "") ? 1 : 2)
    const level = o.decision === "always" ? Math.max(2, base) : base
    if (level >= 3)
      return { kind: "refuse", text: "This one is answered at the Mac." }
    if (
      cls &&
      o.channel &&
      !cls.channels.includes(o.channel.id) &&
      !cls.channels.includes(o.channel.type)
    )
      return {
        kind: "refuse",
        text: "This permission is not answered from this channel.",
      }
    if (level === 1) return { kind: "allow" }
    if (!o.channel)
      return { kind: "refuse", text: "This needs a code from the paired chat." }
    return {
      kind: "code",
      wait: this.engine.codeGate({
        channel: o.channel.id,
        summary: `permission ${o.action ?? ""}: ${o.decision === "always" ? "Always" : "Allow once"}`,
      }),
    }
  }
}
