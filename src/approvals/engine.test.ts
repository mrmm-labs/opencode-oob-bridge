import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { filterSecrets } from "../filter.ts"
import { OFF, type ApprovalsConfig } from "./config.ts"
import {
  Approvals,
  levels,
  ulid,
  type ApprovalView,
  type ChannelPort,
  type Settled,
} from "./engine.ts"
import {
  newSigningKey,
  verifyAnswer,
  type Answer,
  type Mode,
  type RequestRecord,
  type SigningKey,
} from "./sign.ts"
import { RecordStore } from "./store.ts"
import { code, step } from "./totp.ts"
import {
  biometricProof,
  emptyEnrolled,
  passkeyChallenge,
  type Enrolled,
} from "./factors.ts"
import type { Factor } from "./sign.ts"
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto"

const SEED = Buffer.from("12345678901234567890")
const T0 = Date.parse("2026-11-21T12:00:00.000Z")

class Chan implements ChannelPort {
  id = "tg"
  type = "telegram"
  caps: ChannelPort["caps"] = {
    buttons: true,
    approver: "verified",
    replyText: true,
  }
  isUp = true
  appOpen = false
  app() {
    return this.appOpen
  }
  op: string | undefined = "42"
  sent: ApprovalView[] = []
  asked: ApprovalView[] = []
  settled: Array<{ ref: string; s: Settled }> = []
  removed: string[] = []
  fail = false
  n = 0
  up() {
    return this.isUp
  }
  operator() {
    return this.op
  }
  async request(v: ApprovalView) {
    if (this.fail) return undefined
    this.sent.push(v)
    return `m${++this.n}`
  }
  async askCode(v: ApprovalView) {
    this.asked.push(v)
    return `c${++this.n}`
  }
  async settle(ref: string, _v: ApprovalView, s: Settled) {
    this.settled.push({ ref, s })
  }
  async remove(ref: string) {
    this.removed.push(ref)
  }
}

const cfg = (over: Partial<ApprovalsConfig> = {}): ApprovalsConfig => ({
  ...OFF,
  enabled: true,
  classes: {
    "secrets.read": { level: 1, channels: ["telegram"], maxTtl: 600 },
    "secrets.write": { level: 2, channels: ["telegram"], maxTtl: 600 },
    "prod.root": { level: 3, channels: ["telegram"], maxTtl: 600 },
    "ntfy.only": { level: 2, channels: ["ntfy"], maxTtl: 600 },
  },
  callers: {
    "secrets-tool": {
      classes: ["secrets.read", "secrets.write", "prod.root", "ntfy.only"],
    },
    other: { classes: ["secrets.read"] },
  },
  ...over,
})

function setup(over: Partial<ApprovalsConfig> = {}) {
  const t = {
    now: T0,
    mode: "afk" as Mode,
    seed: SEED as Uint8Array | undefined,
    ready: true,
    enrolled: emptyEnrolled() as Enrolled,
    rp: undefined as { id: string; origin: string } | undefined,
  }
  const key: SigningKey = newSigningKey()
  const ch = new Chan()
  const store = new RecordStore()
  let n = 0
  const make = () =>
    new Approvals({
      cfg: () => cfg(over),
      now: () => t.now,
      mode: () => t.mode,
      channels: () => [ch],
      sign: async (a) => {
        const { signAnswer } = await import("./sign.ts")
        return signAnswer(key, a)
      },
      signingReady: async () => t.ready,
      seed: async () => t.seed,
      enrolled: async () => t.enrolled,
      rp: () => t.rp,
      store,
      mask: filterSecrets,
      id: () => `ID${String(++n).padStart(4, "0")}`,
      nonce: () => "nonce",
    })
  return { t, key, ch, store, make, a: make() }
}

const body = (over: Record<string, unknown> = {}) => ({
  idempotency_key: "k1",
  requester: { session_id: "ses_1", agent: "build", tool: "secrets" },
  action_class: "secrets.read",
  scope_summary: "item 4f2a",
  reason: "deploy",
  ...over,
})
type Created = {
  id: string
  state: string
  request: RequestRecord
  answer?: Answer
  reason_code?: string
  request_hash: string
}
const made = async (
  s: ReturnType<typeof setup>,
  over: Record<string, unknown> = {},
  caller = "secrets-tool",
) => {
  const r = await s.a.create(caller, body(over))
  return { r, b: r.body as Created }
}
const tap = (
  s: ReturnType<typeof setup>,
  id: string,
  action: "approve" | "deny" = "approve",
  userId = "42",
) => s.a.tap({ channel: "tg", userId, id, nonce: "nonce", action })
const err = (r: { status: number; body: unknown }) =>
  (r.body as { error: string }).error

