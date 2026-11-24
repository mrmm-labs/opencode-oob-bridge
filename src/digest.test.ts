import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { Bridge, type BridgeEvent, type Host } from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import { DigestLog, digestText, KEEP_MS } from "./digest.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"
import { sleep } from "./util.ts"

const CHAT = 4242
const SECRET = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
const day = (d: number, h: number, m = 0) => Date.UTC(2027, 5, d, h, m)

async function rig(
  o: {
    quiet?: Record<string, unknown>
    digest?: unknown
    start?: number
    stuck?: () => Array<{ id: string; label: string; pending: number }>
  } = {},
) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-dig-"))
  const channel = new TelegramConnector({
    token: async () => tg.token,
    chatId: String(CHAT),
    apiBase: tg.url,
    topicsFile: join(dir, "topics.json"),
    offsetFile: join(dir, "offset.json"),
    pollSeconds: 1,
    backoff: { min: 10, max: 40 },
  })
  const cfg = parseConfig({
    channels: { telegram: { token: { env: "X" } } },
    quiet: o.quiet,
    digest: o.digest,
  }) as Config
  assert.ok(!("error" in cfg), JSON.stringify(cfg))
  const clock = { t: o.start ?? day(1, 2) }
  const host: Host = {
    session: async (id) =>
      id === "root"
        ? { id, agent: "coord", directory: "/w/shop", title: "Fix" }
        : undefined,
    root: (id) => id,
    replyForm: async () => {},
    prompt: async () => {},
    interrupt: async () => true,
    busy: () => false,
  }
  const router = new Router(cfg, async () => true)
  router.setAfk("on", Infinity)
  router.set("root", true)
  const store = new PendingStore()
  const log = new DigestLog()
  const bridge = new Bridge(
    cfg,
    host,
    [channel],
    store,
    router,
    () => clock.t,
    undefined,
    log,
  )
  if (o.stuck) bridge.onStuck(o.stuck)
  bridge.start()
  const ev = (type: string, data: Record<string, unknown> = {}) =>
    bridge.onEvent({
      type,
      data: { sessionID: "root", ...data },
    } as unknown as BridgeEvent)
  return {
    tg,
    bridge,
    store,
    log,
    clock,
    ev,
    sends: () => tg.of("sendMessage").map((c) => c.body),
    async turn(ok = true) {
      await ev("session.execution.started")
      await ev(ok ? "session.execution.succeeded" : "session.execution.failed")
    },
    async done() {
      await bridge.stop()
      await tg.close()
    },
  }
}

const quiet = { from: "23:00", to: "07:00", timezone: "UTC" }
const digests = (r: Awaited<ReturnType<typeof rig>>) =>
  r.sends().filter((b) => /Digest/.test(b.text ?? ""))

describe("quiet hours in delivery", () => {
  it("delivers silently inside the window, and normally outside it", async () => {
    const r = await rig({ quiet })
    await r.turn(false)
    await r.tg.waitFor(() => r.sends().find((b) => /ailed/.test(b.text)))
    await sleep(100)
    assert.ok(r.sends().length > 0)
    assert.ok(
      r.sends().every((b) => b.disable_notification === true),
      JSON.stringify(r.sends().map((b) => b.disable_notification)),
    )
    await r.done()
    const day2 = await rig({ quiet, start: day(1, 12) })
    await day2.turn(false)
    await day2.tg.waitFor(() => day2.sends().find((b) => /ailed/.test(b.text)))
    assert.ok(day2.sends().some((b) => b.disable_notification === false))
    await day2.done()
  })

  it("a break-through kind still makes a sound, and the default list is empty", async () => {
    const loud = await rig({ quiet: { ...quiet, breakthrough: ["failed"] } })
    await loud.turn(false)
    await loud.tg.waitFor(() => loud.sends().find((b) => /ailed/.test(b.text)))
    assert.ok(
      loud.sends().some((b) => b.disable_notification === false),
      "the failure notifies",
    )
    await loud.done()
    const quietly = await rig({ quiet })
    await quietly.turn(false)
    await quietly.tg.waitFor(() =>
      quietly.sends().find((b) => /ailed/.test(b.text)),
    )
    assert.ok(quietly.sends().every((b) => b.disable_notification === true))
    await quietly.done()
  })

  it("is off without the setting", async () => {
    const r = await rig()
    await r.turn(false)
    await r.tg.waitFor(() => r.sends().find((b) => /ailed/.test(b.text)))
    assert.ok(r.sends().some((b) => b.disable_notification === false))
    await r.done()
  })
})

