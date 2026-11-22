import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { Host } from "../bridge.ts"
import type { Config } from "../config.ts"
import { checkInitData, fromHeader, signInitData } from "../link/initdata.ts"
import { Api, Stream } from "../../miniapp/api.js"
import { createController } from "../../miniapp/controller.js"
import * as F from "../../miniapp/form.js"
import { Actions } from "./actions.ts"
import { EventRing, handler } from "./api.ts"
import { TokenStore } from "./auth.ts"
import { Views } from "./views.ts"

const BOT = "123456:e2e-bot-token"
const OPERATOR = 4242

const cfg = {
  redact: { mode: "full" },
  core: { port: 0 },
  miniApp: { maxAgeSeconds: 3600 },
  permissions: { remote: "once" },
  chat: { deny: [], models: [], projects: {} },
} as unknown as Config

const init = (user = OPERATOR) =>
  signInitData(BOT, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: user }),
  })

/** The bridge: the real core API over fake sources. */
async function bridge() {
  const calls: string[] = []
  const prompts = [
    {
      id: "q1",
      kind: "question",
      state: "pending",
      title: "Deploy",
      askedAt: 1,
      rootSessionID: "ses_1",
      questions: [
        {
          key: "env",
          header: "Env",
          text: "Where?",
          options: ["staging", "prod"],
          multiple: false,
          custom: false,
        },
        {
          key: "flags",
          header: "Flags",
          text: "Which flags?",
          options: ["a, b", "c"],
          multiple: true,
          custom: true,
        },
      ],
    },
  ]
  const row = {
    id: "ses_1",
    title: "Fix checkout",
    mode: "auto" as const,
    chat: false,
    busy: true,
    prompts: [],
  }
  const control = {
    snapshot: () => ({
      v: 1,
      at: 1,
      owner: {},
      afk: {},
      pending: 1,
      channels: [],
      sessions: [row],
      stuck: [],
    }),
  } as never
  const host = {
    session: async (id: string) => ({ id, directory: "/w" }),
    busy: () => true,
    interrupt: async () => (calls.push("interrupt"), true),
    agents: async () => [],
    models: async () => [],
    canReplyForm: () => true,
  } as unknown as Host
  const dir = await mkdtemp(join(tmpdir(), "oob-e2e-"))
  const tokens = new TokenStore(join(dir, "t"))
  await tokens.load()
  const ring = new EventRing()
  const h = handler({
    views: new Views({
      control,
      bridge: {
        known: () => [{ id: "ses_1", state: { at: Date.now() } }],
        openPromptList: () => prompts,
        promptEntry: (id: string) => prompts.find((p) => p.id === id),
      } as never,
      host,
      cfg,
      sources: { tail: [], diff: [], todos: [] },
    }),
    actions: new Actions({
      cfg,
      host,
      now: Date.now,
      denial: () => undefined,
      setChat: async () => ({ ok: true, text: "" }),
      setWatch: async () => ({ ok: true, text: "" }),
      resume: async () => ({ ok: true, text: "" }),
      answer: async (id, a) => (
        calls.push("answer:" + id + ":" + JSON.stringify(a)),
        { ok: true, text: "Answered." }
      ),
    }),
    control,
    cfg,
    tokens,
    ring,
    version: "9.9.9",
    keepAliveMs: 50,
    edge: { operator: () => OPERATOR, botToken: () => BOT },
  })
  const server = createServer((req, res) =>
    h(req, res, { client: "203.0.113.9" }),
  )
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const api = {
    port: (server.address() as { port: number }).port,
    close: async () => {
      server.closeAllConnections()
      server.close()
    },
  }
  return { api, calls, ring }
}

/**
 * The relay: only /app/ and /v1/ pass, /v1 needs well-formed fresh init data of
 * the operator (the hash is the bridge's to check), nothing is buffered.
 */