describe("approvals: refusals", () => {
  it("is off unless enabled", async () => {
    const s = setup({ enabled: false })
    assert.equal(err(await s.a.create("secrets-tool", body())), "unavailable")
  })

  it("refuses an unlisted class and a class not listed for the caller", async () => {
    const s = setup()
    assert.equal((await made(s, { action_class: "nope" })).r.status, 403)
    const r = await made(
      s,
      { action_class: "secrets.write", idempotency_key: "k2" },
      "other",
    )
    assert.equal(err(r.r), "forbidden_class")
    assert.equal(s.ch.sent.length, 0)
  })

  it("refuses malformed bodies", async () => {
    const s = setup()
    for (const bad of [
      { idempotency_key: "" },
      { scope_summary: "x".repeat(501) },
      { reason: "x".repeat(301) },
      { ttl: 3 },
      { required_level: 4 },
      { required_level: 0 },
    ])
      assert.equal((await made(s, bad)).r.status, 400, JSON.stringify(bad))
    assert.equal((await s.a.create("secrets-tool", "x")).status, 400)
  })

  it("never lets a request ask for a lower level than its class", async () => {
    const s = setup()
    const r = await made(s, {
      action_class: "secrets.write",
      required_level: 1,
    })
    assert.equal(r.r.status, 400)
  })

  it("answers level 3 at once with needs_local and sends nothing", async () => {
    const s = setup()
    const r = await made(s, { action_class: "prod.root" })
    assert.equal(r.r.status, 409)
    assert.equal(err(r.r), "needs_local")
    assert.equal(s.ch.sent.length, 0)
    const up = await made(s, { required_level: 3, idempotency_key: "k9" })
    assert.equal(err(up.r), "needs_local")
  })

  it("refuses a phone request in present mode", async () => {
    const s = setup()
    s.t.mode = "present"
    const r = await made(s)
    assert.deepEqual(r.r.body, {
      error: "needs_local",
      retryable: false,
      reason: "present",
    })
    assert.equal(s.ch.sent.length, 0)
  })

  it("fails at once when no accepted channel can reach the level", async () => {
    const s = setup()
    assert.equal(
      err((await made(s, { action_class: "ntfy.only" })).r),
      "unavailable",
    )
    s.t.seed = undefined
    assert.equal(
      err(
        (
          await made(s, {
            action_class: "secrets.write",
            idempotency_key: "k3",
          })
        ).r,
      ),
      "unavailable",
    )
    s.ch.isUp = false
    assert.equal(
      err((await made(s, { idempotency_key: "k4" })).r),
      "unavailable",
    )
    s.ch.isUp = true
    s.t.ready = false
    assert.equal(
      err((await made(s, { idempotency_key: "k5" })).r),
      "unavailable",
    )
    s.t.ready = true
    s.ch.fail = true
    assert.equal(
      err((await made(s, { idempotency_key: "k6" })).r),
      "unavailable",
    )
  })

  it("says not_paired when the channel has no operator yet", async () => {
    const s = setup()
    s.ch.op = undefined
    assert.equal(err((await made(s)).r), "not_paired")
  })

  it("a channel that proves nobody carries nothing", async () => {
    const s = setup()
    s.ch.caps = { buttons: true, approver: "none", replyText: false }
    assert.equal(err((await made(s)).r), "unavailable")
    assert.deepEqual(levels(s.ch, true, true), [])
  })
})

