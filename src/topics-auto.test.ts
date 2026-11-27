import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { Bridge, type Host, type SessionInfo } from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import { PendingStore, type Pending } from "./pending.ts"
import { Router } from "./routing.ts"

const CHAT = 4242
const MIN = 60_000
const key = (id: string) => CHAT + ":" + id

const live = (id: string, viewed = true): SessionInfo => ({
  id,
  directory: "/w/shop",
  title: id,
  viewed,
})

async function rig(
  o: {
    sessions?: SessionInfo[]
    closeIdle?: boolean
    closeHeadless?: boolean
    pending?: string
    extra?: string[]
  } = {},
) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-auto-"))
  const topicsFile = join(dir, "topics.json")
  const sessions = o.sessions ?? [live("ses_a")]
  await writeFile(
    topicsFile,
    JSON.stringify(
      Object.fromEntries(
        [...sessions.map((s) => s.id), ...(o.extra ?? [])].map((id, i) => [
          key(id),
          { thread: 11 + i, name: id },
        ]),
      ),
    ),
  )
  const clock = { t: Date.now() }
  const now = () => clock.t
  const table = new Map(sessions.map((s) => [s.id, s]))
  const busy = new Set<string>()
  const open = new Set<string>()
  const host: Host = {
    session: async (id) => table.get(id),
    root: (id) => id,
    replyForm: async () => {},
    prompt: async () => {},
    busy: (id) => busy.has(id),
  }
  const channel = new TelegramConnector({
    token: async () => tg.token,
    chatId: String(CHAT),
    apiBase: tg.url,
    topicsFile,
    offsetFile: join(dir, "offset.json"),
    pollSeconds: 1,
    backoff: { min: 10, max: 40 },
    rate: { gapMs: 0, perMinute: 600 },
    now,
    topics: {
      headless: "session",
      ...(o.closeIdle === undefined ? {} : { closeIdle: o.closeIdle }),
      ...(o.closeHeadless === undefined
        ? {}
        : { closeHeadless: o.closeHeadless }),
    },
  })
  const cfg = parseConfig({
    channels: { telegram: { token: { env: "X" } } },
  }) as Config
  const router = new Router(cfg, async () => true)
  router.setAfk("on", Infinity)
  const store = new PendingStore()
  if (o.pending)
    store.put({
      id: "p1",
      kind: "question",
      requestID: "r1",
      sessionID: o.pending,
      rootSessionID: o.pending,
      title: "Q",
      askedAt: Date.now(),
      state: "pending",
    } as Pending)
  const bridge = new Bridge(cfg, host, [channel], store, router, now)
  bridge.topicSettleMs = 2 * MIN
  bridge.onOpenSessions(() => open)
  bridge.start()
  return {
    tg,
    bridge,
    clock,
    busy,
    open,
    closes: () => tg.of("closeForumTopic").map((c) => c.body.message_thread_id),
    reopens: () =>
      tg.of("reopenForumTopic").map((c) => c.body.message_thread_id),
    saved: async () => {
      await new Promise((r) => setTimeout(r, 100))
      return JSON.parse(await readFile(topicsFile, "utf8"))
    },
    async tick(advanceMs: number) {
      clock.t += advanceMs
      await bridge.topicTick()
    },
    async done() {
      await bridge.stop()
      await tg.close()
    },
  }
}

describe("a topic closes when its session is quiet and not open", () => {
  it("not before the settle time, then once", async () => {
    const r = await rig()
    await r.tick(MIN)
    assert.deepEqual(r.closes(), [], "30 s of quiet is not enough")
    await r.tick(2 * MIN)
    assert.deepEqual(r.closes(), [11])
    await r.tick(MIN)
    assert.deepEqual(r.closes(), [11], "once")
    assert.equal((await r.saved())[key("ses_a")].closed, true)
    await r.done()
  })

  it("an event of the session restarts the settle time", async () => {
    const r = await rig()
    await r.tick(90_000)
    r.bridge.activity("ses_a")
    await r.tick(90_000)
    assert.deepEqual(r.closes(), [])
    await r.tick(40_000)
    assert.deepEqual(r.closes(), [11])
    await r.done()
  })

  it("stays open while a TUI shows it, closes once the TUI shows another", async () => {
    const r = await rig()
    r.open.add("ses_a")
    await r.tick(10 * MIN)
    assert.deepEqual(r.closes(), [])
    r.open.clear()
    await r.tick(MIN)
    assert.deepEqual(r.closes(), [11])
    await r.done()
  })

  it("stays open while working, with chat on, or with a question waiting", async () => {
    const r = await rig({
      sessions: [live("ses_busy"), live("ses_chat"), live("ses_ask")],
      pending: "ses_ask",
    })
    r.busy.add("ses_busy")
    assert.equal((await r.bridge.setChat("ses_chat", true)).ok, true)
    await r.tick(60 * MIN)
    assert.deepEqual(r.closes(), [])
    await r.done()
  })

  it("a headless session closes too", async () => {
    const r = await rig({ sessions: [live("ses_h", false)] })
    await r.tg.waitFor(() => r.tg.of("closeForumTopic")[0])
    await r.tick(3 * MIN)
    assert.deepEqual(r.closes(), [11], "closed at start, not twice")
    await r.done()
  })

  it("the shared and approvals topics never close", async () => {
    const r = await rig({ extra: ["agents/shop", "approvals"] })
    await r.tick(60 * MIN)
    assert.deepEqual(r.closes(), [11], "only the session topic")
    await r.done()
  })
})

describe("the switches", () => {
  it("closeIdle false keeps a viewed session open, and closeHeadless does not govern it", async () => {
    const r = await rig({ closeIdle: false, closeHeadless: true })
    await r.tick(10 * MIN)
    assert.deepEqual(r.closes(), [])
    await r.done()
  })

  it("closeHeadless false keeps a headless session open, and closeIdle does not govern it", async () => {
    const r = await rig({
      sessions: [live("ses_h", false)],
      closeHeadless: false,
      closeIdle: true,
    })
    await r.tick(10 * MIN)
    assert.deepEqual(r.closes(), [])
    await r.done()
  })
})

describe("a closed topic is reopened by activity, without flapping", () => {
  it("the user writes in it: reopened, and not closed again for 10 minutes", async () => {
    const r = await rig()
    await r.tick(3 * MIN)
    assert.deepEqual(r.closes(), [11])
    r.tg.message(CHAT, "hello", undefined, 11)
    await r.tg.waitFor(() => r.tg.of("reopenForumTopic")[0])
    assert.deepEqual(r.reopens(), [11])
    assert.ok(!(await r.saved())[key("ses_a")].closed)
    await r.tick(5 * MIN)
    assert.deepEqual(r.closes(), [11], "within the dwell")
    await r.tick(6 * MIN)
    assert.deepEqual(r.closes(), [11, 11], "after the dwell")
    await r.done()
  })

  it("a message to an unrelated thread reopens nothing", async () => {
    const r = await rig()
    await r.tick(3 * MIN)
    r.tg.message(CHAT, "hello", undefined, 99)
    await new Promise((res) => setTimeout(res, 300))
    assert.deepEqual(r.reopens(), [])
    await r.done()
  })
})
