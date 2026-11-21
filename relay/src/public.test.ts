import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { Down } from "./shared/frame.ts"
import {
  auth,
  BEAT_TOKEN,
  initData,
  OPERATOR,
  rig,
  type FakeBridge,
} from "./rig.test-util.ts"

type Req = Extract<Down, { t: "req" }>
const b64 = (s: string) => Buffer.from(s).toString("base64")

const answer = (
  b: FakeBridge,
  r: Req,
  status: number,
  body: string,
  headers: Record<string, string> = { "content-type": "application/json" },
) => {
  b.send({ t: "res", id: r.id, status, headers })
  b.send({ t: "chunk", id: r.id, n: 0, data: b64(body) })
  b.send({ t: "end", id: r.id })
}

describe("paths", () => {
  it("answers 404 to any other path and sends nothing on the link", async () => {
    const r = await rig()
    const b = await r.bridge()
    for (const p of [
      "/admin",
      "/",
      "/v2/x",
      "/application",
      "/appx",
      "/beats",
      "//admin",
      "/app/../admin",
      "/v1/%2e%2e/admin",
    ]) {
      const res = await fetch(r.url + p, { headers: auth() })
      assert.equal(res.status, 404, p)
      await res.arrayBuffer()
    }
    assert.equal(b.frames.length, 0)
    await r.done()
  })

  it("answers /healthz without a link, and only to GET", async () => {
    const r = await rig()
    const ok = await fetch(r.url + "/healthz")
    assert.equal(ok.status, 200)
    assert.equal(await ok.text(), "ok")
    assert.equal(
      (await fetch(r.url + "/healthz", { method: "POST" })).status,
      404,
    )
    await r.done()
  })

  it("answers 405 to /beat with another method, before looking at credentials", async () => {
    const r = await rig()
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await fetch(r.url + "/beat", { method })
      assert.equal(res.status, 405, method)
      assert.equal(res.headers.get("allow"), "POST")
    }
    await r.done()
  })

  it("answers 405 to other methods on /app and /v1", async () => {
    const r = await rig()
    const res = await fetch(r.url + "/v1/sessions", {
      method: "DELETE",
      headers: auth(),
    })
    assert.equal(res.status, 405)
    await r.done()
  })
})

describe("POST /beat", () => {
  const beat = { v: 1, id: "x", seq: 1, state: "up", reasons: [] }
  const post = (url: string, token: string | undefined, body: unknown) =>
    fetch(url + "/beat", {
      method: "POST",
      headers: token ? { authorization: "Bearer " + token } : {},
      body: JSON.stringify(body),
    })

  it("takes a heartbeat with the bearer token and feeds the receiver", async () => {
    const r = await rig()
    assert.equal((await post(r.url, BEAT_TOKEN, beat)).status, 204)
    assert.equal(r.beats.length, 0, "the link did not carry it")
    assert.equal(r.deadman.shown(), "up")
    await r.done()
  })

  it("refuses no token, a wrong token and a body that is not a heartbeat", async () => {
    const r = await rig()
    assert.equal((await post(r.url, undefined, beat)).status, 401)
    assert.equal((await post(r.url, "w".repeat(48), beat)).status, 401)
    assert.equal((await post(r.url, BEAT_TOKEN, { state: "fine" })).status, 400)
    assert.equal(
      (
        await fetch(r.url + "/beat", {
          method: "POST",
          headers: { authorization: "Bearer " + BEAT_TOKEN },
          body: "{nope",
        })
      ).status,
      400,
    )
    assert.equal(r.deadman.shown(), "unknown")
    await r.done()
  })

  it("is off without a token, and limits how often it is called", async () => {
    const off = await rig({ env: { HEARTBEAT_TOKEN: "" } })
    assert.equal((await post(off.url, BEAT_TOKEN, beat)).status, 404)
    await off.done()
    const r = await rig({ env: { BEAT_RATE_PER_SECOND: "2" } })
    const codes: number[] = []
    for (let i = 0; i < 6; i++)
      codes.push((await post(r.url, BEAT_TOKEN, beat)).status)
    assert.ok(codes.includes(429), codes.join())
    await r.done()
  })
})