describe("approvals: L1", () => {
  it("approves with one tap and signs an answer a caller verifies", async () => {
    const s = setup()
    const { r, b } = await made(s)
    assert.equal(r.status, 201)
    assert.equal(b.state, "pending")
    assert.equal(s.ch.sent.length, 1)
    s.t.now += 20_000
    const out = await tap(s, b.id)
    assert.equal(out.ok, true)
    const got = s.a.get("secrets-tool", b.id).body as Created
    assert.equal(got.state, "approved")
    const answer = got.answer!
    assert.equal(answer.decision, "approve")
    assert.equal(answer.level, 1)
    assert.equal(answer.approver, "42")
    assert.equal(answer.mode, "afk")
    assert.deepEqual(
      verifyAnswer({
        answer,
        keys: [{ kid: s.key.kid, publicKey: s.key.publicKey }],
        request: b.request,
        sentAt: T0,
        now: s.t.now,
        minLevel: 1,
      }),
      { ok: true },
    )
    assert.equal(s.ch.settled[0].s.decision, "approve")
  })

  it("is single use: a second tap is refused", async () => {
    const s = setup()
    const { b } = await made(s)
    await tap(s, b.id)
    const again = await tap(s, b.id)
    assert.equal(again.ok, false)
    assert.match(again.text, /Already approved/)
  })

  it("ignores a tap from another user and keeps the request pending", async () => {
    const s = setup()
    const { b } = await made(s)
    const out = await tap(s, b.id, "approve", "99")
    assert.equal(out.ok, false)
    assert.equal(
      (s.a.get("secrets-tool", b.id).body as Created).state,
      "pending",
    )
    assert.equal(s.ch.settled.length, 0)
  })

  it("ignores a tap with a wrong nonce", async () => {
    const s = setup()
    const { b } = await made(s)
    const out = await s.a.tap({
      channel: "tg",
      userId: "42",
      id: b.id,
      nonce: "other",
      action: "approve",
    })
    assert.equal(out.ok, false)
    assert.equal(
      (s.a.get("secrets-tool", b.id).body as Created).state,
      "pending",
    )
  })

  it("denies at any level with no code asked", async () => {
    const s = setup()
    const { b } = await made(s, { action_class: "secrets.write" })
    const out = await tap(s, b.id, "deny")
    assert.equal(out.ok, true)
    assert.equal(s.ch.asked.length, 0)
    const got = s.a.get("secrets-tool", b.id).body as Created
    assert.equal(got.state, "denied")
    assert.equal(got.answer?.decision, "deny")
  })

  it("expires after its ttl and a late tap hears so", async () => {
    const s = setup()
    const { b } = await made(s)
    s.t.now += 121_000
    await s.a.sweep()
    const got = s.a.get("secrets-tool", b.id).body as Created
    assert.equal(got.state, "expired")
    assert.equal(got.answer?.decision, "expired")
    assert.equal(got.answer?.level, 0)
    assert.equal(got.reason_code, "timeout")
    assert.match((await tap(s, b.id)).text, /Already expired/)
    assert.equal(s.ch.settled[0].s.decision, "expired")
  })

  it("caps the ttl per class and defaults it", async () => {
    const s = setup({
      classes: {
        "secrets.read": { level: 1, channels: ["telegram"], maxTtl: 60 },
      },
    })
    const { b } = await made(s, { ttl: 600 })
    const view = s.ch.sent[0]
    assert.equal(view.expiresAt - T0, 60_000)
    assert.equal(b.request.ttl, 600)
  })

  it("masks a token shape in the message", async () => {
    const s = setup()
    await made(s, {
      scope_summary: "key ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    })
    assert.doesNotMatch(s.ch.sent[0].scope, /ghp_abcdefghijklmnopqrstuvwxyz/)
  })
})

describe("approvals: presence", () => {
  it("withdraws a pending request when the mode turns to present", async () => {
    const s = setup()
    const { b } = await made(s)
    s.t.mode = "present"
    await s.a.sweep()
    const got = s.a.get("secrets-tool", b.id).body as Created
    assert.equal(got.state, "withdrawn")
    assert.equal(got.reason_code, "present")
    assert.equal(got.answer?.decision, "expired")
    assert.equal(s.a.pending(), 0)
  })

  it("refuses a tap that arrives after the mode turned to present", async () => {
    const s = setup()
    const { b } = await made(s)
    s.t.mode = "present"
    const out = await tap(s, b.id)
    assert.equal(out.ok, false)
    assert.equal(
      (s.a.get("secrets-tool", b.id).body as Created).reason_code,
      "present",
    )
  })
})

describe("approvals: idempotency, cooldown and limits", () => {
  it("replays the stored request, and the answer once decided", async () => {
    const s = setup()
    const first = await made(s)
    const again = await made(s)
    assert.equal(again.r.status, 200)
    assert.equal(again.b.id, first.b.id)
    assert.equal(s.ch.sent.length, 1)
    await tap(s, first.b.id)
    const decided = await made(s)
    assert.equal(decided.b.state, "approved")
    assert.equal(decided.b.answer?.decision, "approve")
  })

  it("refuses the same key with another body", async () => {
    const s = setup()
    await made(s)
    const r = await made(s, { scope_summary: "item 9" })
    assert.equal(r.r.status, 409)
    assert.equal(err(r.r), "idempotency_mismatch")
  })

  it("scopes keys to the caller", async () => {
    const s = setup()
    const a = await made(s)
    const b = await made(s, {}, "other")
    assert.notEqual(a.b.id, b.b.id)
  })

  it("answers a repeat of a denied request with deny and cooldown, sending nothing", async () => {
    const s = setup()
    const { b } = await made(s)
    await tap(s, b.id, "deny")
    s.t.now += 30_000
    const again = await made(s, { idempotency_key: "k2" })
    assert.equal(again.b.state, "denied")
    assert.equal(again.b.reason_code, "cooldown")
    assert.equal(again.b.answer?.decision, "deny")
    assert.equal(s.ch.sent.length, 1)
    s.t.now += 121_000
    const later = await made(s, { idempotency_key: "k3" })
    assert.equal(later.b.state, "pending")
    assert.equal(s.ch.sent.length, 2)
  })

  it("a different scope is not in the cooldown", async () => {
    const s = setup()
    const { b } = await made(s)
    await tap(s, b.id, "deny")
    const other = await made(s, {
      idempotency_key: "k2",
      scope_summary: "item 9",
    })
    assert.equal(other.b.state, "pending")
  })

  it("allows 3 pending per caller and refuses the fourth", async () => {
    const s = setup()
    for (const k of ["a", "b", "c"])
      assert.equal((await made(s, { idempotency_key: k })).r.status, 201)
    const r = await made(s, { idempotency_key: "d" })
    assert.equal(r.r.status, 429)
    assert.deepEqual(r.r.body, { error: "rate_limited", retryable: true })
    assert.equal(
      (await made(s, { idempotency_key: "e" }, "other")).r.status,
      201,
    )
  })

  it("allows 12 an hour per caller and a global cap", async () => {
    const s = setup({ limits: { pending: 99, perHour: 12, global: 14 } })
    for (let i = 0; i < 12; i++) {
      const { b } = await made(s, {
        idempotency_key: `k${i}`,
        scope_summary: `s${i}`,
      })
      await tap(s, b.id)
    }
    assert.equal((await made(s, { idempotency_key: "x" })).r.status, 429)
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await made(
            s,
            { idempotency_key: `o${i}`, scope_summary: `o${i}` },
            "other",
          )
        ).r.status,
        201,
      )
    assert.equal(
      (await made(s, { idempotency_key: "o9", scope_summary: "o9" }, "other")).r
        .status,
      429,
    )
    s.t.now += 3_600_001
    assert.equal((await made(s, { idempotency_key: "late" })).r.status, 201)
  })
})

