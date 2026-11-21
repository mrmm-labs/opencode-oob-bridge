/**
 * The approvals service of one server: the engine, the socket, the keys, the
 * callers and the connectors, wired together (docs/approvals.md section 4.3).
 * Everything that creates, replaces or deletes a key is a method here that only
 * the TUI reaches; neither the socket nor a chat can call them.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { filterSecrets } from "../filter.ts"
import { log } from "../logger.ts"
import type { Connector } from "../connectors/types.ts"
import { CallerStore } from "./callers.ts"
import type { ApprovalsConfig } from "./config.ts"
import { Approvals, type ChannelPort } from "./engine.ts"
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

const SIGNING = "signing-key"
const SEED = "totp-seed"

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
}

type PublicKeys = Array<{ kid: string; public_key: string; not_after?: string }>

export type ServiceStatus = {
  state: "off" | "listening" | "refused"
  reason?: string
  socket: string
  signing: boolean
  totp: boolean
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
  }
}

export class ApprovalService {
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
    return {
      ...this.state,
      socket: this.socket,
      signing: ready,
      totp: (await this.seed()) !== undefined,
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