describe("init data on /v1", () => {
  const get = (url: string, headers: Record<string, string>) =>
    fetch(url + "/v1/sessions", { headers })

  it("refuses missing, malformed, wrong-user, stale and tampered init data, and sends nothing", async () => {
    const r = await rig()
    const b = await r.bridge()
    const old = initData({
      auth_date: String(Math.floor(Date.now() / 1000) - 7200),
    })
    const cases: Array<[string, Record<string, string>, number]> = [
      ["none", {}, 401],
      ["bearer", { authorization: "Bearer " + BEAT_TOKEN }, 401],
      ["garbage", { authorization: "tma garbage" }, 401],
      ["other user", auth(initData({}, undefined, 7)), 403],
      ["stale", auth(old), 401],
      ["tampered", auth(initData().replace("AAH-test", "AAH-evil")), 401],
      ["other token", auth(initData({}, "999:OTHER")), 401],
    ]
    for (const [name, h, want] of cases) {
      const res = await get(r.url, h)
      assert.equal(res.status, want, name)
      assert.doesNotMatch(await res.text(), /hash|token|user/i, name)
    }
    assert.equal(b.frames.length, 0)
    await r.done()
  })

  it("without a verify token it checks shape, user and age, and a forged hash passes", async () => {
    const r = await rig({ env: { TELEGRAM_BOT_TOKEN_VERIFY: "" } })
    const b = await r.bridge()
    const forged = initData({}, "999:OTHER")
    const res = get(r.url, auth(forged))
    const req = await b.waitFor(() => b.reqs()[0])
    b.send({ t: "res", id: req.id, status: 200, headers: {} })
    b.send({ t: "end", id: req.id })
    assert.equal((await res).status, 200)
    assert.equal(
      (await get(r.url, auth(initData({}, undefined, 7)))).status,
      403,
    )
    await r.done()
  })

  it("refuses every call while no operator is configured", async () => {
    const r = await rig({ env: { OPERATOR_USER_ID: "" } })
    await r.bridge()
    assert.equal((await get(r.url, auth())).status, 503)
    await r.done()
  })

  it("answers 401 before it says anything about the link", async () => {
    const r = await rig()
    assert.equal((await get(r.url, {})).status, 401)
    assert.equal((await get(r.url, auth())).status, 503)
    await r.done()
  })
})

describe("forwarding", () => {
  it("sends one req frame with the allow-listed headers, the query and the client address", async () => {
    const r = await rig()
    const b = await r.bridge()
    const init = initData()
    const p = fetch(r.url + "/v1/sessions?limit=5&offset=1", {
      headers: {
        authorization: "tma " + init,
        accept: "application/json",
        "last-event-id": "7",
        cookie: "secret=1",
        "x-forwarded-for": "9.9.9.9",
        "cf-connecting-ip": "203.0.113.9, 10.0.0.1",
      },
    })
    const req = await b.waitFor(() => b.reqs()[0])
    assert.equal(req.method, "GET")
    assert.equal(req.path, "/v1/sessions?limit=5&offset=1")
    assert.deepEqual(req.headers, {
      authorization: "tma " + init,
      accept: "application/json",
      "last-event-id": "7",
    })
    assert.equal(req.client, "203.0.113.9")
    assert.equal(req.body, undefined)
    answer(b, req, 200, '{"ok":true}')
    const res = await p
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    assert.equal(res.headers.get("cache-control"), "no-store")
    assert.equal(res.headers.get("x-content-type-options"), "nosniff")
    await r.done()
  })

  it("falls back to the socket address when the header is missing or not an address", async () => {
    const r = await rig()
    const b = await r.bridge()
    const p = fetch(r.url + "/v1/meta", {
      headers: { ...auth(), "cf-connecting-ip": "not-an-ip" },
    })
    const req = await b.waitFor(() => b.reqs()[0])
    assert.match(req.client, /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/)
    answer(b, req, 204, "")
    await p
    await r.done()
  })

  it("passes a POST body base64 and keeps the bridge's own Cache-Control", async () => {
    const r = await rig()
    const b = await r.bridge()
    const p = fetch(r.url + "/v1/sessions/s1/actions/stop", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: '{"x":1}',
    })
    const req = await b.waitFor(() => b.reqs()[0])
    assert.equal(Buffer.from(req.body ?? "", "base64").toString(), '{"x":1}')
    assert.equal(req.headers["content-type"], "application/json")
    answer(b, req, 200, "{}", {
      "content-type": "application/json",
      "cache-control": "max-age=5",
      "set-cookie": "a=1",
      "x-evil": "1",
    })
    const res = await p
    assert.equal(res.headers.get("cache-control"), "max-age=5")
    assert.equal(res.headers.get("set-cookie"), null)
    assert.equal(res.headers.get("x-evil"), null)
    await r.done()
  })

  it("serves /app without init data, through the link", async () => {
    const r = await rig()
    const b = await r.bridge()
    const p = fetch(r.url + "/app/")
    const req = await b.waitFor(() => b.reqs()[0])
    assert.equal(req.path, "/app/")
    answer(b, req, 200, "<html></html>", {
      "content-type": "text/html",
      "content-security-policy": "default-src 'self'",
    })
    const res = await p
    assert.equal(
      res.headers.get("content-security-policy"),
      "default-src 'self'",
    )
    assert.equal(await res.text(), "<html></html>")
    await r.done()
  })

  it("answers a status the bridge gave outside 200 to 599 with 502", async () => {
    const r = await rig()
    const b = await r.bridge()
    const p = fetch(r.url + "/app/")
    const req = await b.waitFor(() => b.reqs()[0])
    b.send({ t: "res", id: req.id, status: 99, headers: {} })
    assert.equal((await p).status, 502)
    await r.done()
  })
})

