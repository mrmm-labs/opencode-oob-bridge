import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { flushLog } from "./logger.ts"
import { parseConfig, type Config } from "./config.ts"
import { Telemetry } from "./otel.ts"
import { Traces } from "./trace.ts"

const clock = () => {
  const c = { t: 1_000_000 }
  return { c, now: () => c.t }
}

function capture() {
  const posts: Array<{ path: string; body: any }> = []
  const tel = new Telemetry(
    { endpoint: "http://127.0.0.1:1" },
    async (url, init) => {
      posts.push({
        path: new URL(url).pathname,
        body: JSON.parse(String(init.body)),
      })
      return new Response("{}")
    },
    60_000,
  )
  return { tel, posts }
}

async function withLog<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "oobb-trace-"))
  const file = join(dir, "bridge.log")
  const prev = process.env.OPENCODE_OOB_BRIDGE_LOG
  process.env.OPENCODE_OOB_BRIDGE_LOG = file
  try {
    return await fn(file)
  } finally {
    await flushLog()
    if (prev === undefined) delete process.env.OPENCODE_OOB_BRIDGE_LOG
    else process.env.OPENCODE_OOB_BRIDGE_LOG = prev
  }
}

const lines = async (file: string) =>
  (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>)

describe("a trace of an inbound update", () => {
  it("keeps the path and outcome, lists newest first, and says what is in flight", () => {
    const { c, now } = clock()
    const t = new Traces(now)
    const a = t.start("in", "text", {
      event: "telegram_inbound",
      update_id: 7,
      message_id: 70,
      thread: 6,
    })
    c.t += 40
    t.step("route", { ms: 12 }, a)
    t.step("deliver", { ms: 30 }, a)
    t.finish(a, {
      outcome: "delivered",
      reason: "sent",
      cls: "delivered",
      line: false,
    })
    const b = t.start("in", "command", {
      event: "telegram_inbound",
      update_id: 8,
    })
    c.t += 1000
    const out = t.format(5)
    assert.match(out[0], /← command u8 in flight/)
    assert.match(out[1], /← text u7 m70 t6 delivered \(sent\)/)
    assert.match(out[2], /route 12ms → deliver 30ms/)
    assert.equal(t.recent(1)[0], b)
  })

  it("counts received, delivered, refused and dropped, and remembers the last error", () => {
    const { c, now } = clock()
    const t = new Traces(now)
    for (const cls of [
      "delivered",
      "delivered",
      "refused",
      "dropped",
    ] as const) {
      t.bump("inbound", "received")
      const r = t.start("in", "text", { event: "telegram_inbound" })
      t.finish(r, {
        outcome: cls === "dropped" ? "error" : cls,
        reason: cls === "dropped" ? "boom" : undefined,
        cls,
        line: false,
      })
    }
    c.t += 5000
    const s = t.stats()
    assert.deepEqual(
      [
        s.inbound.received,
        s.inbound.delivered,
        s.inbound.refused,
        s.inbound.dropped,
      ],
      [4, 2, 1, 1],
    )
    assert.match(
      t.statLines(s, now())[0],
      /4 received, 2 delivered, 1 refused, 1 dropped/,
    )
    assert.match(
      t.statLines(s, now())[2],
      /Last error 5s ago: text error: boom/,
    )
  })

  it("counts sends and failures by API call, and tracks the last good poll and send", () => {
    const { now } = clock()
    const t = new Traces(now)
    t.api("getUpdates", { ms: 900, ok: true })
    t.api("sendMessage", { ms: 80, ok: true })
    t.api("editMessageText", { ms: 10_000, ok: false, code: "timeout" })
    t.api("setMessageReaction", { ms: 50, ok: true })
    const s = t.stats()
    assert.deepEqual(s.outbound, { sent: 1, failed: 1 })
    assert.ok(s.pollOkAt && s.sendOkAt)
    assert.match(s.lastError!.what, /editMessageText timeout/)
  })
})

describe("what a trace carries to the next message", () => {
  it("the reply of a session joins the trace of the message that started its turn", async () => {
    const { now } = clock()
    const t = new Traces(now)
    const a = t.start("in", "text", { event: "telegram_inbound", update_id: 1 })
    t.annotate({ session: "ses_x", agent: "build" }, a)
    t.follow("ses_x", a)
    const sent = await t.out("reply", { session: "ses_x" }, async () => "ok")
    assert.equal(sent, "ok")
    const out = t.recent(1)[0]
    assert.equal(out.id, a.id, "same trace id")
    assert.equal(out.parent, a.spanId)
    assert.equal(out.agent, "build")
    assert.equal(out.outcome, "sent")
  })

  it("a failed send is recorded, rethrown and counted", async () => {
    const { now } = clock()
    const t = new Traces(now)
    await assert.rejects(
      t.out("push:question", {}, async () => {
        throw new Error("nope")
      }),
      /nope/,
    )
    assert.equal(t.recent(1)[0].outcome, "failed")
    assert.match(t.stats().lastError!.what, /push:question failed: nope/)
  })

  it("an unlinked send starts a trace of its own", async () => {
    const { now } = clock()
    const t = new Traces(now)
    await t.out("push:notice", { session: "s" }, async () => 1)
    await t.out("push:notice", { session: "s" }, async () => 1)
    const [x, y] = t.recent(2)
    assert.notEqual(x.id, y.id)
  })
})

