import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type WebSocket from "ws"

import { LINK_KEY_HEADER, seal, sealUpgrade } from "./shared/frame.ts"
import type { ChannelFrame } from "./shared/frame.ts"
import { render } from "./metrics.ts"
import { FakeBridge, rig, SECRET } from "./rig.test-util.ts"

const GW = "g".repeat(40)
const OTHER = "o".repeat(40)
const KEY = "k".repeat(40)

async function channels(
  o: {
    channels?: Record<string, { secret: string; key?: string }>
    link?: object
  } = {},
) {
  const got: Array<[string, ChannelFrame]> = []
  const r = await rig({
    link: {
      channels: o.channels ?? { gw: { secret: GW }, other: { secret: OTHER } },
      onChannel: (ch, f) => void got.push([ch, f]),
      ...o.link,
    },
  })
  const url = (name: string) => r.linkUrl.replace(/\/link$/, "/link/" + name)
  const open = async (name: string, secret: string, extra = {}) => {
    const b = await FakeBridge.connect(url(name), secret, {
      ...sealUpgrade(secret, Date.now(), "/link/" + name),
      ...extra,
    })
    return b
  }
  const say = (b: FakeBridge, secret: string, f: object) =>
    b.ws.send(seal(secret, "up", f as never))
  const settle = () => new Promise((ok) => setTimeout(ok, 80))
  return { r, got, url, open, say, settle }
}