describe("approvals: L2", () => {
  const l2 = (s: ReturnType<typeof setup>) =>
    made(s, { action_class: "secrets.write" })

  it("asks for a code after Approve, and approves on a valid one", async () => {
    const s = setup()
    const { b } = await l2(s)
    const out = await tap(s, b.id)
    assert.equal(out.next, "code")
    assert.equal(s.ch.asked.length, 1)
    assert.equal(
      (s.a.get("secrets-tool", b.id).body as Created).state,
      "awaiting_code",
    )
    const typed = await s.a.typed({
      channel: "tg",
      userId: "42",
      text: code(SEED, step(T0)),
      messageRef: "u1",
    })
    assert.equal(typed, "consumed")
    const got = s.a.get("secrets-tool", b.id).body as Created
    assert.equal(got.state, "approved")
    assert.equal(got.answer?.level, 2)
    assert.ok(s.ch.removed.includes("u1"))
    assert.ok(
      s.ch.removed.includes("c1") ||
        s.ch.removed.some((x) => x.startsWith("c")),
    )
  })

  it("denies after three wrong codes with bad_code", async () => {
    const s = setup()
    const { b } = await l2(s)
    await tap(s, b.id)
    for (let i = 0; i < 3; i++) {
      assert.equal(
        await s.a.typed({
          channel: "tg",
          userId: "42",
          text: "000000",
          messageRef: `u${i}`,
        }),
        "consumed",
      )
    }
    const got = s.a.get("secrets-tool", b.id).body as Created
    assert.equal(got.state, "denied")
    assert.equal(got.reason_code, "bad_code")
    assert.equal(s.ch.removed.filter((x) => x.startsWith("u")).length, 3)
  })

  it("refuses a code that was accepted before, in the same step", async () => {
    const s = setup()
    const one = await l2(s)
    await tap(s, one.b.id)
    const c = code(SEED, step(T0))
    await s.a.typed({ channel: "tg", userId: "42", text: c })
    assert.equal(
      (s.a.get("secrets-tool", one.b.id).body as Created).state,
      "approved",
    )
    const two = await made(s, {
      action_class: "secrets.write",
      idempotency_key: "k2",
      scope_summary: "other",
    })
    await tap(s, two.b.id)
    await s.a.typed({ channel: "tg", userId: "42", text: c })
    assert.equal(
      (s.a.get("secrets-tool", two.b.id).body as Created).state,
      "awaiting_code",
    )
    await s.a.typed({
      channel: "tg",
      userId: "42",
      text: code(SEED, step(T0) + 1),
    })
    assert.equal(
      (s.a.get("secrets-tool", two.b.id).body as Created).state,
      "approved",
    )
  })

  it("accepts one step of tolerance and no more", async () => {
    const s = setup()
    const { b } = await l2(s)
    await tap(s, b.id)
    await s.a.typed({
      channel: "tg",
      userId: "42",
      text: code(SEED, step(T0) - 2),
    })
    assert.equal(
      (s.a.get("secrets-tool", b.id).body as Created).state,
      "awaiting_code",
    )
    await s.a.typed({
      channel: "tg",
      userId: "42",
      text: code(SEED, step(T0) - 1),
    })
    assert.equal(
      (s.a.get("secrets-tool", b.id).body as Created).state,
      "approved",
    )
  })

  it("ignores digits typed by someone else, or when nothing waits for a code", async () => {
    const s = setup()
    assert.equal(
      await s.a.typed({ channel: "tg", userId: "42", text: "123456" }),
      "ignored",
    )
    const { b } = await l2(s)
    await tap(s, b.id)
    assert.equal(
      await s.a.typed({
        channel: "tg",
        userId: "99",
        text: code(SEED, step(T0)),
      }),
      "ignored",
    )
    assert.equal(
      await s.a.typed({ channel: "tg", userId: "42", text: "hello" }),
      "ignored",
    )
    assert.equal(
      (s.a.get("secrets-tool", b.id).body as Created).state,
      "awaiting_code",
    )
  })

  it("expires while waiting for a code", async () => {
    const s = setup()
    const { b } = await l2(s)
    await tap(s, b.id)
    s.t.now += 130_000
    await s.a.sweep()
    assert.equal(
      (s.a.get("secrets-tool", b.id).body as Created).state,
      "expired",
    )
    assert.ok(s.ch.removed.some((x) => x.startsWith("c")))
  })

  it("a code gate resolves on a valid code, three wrong ones, or expiry", async () => {
    const s = setup()
    const p = s.a.codeGate({ channel: "tg", summary: "bash rm" })
    await new Promise((r) => setImmediate(r))
    await s.a.typed({ channel: "tg", userId: "42", text: code(SEED, step(T0)) })
    assert.equal(await p, "approved")
    const q = s.a.codeGate({ channel: "tg", summary: "bash rm" })
    await new Promise((r) => setImmediate(r))
    for (let i = 0; i < 3; i++)
      await s.a.typed({ channel: "tg", userId: "42", text: "000000" })
    assert.equal(await q, "denied")
    const e = s.a.codeGate({ channel: "tg", summary: "bash rm", ttl: 10 })
    await new Promise((r) => setImmediate(r))
    s.t.now += 11_000
    await s.a.sweep()
    assert.equal(await e, "expired")
    s.t.seed = undefined
    assert.equal(
      await s.a.codeGate({ channel: "tg", summary: "x" }),
      "unavailable",
    )
  })
})

