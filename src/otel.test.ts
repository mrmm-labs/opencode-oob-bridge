import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { Bridge, type BridgeEvent } from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import type { Connector, Inbound, Outcome } from "./connectors/types.ts"
import { SCOPE, SERVICE, Telemetry, resolveOtel, traceIdFor } from "./otel.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"

type Body = {
  resourceSpans?: Array<{
    resource: { attributes: Array<{ key: string; value: unknown }> }
    scopeSpans: Array<{
      scope: { name: string }
      spans: Array<Record<string, any>>
    }>
  }>
  resourceMetrics?: Array<{
    scopeMetrics: Array<{ metrics: Array<Record<string, any>> }>
  }>
}

/** A collector that records every export. */
function collector() {
  const posts: Array<{
    url: string
    headers: Record<string, string>
    body: Body
  }> = []
  const post = async (url: string, init: RequestInit) => {
    posts.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    })
    return new Response("{}", { status: 200 })
  }
  const spans = () =>
    posts.flatMap((p) =>
      (p.body.resourceSpans ?? []).flatMap((r) =>
        r.scopeSpans.flatMap((s) => s.spans),
      ),
    )
  const metrics = () =>
    posts.flatMap((p) =>
      (p.body.resourceMetrics ?? []).flatMap((r) =>
        r.scopeMetrics.flatMap((s) => s.metrics),
      ),
    )
  /** Every attribute value exported, as strings. */
  const values = (): string[] => {
    const out: string[] = []
    const walk = (v: unknown) => {
      if (Array.isArray(v)) return v.forEach(walk)
      if (typeof v !== "object" || v === null) return
      const o = v as Record<string, unknown>
      if (Array.isArray(o.attributes))
        for (const a of o.attributes as Array<{
          value: Record<string, unknown>
        }>)
          out.push(...Object.values(a.value).map(String))
      Object.values(o).forEach(walk)
    }
    walk(posts.map((p) => p.body))
    return out
  }
  return {
    posts,
    post,
    spans,
    metrics,
    values,
    all: () => JSON.stringify(posts),
  }
}

const target = {
  endpoint: "http://collector.example:4318/",
  headers: { "x-key": "k" },
}