describe("named channels on the link", () => {
  it("leaves the chat bridge alone: a channel does not evict it and its frames never reach the bridge handlers", async () => {
    const c = await channels()
    const bridge = await c.r.bridge()
    const gw = await c.open("gw", GW)
    await gw.waitFor(() => c.r.link.channelUp("gw"))
    assert.equal(c.r.link.up(), true)
    assert.equal(c.r.link.channelUp("gw"), true)
    assert.deepEqual(bridge.closed, [])
    bridge.send({ t: "beat", beat: { seq: 1, state: "up", reasons: [] } })
    await bridge.waitFor(() => bridge.frames.find((f) => f.t === "ack"))
    c.say(gw, GW, { t: "hello", ch: "gw", n: 1 })
    await gw.waitFor(() => c.got.length > 0)
    assert.deepEqual(c.got, [["gw", { t: "hello", ch: "gw", n: 1 }]])
    assert.equal(c.r.beats.length, 1, "only the bridge's beat")
    gw.close()
    await gw.waitFor(() => !c.r.link.channelUp("gw"))
    assert.equal(c.r.link.up(), true, "the bridge outlives the channel")
    assert.ok(
      !c.r.lines.some((l) => l.includes('"replaced":true')),
      "no replacement logged",
    )
    await c.r.done()
  })

  it("keeps one connection per channel: the same channel evicts the older one with 4000, others stay", async () => {
    const c = await channels()
    const bridge = await c.r.bridge()
    const other = await c.open("other", OTHER)
    const a = await c.open("gw", GW)
    const b = await c.open("gw", GW)
    await a.waitFor(() => a.closed.length > 0)
    assert.deepEqual(a.closed, [{ code: 4000 }])
    assert.deepEqual(b.closed, [])
    assert.deepEqual(other.closed, [])
    assert.deepEqual(bridge.closed, [])
    assert.equal(c.r.link.up() && c.r.link.channelUp("gw"), true)
    assert.ok(
      c.r.lines.some(
        (l) => l.includes('"replaced":true') && l.includes('"channel":"gw"'),
      ),
    )
    await c.r.done()
  })

  it("answers 404 for a name that is reserved, malformed or not configured, and leaves the bridge up", async () => {
    const c = await channels()
    const bridge = await c.r.bridge()
    for (const n of ["chat", "Bad_Name", "a".repeat(25), "1gw", "nope", ""]) {
      await assert.rejects(c.open(n, GW), /refused 404/, "/link/" + n)
    }
    await assert.rejects(
      FakeBridge.connect(
        c.url("gw/x"),
        GW,
        sealUpgrade(GW, Date.now(), "/link/gw/x"),
      ),
      /refused 404/,
    )
    assert.equal(c.r.link.up(), true)
    assert.deepEqual(bridge.closed, [])
    await c.r.done()
  })

  it("behaves as an old relay for every channel when none is configured: 404, the bridge stays", async () => {
    const c = await channels({ channels: {} })
    const bridge = await c.r.bridge()
    await assert.rejects(c.open("gw", GW), /refused 404/)
    assert.equal(c.r.link.up(), true)
    assert.deepEqual(bridge.closed, [])
    assert.deepEqual(c.r.link.channelStates(), {})
    await c.r.done()
  })

  it("refuses a proof signed for another path, in both directions", async () => {
    const c = await channels()
    await assert.rejects(
      FakeBridge.connect(c.url("gw"), GW, sealUpgrade(GW, Date.now(), "/link")),
      /refused 401/,
    )
    await assert.rejects(
      FakeBridge.connect(
        c.url("gw"),
        GW,
        sealUpgrade(GW, Date.now(), "/link/other"),
      ),
      /refused 401/,
    )
    await assert.rejects(
      FakeBridge.connect(
        c.r.linkUrl,
        SECRET,
        sealUpgrade(SECRET, Date.now(), "/link/gw"),
      ),
      /refused 401/,
    )
    assert.equal(c.r.link.up(), false)
    assert.equal(c.r.link.channelUp("gw"), false)
    assert.ok(c.r.link.refused().mac >= 3)
    await c.r.done()
  })

  it("refuses a frame whose label is not the channel's, or that has none", async () => {
    const c = await channels()
    const gw = await c.open("gw", GW)
    c.say(gw, GW, { t: "x", ch: "other" })
    c.say(gw, GW, { t: "x", ch: "chat" })
    c.say(gw, GW, { t: "x" })
    c.say(gw, GW, { ch: "gw" })
    await c.settle()
    assert.deepEqual(c.got, [])
    assert.equal(c.r.link.refused().channel, 4)
    c.say(gw, GW, { t: "x", ch: "gw" })
    await gw.waitFor(() => c.got.length === 1)
    await c.r.done()
  })

  it("keeps secrets apart: the bridge secret does not open a channel and a channel secret does not open the bridge", async () => {
    const c = await channels()
    await assert.rejects(c.open("gw", SECRET), /refused 401/)
    await assert.rejects(c.open("gw", OTHER), /refused 401/)
    await assert.rejects(
      FakeBridge.connect(c.r.linkUrl, GW, sealUpgrade(GW)),
      /refused 401/,
    )
    const gw = await c.open("gw", GW)
    gw.ws.send(seal(SECRET, "up", { t: "x", ch: "gw" } as never))
    await c.settle()
    assert.deepEqual(c.got, [])
    assert.ok(c.r.link.refused().mac >= 4)
    await c.r.done()
  })

  it("asks a channel for its own key, and not for the bridge's", async () => {
    const c = await channels({
      channels: { gw: { secret: GW, key: KEY } },
      link: { key: "b".repeat(40) },
    })
    await assert.rejects(c.open("gw", GW), /refused 401/)
    await assert.rejects(
      c.open("gw", GW, { [LINK_KEY_HEADER]: "b".repeat(40) }),
      /refused 401/,
    )
    assert.equal(c.r.link.refused().key, 2)
    const gw = await c.open("gw", GW, { [LINK_KEY_HEADER]: KEY })
    assert.equal(c.r.link.channelUp("gw"), true)
    gw.close()
    await assert.rejects(
      FakeBridge.connect(c.r.linkUrl, SECRET, {
        ...sealUpgrade(SECRET),
        [LINK_KEY_HEADER]: KEY,
      }),
      /refused 401/,
    )
    await c.r.done()
  })

  it("refuses a frame replayed into another channel, whatever the secrets", async () => {
    for (const secrets of [
      { gw: GW, other: OTHER },
      { gw: GW, other: GW },
    ]) {
      const c = await channels({
        channels: {
          gw: { secret: secrets.gw },
          other: { secret: secrets.other },
        },
      })
      const gw = await c.open("gw", secrets.gw)
      const other = await c.open("other", secrets.other)
      const frame = seal(secrets.gw, "up", { t: "x", ch: "gw" } as never)
      gw.ws.send(frame)
      await gw.waitFor(() => c.got.length === 1)
      other.ws.send(frame)
      gw.ws.send(frame)
      await c.settle()
      assert.equal(c.got.length, 1, "delivered once, to gw")
      const refused = c.r.link.refused()
      assert.ok(
        (refused.replay ?? 0) + (refused.mac ?? 0) >= 2,
        JSON.stringify(refused),
      )
      if (secrets.other === GW) assert.equal(refused.replay, 2)
      await c.r.done()
    }
  })

  it("refuses an upgrade proof replayed on another channel with the same secret", async () => {
    const c = await channels({
      channels: { gw: { secret: GW }, other: { secret: GW } },
    })
    const h = sealUpgrade(GW, Date.now(), "/link/gw")
    const a = await FakeBridge.connect(c.url("gw"), GW, h)
    await assert.rejects(
      FakeBridge.connect(c.url("other"), GW, h),
      /refused 401/,
    )
    a.close()
    await c.r.done()
  })

  it("sends only to the channel asked, labelled and sealed with its secret", async () => {
    const c = await channels()
    const gw = await c.open("gw", GW)
    const other = await c.open("other", OTHER)
    const bridge = await c.r.bridge()
    assert.equal(c.r.link.sendTo("gw", { t: "note", n: 2 }), true)
    await gw.waitFor(() => gw.frames.length > 0)
    assert.deepEqual(gw.frames, [{ t: "note", n: 2, ch: "gw" }])
    assert.equal(c.r.link.sendTo("nobody", { t: "note" }), false)
    assert.equal(
      c.r.link.sendTo("chat", { t: "note" }),
      false,
      "the bridge is not a channel",
    )
    await c.settle()
    assert.deepEqual([other.frames, bridge.frames], [[], []])
    await c.r.done()
  })

  it("refuses channel frames when no consumer is registered, and survives a consumer that throws", async () => {
    const c = await channels({ link: { onChannel: undefined } })
    const gw = await c.open("gw", GW)
    c.say(gw, GW, { t: "x", ch: "gw" })
    await gw.waitFor(() => c.r.link.refused().unrouted === 1)
    await c.r.done()

    const d = await channels({
      link: {
        onChannel: () => {
          throw new Error("boom")
        },
      },
    })
    const g = await d.open("gw", GW)
    d.say(g, GW, { t: "x", ch: "gw" })
    d.say(g, GW, { t: "y", ch: "gw" })
    await d.settle()
    assert.equal(d.r.link.channelUp("gw"), true)
    assert.equal(
      d.r.lines.filter((l) => l.includes("channel_consumer_error")).length,
      2,
    )
    await d.r.done()
  })

  it("closes a channel whose send buffer is over the limit, and only that channel", async () => {
    const c = await channels({ link: { channelBufferBytes: 1024 } })
    const bridge = await c.r.bridge()
    const gw = await c.open("gw", GW)
    const other = await c.open("other", OTHER)
    const sock = (
      c.r.link as unknown as { socks: Map<string, WebSocket> }
    ).socks.get("gw")!
    assert.equal(c.r.link.sendTo("gw", { t: "x" }), true, "under the limit")
    Object.defineProperty(sock, "bufferedAmount", { get: () => 4096 })
    assert.equal(c.r.link.sendTo("gw", { t: "x" }), false)
    await gw.waitFor(() => gw.closed.length > 0)
    assert.deepEqual(gw.closed, [{ code: 1013 }])
    assert.equal(c.r.link.refused().backpressure, 1)
    assert.equal(c.r.link.sendTo("gw", { t: "x" }), false)
    assert.equal(c.r.link.refused().backpressure, 1, "counted once")
    assert.equal(c.r.link.sendTo("other", { t: "x" }), true)
    assert.deepEqual([bridge.closed, other.closed], [[], []])
    await c.r.done()
  })

  it("closes the bridge and every channel with 1001 on shutdown", async () => {
    const c = await channels()
    const bridge = await c.r.bridge()
    const gw = await c.open("gw", GW)
    const other = await c.open("other", OTHER)
    c.r.link.close()
    await Promise.all(
      [bridge, gw, other].map((b) => b.waitFor(() => b.closed.length > 0)),
    )
    assert.deepEqual(
      [bridge, gw, other].map((b) => b.closed),
      [[{ code: 1001 }], [{ code: 1001 }], [{ code: 1001 }]],
    )
    assert.equal(c.r.link.up(), false)
    assert.equal(c.r.link.channelUp("gw"), false)
    await c.r.done()
  })

  it("reports each configured channel as a metric", async () => {
    const c = await channels()
    const gw = await c.open("gw", GW)
    const text = render(c.r.deadman, c.r.link)
    assert.match(text, /oob_relay_channel_up\{channel="gw"\} 1/)
    assert.match(text, /oob_relay_channel_up\{channel="other"\} 0/)
    gw.close()
    await c.r.done()
  })
})