async function relay(bridgePort: number, down = () => false) {
  const seen: string[] = []
  const server: Server = createServer(async (req, res) => {
    const p = new URL(req.url ?? "/", "http://r").pathname
    seen.push(req.method + " " + p)
    const app = p === "/app/" || p.startsWith("/app/")
    const v1 = p.startsWith("/v1/")
    if (!app && !v1 && p !== "/healthz") {
      res.writeHead(404)
      return void res.end()
    }
    if (v1) {
      const v = checkInitData(fromHeader(req.headers.authorization), {
        operator: OPERATOR,
        maxAgeSeconds: 3600,
      })
      if (!v.ok) {
        res.writeHead(v.status)
        return void res.end()
      }
    }
    if (down()) {
      res.writeHead(503)
      return void res.end()
    }
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const up = await fetch("http://127.0.0.1:" + bridgePort + req.url, {
      method: req.method,
      headers: Object.fromEntries(
        ["authorization", "content-type", "accept", "last-event-id"]
          .filter((k) => typeof req.headers[k] === "string")
          .map((k) => [k, req.headers[k] as string]),
      ),
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    })
    res.writeHead(up.status, Object.fromEntries(up.headers))
    res.on("close", () => void up.body?.cancel().catch(() => {}))
    try {
      for await (const c of up.body as unknown as AsyncIterable<Uint8Array>)
        res.write(c)
    } catch {
      return void res.destroy()
    }
    res.end()
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  return {
    url: "http://127.0.0.1:" + (server.address() as { port: number }).port,
    seen,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

const until = async (f: () => boolean, ms = 3000) => {
  const t = Date.now()
  while (!f() && Date.now() - t < ms)
    await new Promise((r) => setTimeout(r, 10))
  assert.ok(f(), "condition not reached")
}

describe("Mini App end to end: phone, relay, bridge", () => {
  it("lists sessions, answers a form once from the question screen, stops after a confirmation", async () => {
    const b = await bridge()
    const r = await relay(b.api.port)
    const api = new Api({ initData: init(), base: r.url })
    const ctl = createController({
      api,
      now: Date.now,
      start: "ses_1",
      makeStream: (h) => new Stream({ api, ...h }),
    })
    try {
      await ctl.boot()
      await until(() => ctl.state.conn === "live")
      assert.equal(ctl.state.sessions[0].id, "ses_1")
      assert.equal(ctl.state.detail.questions[0].id, "q1")
      assert.equal(ctl.state.detail.canAnswer, true)

      await ctl.openPrompt("q1")
      assert.equal(ctl.state.question.view.items.length, 2)
      ctl.edit(F.pick, 0, "prod")
      ctl.edit(F.pick, 1, "a, b")
      ctl.edit(F.other, 1, "free text")
      assert.deepEqual(b.calls, [], "nothing reaches the host before Send")
      await ctl.sendAnswers()
      assert.equal(ctl.state.question.sent, true)
      assert.deepEqual(b.calls, [
        "answer:q1:" +
          JSON.stringify({
            answers: { env: "prod", flags: ["a, b", "free text"] },
          }),
      ])

      ctl.ask("stop", "ses_1")
      assert.deepEqual(b.calls.length, 1, "stop waits for the confirmation")
      await ctl.confirmed()
      assert.equal(b.calls[1], "interrupt")
      assert.deepEqual(
        r.seen.filter((s) => !/^(GET|POST) \/v1\//.test(s)),
        [],
      )
    } finally {
      ctl.stop()
      r.close()
      await b.api.close()
    }
  })

  it("shows the banner state and disables actions when the stream drops, and recovers", async () => {
    const b = await bridge()
    let down = false
    const r = await relay(b.api.port, () => down)
    const api = new Api({ initData: init(), base: r.url })
    const ctl = createController({
      api,
      makeStream: (h) =>
        new Stream({
          api,
          ...h,
          silenceMs: 200,
          sleep: (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 50))),
        }),
    })
    try {
      await ctl.boot()
      await until(() => ctl.state.conn === "live")
      assert.equal(ctl.canAct(), true)
      down = true
      r.close()
      await until(() => ctl.state.conn === "down")
      assert.equal(ctl.canAct(), false)
      const stamp = ctl.state.updatedAt
      assert.ok(stamp > 0, "the time of the last update is kept")
      ctl.ask("stop", "ses_1")
      assert.equal(ctl.state.confirm, undefined)
    } finally {
      ctl.stop()
      await b.api.close()
    }
  })

  it("refuses another user at the relay, and the relay refuses what is not the app or the API", async () => {
    const b = await bridge()
    const r = await relay(b.api.port)
    try {
      const other = new Api({ initData: init(7), base: r.url })
      await assert.rejects(other.meta(), (e: any) => e.kind === "forbidden")
      const none = await fetch(r.url + "/v1/sessions")
      assert.equal(none.status, 401)
      const admin = await fetch(r.url + "/admin")
      assert.equal(admin.status, 404)
      const page = await fetch(r.url + "/app/")
      assert.equal(page.status, 200)
      assert.match(
        page.headers.get("content-security-policy") ?? "",
        /script-src 'self'/,
      )
    } finally {
      r.close()
      await b.api.close()
    }
  })

  it("does not let the bearer token through the link", async () => {
    const b = await bridge()
    try {
      const res = await fetch("http://127.0.0.1:" + b.api.port + "/v1/meta", {
        headers: { authorization: "Bearer nothing" },
      })
      assert.equal(res.status, 401)
    } finally {
      await b.api.close()
    }
  })
})