describe("approvals: restart, events and status", () => {
  it("expires what a restart left pending, and lets the key be retried", async () => {
    const s = setup()
    const { b } = await made(s)
    const next = s.make()
    await next.recover()
    const got = next.get("secrets-tool", b.id).body as Created
    assert.equal(got.state, "expired")
    assert.equal(got.reason_code, "bridge_restart")
    assert.equal(got.answer?.decision, "expired")
    const retry = await next.create("secrets-tool", body())
    assert.equal(retry.status, 201)
    assert.notEqual((retry.body as Created).id, b.id)
  })

  it("streams pending then one answer, and resumes from an id", async () => {
    const s = setup()
    const { b } = await made(s)
    const ev = s.a.events("secrets-tool", b.id)!
    assert.deepEqual(
      ev.replay.map((e) => e.type),
      ["pending"],
    )
    const seen: string[] = []
    ev.subscribe((e) => seen.push(e.type))
    await tap(s, b.id)
    assert.deepEqual(seen, ["answer"])
    const late = s.a.events("secrets-tool", b.id, 1)!
    assert.deepEqual(
      late.replay.map((e) => e.type),
      ["answer"],
    )
    assert.equal(s.a.events("other", b.id), undefined)
  })

  it("a long poll returns once the request is decided", async () => {
    const s = setup()
    const { b } = await made(s)
    const p = s.a.wait("secrets-tool", b.id, 30)
    await tap(s, b.id)
    assert.equal(((await p).body as Created).state, "approved")
    assert.equal((await s.a.wait("other", b.id, 1)).status, 404)
  })

  it("lets the caller withdraw, and only its own", async () => {
    const s = setup()
    const { b } = await made(s)
    assert.equal((await s.a.withdraw("other", b.id)).status, 404)
    const r = await s.a.withdraw("secrets-tool", b.id)
    assert.equal((r.body as Created).state, "withdrawn")
    assert.equal((r.body as Created).reason_code, "withdrawn")
  })

  it("reports channels and the levels they reach", async () => {
    const s = setup()
    assert.deepEqual((await s.a.status()).channels[0].levels, [1, 2])
    s.t.seed = undefined
    assert.deepEqual((await s.a.status()).channels[0].levels, [1])
    s.t.enrolled.biometric.dAAA = "c2VjcmV0"
    s.ch.appOpen = true
    assert.deepEqual((await s.a.status()).channels[0].levels, [1, 2])
    s.ch.op = undefined
    assert.deepEqual((await s.a.status()).channels[0].levels, [])
  })

  it("makes sortable ids", () => {
    const a = ulid(1_000_000)
    const b = ulid(2_000_000)
    assert.equal(a.length, 26)
    assert.ok(a < b)
  })
})