describe("offline", () => {
  it("answers 503 and the offline page to /app, and 503 JSON to /v1", async () => {
    const r = await rig()
    const app = await fetch(r.url + "/app/")
    assert.equal(app.status, 503)
    assert.match(app.headers.get("content-type") ?? "", /text\/html/)
    assert.match(await app.text(), /offline/i)
    assert.match(
      app.headers.get("content-security-policy") ?? "",
      /default-src 'none'/,
    )
    const v1 = await fetch(r.url + "/v1/meta", { headers: auth() })
    assert.equal(v1.status, 503)
    await r.done()
  })

  it("ends a request in flight when the link drops", async () => {
    const r = await rig()
    const b = await r.bridge()
    const p = fetch(r.url + "/v1/meta", { headers: auth() })
    await b.waitFor(() => b.reqs()[0])
    b.close()
    assert.equal((await p).status, 503)
    await r.done()
  })
})

describe("limits", () => {
  it("answers 413 to a body over the cap, by header and by bytes, and sends nothing", async () => {
    const r = await rig({ env: { MAX_BODY_BYTES: "1024" } })
    const b = await r.bridge()
    const big = "x".repeat(2000)
    const a = await fetch(r.url + "/v1/sessions", {
      method: "POST",
      headers: auth(),
      body: big,
    })
    assert.equal(a.status, 413)
    const chunked = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big))
        c.close()
      },
    })
    const c = await fetch(r.url + "/v1/sessions", {
      method: "POST",
      headers: auth(),
      body: chunked,
      duplex: "half",
    } as RequestInit)
    assert.equal(c.status, 413)
    assert.equal(b.frames.length, 0)
    await r.done()
  })

  it("takes the default cap of 256 KiB", async () => {
    const r = await rig()
    const b = await r.bridge()
    const res = await fetch(r.url + "/v1/sessions", {
      method: "POST",
      headers: auth(),
      body: "x".repeat(300 * 1024),
    })
    assert.equal(res.status, 413)
    assert.equal(b.frames.length, 0)
    await r.done()
  })

  it("limits requests per second per client", async () => {
    const r = await rig({
      env: { RATE_LIMIT_PER_SECOND: "1", RATE_LIMIT_BURST: "3" },
    })
    const codes = await Promise.all(
      Array.from({ length: 12 }, () =>
        fetch(r.url + "/app/", {
          headers: { "cf-connecting-ip": "203.0.113.5" },
        }).then(async (x) => (await x.arrayBuffer(), x.status)),
      ),
    )
    assert.ok(codes.filter((c) => c === 429).length >= 8, codes.join())
    const other = await fetch(r.url + "/app/", {
      headers: { "cf-connecting-ip": "203.0.113.6" },
    })
    assert.notEqual(other.status, 429, "another client is not limited")
    await r.done()
  })

  it("limits requests in flight per client and in total", async () => {
    const r = await rig({
      env: { MAX_IN_FLIGHT_PER_CLIENT: "2", MAX_IN_FLIGHT_TOTAL: "3" },
    })
    const b = await r.bridge()
    const open = (ip: string) =>
      fetch(r.url + "/v1/meta", {
        headers: { ...auth(), "cf-connecting-ip": ip },
      })
    const held = [open("203.0.113.1"), open("203.0.113.1")]
    await b.waitFor(() => b.reqs().length === 2)
    assert.equal(
      (await open("203.0.113.1")).status,
      429,
      "third from one client",
    )
    held.push(open("203.0.113.2"))
    await b.waitFor(() => b.reqs().length === 3)
    assert.equal((await open("203.0.113.3")).status, 503, "fourth in total")
    for (const q of b.reqs()) answer(b, q, 200, "{}")
    for (const h of held) assert.equal((await h).status, 200)
    await r.done()
  })
})