describe("telemetry encoding", () => {
  it("posts OTLP/JSON traces and metrics with the service and scope", async () => {
    const c = collector()
    const t = new Telemetry(target, c.post, 60_000)
    const parent = t.begin("oob.push", {
      session: "root",
      attrs: { "push.kind": "question" },
    })
    t.begin("oob.send", {
      session: "root",
      parent: parent.id,
      attrs: { "connector.type": "x" },
    }).end({ ok: false, http_status: 500 }, "send-failed")
    parent.end()
    t.count("oob.pushes", { "connector.type": "x" })
    t.count("oob.pushes", { "connector.type": "x" })
    t.record("oob.answer.latency_ms", { answered_by: "phone" }, 1500)
    t.gauge("oob.pending", {}, 3)
    await t.flush()

    assert.deepEqual(c.posts.map((p) => p.url).sort(), [
      "http://collector.example:4318/v1/metrics",
      "http://collector.example:4318/v1/traces",
    ])
    assert.equal(c.posts[0].headers["x-key"], "k")
    assert.equal(c.posts[0].headers["content-type"], "application/json")

    const rs = c.posts.find((p) => p.body.resourceSpans)!.body.resourceSpans![0]
    assert.deepEqual(rs.resource.attributes, [
      { key: "service.name", value: { stringValue: SERVICE } },
    ])
    assert.equal(SERVICE, "opencode/oob-bridge")
    assert.equal(rs.scopeSpans[0].scope.name, SCOPE)
    const [send, push] = rs.scopeSpans[0].spans
    assert.equal(send.name, "oob.send")
    assert.equal(send.parentSpanId, push.spanId)
    assert.equal(send.traceId, push.traceId)
    assert.match(send.traceId, /^[0-9a-f]{32}$/)
    assert.match(send.spanId, /^[0-9a-f]{16}$/)
    assert.deepEqual(send.status, { code: 2, message: "send-failed" })
    assert.deepEqual(push.status, { code: 1 })
    assert.ok(BigInt(send.endTimeUnixNano) > BigInt(send.startTimeUnixNano))
    assert.deepEqual(
      send.attributes.find((a: any) => a.key === "http_status").value,
      { intValue: "500" },
    )
    assert.deepEqual(send.attributes.find((a: any) => a.key === "ok").value, {
      boolValue: false,
    })

    const byName = Object.fromEntries(c.metrics().map((m) => [m.name, m]))
    assert.equal(byName["oob.pushes"].sum.isMonotonic, true)
    assert.equal(byName["oob.pushes"].sum.dataPoints[0].asInt, "2")
    assert.equal(byName["oob.pending"].gauge.dataPoints[0].asInt, "3")
    const h = byName["oob.answer.latency_ms"].histogram.dataPoints[0]
    assert.equal(h.count, "1")
    assert.equal(h.sum, 1500)
    assert.equal(h.bucketCounts.length, h.explicitBounds.length + 1)
    await t.dispose()
  })

  it("derives the trace id from the root session like the sibling plugins", () => {
    const want = createHash("sha256")
      .update("ses_example")
      .digest("hex")
      .slice(0, 32)
    assert.equal(traceIdFor("ses_example"), want)
    assert.notEqual(traceIdFor(undefined), traceIdFor(undefined))
    const c = collector()
    const t = new Telemetry(target, c.post, 60_000)
    t.begin("oob.route", { session: "ses_example" }).end()
    return t.flush().then(() => {
      assert.equal(c.spans()[0].traceId, want)
    })
  })

  it("a span whose session is known late still lands in that session's trace", async () => {
    const c = collector()
    const t = new Telemetry(target, c.post, 60_000)
    const s = t.begin("oob.inbound")
    s.setSession("late")
    s.end()
    await t.flush()
    assert.equal(c.spans()[0].traceId, traceIdFor("late"))
  })

  it("drops the oldest spans past the queue bound", async () => {
    const c = collector()
    const t = new Telemetry(target, c.post, 60_000)
    for (let i = 0; i < 2005; i++) t.begin("s", { attrs: { i } }).end()
    await t.flush()
    const spans = c.spans()
    assert.equal(spans.length, 2000)
    assert.equal(
      spans[0].attributes.find((a: any) => a.key === "i").value.intValue,
      "5",
    )
  })

  it("never throws on a failing or refusing collector", async () => {
    const t = new Telemetry(
      target,
      async () => {
        throw new Error("down")
      },
      60_000,
    )
    t.begin("s").end()
    t.count("c")
    await t.flush()
    const u = new Telemetry(
      target,
      async () => new Response("no", { status: 503 }),
      60_000,
    )
    u.begin("s").end()
    await u.flush()
    await u.dispose()
  })

  it("flushes what is queued on dispose", async () => {
    const c = collector()
    const t = new Telemetry(target, c.post, 60_000)
    t.begin("s").end()
    await t.dispose()
    assert.equal(c.spans().length, 1)
  })
})

