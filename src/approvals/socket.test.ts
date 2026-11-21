import assert from "node:assert/strict"
import { request } from "node:http"
import { mkdtemp, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

import { filterSecrets } from "../filter.ts"
import { CallerStore, proof, type CallerFile } from "./callers.ts"
import { OFF } from "./config.ts"
import { Approvals, type ApprovalView, type ChannelPort } from "./engine.ts"
import { newSigningKey, signAnswer } from "./sign.ts"
import { startEndpoint, type Endpoint } from "./socket.ts"
import { RecordStore } from "./store.ts"

const open: Endpoint[] = []
after(async () => {
  for (const e of open) await e.close()
})

class Chan implements ChannelPort {
  id = "tg"
  type = "telegram"
  caps = { buttons: true, approver: "verified" as const, replyText: true }
  views: ApprovalView[] = []
  up = () => true
  operator = () => "42"
  async request(v: ApprovalView) {
    this.views.push(v)
    return "m1"
  }
  async askCode() {
    return "c1"
  }
  async settle() {}
  async remove() {}
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "oa-"))
  const path = join(dir, "approvals.sock")
  const callers = new CallerStore(join(dir, "callers"))
  const file = await callers.pair("secrets-tool", [], path)
  const key = newSigningKey()
  const ch = new Chan()
  let mode: "afk" | "present" = "afk"
  const engine = new Approvals({
    cfg: () => ({
      ...OFF,
      enabled: true,
      classes: {
        "secrets.read": { level: 1, channels: ["telegram"], maxTtl: 600 },
      },
      callers: { "secrets-tool": { classes: ["secrets.read"] } },
    }),
    now: Date.now,
    mode: () => mode,
    channels: () => [ch],
    sign: async (a) => signAnswer(key, a),
    signingReady: async () => true,
    seed: async () => undefined,
    store: new RecordStore(),
    mask: filterSecrets,
  })
  const ep = await startEndpoint({ path, engine, callers, keepAliveMs: 50 })
  open.push(ep)
  return {
    dir,
    path,
    callers,
    file,
    engine,
    ch,
    ep,
    setMode: (m: typeof mode) => (mode = m),
  }
}

type Reply = { status: number; json: any; text: string }
function call(
  s: { path: string; file: CallerFile },
  method: string,
  target: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Reply> {
  const raw = body === undefined ? "" : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: s.path,
        path: target,
        method,
        headers: headers ?? proof(s.file, method, target, raw),
      },
      (res) => {
        let text = ""
        res.on("data", (c) => (text += c))
        res.on("end", () => {
          let json: unknown
          try {
            json = JSON.parse(text)
          } catch {}
          resolve({ status: res.statusCode ?? 0, json, text })
        })
      },
    )
    req.on("error", reject)
    req.end(raw)
  })
}

const body = (over = {}) => ({
  idempotency_key: "k1",
  action_class: "secrets.read",
  scope_summary: "item 4f2a",
  ...over,
})

describe("approvals socket", () => {
  it("is 0600 in a 0700 directory", async () => {
    const s = await setup()
    assert.equal((await stat(s.path)).mode & 0o777, 0o600)
    assert.equal((await stat(join(s.path, ".."))).mode & 0o777, 0o700)
  })

  it("refuses a request without a proof, with a bad mac, or an old time, and sends nothing", async () => {
    const s = await setup()
    assert.equal(
      (await call(s, "POST", "/v1/approvals", body(), {})).status,
      401,
    )
    const good = proof(s.file, "POST", "/v1/approvals", JSON.stringify(body()))
    const bad = { ...good, "x-caller-mac": "0".repeat(64) }
    const r = await call(s, "POST", "/v1/approvals", body(), bad)
    assert.deepEqual(r.json, { error: "unauthenticated", retryable: false })
    const old = proof(
      s.file,
      "POST",
      "/v1/approvals",
      JSON.stringify(body()),
      Date.now() - 90_000,
    )
    assert.equal(
      (await call(s, "POST", "/v1/approvals", body(), old)).status,
      401,
    )
    assert.equal(s.ch.views.length, 0)
  })

  it("creates, reads, long-polls and withdraws a request", async () => {
    const s = await setup()
    const made = await call(s, "POST", "/v1/approvals", body())
    assert.equal(made.status, 201)
    assert.equal(made.json.state, "pending")
    const id = made.json.id
    assert.equal(
      (await call(s, "GET", `/v1/approvals/${id}`)).json.state,
      "pending",
    )
    const waiting = call(s, "GET", `/v1/approvals/${id}?wait=20`)
    await new Promise((r) => setTimeout(r, 30))
    const del = await call(s, "DELETE", `/v1/approvals/${id}`)
    assert.equal(del.json.state, "withdrawn")
    assert.equal((await waiting).json.state, "withdrawn")
    assert.equal((await call(s, "GET", "/v1/approvals/NOPE")).status, 404)
  })

  it("streams pending, then the signed answer, over SSE", async () => {
    const s = await setup()
    const made = await call(s, "POST", "/v1/approvals", body())
    const id = made.json.id
    const sse = call(s, "GET", `/v1/approvals/${id}/events`)
    await new Promise((r) => setTimeout(r, 120))
    const view = s.ch.views[0]
    await s.engine.tap({
      channel: "tg",
      userId: "42",
      id,
      nonce: view.nonce,
      action: "approve",
    })
    const r = await sse
    assert.match(r.text, /event: pending/)
    assert.match(r.text, /event: answer/)
    assert.match(r.text, /"decision":"approve"/)
    assert.match(r.text, /: keep-alive/)
  })

  it("reports the mode and refuses a phone request in present mode", async () => {
    const s = await setup()
    assert.equal((await call(s, "GET", "/v1/status")).json.mode, "afk")
    s.setMode("present")
    assert.equal((await call(s, "GET", "/v1/status")).json.mode, "present")
    const r = await call(s, "POST", "/v1/approvals", body())
    assert.equal(r.status, 409)
    assert.equal(r.json.reason, "present")
  })

  it("replaces a stale socket and refuses a live one", async () => {
    const s = await setup()
    await s.ep.close()
    const stale = createServer()
    await new Promise<void>((r) => stale.listen(s.path, r))
    // The listener is gone but the file stays, as after a crash.
    stale.close()
    await writeFile(join(s.dir, "x"), "")
    const again = await startEndpoint({
      path: s.path,
      engine: s.engine,
      callers: s.callers,
    })
    open.push(again)
    assert.equal((await call(s, "GET", "/v1/status")).status, 200)
    await assert.rejects(
      startEndpoint({ path: s.path, engine: s.engine, callers: s.callers }),
      /another process/,
    )
  })

  it("rejects an unknown route and a body that is not json", async () => {
    const s = await setup()
    assert.equal((await call(s, "GET", "/v2/status")).status, 404)
    assert.equal((await call(s, "GET", "/v1/other")).status, 404)
    const junk = "{nope"
    const r = await new Promise<number>((resolve) => {
      const req = request(
        {
          socketPath: s.path,
          path: "/v1/approvals",
          method: "POST",
          headers: proof(s.file, "POST", "/v1/approvals", junk),
        },
        (res) => (res.resume(), resolve(res.statusCode ?? 0)),
      )
      req.end(junk)
    })
    assert.equal(r, 400)
  })
})