describe("streams", () => {
  it("passes chunks in order, and adds a comment line while the stream is idle", async () => {
    const r = await rig({ env: { SSE_KEEPALIVE_SECONDS: "1" } })
    const b = await r.bridge()
    const res = fetch(r.url + "/v1/events", { headers: auth() })
    const req = await b.waitFor(() => b.reqs()[0])
    b.send({
      t: "res",
      id: req.id,
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
    const res2 = await res
    assert.equal(res2.status, 200)
    const reader = res2.body!.getReader()
    const dec = new TextDecoder()
    b.send({ t: "chunk", id: req.id, n: 0, data: b64("data: one\n\n") })
    b.send({ t: "chunk", id: req.id, n: 1, data: b64("data: two\n\n") })
    let got = ""
    while (!got.includes("two")) got += dec.decode((await reader.read()).value)
    assert.ok(got.indexOf("one") < got.indexOf("two"))
    while (!got.includes("keep-alive"))
      got += dec.decode((await reader.read()).value)
    assert.match(got, /: keep-alive/)
    await reader.cancel()
    await r.done()
  })

  it("sends a close frame when the phone leaves", async () => {
    const r = await rig()
    const b = await r.bridge()
    const ctl = new AbortController()
    const res = fetch(r.url + "/v1/events", {
      headers: auth(),
      signal: ctl.signal,
    })
    const req = await b.waitFor(() => b.reqs()[0])
    b.send({
      t: "res",
      id: req.id,
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
    await res
    ctl.abort()
    const close = await b.waitFor(() => b.frames.find((f) => f.t === "close"))
    assert.deepEqual(close, { t: "close", id: req.id })
    await r.done()
  })

  it("ends the stream when chunks arrive out of order", async () => {
    const r = await rig()
    const b = await r.bridge()
    const res = fetch(r.url + "/v1/events", { headers: auth() })
    const req = await b.waitFor(() => b.reqs()[0])
    b.send({
      t: "res",
      id: req.id,
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
    const r2 = await res
    b.send({ t: "chunk", id: req.id, n: 5, data: b64("x") })
    await assert.rejects(async () => {
      const rd = r2.body!.getReader()
      for (;;) if ((await rd.read()).done) throw new Error("ended")
    })
    await b.waitFor(() => b.frames.find((f) => f.t === "close"))
    await r.done()
  })

  it("answers 504 when the bridge does not answer in time", async () => {
    const r = await rig({ link: { requestTimeoutMs: 100 } })
    const b = await r.bridge()
    const res = await fetch(r.url + "/v1/meta", { headers: auth() })
    assert.equal(res.status, 504)
    await b.waitFor(() => b.frames.find((f) => f.t === "close"))
    await r.done()
  })
})

describe("logs", () => {
  it("hold no credential, query, body or path", async () => {
    const r = await rig()
    const b = await r.bridge()
    const init = initData()
    const p = fetch(
      r.url + "/v1/sessions/secret-session-id?token=QUERYSECRET",
      {
        method: "POST",
        headers: {
          authorization: "tma " + init,
          "content-type": "application/json",
        },
        body: '{"text":"BODYSECRET"}',
      },
    )
    const req = await b.waitFor(() => b.reqs()[0])
    answer(b, req, 200, "{}")
    await p
    await fetch(r.url + "/beat", {
      method: "POST",
      headers: { authorization: "Bearer " + BEAT_TOKEN },
      body: '{"state":"up"}',
    })
    await new Promise((ok) => setTimeout(ok, 50))
    const text = r.lines.join("\n")
    assert.ok(text.includes('"route":"v1"'))
    for (const s of [
      init,
      "QUERYSECRET",
      "BODYSECRET",
      "secret-session-id",
      BEAT_TOKEN,
      "tma",
      String(OPERATOR),
      "AAH-test",
    ])
      assert.ok(!text.includes(s), "the log holds " + s.slice(0, 6))
    await r.done()
  })
})
