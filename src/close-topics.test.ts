import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  Bridge,
  type BridgeEvent,
  type Host,
  type SessionInfo,
} from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import { flushLog } from "./logger.ts"
import { PendingStore, type Pending } from "./pending.ts"
import { Router } from "./routing.ts"

const CHAT = 4242

const info = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  agent: "reviewer",
  directory: "/w/shop",
  title: id,
  viewed: false,
  ...over,
})

async function rig(
  o: {
    sessions: SessionInfo[]
    topics?: Record<string, { thread: number; name?: string }>
    busy?: string[]
    pending?: string
    headless?: "project" | "session"
    close?: boolean
  } = { sessions: [] },
) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-close-"))
  const topicsFile = join(dir, "topics.json")
  if (o.topics) await writeFile(topicsFile, JSON.stringify(o.topics))
  const table = new Map(o.sessions.map((s) => [s.id, s]))
  const busy = new Set(o.busy ?? [])
  const host: Host = {
    session: async (id) => table.get(id),
    root: (id) => {
      let cur = id
      for (let i = 0; i < 8 && table.get(cur)?.parentID; i++)
        cur = table.get(cur)!.parentID!
      return cur
    },
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
    topics: {
      headless: o.headless ?? "session",
      ...(o.close === undefined ? {} : { closeHeadless: o.close }),
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
  const bridge = new Bridge(cfg, host, [channel], store, router, Date.now)
  bridge.start()
  const ev = (type: string, sessionID: string, data: object = {}) =>
    bridge.onEvent({
      type,
      data: { sessionID, ...data },
    } as unknown as BridgeEvent)
  return {
    tg,
    bridge,
    busy,
    table,
    topicsFile,
    ev,
    closes: () => tg.of("closeForumTopic").map((c) => c.body.message_thread_id),
    reopens: () =>
      tg.of("reopenForumTopic").map((c) => c.body.message_thread_id),
    async quiet() {
      await new Promise((r) => setTimeout(r, 300))
    },
    async done() {
      assert.equal(tg.of("deleteForumTopic").length, 0, "never deletes")
      await bridge.stop()
      await tg.close()
    },
  }
}

async function withLog<T>(fn: (lines: () => Promise<any[]>) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "oobb-close-log-"))
  const file = join(dir, "log.jsonl")
  const old = process.env.OPENCODE_OOB_BRIDGE_LOG
  process.env.OPENCODE_OOB_BRIDGE_LOG = file
  try {
    return await fn(async () => {
      await flushLog()
      return (await readFile(file, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    })
  } finally {
    if (old === undefined) delete process.env.OPENCODE_OOB_BRIDGE_LOG
    else process.env.OPENCODE_OOB_BRIDGE_LOG = old
  }
}

const key = (id: string) => `${CHAT}:${id}`

describe("the sweep at start", () => {
  it("closes the topics of idle headless sessions and leaves the others", async () => {
    await withLog(async (lines) => {
      const r = await rig({
        sessions: [
          info("ses_a"),
          info("ses_b"),
          info("ses_viewed", { viewed: true }),
          info("ses_child", { parentID: "ses_a" }),
          info("ses_busy"),
          info("ses_ask"),
        ],
        busy: ["ses_busy"],
        pending: "ses_ask",
        topics: {
          [key("ses_a")]: { thread: 11, name: "shop · reviewer-1" },
          [key("ses_b")]: { thread: 12 },
          [key("ses_viewed")]: { thread: 13 },
          [key("ses_child")]: { thread: 14 },
          [key("ses_busy")]: { thread: 15 },
          [key("ses_ask")]: { thread: 16 },
          [key("ses_gone")]: { thread: 17 },
          [key("shared:shop")]: { thread: 18 },
        },
      })
      await r.tg.waitFor(() => r.closes().length >= 2 || undefined)
      await r.quiet()
      assert.deepEqual(r.closes().sort(), [11, 12])
      const saved = JSON.parse(await readFile(r.topicsFile, "utf8"))
      assert.equal(saved[key("ses_a")].closed, true)
      assert.equal(saved[key("ses_viewed")].closed, undefined)
      assert.equal(r.tg.of("editForumTopic").length, 0, "no rename")
      const closed = (await lines()).filter(
        (l) => l.event === "telegram_topic_closed",
      )
      assert.deepEqual(closed.map((l) => [l.session, l.thread, l.why]).sort(), [
        ["ses_a", 11, "start"],
        ["ses_b", 12, "start"],
      ])
      await r.done()
    })
  })

  it("does not close a topic twice, and does nothing when closing is off", async () => {
    const r = await rig({
      sessions: [info("ses_a")],
      topics: { [key("ses_a")]: { thread: 11 } },
    })
    await r.tg.waitFor(() => r.closes()[0])
    await r.bridge.sweepTopics()
    assert.deepEqual(r.closes(), [11])
    await r.done()
    const off = await rig({
      sessions: [info("ses_a")],
      topics: { [key("ses_a")]: { thread: 11 } },
      close: false,
    })
    await off.quiet()
    assert.deepEqual(off.closes(), [])
    await off.done()
  })

  it("a close that fails is logged and left", async () => {
    await withLog(async (lines) => {
      const r = await rig({
        sessions: [info("ses_a")],
        topics: { [key("ses_a")]: { thread: 11 } },
      })
      r.tg.fail("closeForumTopic", 400, { description: "not enough rights" })
      await r.tg.waitFor(() => r.closes()[0])
      await r.quiet()
      const saved = JSON.parse(await readFile(r.topicsFile, "utf8"))
      assert.equal(saved[key("ses_a")].closed, undefined)
      assert.ok(
        (await lines()).some((l) => l.event === "telegram_topic_close_failed"),
      )
      await r.done()
    })
  })
})

describe("a session that ends", () => {
  it("closes its topic, then reopens it on a new turn", async () => {
    await withLog(async (lines) => {
      const r = await rig({ sessions: [info("ses_a")] })
      await r.ev("session.execution.started", "ses_a")
      await r.tg.waitFor(() => r.tg.of("createForumTopic")[0])
      assert.deepEqual(r.closes(), [], "working: left open")
      await r.ev("session.execution.succeeded", "ses_a")
      await r.tg.waitFor(() => r.closes()[0])
      const thread = r.closes()[0]
      await r.ev("session.execution.started", "ses_a")
      await r.tg.waitFor(() => r.reopens()[0])
      assert.deepEqual(r.reopens(), [thread])
      const saved = JSON.parse(await readFile(r.topicsFile, "utf8"))
      assert.equal(saved[key("ses_a")].closed, undefined)
      const events = (await lines())
        .filter((l) => /^telegram_topic_(closed|reopened)$/.test(l.event))
        .map((l) => [l.event, l.session, l.thread])
      assert.deepEqual(events, [
        ["telegram_topic_closed", "ses_a", thread],
        ["telegram_topic_reopened", "ses_a", thread],
      ])
      await r.done()
    })
  })

  it("a late edit of the idle card does not reopen it", async () => {
    const r = await rig({ sessions: [info("ses_a")] })
    await r.ev("session.execution.started", "ses_a")
    await r.tg.waitFor(() => r.tg.of("createForumTopic")[0])
    await r.ev("session.execution.succeeded", "ses_a")
    await r.tg.waitFor(() => r.closes()[0])
    await r.ev("session.renamed", "ses_a", { title: "new title" })
    await r.quiet()
    assert.deepEqual(r.reopens(), [])
    await r.done()
  })

  it("is not closed when a TUI has viewed the session, or the host says it works", async () => {
    const r = await rig({
      sessions: [info("ses_v", { viewed: true }), info("ses_w")],
      busy: ["ses_w"],
    })
    for (const id of ["ses_v", "ses_w"]) {
      await r.ev("session.execution.started", id)
      await r.ev("session.execution.succeeded", id)
    }
    await r.quiet()
    assert.deepEqual(r.closes(), [])
    await r.done()
  })

  it("closing off: nothing is closed", async () => {
    const r = await rig({ sessions: [info("ses_a")], close: false })
    await r.ev("session.execution.started", "ses_a")
    await r.tg.waitFor(() => r.tg.of("createForumTopic")[0])
    await r.ev("session.execution.succeeded", "ses_a")
    await r.quiet()
    assert.deepEqual(r.closes(), [])
    await r.done()
  })

  it("a topic shared by headless sessions is never closed", async () => {
    const r = await rig({ sessions: [info("ses_a")], headless: "project" })
    await r.ev("session.execution.started", "ses_a")
    await r.ev("session.execution.succeeded", "ses_a")
    await r.quiet()
    assert.deepEqual(r.closes(), [])
    await r.done()
  })
})
