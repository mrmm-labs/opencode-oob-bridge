/**
 * The approval state machine (docs/approvals.md section 5). It holds the rules
 * and nothing else: the clock, the keys, the channels and the store are
 * injected, so every rule is tested alone. The socket and the Telegram wiring
 * are thin layers over `create`, `tap` and `typed`.
 */
import { randomBytes, timingSafeEqual } from "node:crypto"

import type { ApprovalsConfig } from "./config.ts"
import {
  requestHash,
  type Answer,
  type Decision,
  type Mode,
  type RequestRecord,
} from "./sign.ts"
import { RecordStore, sha, terminal, type Rec, type State } from "./store.ts"
import { match } from "./totp.ts"
import type { ApprovalView, ChannelCaps, Settled, TapResult } from "./types.ts"

export type { ApprovalView, ChannelCaps, Settled, TapResult }

export interface ChannelPort {
  id: string
  type: string
  caps: ChannelCaps
  up(): boolean
  /** The user id stored at pairing: the only one whose tap or code counts. */
  operator(): string | undefined
  /** Posts the request with Approve and Deny; the reference of the message. */
  request(v: ApprovalView): Promise<string | undefined>
  /** Asks for the code in the same chat; the reference of the prompt. */
  askCode(v: ApprovalView): Promise<string | undefined>
  /** Rewrites the message to its final state and removes the buttons. Never throws. */
  settle(ref: string, v: ApprovalView, s: Settled): Promise<void>
  /** Deletes a message, best effort. Never throws. */
  remove(ref: string): Promise<void>
}

export type Deps = {
  cfg: () => ApprovalsConfig
  now: () => number
  mode: () => Mode
  channels: () => ChannelPort[]
  /** Signs an answer; throws when the key cannot be read. */
  sign: (a: Omit<Answer, "sig" | "kid">) => Promise<Answer>
  signingReady: () => Promise<boolean>
  seed: () => Promise<Uint8Array | undefined>
  store: RecordStore
  mask: (text: string) => string
  log?: (event: string, fields: Record<string, unknown>) => void
  id?: () => string
  nonce?: () => string
}

export type Res = { status: number; body: unknown }
export type Ev = { id: number; type: "pending" | "answer"; data: unknown }

