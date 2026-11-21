import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, it } from "node:test"

import type { AppApprovals } from "../approvals/types.ts"
import { signInitData } from "../link/initdata.ts"
import { handler } from "./api.ts"
import { TokenStore } from "./auth.ts"

const BOT = "123456:EDGE-TEST-TOKEN"
const OPERATOR = 4242
const BEARER = "b".repeat(43)
const ID = "01HZZZZZZZZZZZZZZZZZZZZZZZ"

async function rig(approvals: AppApprovals | undefined) {
  const now = Date.now()
  const tokens = new TokenStore("/nonexistent/token")
  ;(tokens as unknown as { token: string }).token = BEARER
  const h = handler({
    views: {
      list: () => ({ sessions: [], total: 0 }),
      fields: () => [],
    } as never,
    actions: { available: () => [] } as never,
    control: {} as never,
    cfg: {
      permissions: { remote: "once" },
      approvals: { enabled: true },
    } as never,
    tokens,
    ring: {} as never,
    version: "9.9.9",
    approvals: () => approvals,
    edge: { operator: () => OPERATOR, botToken: () => BOT, now: () => now },
  })
  const server = createServer((req, res) =>
    "x-edge" in req.headers
      ? h(req, res, { client: "203.0.113.1" })
      : h(req, res),
  )
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port
  const init =
    "tma " +
    signInitData(BOT, {
      auth_date: String(Math.floor(now / 1000) - 5),
      query_id: "AAH",
      user: JSON.stringify({ id: OPERATOR }),
    })
  return {
    url,
    app: (path: string, o: { method?: string; body?: unknown } = {}) =>
      fetch(url + path, {
        method: o.method ?? "GET",
        headers: {
          "x-edge": "1",
          authorization: init,
          "content-type": "application/json",
        },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      }),
    bearer: (path: string, method = "GET") =>
      method === "POST"
        ? fetch(url + path, {
            method: "POST",
            headers: { authorization: "Bearer " + BEARER },
            body: "{}",
          })
        : fetch(url + path, { headers: { authorization: "Bearer " + BEARER } }),
    async done() {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    },
  }
}

const fake = () => {
  const calls: unknown[][] = []
  const port: AppApprovals = {
    appView: async (id) => (
      calls.push(["view", id]), { status: 200, body: { id, challenge: "c" } }
    ),
    appProof: async (id, b) => (
      calls.push(["proof", id, b]),
      { status: 422, body: { ok: false, text: "Wrong." } }
    ),
    enrol: async (b) => (
      calls.push(["enrol", b]), { status: 200, body: { ok: true } }
    ),
  }
  return { port, calls }
}

describe("approvals routes of the core API", () => {
  it("serve the app through the relay with init data", async () => {
    const f = fake()
    const r = await rig(f.port)
    const v = await r.app("/v1/approvals/" + ID)
    assert.equal(v.status, 200)
    assert.equal(((await v.json()) as { challenge: string }).challenge, "c")
    const p = await r.app(`/v1/approvals/${ID}/proof`, {
      method: "POST",
      body: { factor: "totp", code: "1" },
    })
    assert.equal(p.status, 422)
    assert.deepEqual(await p.json(), { ok: false, text: "Wrong." })
    const e = await r.app("/v1/approvals/enroll", {
      method: "POST",
      body: { kind: "biometric", code: "X" },
    })
    assert.equal(e.status, 200)
    assert.deepEqual(
      f.calls.map((c) => c[0]),
      ["view", "proof", "enrol"],
    )
    await r.done()
  })

  it("refuse the bearer token on the socket: only the app's init data may settle an approval", async () => {
    const f = fake()
    const r = await rig(f.port)
    assert.equal((await r.bearer("/v1/approvals/" + ID)).status, 403)
    assert.equal(
      (await r.bearer(`/v1/approvals/${ID}/proof`, "POST")).status,
      403,
    )
    assert.equal((await r.bearer("/v1/approvals/enroll", "POST")).status, 403)
    assert.deepEqual(f.calls, [])
    await r.done()
  })

  it("refuse a malformed id, an unknown route and a missing service", async () => {
    const f = fake()
    const r = await rig(f.port)
    assert.equal((await r.app("/v1/approvals/..%2Fx")).status, 404)
    assert.equal(
      (await r.app(`/v1/approvals/${ID}/other`, { method: "POST", body: {} }))
        .status,
      404,
    )
    assert.deepEqual(f.calls, [])
    await r.done()
    const off = await rig(undefined)
    assert.equal((await off.app("/v1/approvals/" + ID)).status, 503)
    await off.done()
  })

  it("tell the app in meta whether approvals are on", async () => {
    const r = await rig(fake().port)
    const m = (await (await r.app("/v1/meta")).json()) as { approvals: boolean }
    assert.equal(m.approvals, true)
    await r.done()
    const off = await rig(undefined)
    assert.equal(
      ((await (await off.app("/v1/meta")).json()) as { approvals: boolean })
        .approvals,
      false,
    )
    await off.done()
  })
})