describe("the digest", () => {
  it("is sent once at its time, with the three sections", async () => {
    let stuck = [{ id: "root", label: "shop", pending: 2 }]
    const r = await rig({ quiet, digest: true, stuck: () => stuck })
    await r.turn()
    await r.turn()
    await r.turn(false)
    r.store.put({
      id: "q1",
      kind: "question",
      requestID: "x",
      sessionID: "root",
      rootSessionID: "root",
      title: "Which db? " + SECRET,
      askedAt: r.clock.t,
      state: "pending",
    })
    r.clock.t = day(1, 6, 59)
    await r.bridge.digestTick()
    assert.equal(digests(r).length, 0, "not yet")
    r.clock.t = day(1, 7, 0)
    await r.bridge.digestTick()
    const d = await r.tg.waitFor(() => digests(r)[0])
    assert.match(d.text, /Finished \(2\)/)
    assert.match(d.text, /Failed \(1\)/)
    assert.match(d.text, /Waiting on you \(2\)/)
    assert.match(d.text, /question: Which db\?/)
    assert.match(d.text, /stuck: shop \(2 waiting\)/)
    assert.ok(!d.text.includes(SECRET))
    assert.equal(
      d.disable_notification,
      false,
      "the morning message makes a sound",
    )
    await r.bridge.digestTick()
    r.clock.t = day(1, 7, 30)
    await r.bridge.digestTick()
    assert.equal(digests(r).length, 1, "once a day")
    stuck = []
    await r.done()
  })

  it("is not sent when nothing happened, unless digest.empty", async () => {
    const r = await rig({ quiet, digest: true, start: day(1, 8) })
    await r.bridge.digestTick()
    await sleep(100)
    assert.equal(digests(r).length, 0)
    await r.done()
    const e = await rig({ quiet, digest: { empty: true }, start: day(1, 8) })
    await e.bridge.digestTick()
    const d = await e.tg.waitFor(() => digests(e)[0])
    assert.match(d.text, /Nothing to report/)
    await e.done()
  })

  it("does not list a question that was answered before it was sent", async () => {
    const r = await rig({ quiet, digest: true })
    await r.turn()
    r.store.put({
      id: "q1",
      kind: "question",
      requestID: "x",
      sessionID: "root",
      rootSessionID: "root",
      title: "Which db?",
      askedAt: day(1, 3),
      state: "pending",
    })
    r.store.update("q1", { state: "answered", answeredAt: day(1, 6) })
    r.clock.t = day(1, 7, 30)
    await r.bridge.digestTick()
    const d = await r.tg.waitFor(() => digests(r)[0])
    assert.doesNotMatch(d.text, /Waiting/)
    assert.doesNotMatch(d.text, /Which db/)
    await r.done()
  })

  it("/digest sends it now and the next one covers only what follows", async () => {
    const r = await rig({ quiet, digest: true })
    await r.turn()
    const out = await r.bridge.digestNow()
    assert.match(out.text, /Finished \(1\)/)
    r.clock.t = day(1, 7, 0)
    await r.bridge.digestTick()
    await sleep(100)
    assert.equal(digests(r).length, 0, "nothing new since /digest")
    await r.turn(false)
    r.clock.t = day(2, 7, 0)
    await r.bridge.digestTick()
    const d = await r.tg.waitFor(() => digests(r)[0])
    assert.doesNotMatch(d.text, /Finished/)
    assert.match(d.text, /Failed \(1\)/)
    await r.done()
  })

  it("/digest says so when the digest is off", async () => {
    const r = await rig()
    const out = await r.bridge.digestNow()
    assert.equal(out.ok, false)
    assert.match(out.text, /not enabled/)
    await r.done()
  })
})

describe("the records", () => {
  it("are appended, survive a reload, and drop what is older than seven days", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oobb-dlog-"))
    const file = join(dir, "digest.jsonl")
    const now = day(10, 12)
    await writeFile(
      file,
      [
        JSON.stringify({
          k: "finished",
          at: now - KEEP_MS - 1000,
          title: "old",
        }),
        JSON.stringify({ k: "failed", at: now - 1000, title: "new" }),
        "not json",
      ].join("\n") + "\n",
    )
    const log = new DigestLog(file)
    await log.load(now)
    assert.deepEqual(
      log.pending().map((r) => r.title),
      ["new"],
    )
    log.append({ k: "finished", at: now, title: "later" })
    await log.flush()
    const text = await readFile(file, "utf8")
    assert.doesNotMatch(text, /old/)
    assert.match(text, /later/)
    const again = new DigestLog(file)
    await again.load(now)
    assert.equal(again.pending().length, 2)
  })

  it("a missing file is an empty log, not an error", async () => {
    const log = new DigestLog("/nonexistent/dir/digest.jsonl")
    await log.load()
    assert.deepEqual(log.pending(), [])
    assert.equal(log.lastDigest(), 0)
  })

  it("the text groups repeats and leaves out an empty section", () => {
    const t = digestText({
      records: [
        { k: "finished", at: 1, title: "shop · Fix" },
        { k: "finished", at: 2, title: "shop · Fix" },
      ],
      waiting: [],
    })
    assert.equal(t, "✅ Finished (2)\n• shop · Fix ×2")
  })
})
