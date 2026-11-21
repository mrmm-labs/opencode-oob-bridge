import assert from "node:assert/strict"
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "node:test"

import { fakeNtfy } from "./connectors/fake-ntfy.test-util.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { fakeServer, noService } from "./fake-server.test-util.ts"
import plugin from "./index.ts"
import { formRelay } from "./remote.ts"
import { RPC_ID, type Snapshot } from "./rpc.ts"
import { startServer, timings } from "./server.ts"
import { TimedOut, withTimeout } from "./util.ts"

async function withEnv<T>(
  vars: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = Object.fromEntries(
    Object.keys(vars).map((k) => [k, process.env[k]]),
  )
  Object.assign(process.env, vars)
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(prev))
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
  }
}

// A test that fails before it stops its instances must not leave them in the process hub.
const running: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const stop of running.splice(0)) await stop().catch(() => {})
})

async function setup() {
  const n = await fakeNtfy()
  const dir = await mkdtemp(join(tmpdir(), "oobb-server-"))
  const cfg = join(dir, "c.jsonc")
  await writeFile(
    cfg,
    JSON.stringify({
      channels: { ntfy: { server: n.url, topics: { out: "o", in: "i" } } },
    }),
  )
  const env = {
    OPENCODE_OOB_BRIDGE_CONFIG: cfg,
    OPENCODE_OOB_BRIDGE_DATA: dir,
  }
  return {
    n,
    dir,
    env,
    // Never the service of the machine the tests run on: no service unless a test names one.
    load: async (o: Parameters<typeof startServer>[1] = {}) => {
      const server = fakeServer()
      const stop = await withEnv(env, () =>
        startServer(server.ctx, { service: noService, ...o }),
      )
      if (stop) running.push(stop)
      return { server, stop }
    },
  }
}

const status = async (s: ReturnType<typeof fakeServer>, tui = "t") =>
  (
    (await s.call({
      method: "status",
      input: { tui, inputAt: Date.now() },
    })) as { output: Snapshot }
  ).output

