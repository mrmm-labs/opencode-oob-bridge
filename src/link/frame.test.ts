import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  describe as why,
  NonceCache,
  seal,
  sealUpgrade,
  Verifier,
  type Down,
  type Up,
} from "./frame.ts"

const SECRET = "s".repeat(40)
const clock = (t = 1_700_000_000_000) => ({
  now: () => t,
  at: (x: number) => (t = x),
  add: (x: number) => (t += x),
})
const up: Up = { t: "end", id: "r1" }
const down: Down = { t: "ack", seq: 3 }

describe("frames", () => {
  it("opens a frame the other side sealed", () => {
    const c = clock()
    const v = new Verifier(SECRET, "up", c.now)
    const r = v.open(seal(SECRET, "up", up, c.now()))
    assert.deepEqual(r, { ok: true, payload: up })
  })

  it("refuses a tampered body", () => {
    const c = clock()
    const env = JSON.parse(seal(SECRET, "up", up, c.now()))
    env.body = env.body.replace("r1", "r2")
    const r = new Verifier(SECRET, "up", c.now).open(JSON.stringify(env))
    assert.deepEqual(r, { ok: false, reason: "mac" })
  })

  it("refuses another secret", () => {
    const c = clock()
    const r = new Verifier("x".repeat(40), "up", c.now).open(
      seal(SECRET, "up", up, c.now()),
    )
    assert.deepEqual(r, { ok: false, reason: "mac" })
  })

  it("refuses a stale frame and names the skew", () => {
    const c = clock()
    const text = seal(SECRET, "up", up, c.now() - 90_000)
    const r = new Verifier(SECRET, "up", c.now).open(text)
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.reason, "skew")
    assert.match(!r.ok ? why(r) : "", /clock skew of 90s/)
    assert.equal(
      new Verifier(SECRET, "up", c.now).open(
        seal(SECRET, "up", up, c.now() - 59_000),
      ).ok,
      true,
    )
  })

  it("refuses a frame from the future the same way", () => {
    const c = clock()
    const r = new Verifier(SECRET, "up", c.now).open(
      seal(SECRET, "up", up, c.now() + 61_000),
    )
    assert.equal(!r.ok && r.reason, "skew")
  })

  it("refuses a replayed nonce, and only after the first was accepted", () => {
    const c = clock()
    const v = new Verifier(SECRET, "up", c.now)
    const text = seal(SECRET, "up", up, c.now())
    assert.equal(v.open(text).ok, true)
    assert.deepEqual(v.open(text), { ok: false, reason: "replay" })
    const bad = JSON.parse(text)
    bad.mac = "0".repeat(64)
    const v2 = new Verifier(SECRET, "up", c.now)
    assert.equal(v2.open(JSON.stringify(bad)).ok, false)
    assert.equal(
      v2.open(text).ok,
      true,
      "a refused MAC does not burn the nonce",
    )
  })

  it("refuses a reflected frame: the bridge's own up frame sent back", () => {
    const c = clock()
    const sentByBridge = seal(SECRET, "up", up, c.now())
    const r = new Verifier(SECRET, "down", c.now).open(sentByBridge)
    assert.deepEqual(r, { ok: false, reason: "mac" })
    const sentByRelay = seal(SECRET, "down", down, c.now())
    assert.equal(new Verifier(SECRET, "down", c.now).open(sentByRelay).ok, true)
    assert.equal(new Verifier(SECRET, "up", c.now).open(sentByRelay).ok, false)
  })

  it("refuses what is not a frame", () => {
    const v = new Verifier(SECRET, "up")
    for (const t of [
      "",
      "nope",
      "[]",
      "{}",
      JSON.stringify({ ts: "1", nonce: "ab", mac: "x", body: "{}" }),
      JSON.stringify({ ts: 1, nonce: "zz", mac: "x", body: "{}" }),
      "x".repeat(1024 * 1024 + 1),
    ])
      assert.deepEqual(v.open(t), { ok: false, reason: "format" })
  })

  it("holds one body shape: a payload that is not an object is refused", () => {
    const c = clock()
    const env = JSON.parse(seal(SECRET, "up", up, c.now()))
    assert.equal(typeof env.body, "string")
    assert.equal(Object.keys(env).sort().join(), "body,mac,nonce,ts")
  })
})

describe("upgrade proof", () => {
  const lower = (h: Record<string, string>) =>
    Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))

  it("opens once and refuses the replay", () => {
    const c = clock()
    const v = new Verifier(SECRET, "up", c.now)
    const h = lower(sealUpgrade(SECRET, c.now()))
    assert.equal(v.openUpgrade(h).ok, true)
    assert.deepEqual(v.openUpgrade(h), { ok: false, reason: "replay" })
  })

  it("refuses a stale, a wrong or a missing proof", () => {
    const c = clock()
    const v = new Verifier(SECRET, "up", c.now)
    assert.equal(
      !v.openUpgrade(lower(sealUpgrade(SECRET, c.now() - 120_000))).ok,
      true,
    )
    assert.equal(
      !v.openUpgrade(lower(sealUpgrade("y".repeat(40), c.now()))).ok,
      true,
    )
    assert.deepEqual(v.openUpgrade({}), { ok: false, reason: "format" })
  })

  it("cannot be reused as a frame", () => {
    const c = clock()
    const h = lower(sealUpgrade(SECRET, c.now()))
    const env = JSON.stringify({
      ts: Number(h["x-link-ts"]),
      nonce: h["x-link-nonce"],
      mac: h["x-link-mac"],
      body: "GET /link",
    })
    assert.equal(new Verifier(SECRET, "up", c.now).open(env).ok, false)
  })
})

describe("nonce cache", () => {
  it("forgets after twice the window and caps its size", () => {
    const c = clock()
    const n = new NonceCache(c.now, 120_000, 3)
    assert.equal(n.fresh("a"), true)
    assert.equal(n.fresh("a"), false)
    c.add(121_000)
    assert.equal(n.fresh("a"), true)
    for (const k of ["b", "c", "d", "e"]) n.fresh(k)
    assert.equal(n.fresh("e"), false)
    assert.equal(
      n.fresh("b"),
      true,
      "the oldest was dropped to stay under the cap",
    )
  })
})