describe("telemetry is off unless configured", () => {
  it("resolves no target without an endpoint, and sends nothing", async () => {
    assert.equal(resolveOtel(undefined, {}), undefined)
    assert.equal(
      resolveOtel(undefined, { OTEL_EXPORTER_OTLP_ENDPOINT: "nope" }),
      undefined,
    )
    let calls = 0
    const t = new Telemetry(undefined, async () => {
      calls++
      return new Response()
    })
    assert.equal(t.enabled(), false)
    t.begin("s").end()
    t.count("c")
    t.record("h", {}, 1)
    t.gauge("g", {}, 1)
    await t.trace("x", {}, async () => 1)
    await t.flush()
    await t.dispose()
    assert.equal(calls, 0)
  })

  it("uses the config endpoint, else the standard environment variables", () => {
    assert.deepEqual(
      resolveOtel(target, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://env:4318" }),
      target,
    )
    assert.deepEqual(
      resolveOtel(undefined, {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://env:4318",
        OTEL_EXPORTER_OTLP_HEADERS: "a=1, b=x%20y",
      }),
      { endpoint: "http://env:4318", headers: { a: "1", b: "x y" } },
    )
  })

  it("parses otel in the config", () => {
    const base = { server: "https://n.example", topics: { out: "a", in: "b" } }
    assert.equal((parseConfig(base) as Config).otel, undefined)
    assert.deepEqual(
      (
        parseConfig({
          ...base,
          otel: { endpoint: "http://c:4318", headers: { a: "b" } },
        }) as Config
      ).otel,
      { endpoint: "http://c:4318", headers: { a: "b" } },
    )
    for (const otel of [
      { endpoint: "c" },
      { endpoint: "http://c", headers: { a: 1 } },
      5,
    ])
      assert.ok("error" in (parseConfig({ ...base, otel }) as object))
  })
})

const SECRET = "hunter2-sample-secret"
const QUESTION = "Deploy the quarterly-payroll-migration?"
const TITLE = "Confidential merger plan"

function stub(
  id: string,
  type: string,
  rec: { onInbound?: (m: Inbound) => Promise<Outcome | undefined> },
) {
  const ch: Connector = {
    id,
    type,
    capabilities: {
      buttons: true,
      edit: true,
      multiselect: false,
      rich: false,
      threads: false,
      pairing: false,
      inboundPrompt: false,
    },
    enabled: true,
    start: (cb) => void (rec.onInbound = cb),
    hint: () => "tap",
    send: async (p) => {
      if (p.stats) p.stats.httpStatus = 200
      return `${id}-ref`
    },
    update: async () => true,
    status: () => ({}),
  }
  return ch
}

describe("bridge telemetry", () => {
  it("traces routing, pushes, inbound and answers, with latency and pending gauge", async () => {
    const c = collector()
    const tel = new Telemetry(target, c.post, 60_000)
    const cfg = parseConfig({
      channels: {
        ntfy: { server: "https://n.example", topics: { out: "a", in: "b" } },
      },
    }) as Config
    let t = 1_700_000_000_000
    const rec: Parameters<typeof stub>[2] = {}
    const router = new Router(
      cfg,
      async () => true,
      () => t,
    )
    router.setAfk("on", Infinity)
    router.set("root", true)
    const bridge = new Bridge(
      cfg,
      {
        session: async () => ({
          id: "root",
          agent: "a",
          directory: "/w/p",
          title: TITLE,
        }),
        root: () => "root",
        replyForm: async () => {},
      },
      [stub("ntfy", "ntfy", rec)],
      new PendingStore(),
      router,
      () => t,
      tel,
    )
    bridge.start()
    await bridge.onEvent({
      type: "form.created",
      data: {
        form: {
          id: "f1",
          sessionID: "root",
          metadata: { kind: "question" },
          fields: [
            {
              key: "q0",
              type: "string",
              description: `${QUESTION} password=${SECRET}`,
              options: [{ label: "Yes" }, { label: "No" }],
            },
          ],
        },
      },
    } as BridgeEvent)
    const id = (bridge as any).store.list()[0].id as string
    t += 4000
    const base = {
      kind: "answer" as const,
      time: Math.floor(t / 1000),
      from: { connector: "ntfy", chat: "secret-topic" },
    }
    await rec.onInbound!({
      ...base,
      id: "r1",
      pendingId: id,
      text: "1",
      choice: 1,
    })
    await rec.onInbound!({
      ...base,
      id: "r2",
      pendingId: id,
      text: "2",
      choice: 2,
    })
    await rec.onInbound!({ ...base, id: "r3", pendingId: "zzzz", text: "2" })
    await tel.flush()

    const spans = c.spans()
    const names = spans.map((s) => s.name)
    for (const n of [
      "oob.route",
      "oob.push",
      "oob.send",
      "oob.update",
      "oob.inbound",
    ])
      assert.ok(names.includes(n), n)
    const attr = (s: any, k: string) =>
      s.attributes.find((a: any) => a.key === k)?.value
    const route = spans.find((s) => s.name === "oob.route")!
    assert.deepEqual(attr(route, "mode"), { stringValue: "on" })
    assert.deepEqual(attr(route, "reason"), { stringValue: "manual-on" })
    assert.equal(route.traceId, traceIdFor("root"))
    const send = spans.find((s) => s.name === "oob.send")!
    assert.deepEqual(attr(send, "connector.type"), { stringValue: "ntfy" })
    assert.deepEqual(attr(send, "push.kind"), { stringValue: "question" })
    assert.deepEqual(attr(send, "pending.id"), { stringValue: id })
    assert.deepEqual(attr(send, "http_status"), { intValue: "200" })
    const push = spans.find(
      (s) =>
        s.name === "oob.push" &&
        attr(s, "push.kind").stringValue === "question",
    )!
    assert.equal(send.parentSpanId, push.spanId)
    const outcomes = spans
      .filter((s) => s.name === "oob.inbound")
      .map((s) => attr(s, "outcome").stringValue)
    assert.deepEqual(outcomes, ["applied", "duplicate", "expired"])

    const m = c.metrics()
    const sum = (name: string) =>
      m
        .filter((x) => x.name === name)
        .flatMap((x) => x.sum.dataPoints)
        .reduce((n: number, p: any) => n + Number(p.asInt), 0)
    // question + closed update + two notices (duplicate, expired)
    assert.equal(sum("oob.pushes"), 4)
    assert.equal(sum("oob.answers"), 1)
    assert.equal(sum("oob.inbound.rejected"), 2)
    const lat = m.find((x) => x.name === "oob.answer.latency_ms")!.histogram
      .dataPoints[0]
    assert.equal(lat.sum, 4000)
    const gauges = m
      .filter((x) => x.name === "oob.pending")
      .flatMap((x) => x.gauge.dataPoints)
    assert.equal(gauges.at(-1).asInt, "0")

    // No text, titles, answers or secrets anywhere in what was exported.
    const dump = c.all()
    for (const bad of [
      SECRET,
      QUESTION,
      TITLE,
      "quarterly",
      "secret-topic",
      "https://n.example",
    ])
      assert.ok(!dump.includes(bad), `exported ${bad}`)
    for (const bad of ["Yes", "Answered", "n.example", "payroll", "/w/p"])
      assert.ok(
        !c.values().some((v) => v.includes(bad)),
        `attribute has ${bad}`,
      )
    await bridge.stop()
  })

  it("a failed send is an error span and counter", async () => {
    const c = collector()
    const tel = new Telemetry(target, c.post, 60_000)
    const cfg = parseConfig({
      channels: {
        ntfy: { server: "https://n.example", topics: { out: "a", in: "b" } },
      },
    }) as Config
    const router = new Router(cfg, async () => true)
    router.setAfk("on", Infinity)
    router.set("root", true)
    const ch = stub("ntfy", "ntfy", {})
    ch.send = async () => undefined
    const bridge = new Bridge(
      cfg,
      {
        session: async () => ({ id: "root", agent: "a", directory: "/w/p" }),
        root: () => "root",
        replyForm: async () => {},
      },
      [ch],
      new PendingStore(),
      router,
      Date.now,
      tel,
    )
    await bridge.onEvent({
      type: "session.execution.succeeded",
      data: { sessionID: "root" },
    })
    await tel.flush()
    const err = c.spans().find((s) => s.name === "oob.send")!
    assert.equal(err.status.code, 2)
    assert.ok(c.metrics().some((x) => x.name === "oob.push.errors"))
  })
})

describe("connector telemetry carries no identifiers", () => {
  it("telegram: pushes, a rejected chat and a reconnect export no token, chat id, url or text", async () => {
    const c = collector()
    const tel = new Telemetry(target, c.post, 60_000)
    const tg = await fakeTelegram()
    const dir = await mkdtemp(join(tmpdir(), "oobb-otel-"))
    const conn = new TelegramConnector({
      token: async () => tg.token,
      chatId: "4242",
      apiBase: tg.url,
      offsetFile: join(dir, "o.json"),
      backoff: { min: 5, max: 10 },
      pollSeconds: 1,
      tel,
    })
    const ac = new AbortController()
    conn.start(async () => undefined, ac.signal)
    tg.fail("getUpdates", 502)
    tg.message(999, `intruder says ${SECRET}`)
    // Until both have happened, not for a fixed time: a loaded machine is slower.
    const end = Date.now() + 5000
    const seen = () =>
      ["oob.reconnect", "oob.inbound"].every((n) =>
        c.spans().some((s) => s.name === n),
      )
    while (!seen() && Date.now() < end) {
      await tel.flush()
      await new Promise((r) => setTimeout(r, 20))
    }
    await conn.send({ title: TITLE, message: `${QUESTION} ${SECRET}` })
    ac.abort()
    await tel.flush()

    const names = c.spans().map((s) => s.name)
    assert.ok(names.includes("oob.reconnect"))
    const rejected = c.spans().find((s) => s.name === "oob.inbound")!
    assert.ok(rejected, "rejected-chat span")
    assert.ok(
      rejected.attributes.some(
        (a: any) =>
          a.key === "outcome" && a.value.stringValue === "rejected-chat",
      ),
    )
    const names2 = c.metrics().map((m) => m.name)
    assert.ok(names2.includes("oob.reconnects"))
    assert.ok(names2.includes("oob.inbound.rejected"))
    const dump = c.all()
    for (const bad of [
      tg.token,
      "TESTTOKEN",
      "127.0.0.1",
      tg.url,
      SECRET,
      QUESTION,
      TITLE,
      "intruder",
    ])
      assert.ok(!dump.includes(bad), `exported ${bad}`)
    for (const bad of ["4242", "999", "127.0.0.1", "bot"])
      assert.ok(
        !c.values().some((v) => v.includes(bad)),
        `attribute has ${bad}`,
      )
    await tg.close()
  })
})
