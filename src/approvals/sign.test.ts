import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  canonical,
  newSigningKey,
  requestHash,
  signAnswer,
  signedString,
  verifyAnswer,
  type Answer,
  type RequestRecord,
} from "./sign.ts"

const NOW = Date.parse("2026-11-21T12:00:30.000Z")
const request: RequestRecord = {
  id: "01HZZZ",
  caller: "secrets-tool",
  mode: "afk",
  created_at: "2026-11-21T12:00:00.000Z",
  idempotency_key: "k1",
  requester: { session_id: "ses_1", agent: "build", tool: "secrets" },
  action_class: "secrets.read",
  scope_summary: "item 4f2a",
  reason: "deploy",
  ttl: 120,
  required_level: null,
}
const key = newSigningKey()
const answer = (over: Partial<Answer> = {}): Answer => ({
  ...signAnswer(key, {
    id: request.id,
    request_hash: requestHash(request),
    decision: "approve",
    level: 1,
    mode: "afk",
    approver: "42",
    decided_at: "2026-11-21T12:00:20.000Z",
  }),
  ...over,
})
const check = (a: Answer, over: Record<string, unknown> = {}) =>
  verifyAnswer({
    answer: a,
    keys: [{ kid: key.kid, publicKey: key.publicKey }],
    request,
    sentAt: Date.parse(request.created_at),
    now: NOW,
    minLevel: 1,
    ...over,
  })

describe("signed answers", () => {
  it("canonical json sorts keys and drops undefined", () =>
    assert.equal(
      canonical({ b: 1, a: [{ d: undefined, c: null }] }),
      '{"a":[{"c":null}],"b":1}',
    ))

  it("verifies a good answer", () =>
    assert.deepEqual(check(answer()), { ok: true }))

  it("fails when the decision is changed after signing", () =>
    assert.deepEqual(check(answer({ decision: "deny" })), {
      ok: false,
      reason: "bad_signature",
    }))

  it("fails when the level is raised after signing", () =>
    assert.equal(
      (check(answer({ level: 2 })) as { reason: string }).reason,
      "bad_signature",
    ))

  it("fails with a key it does not trust", () => {
    const other = newSigningKey()
    const r = check(answer(), {
      keys: [{ kid: key.kid, publicKey: other.publicKey }],
    })
    assert.deepEqual(r, { ok: false, reason: "bad_signature" })
    assert.deepEqual(check(answer(), { keys: [] }), {
      ok: false,
      reason: "unknown_kid",
    })
  })

  it("fails on an id it did not create", () =>
    assert.deepEqual(check(answer(), { knownId: () => false }), {
      ok: false,
      reason: "unknown_id",
    }))

  it("fails when the request differs from its own copy", () =>
    assert.deepEqual(
      check(answer(), { request: { ...request, scope_summary: "item 9" } }),
      { ok: false, reason: "request_mismatch" },
    ))

  it("fails on a time outside send time and now", () => {
    const late = answer({
      ...signAnswer(key, {
        id: request.id,
        request_hash: requestHash(request),
        decision: "approve",
        level: 1,
        mode: "afk",
        approver: "42",
        decided_at: "2026-11-21T13:00:00.000Z",
      }),
    })
    assert.deepEqual(check(late), { ok: false, reason: "time" })
  })

  it("fails below the required level, outside afk mode, and when spent", () => {
    assert.deepEqual(check(answer(), { minLevel: 2 }), {
      ok: false,
      reason: "level",
    })
    assert.deepEqual(check(answer(), { mode: "present" }), {
      ok: false,
      reason: "mode",
    })
    assert.deepEqual(check(answer(), { spent: () => true }), {
      ok: false,
      reason: "spent",
    })
  })

  it("accepts both keys during a rotation overlap, then only the new one", () => {
    const next = newSigningKey()
    const keys = [
      { kid: key.kid, publicKey: key.publicKey, notAfter: NOW + 1000 },
      { kid: next.kid, publicKey: next.publicKey },
    ]
    assert.equal(check(answer(), { keys }).ok, true)
    assert.equal(check(answer(), { keys, now: NOW + 5000 }).ok, false)
  })
})

describe("the factor of an L2 answer", () => {
  const l2 = (over: Partial<Answer> = {}) => {
    const a = signAnswer(key, {
      id: request.id,
      request_hash: requestHash(request),
      decision: "approve",
      level: 2,
      mode: "afk",
      approver: "42",
      decided_at: "2026-11-21T12:00:20.000Z",
      factor: "biometric",
    })
    return { ...a, ...over }
  }

  it("signs the factor under the v2 tag, and verifies it", () => {
    assert.deepEqual(check(l2(), { minLevel: 2 }), { ok: true })
    assert.match(signedString(l2()), /^oob-approval-v2\n/)
    assert.ok(signedString(l2()).endsWith("\nbiometric"))
  })

  it("refuses a factor changed or added after signing", () => {
    assert.deepEqual(check(l2({ factor: "totp" }), { minLevel: 2 }), {
      ok: false,
      reason: "bad_signature",
    })
    assert.deepEqual(check(l2({ factor: undefined }), { minLevel: 2 }), {
      ok: false,
      reason: "bad_signature",
    })
    assert.deepEqual(check(answer({ factor: "totp" })), {
      ok: false,
      reason: "bad_signature",
    })
  })

  it("leaves the string of an answer without a factor as it was", () => {
    assert.match(signedString(answer()), /^oob-approval-v1\n/)
    assert.equal(signedString(answer()).split("\n").length, 8)
  })
})