describe("spans and metrics of a trace", () => {
  it("one trace id covers the update and its steps, with ids and outcome but no text", async () => {
    const { posts, tel } = capture()
    const { now } = clock()
    const t = new Traces(now)
    t.attach(tel)
    const r = t.start("in", "text", {
      event: "telegram_inbound",
      update_id: 11,
      message_id: 110,
      thread: 6,
    })
    t.annotate({ session: "ses_x", agent: "build", state: "sent" }, r)
    t.step("route", { ms: 3 }, r)
    t.finish(r, { outcome: "delivered", cls: "delivered", line: false })
    await tel.flush()
    const spans = posts
      .filter((p) => p.path === "/v1/traces")
      .flatMap((p) => p.body.resourceSpans[0].scopeSpans[0].spans)
    const root = spans.find((s: any) => s.name === "oob.update")
    assert.ok(root)
    assert.equal(root.traceId, r.id)
    const attr = (s: any, k: string) =>
      s.attributes.find((a: any) => a.key === k)?.value
    assert.equal(attr(root, "update_id").intValue, "11")
    assert.equal(attr(root, "session.id").stringValue, "ses_x")
    assert.equal(attr(root, "outcome").stringValue, "delivered")
    const step = spans.find((s: any) => s.name === "oob.step.route")
    assert.equal(step.parentSpanId, root.spanId)
    assert.equal(step.traceId, r.id)
    assert.ok(!JSON.stringify(spans).includes('text":'), "no text attribute")
  })

  it("exports the inbound and outbound counters, the queue depth and the API latency", async () => {
    const { posts, tel } = capture()
    const { now } = clock()
    const t = new Traces(now)
    t.attach(tel)
    t.bump("inbound", "delivered")
    t.setQueue(3)
    t.api("sendMessage", { ms: 40, ok: true })
    t.api("sendMessage", { ms: 40, ok: false, code: 429 })
    t.api("getUpdates", { ms: 1, ok: true })
    await tel.flush()
    const names = posts
      .filter((p) => p.path === "/v1/metrics")
      .flatMap((p) => p.body.resourceMetrics[0].scopeMetrics[0].metrics)
      .map((m: any) => m.name)
    for (const n of [
      "oob.telegram.inbound",
      "oob.telegram.outbound",
      "oob.telegram.queue_depth",
      "oob.telegram.api.ms",
      "oob.telegram.api.errors",
      "oob.telegram.last_poll_ok",
      "oob.telegram.last_send_ok",
    ])
      assert.ok(names.includes(n), n)
  })
})

describe("log.level", () => {
  const run = async (level: "warn" | "info" | "debug") =>
    withLog(async (file) => {
      const { now } = clock()
      const t = new Traces(now)
      t.attach(new Telemetry(undefined), level)
      const ok = t.start("in", "text", {
        event: "telegram_inbound",
        update_id: 1,
      })
      t.step("route", { ms: 2 }, ok)
      t.finish(ok, { outcome: "delivered", cls: "delivered" })
      const bad = t.start("in", "text", {
        event: "telegram_inbound",
        update_id: 2,
      })
      t.finish(bad, { outcome: "error", reason: "boom", cls: "dropped" })
      await flushLog()
      return lines(file)
    })

  it("warn writes failures only", async () => {
    const l = await run("warn")
    assert.deepEqual(
      l.map((x) => x.outcome),
      ["error"],
    )
  })

  it("info writes every outcome, with the trace id, and no steps", async () => {
    const l = await run("info")
    assert.deepEqual(
      l.map((x) => x.outcome),
      ["delivered", "error"],
    )
    assert.ok(l.every((x) => /^[0-9a-f]{32}$/.test(x.trace_id)))
    assert.ok(l.every((x) => x.event === "telegram_inbound"))
  })

  it("debug also writes each step on the same trace id", async () => {
    const l = await run("debug")
    const step = l.find((x) => x.event === "trace_step")
    assert.ok(step)
    assert.equal(
      step.trace_id,
      l.find((x) => x.outcome === "delivered")!.trace_id,
    )
  })
})

describe("the log.level setting", () => {
  const parse = (log: unknown) =>
    parseConfig({ channels: { telegram: { token: { env: "X" } } }, log })

  it("defaults to info and accepts warn, info and debug", () => {
    assert.equal((parse(undefined) as Config).log.level, "info")
    for (const level of ["warn", "info", "debug"])
      assert.equal((parse({ level }) as Config).log.level, level)
  })

  it("refuses anything else, naming the key", () => {
    for (const level of ["trace", 3, ""])
      assert.match((parse({ level }) as { error: string }).error, /log.level/)
    assert.match((parse("x") as { error: string }).error, /log must be/)
  })
})
