import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { handler } from "../core/api.ts"
import { TokenStore } from "../core/auth.ts"
import {
  auth,
  initData,
  OPERATOR,
  SECRET,
  TOKEN,
  rig,
} from "../../relay/src/rig.test-util.ts"
import { LinkClient } from "./client.ts"

/** A real bridge link talking to a real relay, on loopback. */
function bridge(url: string, secret = SECRET) {
  const tokens = new TokenStore("/nonexistent/token")
  const h = handler({
    views: {
      list: () => ({ sessions: [], total: 0 }),
      fields: () => [],
    } as never,
    actions: { available: () => [] } as never,
    control: {} as never,
    cfg: {} as never,
    tokens,
    ring: {} as never,
    version: "9.9.9",
    edge: { operator: () => OPERATOR, botToken: () => TOKEN },
  })
  return new LinkClient({
    url,
    secret: async () => secret,
    handler: (req, res, edge) => h(req, res, edge),
    backoff: { minMs: 10, maxMs: 40 },
  })
}

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe("the bridge link against the relay", () => {
  it("serves the phone's request from the core API, checked again at this end", async () => {
    const r = await rig()
    const b = bridge(r.linkUrl)
    b.start()
    await until(() => b.up())
    const ok = await fetch(r.url + "/v1/meta", { headers: auth() })
    assert.equal(ok.status, 200)
    assert.equal(((await ok.json()) as { api: string }).api, "v1")
    const other = await fetch(r.url + "/v1/meta", {
      headers: auth(initData({}, TOKEN, 7)),
    })
    assert.ok([401, 403].includes(other.status))
    await b.stop()
    await r.done()
  })

  it("carries a heartbeat to the dead-man receiver and gets the ack", async () => {
    const r = await rig()
    const b = bridge(r.linkUrl)
    b.start()
    await until(() => b.up())
    const acked = await b.beat(
      { seq: 1, state: "up", reasons: [] } as never,
      2000,
    )
    assert.equal(acked, true)
    assert.equal(r.beats.length, 1)
    assert.equal(r.beats[0].state, "up")
    await b.stop()
    await r.done()
  })

  it("stays down with a wrong secret and the phone sees the offline page", async () => {
    const r = await rig()
    const b = bridge(r.linkUrl, "z".repeat(48))
    b.start()
    await new Promise((x) => setTimeout(x, 150))
    assert.equal(b.up(), false)
    const res = await fetch(r.url + "/v1/meta", { headers: auth() })
    assert.equal(res.status, 503)
    await b.stop()
    await r.done()
  })
})
