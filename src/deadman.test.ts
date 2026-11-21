import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "node:test"

import { fakeNtfy } from "./connectors/fake-ntfy.test-util.ts"
import {
  Deadman,
  jsonOnly,
  selfCheck,
  urlProblem,
  type CheckInput,
  type Heartbeat,
} from "./deadman.ts"
import { Receiver } from "./deadman.test-util.ts"
import { fakeServer, noService } from "./fake-server.test-util.ts"
import { startServer } from "./server.ts"

const up = async () => ({ state: "up" as const, reasons: [], channels: {} })

describe("the URL rule", () => {
  it("accepts https and loopback http only", () => {
    assert.equal(urlProblem("https://example.com/beat"), undefined)
    assert.equal(urlProblem("http://127.0.0.1:8080/beat"), undefined)
    assert.equal(urlProblem("http://localhost/beat"), undefined)
    assert.equal(urlProblem("http://[::1]:9/beat"), undefined)
    assert.ok(urlProblem("http://example.com/beat"))
    assert.ok(urlProblem("ftp://example.com"))
    assert.ok(urlProblem("nope"))
  })
})

describe("the heartbeat", () => {
  const beats: Array<{ auth: string; body: Heartbeat }> = []
  const fetcher = (async (_u: string, init: RequestInit) => {
    beats.push({
      auth: (init.headers as Record<string, string>).authorization,
      body: JSON.parse(String(init.body)) as Heartbeat,
    })
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch

  it("carries only the listed fields, with a bearer token", async () => {
    beats.length = 0
    const dm = new Deadman({
      url: "https://x.example/beat",
      token: "tok",
      intervalMs: 1000,
      version: "1.2.3",
      check: async () => ({ state: "up", reasons: [], channels: { tg: true } }),
      fetch: fetcher,
    })
    await dm.beat()
    assert.equal(beats[0].auth, "Bearer tok")
    assert.deepEqual(Object.keys(beats[0].body).sort(), [
      "at",
      "channels",
      "id",
      "pid",
      "reasons",
      "seq",
      "state",
      "v",
      "version",
    ])
    assert.equal(beats[0].body.state, "up")
    assert.deepEqual(beats[0].body.channels, { tg: true })
  })

  it("beats on an interval, then says stopping", async () => {
    beats.length = 0
    const dm = new Deadman({
      url: "https://x.example/beat",
      token: "t",
      intervalMs: 20,
      version: "1",
      check: up,
      fetch: fetcher,
    })
    dm.start()
    await new Promise((r) => setTimeout(r, 110))
    await dm.stop()
    const states = beats.map((b) => b.body.state)
    assert.ok(states.length >= 3, states.join())
    assert.equal(states.at(-1), "stopping")
    assert.deepEqual(
      beats.map((b) => b.body.seq),
      beats.map((_, i) => i + 1),
    )
    assert.equal(new Set(beats.map((b) => b.body.id)).size, 1)
  })

  it("a check that throws gives degraded with check_failed", async () => {
    beats.length = 0
    const dm = new Deadman({
      url: "https://x.example/beat",
      token: "t",
      intervalMs: 1000,
      version: "1",
      check: async () => {
        throw new Error("boom")
      },
      fetch: fetcher,
    })
    await dm.beat()
    assert.equal(beats[0].body.state, "degraded")
    assert.deepEqual(beats[0].body.reasons, ["check_failed"])
  })

  it("an unreachable or hanging receiver never rejects or queues beats", async () => {
    let calls = 0
    const dm = new Deadman({
      url: "https://x.example/beat",
      token: "t",
      intervalMs: 1000,
      version: "1",
      check: up,
      fetch: (async () => {
        calls++
        throw new TypeError("fetch failed")
      }) as unknown as typeof fetch,
    })
    await dm.beat()
    await dm.beat()
    assert.equal(calls, 2)
    let slow = 0
    const hang = new Deadman({
      url: "https://x.example/beat",
      token: "t",
      intervalMs: 1000,
      version: "1",
      check: up,
      fetch: ((_u: string, init: RequestInit) => {
        slow++
        return new Promise((_r, rej) =>
          init.signal?.addEventListener("abort", () => rej(new Error("x"))),
        )
      }) as unknown as typeof fetch,
    })
    const first = hang.beat(undefined, 60)
    await hang.beat() // skipped: the first is still in flight
    await first
    assert.equal(slow, 1)
  })
})

describe("the self-check", () => {
  const ok = (over: Partial<CheckInput> = {}): CheckInput => ({
    snapshot: () => ({ v: 1, a: [1, "x", null] }),
    rpcRegistered: () => true,
    lockHeld: async () => true,
    channels: () => [{ id: "tg", enabled: true, connected: true }],
    ...over,
  })

  it("is up when everything holds", async () => {
    assert.deepEqual(await selfCheck(ok()), {
      state: "up",
      reasons: [],
      channels: { tg: true },
    })
  })

  it("flags a snapshot with an undefined key", async () => {
    const h = await selfCheck(ok({ snapshot: () => ({ a: 1, b: undefined }) }))
    assert.equal(h.state, "degraded")
    assert.deepEqual(h.reasons, ["snapshot_invalid"])
    assert.equal(jsonOnly({ a: { b: [1, undefined] } }), false)
    assert.equal(jsonOnly({ a: Number.NaN }), false)
  })

  it("flags a snapshot that throws", async () => {
    const h = await selfCheck(
      ok({
        snapshot: () => {
          throw new Error("x")
        },
      }),
    )
    assert.deepEqual(h.reasons, ["snapshot_invalid"])
  })

  it("flags a missing RPC and a lost lock", async () => {
    const h = await selfCheck(
      ok({ rpcRegistered: () => false, lockHeld: async () => false }),
    )
    assert.deepEqual(h.reasons, ["rpc_missing", "lock_lost"])
  })

  it("flags a channel that is down, and ignores a disabled one", async () => {
    const h = await selfCheck(
      ok({
        channels: () => [
          { id: "tg", enabled: true, connected: false },
          { id: "ntfy", enabled: false, connected: false },
          { id: "other", enabled: true },
        ],
      }),
    )
    assert.deepEqual(h.reasons, ["channel_down:tg"])
    assert.deepEqual(h.channels, { tg: false, other: true })
  })

  it("is check_failed when the check itself throws", async () => {
    const h = await selfCheck(
      ok({
        channels: () => {
          throw new Error("x")
        },
      }),
    )
    assert.deepEqual(h.reasons, ["check_failed"])
  })
})

describe("the receiver contract", () => {
  const MIN = 60_000
  function rig() {
    let t = 1_000_000
    const sent: string[] = []
    const calls: string[] = []
    const telegram = {
      sendMessage: (text: string) => {
        calls.push("sendMessage")
        sent.push(text)
      },
      getUpdates: () => calls.push("getUpdates"),
      setWebhook: () => calls.push("setWebhook"),
    }
    const r = new Receiver({ telegram, now: () => t })
    const beat = (state: Heartbeat["state"], reasons: string[] = []) =>
      r.beat({
        v: 1,
        id: "i",
        seq: 1,
        at: t,
        state,
        reasons,
        version: "1",
        pid: 1,
        channels: {},
      })
    return { r, sent, calls, beat, advance: (ms: number) => (t += ms) }
  }

  it("alerts once on silence, reminds every 30 minutes, and says when it recovers", () => {
    const x = rig()
    x.beat("up")
    x.advance(60_000)
    x.r.tick()
    assert.equal(x.sent.length, 0)
    x.advance(40_000)
    x.r.tick()
    x.r.tick()
    assert.equal(x.sent.length, 1)
    x.advance(29 * MIN)
    x.r.tick()
    assert.equal(x.sent.length, 1)
    x.advance(2 * MIN)
    x.r.tick()
    assert.equal(x.sent.length, 2)
    x.beat("up")
    assert.equal(x.sent.length, 3)
    assert.match(x.sent[2], /Recovered/)
    x.beat("up")
    assert.equal(x.sent.length, 3)
  })

  it("waits five minutes after stopping", () => {
    const x = rig()
    x.beat("stopping")
    x.advance(4 * MIN)
    x.r.tick()
    assert.equal(x.sent.length, 0)
    x.advance(2 * MIN)
    x.r.tick()
    assert.equal(x.sent.length, 1)
  })

  it("alerts on two degraded beats in a row and names the reason", () => {
    const x = rig()
    x.beat("degraded", ["snapshot_invalid"])
    assert.equal(x.sent.length, 0)
    x.beat("up")
    x.beat("degraded", ["snapshot_invalid"])
    assert.equal(x.sent.length, 0, "a beat in between resets the streak")
    x.beat("degraded", ["snapshot_invalid"])
    assert.equal(x.sent.length, 1)
    assert.match(x.sent[0], /snapshot_invalid/)
  })

  it("uses sendMessage only", () => {
    const x = rig()
    x.beat("degraded", ["lock_lost"])
    x.beat("degraded", ["lock_lost"])
    x.advance(100 * MIN)
    x.r.tick()
    x.beat("up")
    assert.ok(x.calls.length >= 3)
    assert.deepEqual([...new Set(x.calls)], ["sendMessage"])
  })
})

describe("the server heartbeat", () => {
  const closers: Array<() => Promise<void>> = []
  const stops: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const s of stops.splice(0)) await s().catch(() => {})
    for (const c of closers.splice(0)) await c().catch(() => {})
  })

  async function receiver() {
    const got: Array<{ auth?: string; body: Heartbeat }> = []
    const server: Server = createServer((req, res) => {
      let s = ""
      req.on("data", (c) => (s += c))
      req.on("end", () => {
        got.push({ auth: req.headers.authorization, body: JSON.parse(s) })
        res.writeHead(204).end()
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    closers.push(() =>
      new Promise((r) => server.close(() => r())).then(() => {}),
    )
    const port = (server.address() as { port: number }).port
    return { got, url: `http://127.0.0.1:${port}/beat`, server }
  }

  async function boot(deadman: unknown) {
    const n = await fakeNtfy()
    closers.push(() => n.close())
    const dir = await mkdtemp(join(tmpdir(), "oobb-deadman-"))
    const cfg = join(dir, "c.jsonc")
    await writeFile(
      cfg,
      JSON.stringify({
        channels: { ntfy: { server: n.url, topics: { out: "o", in: "i" } } },
        deadman,
      }),
    )
    const env = {
      OPENCODE_OOB_BRIDGE_CONFIG: cfg,
      OPENCODE_OOB_BRIDGE_DATA: dir,
      OOB_DEADMAN_TOKEN: "hb-secret-token",
    }
    const prev = Object.fromEntries(
      Object.keys(env).map((k) => [k, process.env[k]]),
    )
    Object.assign(process.env, env)
    const load = async () => {
      const server = fakeServer()
      const stop = await startServer(server.ctx, { service: noService })
      if (stop) stops.push(stop)
      return { server, stop: stop! }
    }
    closers.push(async () => {
      for (const [k, v] of Object.entries(prev))
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
    })
    return { load, n }
  }

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it("sends one stream from two instances, then stopping and up across a restart", async () => {
    const rx = await receiver()
    const t = await boot({
      url: rx.url,
      token: { env: "OOB_DEADMAN_TOKEN" },
      intervalSeconds: 1,
    })
    const a = await t.load()
    await t.load()
    const end = Date.now() + 10_000
    while (rx.got.length < 2 && Date.now() < end) await wait(50)
    assert.ok(rx.got.length >= 2, "beats arrive")
    assert.equal(new Set(rx.got.map((g) => g.body.id)).size, 1, "one stream")
    assert.equal(rx.got[0].auth, "Bearer hb-secret-token")
    assert.equal(rx.got[0].body.state, "up")
    const before = rx.got.length
    await a.server.call({ method: "op", input: { op: "restart" } })
    const after = rx.got.slice(before)
    assert.equal(after[0].body.state, "stopping")
    await wait(200)
    const last = rx.got.at(-1)!
    assert.equal(last.body.state, "up")
    assert.notEqual(
      last.body.id,
      rx.got[0].body.id,
      "a new start is a new stream",
    )
  })

  it("sends nothing without a URL, and refuses plain http to a public host", async () => {
    const rx = await receiver()
    const none = await boot({ intervalSeconds: 1 })
    await none.load()
    const plain = await boot({
      url: "http://example.com/beat",
      token: { env: "OOB_DEADMAN_TOKEN" },
      intervalSeconds: 1,
    })
    await plain.load()
    await wait(1300)
    assert.equal(rx.got.length, 0)
  })

  it("leaves status answering when the receiver is down", async () => {
    const rx = await receiver()
    await new Promise<void>((r) => rx.server.close(() => r()))
    const t = await boot({
      url: rx.url,
      token: { env: "OOB_DEADMAN_TOKEN" },
      intervalSeconds: 1,
    })
    const a = await t.load()
    await wait(1200)
    const res = (await a.server.call({
      method: "status",
      input: { tui: "t", inputAt: Date.now() },
    })) as { output: { owner: { pid: number } } }
    assert.equal(res.output.owner.pid, process.pid)
  })
})
