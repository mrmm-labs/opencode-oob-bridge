import assert from "node:assert/strict"
import { describe, it } from "node:test"
import WebSocket from "ws"

import {
  LINK_KEY_HEADER,
  seal,
  sealUpgrade,
  type Down,
} from "./shared/frame.ts"
import { FakeBridge, rig, SECRET } from "./rig.test-util.ts"

describe("the link face", () => {
  it("accepts a valid upgrade and reports the link up", async () => {
    const r = await rig()
    assert.equal(r.link.up(), false)
    await r.bridge()
    assert.equal(r.link.up(), true)
    assert.ok(r.link.since())
    await r.done()
  })

  it("refuses a replayed upgrade, a wrong secret, a stale proof and no proof", async () => {
    const r = await rig()
    const h = sealUpgrade(SECRET)
    const a = await FakeBridge.connect(r.linkUrl, SECRET, h)
    a.close()
    await assert.rejects(
      FakeBridge.connect(r.linkUrl, SECRET, h),
      /refused 401/,
    )
    await assert.rejects(
      FakeBridge.connect(
        r.linkUrl,
        "w".repeat(48),
        sealUpgrade("w".repeat(48)),
      ),
      /refused 401/,
    )
    await assert.rejects(
      FakeBridge.connect(
        r.linkUrl,
        SECRET,
        sealUpgrade(SECRET, Date.now() - 120_000),
      ),
      /refused 401/,
    )
    await assert.rejects(
      FakeBridge.connect(r.linkUrl, SECRET, {}),
      /refused 401/,
    )
    const refused = r.link.refused()
    assert.ok(refused.replay >= 1 && refused.mac >= 1 && refused.format >= 1)
    assert.ok(Object.keys(refused).some((k) => k.startsWith("clock skew")))
    assert.equal(r.link.up(), false)
    await r.done()
  })

  it("with LINK_KEY set, refuses a missing or wrong key with 401 before the HMAC, and logs without the key", async () => {
    const KEY = "p".repeat(40)
    const r = await rig({ env: { LINK_KEY: KEY } })
    const good = { ...sealUpgrade(SECRET), [LINK_KEY_HEADER]: KEY }
    for (const headers of [
      sealUpgrade(SECRET),
      { ...sealUpgrade(SECRET), [LINK_KEY_HEADER]: "x".repeat(40) },
      { ...sealUpgrade(SECRET), [LINK_KEY_HEADER]: "" },
      { ...sealUpgrade(SECRET), [LINK_KEY_HEADER]: KEY + "x" },
    ])
      await assert.rejects(
        FakeBridge.connect(r.linkUrl, SECRET, headers),
        /refused 401/,
      )
    assert.equal(r.link.up(), false)
    assert.equal(r.link.refused().key, 4)
    assert.equal(
      r.lines.filter((l) => /"reason":"key"/.test(l)).length,
      1,
      "one log line, the rest suppressed",
    )
    assert.ok(!r.lines.join("\n").includes(KEY), "no key material in the log")
    const b = await FakeBridge.connect(r.linkUrl, SECRET, good)
    assert.equal(r.link.up(), true)
    b.close()
    await r.done()
  })

  it("with LINK_KEY set the HMAC is still required", async () => {
    const KEY = "p".repeat(40)
    const r = await rig({ env: { LINK_KEY: KEY } })
    await assert.rejects(
      FakeBridge.connect(r.linkUrl, SECRET, {
        [LINK_KEY_HEADER]: KEY,
      }),
      /refused 401/,
    )
    await assert.rejects(
      FakeBridge.connect(r.linkUrl, SECRET, {
        ...sealUpgrade("w".repeat(48)),
        [LINK_KEY_HEADER]: KEY,
      }),
      /refused 401/,
    )
    assert.equal(r.link.up(), false)
    await r.done()
  })

  it("without LINK_KEY a key header is ignored and nothing changes", async () => {
    const r = await rig()
    const b = await FakeBridge.connect(r.linkUrl, SECRET, {
      ...sealUpgrade(SECRET),
      [LINK_KEY_HEADER]: "anything",
    })
    assert.equal(r.link.up(), true)
    b.close()
    await r.done()
  })

  it("serves nothing but the upgrade on /link", async () => {
    const r = await rig()
    const plain = await fetch(r.linkUrl.replace("ws:", "http:"))
    assert.equal(plain.status, 404)
    await assert.rejects(
      new Promise((ok, fail) => {
        const ws = new WebSocket(r.linkUrl.replace("/link", "/other"), {
          headers: sealUpgrade(SECRET),
        })
        ws.once("open", ok)
        ws.once("error", fail)
      }),
      /404/,
    )
    await r.done()
  })

  it("replaces the old link with a new one, and ends what the old one carried", async () => {
    const r = await rig()
    const first = await r.bridge()
    const second = await r.bridge()
    await first.waitFor(() => first.closed[0])
    assert.equal(first.closed[0].code, 4000)
    assert.equal(r.link.up(), true)
    assert.equal(second.closed.length, 0)
    await r.done()
  })

  it("drops a replayed frame, a tampered frame and a reflected frame, and counts them", async () => {
    const r = await rig()
    const b = await r.bridge()
    const frame = seal(SECRET, "up", {
      t: "beat",
      beat: { state: "up", reasons: [], seq: 1 },
    })
    b.sendRaw(frame)
    b.sendRaw(frame)
    const tampered = JSON.parse(
      seal(SECRET, "up", {
        t: "beat",
        beat: { state: "degraded", reasons: ["x"], seq: 2 },
      }),
    )
    tampered.body = tampered.body.replace("degraded", "up")
    b.sendRaw(JSON.stringify(tampered))
    const sentByRelay = seal(SECRET, "down", { t: "ack", seq: 9 })
    b.sendRaw(sentByRelay)
    await b.waitFor(() => r.link.refused().replay)
    await b.waitFor(() => r.link.refused().mac && r.link.refused().mac >= 2)
    assert.equal(r.beats.length, 1)
    await r.done()
  })

  it("answers a beat frame with an ack that holds the sequence number", async () => {
    const r = await rig()
    const b = await r.bridge()
    b.send({
      t: "beat",
      beat: { v: 1, id: "i", seq: 41, state: "up", reasons: [] },
    })
    const ack = await b.waitFor(() =>
      b.frames.find((f): f is Extract<Down, { t: "ack" }> => f.t === "ack"),
    )
    assert.equal(ack.seq, 41)
    assert.equal(r.deadman.shown(), "up")
    await r.done()
  })

  it("closes the link when the bridge goes quiet and never answers a ping", async () => {
    const r = await rig({ link: { pingMs: 40 } })
    const b = await r.bridge()
    b.ws.pong = () => {}
    b.ws.removeAllListeners("ping")
    await b.waitFor(() => !r.link.up() || undefined, 2000)
    await r.done()
  })

  it("ignores a response for an unknown request and refuses a binary frame", async () => {
    const r = await rig()
    const b = await r.bridge()
    b.send({ t: "res", id: "nope", status: 200, headers: {} })
    b.send({ t: "chunk", id: "nope", n: 0, data: "" })
    b.send({ t: "end", id: "nope" })
    b.ws.send(Buffer.from("x"))
    await b.waitFor(() => r.link.refused().binary)
    assert.equal(r.link.up(), true)
    await r.done()
  })
})