describe("the server half", () => {
  it("is a server plugin that starts the bridge", () => {
    assert.equal(plugin.id, "oob-bridge")
    assert.equal(typeof plugin.setup, "function")
    assert.equal(RPC_ID, "oob-bridge")
  })

  it("does nothing without a config file", async () => {
    const server = fakeServer()
    const stop = await withEnv(
      { OPENCODE_OOB_BRIDGE_CONFIG: "/nonexistent/oob-bridge.jsonc" },
      () => startServer(server.ctx, { service: noService }),
    )
    assert.equal(stop, undefined)
    assert.equal(server.registrations(), 0)
  })

  it("reports the owner, the channels and the windows through the RPC", async () => {
    const t = await setup()
    const { server, stop } = await t.load()
    assert.equal(server.registrations(), 1)
    const s = await status(server, "w1")
    assert.equal(s.owner.pid, process.pid)
    assert.equal(s.afk.tuis, 1)
    assert.equal(s.afk.away, false)
    assert.deepEqual(
      s.channels.map((c) => [c.id, c.enabled]),
      [["ntfy", true]],
    )
    assert.equal((await status(server, "w2")).afk.tuis, 2)
    await stop!()
    assert.equal(server.disposed(), 1)
    await t.n.close()
  })

  describe("a question with no TUI attached", () => {
    const form = {
      form: {
        id: "frm_1",
        sessionID: "root",
        metadata: { kind: "question" },
        fields: [
          {
            key: "q0",
            type: "string",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      },
    }
    const svc = (ok: boolean, fail?: string) => {
      const replies: Array<Record<string, unknown>> = []
      return {
        replies,
        service: {
          ready: async () => ok,
          reply: async (r: Record<string, unknown>) => {
            if (fail) throw new Error(fail)
            replies.push(r)
          },
        },
      }
    }

    it("is posted with buttons and answered through the service, with no window involved", async () => {
      const t = await setup()
      const s = svc(true)
      const { server, stop } = await t.load({ service: s.service })
      await server.call({
        method: "op",
        input: { op: "afk", args: { mode: "on" } },
      })
      const relayed: unknown[] = []
      server.onTui("rpc.oob-bridge.form", (e) => relayed.push(e.data))
      server.emit("form.created", form)
      const pub = await t.n.waitFor(() => t.n.published[0])
      const actions = pub.body.actions as Array<{ body: string }>
      assert.ok(actions?.length >= 1, "buttons")
      assert.ok(!/no OpenCode window/i.test(JSON.stringify(pub.body)))
      await t.n.waitFor(() => t.n.subscribes.length > 0)
      t.n.send("r1", actions[0].body)
      const reply = await t.n.waitFor(() => s.replies[0])
      assert.equal(reply.sessionID, "root")
      assert.equal(reply.formID, "frm_1")
      assert.deepEqual(reply.answer, { q0: "Yes" })
      assert.deepEqual(relayed, [], "no window was asked")
      await stop!()
      await t.n.close()
    })

    it("falls back to the 'answer at the Mac' note only when the service cannot reply", async () => {
      const t = await setup()
      const { server, stop } = await t.load({ service: svc(false).service })
      await server.call({
        method: "op",
        input: { op: "afk", args: { mode: "on" } },
      })
      server.emit("form.created", form)
      const pub = await t.n.waitFor(() => t.n.published[0])
      assert.ok(/no OpenCode window/i.test(JSON.stringify(pub.body)))
      assert.ok(!(pub.body.actions as unknown[] | undefined)?.length)
      await stop!()
      await t.n.close()
    })

    it("relays through a window when the service refuses the reply and one is attached", async () => {
      const t = await setup()
      const s = svc(true, "503")
      const { server, stop } = await t.load({ service: s.service })
      const relayed: Array<Record<string, unknown>> = []
      server.onTui("rpc.oob-bridge.form", (e) => relayed.push(e.data as never))
      await server.call({
        method: "op",
        input: { op: "afk", args: { mode: "on" } },
      })
      await status(server, "win")
      server.emit("form.created", form)
      const pub = await t.n.waitFor(() => t.n.published[0])
      await t.n.waitFor(() => t.n.subscribes.length > 0)
      t.n.send("r1", (pub.body.actions as Array<{ body: string }>)[0].body)
      await t.n.waitFor(() => relayed[0])
      assert.equal(relayed[0].to, "win")
      assert.equal(relayed[0].formID, "frm_1")
      await stop!()
      await t.n.close()
    })
  })

  it("offers the oob_send_file tool in each instance, and says why it cannot send", async () => {
    const t = await setup()
    const { server, stop } = await t.load()
    assert.deepEqual(
      server.agentTools.map((x) => x.name),
      ["oob_send_file"],
    )
    const out = await server.agentTools[0].execute(
      { path: "/nope" },
      { sessionID: "root" },
    )
    assert.match(out.content ?? "", /^Error: /)
    assert.equal(out.metadata?.error, true)
    await stop!()
    assert.equal(server.toolsDisposed(), 1)
  })

  it("answers with JSON values only: a connector status holding undefined is not refused by the host", async () => {
    const tg = await fakeTelegram()
    const dir = await mkdtemp(join(tmpdir(), "oobb-json-"))
    const cfg = join(dir, "c.jsonc")
    await writeFile(
      cfg,
      JSON.stringify({
        channels: {
          telegram: {
            token: { env: "OOBB_JSON_TOKEN" },
            chatId: 7,
            apiBase: tg.url,
          },
        },
      }),
    )
    const server = fakeServer()
    const stop = await withEnv(
      {
        OPENCODE_OOB_BRIDGE_CONFIG: cfg,
        OPENCODE_OOB_BRIDGE_DATA: dir,
        OOBB_JSON_TOKEN: "123456:TESTTOKEN",
      },
      () => startServer(server.ctx, { service: noService }),
    )
    if (stop) running.push(stop)
    const s = await status(server)
    assert.deepEqual(
      s.channels.map((c) => c.id),
      ["telegram"],
    )
    await stop!()
    await tg.close()
  })

  it("two instances in one process: one poller, and both answer", async () => {
    const t = await setup()
    const a = await t.load()
    const b = await t.load()
    // The host keeps its RPC registry per location, so each instance has to register.
    assert.equal(a.server.registrations(), 1)
    assert.equal(b.server.registrations(), 1)
    await t.n.waitFor(() => t.n.subscribes.length > 0)
    const [sa, sb] = [
      await status(a.server, "wa"),
      await status(b.server, "wb"),
    ]
    assert.equal(sa.owner.pid, process.pid)
    assert.equal(sb.owner.pid, process.pid)
    assert.equal(sb.afk.tuis, 2, "one controller behind both")
    const c = await t.load()
    assert.equal((await status(c.server, "wc")).afk.tuis, 3)
    assert.equal(
      t.n.subscribes.length,
      1,
      "one subscription, not one per instance",
    )
    await c.stop!()
    await b.stop!()
    await a.stop!()
    await t.n.close()
  })

  it("an instance that is not the owner still reaches the bridge, and gets form replies to relay", async () => {
    const t = await setup()
    const a = await t.load()
    const b = await t.load()
    const relayed: Array<Record<string, unknown>> = []
    b.server.onTui("rpc.oob-bridge.form", (e) => relayed.push(e.data as never))
    await b.server.call({
      method: "op",
      input: { op: "afk", args: { mode: "on" } },
    })
    await status(b.server, "win")
    a.server.emit("form.created", {
      form: {
        id: "frm_1",
        sessionID: "root",
        metadata: { kind: "question" },
        fields: [{ key: "q0", type: "string", options: [{ label: "Yes" }] }],
      },
    })
    const pub = await t.n.waitFor(() => t.n.published[0])
    await t.n.waitFor(() => t.n.subscribes.length > 0)
    t.n.send("r1", (pub.body.actions as Array<{ body: string }>)[0].body)
    await t.n.waitFor(() => relayed[0])
    assert.equal(relayed[0].to, "win")
    assert.equal(relayed[0].formID, "frm_1")
    const done = (await b.server.call({
      method: "formDone",
      input: { token: relayed[0].token, ok: true },
    })) as { output: { ok: boolean } }
    assert.equal(done.output.ok, true)
    await b.stop!()
    await a.stop!()
    await t.n.close()
  })

  it("a window acts once on a form reply the server emitted through several locations", async () => {
    const calls: string[] = []
    const relay = formRelay({
      id: "w",
      call: async (m, i) => void calls.push(m + ":" + i.ok),
      reply: async () => void calls.push("reply"),
    })
    const e = {
      data: { to: "w", token: "t1", sessionID: "s", formID: "f", answer: {} },
    }
    relay(e)
    relay(e)
    relay({ data: { ...e.data, to: "other", token: "t2" } })
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(calls, ["reply", "formDone:true"])
  })

  it("when the owner instance goes, another takes over and keeps serving", async () => {
    const t = await setup()
    const a = await t.load()
    const b = await t.load()
    await t.n.waitFor(() => t.n.subscribes.length > 0)
    await a.stop!()
    assert.equal(a.server.disposed(), 1)
    await b.server.call({
      method: "op",
      input: { op: "afk", args: { mode: "on" } },
    })
    await assert.rejects(status(a.server), /unavailable/)
    assert.equal((await status(b.server)).owner.pid, process.pid)
    // The new owner reads the events of its own location.
    b.server.emit("form.created", {
      form: {
        id: "frm_2",
        sessionID: "root",
        metadata: { kind: "question" },
        fields: [{ key: "q0", type: "string", options: [{ label: "Yes" }] }],
      },
    })
    await t.n.waitFor(() => t.n.published[0])
    await t.n.waitFor(() => t.n.subscribes.length > 1)
    await b.stop!()
    // Nothing is left: the lock is free for the next process.
    const d = await t.load()
    assert.equal(d.server.registrations(), 1)
    assert.equal((await status(d.server)).owner.pid, process.pid)
    await d.stop!()
    await t.n.close()
  })

  it("another process owns the lock: every instance still answers, and the standby is logged once", async () => {
    const t = await setup()
    const logFile = join(t.dir, "test.log")
    await writeFile(
      join(t.dir, "owner.lock"),
      JSON.stringify({ pid: process.ppid, startedAt: 1 }),
    )
    const env = { ...t.env, OPENCODE_OOB_BRIDGE_LOG: logFile }
    const load = async (standbyMs?: number) => {
      const server = fakeServer()
      const stop = await withEnv(env, () =>
        startServer(server.ctx, { standbyMs, service: noService }),
      )
      return { server, stop }
    }
    const a = await load(40)
    const b = await load(40)
    const c = await load(40)
    assert.equal(
      a.server.registrations() +
        b.server.registrations() +
        c.server.registrations(),
      3,
    )
    await assert.rejects(status(b.server), /another OpenCode process/)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(t.n.subscribes.length, 0, "no poller here")
    const standby = (await readFile(logFile, "utf8"))
      .split("\n")
      .filter((l) => l.includes("server_standby"))
    assert.equal(standby.length, 1)
    // The other process goes away: a retry here takes the lock.
    await unlink(join(t.dir, "owner.lock"))
    await t.n.waitFor(() => t.n.subscribes.length > 0)
    assert.equal((await status(c.server)).owner.pid, process.pid)
    await c.stop!()
    await b.stop!()
    await a.stop!()
    await t.n.close()
  })

  it("restarts the bridge without the server: the RPC keeps answering", async () => {
    const t = await setup()
    const { server, stop } = await t.load()
    const before = await status(server)
    const out = (
      (await server.call({
        method: "op",
        input: { op: "restart", args: {} },
      })) as { output: { ok: boolean } }
    ).output
    assert.equal(out.ok, true)
    const after = await status(server)
    assert.equal(after.owner.pid, before.owner.pid)
    assert.equal(server.registrations(), 1)
    assert.equal(server.disposed(), 0)
    await stop!()
    await t.n.close()
  })

  it("a session the host never answers for does not stop the events of the others", async () => {
    const t = await setup()
    const { server, stop } = await t.load()
    server.hang.add("stuck")
    server.emit("session.execution.started", { sessionID: "stuck" })
    server.emit("session.text.delta", {
      sessionID: "stuck",
      assistantMessageID: "m",
      ordinal: 0,
      delta: "x",
    })
    server.emit("form.created", {
      form: {
        id: "frm_2",
        sessionID: "root",
        metadata: { kind: "question" },
        fields: [{ key: "q0", type: "string", options: [{ label: "Yes" }] }],
      },
    })
    const pub = await t.n.waitFor(() => t.n.published[0])
    assert.match(String(pub.body.message), /Answer this at the Mac/)
    await stop!()
    await t.n.close()
  })

  it("goes on without a host answer after the time limit", async () => {
    const t = await setup()
    const keep = timings.sessionGetMs
    timings.sessionGetMs = 50
    try {
      const { server, stop } = await t.load()
      server.hang.add("root")
      server.emit("form.created", {
        form: {
          id: "frm_3",
          sessionID: "root",
          metadata: { kind: "question" },
          fields: [{ key: "q0", type: "string", options: [{ label: "Yes" }] }],
        },
      })
      await t.n.waitFor(() => t.n.published[0])
      await stop!()
    } finally {
      timings.sessionGetMs = keep
    }
    await t.n.close()
  })

  it("withTimeout rejects a call that never returns and passes one that does", async () => {
    await assert.rejects(
      withTimeout(new Promise(() => {}), 20, "host"),
      TimedOut,
    )
    assert.equal(await withTimeout(Promise.resolve(7), 20, "host"), 7)
  })

  it("says why a form answer cannot be made when no window is attached", async () => {
    const t = await setup()
    const { server, stop } = await t.load()
    server.emit("form.created", {
      form: {
        id: "frm_1",
        sessionID: "root",
        metadata: { kind: "question" },
        fields: [{ key: "q0", type: "string", options: [{ label: "Yes" }] }],
      },
    })
    // No window to make the reply: the push says so and has no buttons, and the bridge stays up.
    const pub = await t.n.waitFor(() => t.n.published[0])
    assert.equal(pub.body.actions, undefined)
    assert.match(String(pub.body.message), /Answer this at the Mac/)
    assert.equal(server.prompts.length, 0)
    assert.equal((await status(server)).owner.pid, process.pid)
    await stop!()
    await t.n.close()
  })
})