export const MAX_SCOPE = 500
export const MAX_REASON = 300
export const MAX_WRONG = 3

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export function ulid(now = Date.now(), rnd = randomBytes(10)): string {
  let t = ""
  for (let n = now, i = 0; i < 10; i++, n = Math.floor(n / 32))
    t = CROCKFORD[n % 32] + t
  let bits = 0
  let acc = 0
  let r = ""
  for (const b of rnd) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      r += CROCKFORD[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return t + r
}

const fail = (
  status: number,
  error: string,
  retryable = false,
  extra: Record<string, unknown> = {},
): Res => ({ status, body: { error, retryable, ...extra } })

type Live = {
  rec: Rec
  view: ApprovalView
  nonce: string
  wrong: number
  deciding: boolean
  codeRef?: string
  events: Ev[]
  subs: Set<(e: Ev) => void>
}

const str = (v: unknown, max: number) =>
  typeof v === "string" && v.length <= max ? v : undefined

export class Approvals {
  private readonly d: Deps
  private readonly live = new Map<string, Live>()
  private readonly usedSteps = new Set<number>()
  /** Code gates for permission replies: they are not requests and are never stored. */
  private readonly gates = new Map<
    string,
    {
      channel: ChannelPort
      view: ApprovalView
      wrong: number
      codeRef?: string
      done: (r: "approved" | "denied" | "expired") => void
    }
  >()

  constructor(d: Deps) {
    this.d = d
  }

  private log(event: string, f: Record<string, unknown>) {
    this.d.log?.(event, f)
  }

  /** Expires what a restart left pending, with a signed answer when the key can be read. */
  async recover(): Promise<void> {
    for (const rec of this.d.store.all()) {
      if (terminal(rec.state)) continue
      const l = this.liveOf(rec, "")
      await this.finish(l, "expired", 0, "bridge", "bridge_restart")
    }
  }

  private liveOf(rec: Rec, nonce: string): Live {
    return {
      rec,
      nonce,
      wrong: 0,
      deciding: false,
      events: [],
      subs: new Set(),
      view: this.viewOf(rec, nonce),
    }
  }

  private viewOf(rec: Rec, nonce: string): ApprovalView {
    const r = rec.request
    const m = this.d.mask
    return {
      id: r.id,
      short: r.id.slice(-4).toLowerCase(),
      nonce,
      caller: rec.caller,
      requester: {
        session_id: r.requester.session_id && m(r.requester.session_id),
        agent: r.requester.agent && m(r.requester.agent),
        tool: r.requester.tool && m(r.requester.tool),
      },
      action_class: r.action_class,
      level: rec.level,
      scope: m(r.scope_summary),
      reason: m(r.reason),
      expiresAt: rec.expiresAt,
    }
  }

  // ----- the socket's operations -----

  async create(caller: string, raw: unknown): Promise<Res> {
    const cfg = this.d.cfg()
    if (!cfg.enabled) return fail(503, "unavailable", false)
    const b = raw as Record<string, unknown>
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return fail(400, "invalid_request")
    const key = str(b.idempotency_key, 128)
    const cls = str(b.action_class, 64)
    const scope = str(b.scope_summary, MAX_SCOPE)
    const reason = b.reason === undefined ? "" : str(b.reason, MAX_REASON)
    if (!key || !cls || scope === undefined || reason === undefined)
      return fail(400, "invalid_request", false, {
        detail:
          "idempotency_key, action_class and scope_summary are needed; scope_summary is at most 500 characters and reason at most 300",
      })
    const rq = b.requester === undefined ? {} : b.requester
    if (typeof rq !== "object" || rq === null || Array.isArray(rq))
      return fail(400, "invalid_request")
    const requester: RequestRecord["requester"] = {}
    for (const k of ["session_id", "agent", "tool"] as const) {
      const v = (rq as Record<string, unknown>)[k]
      if (v === undefined) continue
      const s = str(v, 200)
      if (s === undefined) return fail(400, "invalid_request")
      requester[k] = s
    }
    const ttlIn = b.ttl
    if (
      ttlIn !== undefined &&
      !(typeof ttlIn === "number" && Number.isInteger(ttlIn) && ttlIn >= 10)
    )
      return fail(400, "invalid_request", false, {
        detail: "ttl is seconds, 10 or more",
      })
    const asked = b.required_level
    if (asked !== undefined && asked !== 1 && asked !== 2 && asked !== 3)
      return fail(400, "invalid_request", false, {
        detail: "required_level is 1, 2 or 3",
      })

    const now = this.d.now()
    const bodyHash = sha(
      JSON.stringify([
        key,
        cls,
        scope,
        reason,
        requester,
        ttlIn ?? null,
        asked ?? null,
      ]),
    )
    const prior = this.d.store.get(caller, key)
    if (prior) {
      if (prior.bodyHash !== bodyHash) return fail(409, "idempotency_mismatch")
      if (!(prior.state === "expired" && prior.reasonCode === "bridge_restart"))
        return { status: 200, body: this.view(prior) }
    }

    const c = cfg.classes[cls]
    if (!c || !cfg.callers[caller]?.classes.includes(cls))
      return fail(403, "forbidden_class")
    if (asked !== undefined && asked < c.level)
      return fail(400, "invalid_request", false, {
        detail:
          "a request may ask for a higher level than its class, never a lower one",
      })
    const level = Math.max(c.level, asked ?? 0)
    if (level >= 3) return fail(409, "needs_local", false, { reason: "level" })
    const mode = this.d.mode()
    if (mode === "present")
      return fail(409, "needs_local", false, { reason: "present" })

    const scopeHash = sha(scope)
    const id = this.d.id?.() ?? ulid(now)
    const ttl = Math.min(
      (ttlIn as number | undefined) ?? cfg.defaultTtl,
      c.maxTtl,
    )
    const record: RequestRecord = {
      id,
      caller,
      mode,
      created_at: new Date(now).toISOString(),
      idempotency_key: key,
      requester,
      action_class: cls,
      scope_summary: scope,
      reason,
      ttl: (ttlIn as number | undefined) ?? cfg.defaultTtl,
      required_level: (asked as number | undefined) ?? null,
    }
    const rec: Rec = {
      caller,
      request: record,
      requestHash: requestHash(record),
      bodyHash,
      scopeHash,
      level,
      state: "pending",
      createdAt: now,
      expiresAt: now + ttl * 1000,
    }

    if (!(await this.d.signingReady())) return fail(503, "unavailable", true)
    if (this.cooling(caller, cls, scopeHash, cfg.cooldown, now)) {
      const l = this.liveOf(rec, "")
      await this.finish(l, "deny", 0, "bridge", "cooldown")
      return { status: 201, body: this.view(rec) }
    }

    const lim = cfg.limits
    const open = [...this.live.values()].filter(
      (l) => l.rec.caller === caller,
    ).length
    const hour = this.d.store
      .all()
      .filter(
        (r) => now - r.createdAt < 3_600_000 && r.reasonCode !== "cooldown",
      )
    if (
      open >= lim.pending ||
      hour.filter((r) => r.caller === caller).length >= lim.perHour ||
      hour.length >= lim.global
    )
      return fail(429, "rate_limited", true)

    const seed = level >= 2 ? await this.d.seed() : undefined
    const wanted = this.d
      .channels()
      .filter(
        (ch) => c.channels.includes(ch.id) || c.channels.includes(ch.type),
      )
    const ch = wanted.find(
      (x) =>
        x.up() &&
        x.operator() !== undefined &&
        x.caps.buttons &&
        x.caps.approver === "verified" &&
        (level < 2 || (x.caps.replyText && seed)),
    )
    if (!ch) {
      const unpaired = wanted.some((x) => x.up() && x.operator() === undefined)
      return unpaired
        ? fail(409, "not_paired", false)
        : fail(503, "unavailable", true)
    }

    const nonce = this.d.nonce?.() ?? randomBytes(6).toString("base64url")
    const l = this.liveOf(rec, nonce)
    this.live.set(id, l)
    rec.channel = { id: ch.id, type: ch.type }
    const ref = await ch.request(l.view)
    if (!ref) {
      this.live.delete(id)
      this.log("approval_undelivered", {
        id,
        caller,
        class: cls,
        channel: ch.id,
      })
      return fail(503, "unavailable", true)
    }
    rec.channel.ref = ref
    this.d.store.put(rec)
    this.emit(l, "pending", {
      id,
      state: "pending",
      expires_at: iso(rec.expiresAt),
    })
    this.log("approval_created", {
      id,
      caller,
      class: cls,
      level,
      channel: ch.id,
    })
    return { status: 201, body: this.view(rec) }
  }

  private cooling(
    caller: string,
    cls: string,
    scopeHash: string,
    cooldown: number,
    now: number,
  ): boolean {
    return (
      cooldown > 0 &&
      this.d.store
        .all()
        .some(
          (r) =>
            r.caller === caller &&
            r.request.action_class === cls &&
            r.scopeHash === scopeHash &&
            r.state === "denied" &&
            r.reasonCode !== "cooldown" &&
            r.decidedAt !== undefined &&
            now - r.decidedAt < cooldown * 1000,
        )
    )
  }

  private view(rec: Rec) {
    return {
      id: rec.request.id,
      state: rec.state,
      expires_at: iso(rec.expiresAt),
      request: rec.request,
      request_hash: rec.requestHash,
      ...(rec.answer ? { answer: rec.answer } : {}),
      ...(rec.reasonCode ? { reason_code: rec.reasonCode } : {}),
    }
  }

  /** The request, for its caller only. */
  get(caller: string, id: string): Res {
    const rec = this.d.store.byId(id)
    if (!rec || rec.caller !== caller) return fail(404, "invalid_request")
    return { status: 200, body: this.view(rec) }
  }

  /** Long poll: returns when the request is decided or after `seconds`. */
  async wait(caller: string, id: string, seconds: number): Promise<Res> {
    const first = this.get(caller, id)
    const l = this.live.get(id)
    if (first.status !== 200 || !l) return first
    await new Promise<void>((resolve) => {
      const off = (): void => {
        clearTimeout(timer)
        l.subs.delete(sub)
        resolve()
      }
      const sub = (e: Ev) => e.type === "answer" && off()
      const timer = setTimeout(off, Math.min(Math.max(seconds, 0), 60) * 1000)
      timer.unref?.()
      l.subs.add(sub)
    })
    return this.get(caller, id)
  }

  /** Events of a request after `last`, and a subscription to the rest. */
  events(
    caller: string,
    id: string,
    last = 0,
  ): { replay: Ev[]; subscribe(fn: (e: Ev) => void): () => void } | undefined {
    const rec = this.d.store.byId(id)
    if (!rec || rec.caller !== caller) return undefined
    const l = this.live.get(id)
    const all: Ev[] = l?.events ?? [
      {
        id: 1,
        type: "pending",
        data: { id, state: "pending", expires_at: iso(rec.expiresAt) },
      },
      ...(terminal(rec.state)
        ? [
            {
              id: 2,
              type: "answer" as const,
              data: rec.answer ?? { id, state: rec.state },
            },
          ]
        : []),
    ]
    return {
      replay: all.filter((e) => e.id > last),
      subscribe: (fn) => {
        l?.subs.add(fn)
        return () => void l?.subs.delete(fn)
      },
    }
  }

  async withdraw(caller: string, id: string): Promise<Res> {
    const rec = this.d.store.byId(id)
    if (!rec || rec.caller !== caller) return fail(404, "invalid_request")
    const l = this.live.get(id)
    if (l && !terminal(rec.state))
      await this.finish(l, "expired", 0, "bridge", "withdrawn")
    return { status: 200, body: this.view(rec) }
  }

  async status() {
    const cfg = this.d.cfg()
    const signing = await this.d.signingReady().catch(() => false)
    const seed = (await this.d.seed().catch(() => undefined)) !== undefined
    return {
      enabled: cfg.enabled,
      mode: this.d.mode(),
      signing,
      totp: seed,
      channels: this.d.channels().map((ch) => ({
        id: ch.id,
        type: ch.type,
        up: ch.up(),
        paired: ch.operator() !== undefined,
        levels: levels(ch, signing, seed),
      })),
    }
  }

  // ----- what the operator does -----

  async tap(t: {
    channel: string
    userId: string
    id: string
    nonce: string
    action: "approve" | "deny"
  }): Promise<TapResult> {
    const ch = this.d.channels().find((c) => c.id === t.channel)
    const op = ch?.operator()
    if (!ch || op === undefined || op !== t.userId) {
      this.log("approval_ignored", {
        id: t.id,
        reason: "not_operator",
        channel: t.channel,
      })
      return { ok: false, text: "Only the paired operator can answer." }
    }
    const l = this.live.get(t.id)
    if (!l || !same(l.nonce, t.nonce)) {
      const rec = this.d.store.byId(t.id)
      return {
        ok: false,
        text:
          rec && terminal(rec.state)
            ? `Already ${rec.state}.`
            : "Unknown request.",
      }
    }
    const rec = l.rec
    if (terminal(rec.state) || l.deciding)
      return { ok: false, text: `Already ${rec.state}.` }
    if (this.d.now() >= rec.expiresAt) {
      await this.finish(l, "expired", 0, "bridge", "timeout")
      return { ok: false, text: "Expired." }
    }
    if (this.d.mode() === "present") {
      await this.finish(l, "expired", 0, "bridge", "present")
      return { ok: false, text: "Withdrawn: you are at the Mac." }
    }
    if (t.action === "deny") {
      await this.finish(l, "deny", 1, t.userId)
      return { ok: true, text: "Denied." }
    }
    if (rec.level <= 1) {
      await this.finish(l, "approve", 1, t.userId)
      return { ok: true, text: "Approved." }
    }
    if (rec.state === "awaiting_code")
      return { ok: true, text: "Type the code in the chat.", next: "code" }
    rec.state = "awaiting_code"
    this.d.store.put(rec)
    l.codeRef = await ch.askCode({ ...l.view, code: true })
    return { ok: true, text: "Type the code in the chat.", next: "code" }
  }

  /**
   * Text typed in a chat. A code is consumed (and its message deleted) when a
   * request of this channel waits for one and the sender is the operator.
   */
  async typed(t: {
    channel: string
    userId: string
    text: string
    messageRef?: string
    replyTo?: string
  }): Promise<"consumed" | "ignored"> {
    const ch = this.d.channels().find((c) => c.id === t.channel)
    if (!ch || ch.operator() === undefined || ch.operator() !== t.userId)
      return "ignored"
    if (!/^\d{6}$/.test(t.text.trim())) return "ignored"
    const waiting = [
      ...[...this.live.values()]
        .filter(
          (l) =>
            l.rec.state === "awaiting_code" && l.rec.channel?.id === t.channel,
        )
        .map((l) => ({
          id: l.rec.request.id,
          ref: l.codeRef,
          at: l.rec.createdAt,
        })),
      ...[...this.gates.entries()]
        .filter(([, g]) => g.channel.id === t.channel)
        .map(([id, g]) => ({ id, ref: g.codeRef, at: 0 })),
    ].sort((a, b) => b.at - a.at)
    const pick = waiting.find((w) => w.ref && w.ref === t.replyTo) ?? waiting[0]
    if (!pick) return "ignored"
    if (t.messageRef) void ch.remove(t.messageRef)

    const seed = await this.d.seed().catch(() => undefined)
    const step = seed ? match(seed, t.text.trim(), this.d.now()) : undefined
    const ok = step !== undefined && !this.usedSteps.has(step)
    if (ok) {
      this.usedSteps.add(step)
      for (const s of this.usedSteps) if (s < step - 4) this.usedSteps.delete(s)
    }
    const gate = this.gates.get(pick.id)
    if (gate) {
      if (this.d.now() >= gate.view.expiresAt) this.endGate(pick.id, "expired")
      else if (ok) this.endGate(pick.id, "approved")
      else if (++gate.wrong >= MAX_WRONG) this.endGate(pick.id, "denied")
      return "consumed"
    }
    const l = this.live.get(pick.id)
    if (!l || terminal(l.rec.state) || l.deciding) return "consumed"
    if (this.d.now() >= l.rec.expiresAt)
      await this.finish(l, "expired", 0, "bridge", "timeout")
    else if (ok) await this.finish(l, "approve", 2, t.userId)
    else if (++l.wrong >= MAX_WRONG)
      await this.finish(l, "deny", 1, t.userId, "bad_code")
    return "consumed"
  }

  /**
   * A code gate: the operator has already tapped (a permission button) and the
   * level needs a code too. Resolves when it is typed, or after `ttl` seconds.
   */
  codeGate(o: {
    channel: string
    summary: string
    ttl?: number
  }): Promise<"approved" | "denied" | "expired" | "unavailable"> {
    const ch = this.d.channels().find((c) => c.id === o.channel)
    if (!ch || !ch.caps.replyText) return Promise.resolve("unavailable")
    return this.d.seed().then(
      async (seed) => {
        if (!seed) return "unavailable"
        const id = ulid(this.d.now())
        const view: ApprovalView = {
          id,
          short: id.slice(-4).toLowerCase(),
          nonce: "",
          caller: "permission",
          requester: {},
          action_class: "permission",
          level: 2,
          scope: this.d.mask(o.summary),
          reason: "",
          expiresAt: this.d.now() + (o.ttl ?? 120) * 1000,
          code: true,
        }
        return await new Promise<"approved" | "denied" | "expired">(
          (resolve) => {
            const gate = {
              channel: ch,
              view,
              wrong: 0,
              codeRef: undefined as string | undefined,
              done: resolve,
            }
            this.gates.set(id, gate)
            void ch.askCode(view).then((ref) => {
              gate.codeRef = ref
              if (!ref) this.endGate(id, "expired")
            })
          },
        )
      },
      () => "unavailable" as const,
    )
  }

  private endGate(id: string, r: "approved" | "denied" | "expired") {
    const g = this.gates.get(id)
    if (!g) return
    this.gates.delete(id)
    if (g.codeRef) void g.channel.remove(g.codeRef)
    g.done(r)
  }

  /** Expires what ran out and withdraws everything when the operator is present. Called every second. */
  async sweep(): Promise<void> {
    const now = this.d.now()
    const present = this.d.mode() === "present"
    for (const l of this.live.values()) {
      if (terminal(l.rec.state) || l.deciding) continue
      if (present) await this.finish(l, "expired", 0, "bridge", "present")
      else if (now >= l.rec.expiresAt)
        await this.finish(l, "expired", 0, "bridge", "timeout")
    }
    for (const [id, g] of this.gates)
      if (now >= g.view.expiresAt || present) this.endGate(id, "expired")
  }

  pending(): number {
    return this.live.size
  }

  private emit(l: Live, type: Ev["type"], data: unknown) {
    const e: Ev = { id: l.events.length + 1, type, data }
    l.events.push(e)
    for (const s of l.subs) s(e)
  }

  private async finish(
    l: Live,
    decision: Decision,
    level: number,
    approver: string,
    reasonCode?: string,
  ): Promise<void> {
    const rec = l.rec
    if (l.deciding || terminal(rec.state)) return
    l.deciding = true
    const now = this.d.now()
    const state: State =
      decision === "approve"
        ? "approved"
        : decision === "deny"
          ? "denied"
          : reasonCode === "withdrawn" || reasonCode === "present"
            ? "withdrawn"
            : "expired"
    const decidedAt = iso(now)
    let answer: Answer | undefined
    try {
      answer = await this.d.sign({
        id: rec.request.id,
        request_hash: rec.requestHash,
        decision,
        level,
        mode: rec.request.mode,
        approver,
        decided_at: decidedAt,
        channel: rec.channel && {
          type: rec.channel.type,
          message_ref: rec.channel.ref,
        },
        ...(reasonCode ? { reason_code: reasonCode } : {}),
      })
    } catch (err) {
      this.log("approval_unsigned", {
        id: rec.request.id,
        message: (err as Error).message,
      })
    }
    rec.state = answer ? state : "expired"
    rec.decidedAt = now
    rec.answer = answer
    rec.reasonCode = answer ? reasonCode : "unavailable"
    this.d.store.put(rec)
    this.live.delete(rec.request.id)
    this.emit(
      l,
      "answer",
      answer ?? { id: rec.request.id, state: rec.state, error: "unavailable" },
    )
    this.log("approval_decided", {
      id: rec.request.id,
      caller: rec.caller,
      class: rec.request.action_class,
      decision,
      level,
      reason_code: reasonCode,
      channel: rec.channel?.id,
    })
    const ch = this.d.channels().find((c) => c.id === rec.channel?.id)
    if (ch && rec.channel?.ref)
      await ch.settle(rec.channel.ref, l.view, {
        decision,
        level,
        reason: reasonCode,
        by: approver === "bridge" ? undefined : approver,
      })
    if (ch && l.codeRef) await ch.remove(l.codeRef)
  }
}

export const iso = (ms: number) => new Date(ms).toISOString()

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function levels(
  ch: ChannelPort,
  signing: boolean,
  seed: boolean,
): number[] {
  if (!signing || !ch.up() || ch.operator() === undefined) return []
  if (!ch.caps.buttons || ch.caps.approver !== "verified") return []
  return ch.caps.replyText && seed ? [1, 2] : [1]
}
