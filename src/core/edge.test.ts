import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, it } from "node:test"

import { signInitData } from "../link/initdata.ts"
import { handler } from "./api.ts"
import { FailLimiter, TokenStore } from "./auth.ts"

const BOT = "123456:EDGE-TEST-TOKEN"
const OPERATOR = 4242
const BEARER = "b".repeat(43)

async function rig(o: { operator?: number; token?: string } = {}) {
  let now = Date.now()
  const tokens = new TokenStore("/nonexistent/token")
  ;(tokens as unknown as { token: string }).token = BEARER
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
    edge: {
      operator: () => ("operator" in o ? o.operator : OPERATOR),
      botToken: () => ("token" in o ? o.token : BOT),
      now: () => now,
    },
  })
  const server = createServer((req, res) =>
    "x-edge" in req.headers
      ? h(req, res, { client: String(req.headers["x-edge"]) })
      : h(req, res),
  )
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port
  return {
    url,
    at: (ms: number) => (now += ms),
    now: () => now,
    async done() {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    },
  }
}

const init = (now: number, over: Record<string, string> = {}, bot = BOT) =>
  "tma " +
  signInitData(bot, {
    auth_date: String(Math.floor(now / 1000) - 5),
    query_id: "AAH",
    user: JSON.stringify({ id: OPERATOR }),
    ...over,
  })
const via = (client = "203.0.113.1") => ({ "x-edge": client })

describe("a request through the relay link", () => {
  it("is served with fresh init data of the operator", async () => {
    const r = await rig()
    const res = await fetch(r.url + "/v1/meta", {
      headers: { ...via(), authorization: init(r.now()) },
    })
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { api: string }).api, "v1")
    await r.done()
  })

  it("refuses the bearer token with 401", async () => {
    const r = await rig()
    const res = await fetch(r.url + "/v1/meta", {
      headers: { ...via(), authorization: "Bearer " + BEARER },
    })
    assert.equal(res.status, 401)
    assert.equal(await res.text(), "")
    const direct = await fetch(r.url + "/v1/meta", {
      headers: { authorization: "Bearer " + BEARER },
    })
    assert.equal(direct.status, 200, "the same token still works on the socket")
    await r.done()
  })

  it("refuses init data of the socket path: a direct client cannot use it", async () => {
    const r = await rig()
    const res = await fetch(r.url + "/v1/meta", {
      headers: { authorization: init(r.now()) },
    })
    assert.equal(res.status, 401)
    await r.done()
  })

  it("answers 403 for another user, 401 for a stale, a tampered and a forged hash", async () => {
    const r = await rig()
    const get = async (authorization: string) =>
      (
        await fetch(r.url + "/v1/meta", {
          headers: { ...via(), authorization },
        })
      ).status
    assert.equal(
      await get(init(r.now(), { user: JSON.stringify({ id: 7 }) })),
      403,
    )
    assert.equal(
      await get(
        init(r.now(), { auth_date: String(Math.floor(r.now() / 1000) - 7200) }),
      ),
      401,
    )
    assert.equal(await get(init(r.now()).replace("AAH", "EVIL")), 401)
    assert.equal(await get(init(r.now(), {}, "999:OTHER")), 401)
    assert.equal(await get("tma nonsense"), 401)
    assert.equal(await get(""), 401)
    await r.done()
  })

  it("refuses everything while the operator or the bot token is not known", async () => {
    for (const o of [{ operator: undefined }, { token: undefined }]) {
      const r = await rig(o)
      const res = await fetch(r.url + "/v1/meta", {
        headers: { ...via(), authorization: init(r.now()) },
      })
      assert.equal(res.status, 401)
      await r.done()
    }
  })

  it("serves only /v1 and GET /healthz: /admin, /app until it exists, and the rest are 404", async () => {
    const r = await rig()
    const ok = { ...via(), authorization: init(r.now()) }
    for (const p of ["/admin", "/app/", "/", "/v2/meta", "/v1x"]) {
      const res = await fetch(r.url + p, { headers: ok })
      assert.equal(res.status, 404, p)
      await res.arrayBuffer()
    }
    const health = await fetch(r.url + "/healthz", { headers: via() })
    assert.equal(health.status, 200)
    assert.equal(
      (await fetch(r.url + "/healthz", { method: "POST", headers: via() }))
        .status,
      404,
    )
    await r.done()
  })

  it("answers 429 for five minutes after ten failures in a minute from one client address", async () => {
    const r = await rig()
    const bad = { ...via("198.51.100.7"), authorization: "tma nope" }
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await fetch(r.url + "/v1/meta", { headers: bad })).status,
        401,
        "failure " + (i + 1),
      )
    const good = { ...via("198.51.100.7"), authorization: init(r.now()) }
    assert.equal(
      (await fetch(r.url + "/v1/meta", { headers: good })).status,
      429,
    )
    const other = { ...via("198.51.100.8"), authorization: init(r.now()) }
    assert.equal(
      (await fetch(r.url + "/v1/meta", { headers: other })).status,
      200,
    )
    r.at(4 * 60_000)
    assert.equal(
      (await fetch(r.url + "/v1/meta", { headers: good })).status,
      429,
    )
    r.at(61_000)
    assert.equal(
      (
        await fetch(r.url + "/v1/meta", {
          headers: { ...via("198.51.100.7"), authorization: init(r.now()) },
        })
      ).status,
      200,
    )
    await r.done()
  })
})

describe("FailLimiter", () => {
  it("counts only the last minute", () => {
    let t = 0
    const l = new FailLimiter(() => t)
    for (let i = 0; i < 9; i++) {
      l.fail("a")
      t += 7000
    }
    assert.equal(
      l.blocked("a"),
      false,
      "nine in 63 seconds, and the first has aged out",
    )
    for (let i = 0; i < 9; i++) l.fail("b")
    assert.equal(l.blocked("b"), false)
    l.fail("b")
    assert.equal(l.blocked("b"), true)
  })
})
