import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { Up } from "./frame.ts"
import {
  LinkServer,
  MAX_BODY_BYTES,
  MAX_IN_FLIGHT,
  type Handler,
} from "./serve.ts"

const b64 = (s: string) => Buffer.from(s).toString("base64")
const req = (id: string, over: Record<string, unknown> = {}) =>
  ({
    t: "req",
    id,
    method: "GET",
    path: "/v1/meta",
    headers: {},
    client: "203.0.113.4",
    ...over,
  }) as never

function rig(handler: Handler) {
  const out: Up[] = []
  const s = new LinkServer(handler, (f) => out.push(f))
  const text = (id: string) =>
    out
      .filter((f) => f.t === "chunk" && f.id === id)
      .map((f) =>
        Buffer.from((f as { data: string }).data, "base64").toString(),
      )
      .join("")
  return { s, out, text }
}

const json: Handler = (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" })
  res.end('{"ok":true}')
}

describe("serving a request frame", () => {
  it("runs the handler on a request made from the frame and sends res, chunk and end frames", async () => {
    let seen: Record<string, unknown> = {}
    const { s, out, text } = rig((rq, res, edge) => {
      seen = {
        method: rq.method,
        url: rq.url,
        headers: rq.headers,
        edge,
        ip: rq.socket.remoteAddress,
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      res.end('{"ok":true}')
    })
    s.request(
      req("r1", {
        path: "/v1/sessions?limit=2",
        headers: { authorization: "tma x", cookie: "no", "x-evil": "1" },
      }),
    )
    assert.deepEqual(seen, {
      method: "GET",
      url: "/v1/sessions?limit=2",
      headers: { authorization: "tma x" },
      edge: { client: "203.0.113.4" },
      ip: "203.0.113.4",
    })
    assert.deepEqual(out[0], {
      t: "res",
      id: "r1",
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    })
    assert.equal(text("r1"), '{"ok":true}')
    assert.deepEqual(out.at(-1), { t: "end", id: "r1" })
    assert.equal(s.inFlight(), 0)
  })

  it("gives a POST handler its body, and splits a large answer into ordered chunks", async () => {
    const big = "x".repeat(100_000)
    const { s, out, text } = rig(async (rq, res) => {
      let body = ""
      for await (const c of rq) body += c
      res.writeHead(200, {})
      res.end(body)
    })
    s.request(req("r2", { method: "POST", body: b64(big) }))
    await new Promise((r) => setTimeout(r, 20))
    const chunks = out.filter((f) => f.t === "chunk") as Array<{ n: number }>
    assert.ok(chunks.length >= 3)
    assert.deepEqual(
      chunks.map((c) => c.n),
      chunks.map((_, i) => i),
    )
    assert.equal(text("r2").length, 100_000)
  })

  it("keeps a stream open, and stops writing to it when the relay says the phone left", async () => {
    let closed = false
    let res!: { write(s: string): boolean }
    const { s, out } = rig((rq, r) => {
      r.writeHead(200, { "content-type": "text/event-stream" })
      r.write(": ok\n\n")
      res = r as never
      rq.on("close", () => (closed = true))
    })
    s.request(req("r3", { path: "/v1/events" }))
    assert.equal(s.inFlight(), 1)
    res.write("data: 1\n\n")
    const before = out.length
    s.close("r3")
    await new Promise((r) => setImmediate(r))
    assert.equal(closed, true)
    assert.equal(s.inFlight(), 0)
    res.write("data: 2\n\n")
    assert.equal(out.length, before, "nothing is sent after the close")
  })

  it("answers 404 for paths outside /app, /v1 and /healthz, and 405 for other methods", () => {
    const { s, out } = rig(json)
    for (const [id, path, method] of [
      ["a", "/admin", "GET"],
      ["b", "//x/v1/meta", "GET"],
      ["c", "/v1/../admin", "GET"],
      ["d", "/", "GET"],
      ["e", "/v1/meta", "DELETE"],
    ])
      s.request(req(id, { path, method }))
    const status = (id: string) =>
      (out.find((f) => f.t === "res" && f.id === id) as { status: number })
        .status
    assert.deepEqual(["a", "b", "c", "d"].map(status), [404, 404, 404, 404])
    assert.equal(status("e"), 405)
  })

  it("answers 413 for a body over 256 KiB", () => {
    const { s, out } = rig(json)
    s.request(
      req("big", {
        method: "POST",
        body: Buffer.alloc(MAX_BODY_BYTES + 1).toString("base64"),
      }),
    )
    assert.equal((out[0] as { status: number }).status, 413)
    const ok = rig(json)
    ok.s.request(
      req("ok", {
        method: "POST",
        body: Buffer.alloc(MAX_BODY_BYTES).toString("base64"),
      }),
    )
    assert.equal((ok.out[0] as { status: number }).status, 200)
  })

  it("answers the 17th request in flight with 503", () => {
    const { s, out } = rig(() => {})
    for (let i = 0; i < MAX_IN_FLIGHT; i++)
      s.request(req("s" + i, { path: "/v1/events" }))
    assert.equal(s.inFlight(), 16)
    s.request(req("over"))
    assert.equal(
      (out.find((f) => f.t === "res" && f.id === "over") as { status: number })
        .status,
      503,
    )
    s.closeAll()
    assert.equal(s.inFlight(), 0)
  })

  it("answers 500 when the handler throws, and ignores a repeated id", () => {
    const { s, out } = rig(() => {
      throw new Error("boom")
    })
    s.request(req("x"))
    assert.equal((out[0] as { status: number }).status, 500)
    const quiet = rig(() => {})
    quiet.s.request(req("dup", { path: "/v1/events" }))
    quiet.s.request(req("dup", { path: "/v1/events" }))
    assert.equal(quiet.s.inFlight(), 1)
  })
})