describe("approvals: L2 factors", () => {
  const SECRET = Buffer.from("device-secret-0123456789abcdef!!").toString(
    "base64url",
  )
  const rp = { id: "app.example.com", origin: "https://app.example.com" }

  const rig = (over: Partial<ApprovalsConfig> = {}) => {
    const s = setup(over)
    s.t.enrolled.biometric.dDEV = SECRET
    s.ch.appOpen = true
    return s
  }
  const waiting = async (s: ReturnType<typeof setup>) => {
    const { b } = await made(s, { action_class: "secrets.write" })
    await tap(s, b.id)
    return b
  }
  type View = {
    factors: Factor[]
    challenge: string
    request_hash: string
    passkey?: { challenge: string; rp: string; credentials: string[] }
  }
  const view = async (s: ReturnType<typeof setup>, id: string) =>
    (await s.a.appView(id)).body as View
  const proof = (
    s: ReturnType<typeof setup>,
    id: string,
    b: Record<string, unknown>,
  ) => s.a.appProof(id, b)
  const bio = (v: View, over: Record<string, unknown> = {}) => ({
    factor: "biometric",
    device: "dDEV",
    challenge: v.challenge,
    proof: biometricProof(
      Buffer.from(SECRET, "base64url"),
      v.request_hash,
      v.challenge,
    ),
    ...over,
  })
  const state = (s: ReturnType<typeof setup>, id: string) =>
    s.a.get("secrets-tool", id).body as Created

  it("offers the configured factors that are ready, in the configured order", async () => {
    const s = rig()
    const b = await waiting(s)
    assert.deepEqual(s.ch.asked[0].factors, ["biometric", "totp"])
    assert.deepEqual((await view(s, b.id)).factors, ["biometric", "totp"])
    const t = rig({ l2: { factors: ["totp", "biometric"] } })
    await waiting(t)
    assert.deepEqual(t.ch.asked[0].factors, ["totp", "biometric"])
  })

  it("leaves a factor out until it is ready: no app, no device, no passkey host", async () => {
    const s = setup()
    s.t.enrolled.biometric.dDEV = SECRET
    await waiting(s)
    assert.deepEqual(s.ch.asked[0].factors, ["totp"])
    const p = rig()
    p.t.enrolled.passkeys.cred = "x"
    const b = await waiting(p)
    assert.ok(!(await view(p, b.id)).factors.includes("passkey"))
    p.t.rp = rp
    assert.deepEqual((await view(p, b.id)).factors, [
      "biometric",
      "passkey",
      "totp",
    ])
  })

  it("approves at L2 on a right Face ID proof and signs the factor", async () => {
    const s = rig()
    const b = await waiting(s)
    const v = await view(s, b.id)
    const r = await proof(s, b.id, bio(v))
    assert.equal(r.status, 200)
    const got = state(s, b.id)
    assert.equal(got.state, "approved")
    assert.equal(got.answer?.level, 2)
    assert.equal(got.answer?.factor, "biometric")
    const v2 = verifyAnswer({
      answer: got.answer!,
      keys: [{ kid: s.key.kid, publicKey: s.key.publicKey }],
      request: got.request,
      sentAt: T0,
      now: T0,
      minLevel: 2,
    })
    assert.deepEqual(v2, { ok: true })
  })

  it("spends the challenge at the first proof, right or wrong", async () => {
    const s = rig()
    const b = await waiting(s)
    const v = await view(s, b.id)
    assert.equal((await proof(s, b.id, bio(v, { proof: "00" }))).status, 422)
    assert.equal((await proof(s, b.id, bio(v))).status, 422)
    const again = await view(s, b.id)
    assert.equal((await proof(s, b.id, bio(again))).status, 200)
  })

  it("refuses a proof made for another request, another challenge or a revoked device", async () => {
    const s = rig()
    const one = await waiting(s)
    const v1 = await view(s, one.id)
    const two = await made(s, {
      action_class: "secrets.write",
      idempotency_key: "k2",
    })
    await tap(s, two.b.id)
    const v2 = await view(s, two.b.id)
    assert.equal(
      (await proof(s, two.b.id, { ...bio(v2), proof: bio(v1).proof })).status,
      422,
    )
    const v1b = await view(s, one.id)
    assert.equal(
      (await proof(s, one.id, bio(v1b, { challenge: v1.challenge }))).status,
      422,
    )
    const v1c = await view(s, one.id)
    delete s.t.enrolled.biometric.dDEV
    assert.equal((await proof(s, one.id, bio(v1c))).status, 409)
    assert.equal(state(s, one.id).state, "awaiting_code")
  })

  it("denies after three wrong proofs with bad_proof", async () => {
    const s = rig()
    const b = await waiting(s)
    for (let i = 0; i < 3; i++) {
      const v = await view(s, b.id)
      await proof(s, b.id, bio(v, { proof: "00" }))
    }
    const got = state(s, b.id)
    assert.equal(got.state, "denied")
    assert.equal(got.reason_code, "bad_proof")
  })

  it("takes the code in the app, with the factor recorded, and a step only once", async () => {
    const s = rig()
    const b = await waiting(s)
    const c = code(SEED, step(T0))
    assert.equal(
      (await proof(s, b.id, { factor: "totp", code: c })).status,
      200,
    )
    assert.equal(state(s, b.id).answer?.factor, "totp")
    const n = await made(s, {
      action_class: "secrets.write",
      idempotency_key: "k2",
    })
    await tap(s, n.b.id)
    assert.equal(
      (await proof(s, n.b.id, { factor: "totp", code: c })).status,
      422,
    )
  })

  it("records totp for a code typed in the chat", async () => {
    const s = rig()
    const b = await waiting(s)
    await s.a.typed({ channel: "tg", userId: "42", text: code(SEED, step(T0)) })
    assert.equal(state(s, b.id).answer?.factor, "totp")
  })

  it("falls back to the typed code when the app is not available", async () => {
    const s = setup()
    const b = await waiting(s)
    assert.deepEqual(s.ch.asked[0].factors, ["totp"])
    await s.a.typed({ channel: "tg", userId: "42", text: code(SEED, step(T0)) })
    assert.equal(state(s, b.id).state, "approved")
  })

  it("ignores a typed code when totp is not a listed factor", async () => {
    const s = rig({ l2: { factors: ["biometric"] } })
    const b = await waiting(s)
    assert.deepEqual(s.ch.asked[0].factors, ["biometric"])
    assert.equal(
      await s.a.typed({
        channel: "tg",
        userId: "42",
        text: code(SEED, step(T0)),
      }),
      "ignored",
    )
    assert.equal(
      (await proof(s, b.id, { factor: "totp", code: code(SEED, step(T0)) }))
        .status,
      409,
    )
    assert.equal(state(s, b.id).state, "awaiting_code")
  })

  it("fails an L2 request at once when no factor is ready", async () => {
    const s = setup({ l2: { factors: ["biometric"] } })
    assert.equal(
      err((await made(s, { action_class: "secrets.write" })).r),
      "unavailable",
    )
  })

  it("serves the app for a pending request, and not for a finished one", async () => {
    const s = rig()
    const { b } = await made(s, { action_class: "secrets.write" })
    assert.equal((await s.a.appView(b.id)).status, 200)
    const v = await view(s, b.id)
    await proof(s, b.id, bio(v))
    assert.equal((await s.a.appView(b.id)).status, 404)
    assert.equal((await proof(s, b.id, bio(v))).status, 404)
  })

  it("denies from the app at any level, and approves only a level 1 request with no factor", async () => {
    const s = rig()
    const l2 = (await made(s, { action_class: "secrets.write" })).b
    assert.equal(
      (await s.a.appDecide(l2.id, { action: "approve" })).status,
      409,
    )
    assert.equal(state(s, l2.id).state, "pending")
    assert.equal((await s.a.appDecide(l2.id, { action: "deny" })).status, 200)
    assert.equal(state(s, l2.id).state, "denied")
    assert.equal((await s.a.appDecide(l2.id, { action: "deny" })).status, 404)

    const l1 = (await made(s, { idempotency_key: "k-l1" })).b
    assert.equal((await s.a.appView(l1.id)).body.level, 1)
    assert.equal((await s.a.appProof(l1.id, { factor: "totp" })).status, 409)
    assert.equal((await s.a.appDecide(l1.id, { action: "x" })).status, 409)
    assert.equal(
      (await s.a.appDecide(l1.id, { action: "approve" })).status,
      200,
    )
    const got = state(s, l1.id)
    assert.equal(got.state, "approved")
    assert.equal(got.answer?.level, 1)
    assert.equal(got.answer?.approver, "42")
    assert.equal(s.a.pending(), 0, "nothing is left to wait for")
  })

  it("withdraws when the operator is at the Mac, and expires on time", async () => {
    const s = rig()
    const b = await waiting(s)
    const v = await view(s, b.id)
    s.t.mode = "present"
    assert.equal((await proof(s, b.id, bio(v))).status, 409)
    assert.equal(state(s, b.id).state, "withdrawn")
    const t = rig()
    const x = await waiting(t)
    const vx = await view(t, x.id)
    t.t.now += 600_000
    assert.equal((await proof(t, x.id, bio(vx))).status, 409)
    assert.equal(state(t, x.id).state, "expired")
  })

  it("approves on a valid passkey assertion and refuses a wrong origin or unverified user", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    })
    const spki = (
      publicKey.export({ type: "spki", format: "der" }) as Buffer
    ).toString("base64url")
    const s = rig()
    s.t.rp = rp
    s.t.enrolled.passkeys.cred1 = spki
    const b = await waiting(s)
    const assertion = async (
      o: { origin?: string; flags?: number; rpId?: string } = {},
    ) => {
      const v = await view(s, b.id)
      const challenge = v.passkey!.challenge
      assert.equal(challenge, passkeyChallenge(v.request_hash, v.challenge))
      const data = Buffer.concat([
        createHash("sha256")
          .update(o.rpId ?? rp.id)
          .digest(),
        Buffer.from([o.flags ?? 0x05, 0, 0, 0, 1]),
      ])
      const client = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge,
          origin: o.origin ?? rp.origin,
        }),
      )
      const sig = edSign(
        "sha256",
        Buffer.concat([data, createHash("sha256").update(client).digest()]),
        privateKey,
      )
      return {
        factor: "passkey",
        challenge: v.challenge,
        credential: {
          id: "cred1",
          authenticatorData: data.toString("base64url"),
          clientDataJSON: client.toString("base64url"),
          signature: sig.toString("base64url"),
        },
      }
    }
    assert.equal(
      (
        await proof(
          s,
          b.id,
          await assertion({ origin: "https://evil.example" }),
        )
      ).status,
      422,
    )
    assert.equal(
      (await proof(s, b.id, await assertion({ flags: 0x01 }))).status,
      422,
    )
    assert.equal(
      (await proof(s, b.id, await assertion({ rpId: "other.example.com" })))
        .status,
      422,
    )
    assert.equal(state(s, b.id).state, "denied")
    const t = rig()
    t.t.rp = rp
    t.t.enrolled.passkeys.cred1 = spki
    const x = await waiting(t)
    const ok = await (async () => {
      const v = await view(t, x.id)
      const data = Buffer.concat([
        createHash("sha256").update(rp.id).digest(),
        Buffer.from([0x05, 0, 0, 0, 1]),
      ])
      const client = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: v.passkey!.challenge,
          origin: rp.origin,
        }),
      )
      const sig = edSign(
        "sha256",
        Buffer.concat([data, createHash("sha256").update(client).digest()]),
        privateKey,
      )
      return proof(t, x.id, {
        factor: "passkey",
        challenge: v.challenge,
        credential: {
          id: "cred1",
          authenticatorData: data.toString("base64url"),
          clientDataJSON: client.toString("base64url"),
          signature: sig.toString("base64url"),
        },
      })
    })()
    assert.equal(ok.status, 200)
    assert.equal(state(t, x.id).answer?.factor, "passkey")
  })

  it("never counts a tap on a channel that proves nobody as L2", async () => {
    const s = rig()
    s.ch.caps = { buttons: true, approver: "none", replyText: true }
    assert.equal(
      err((await made(s, { action_class: "secrets.write" })).r),
      "unavailable",
    )
  })
})
