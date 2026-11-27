import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { Bridge, type Host, type SessionInfo } from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"

const CHAT = 4242
const SEC = 1000
const key = (id: string) => CHAT + ":" + id

type Topics = Record<
  string,
  { thread: number; name?: string; marked?: boolean }
>

const sessions: SessionInfo[] = [
  { id: "ses_a", directory: "/w/shop", title: "a", viewed: true },
]

async function rig(o: { topics?: Topics; markOpen?: boolean } = {}) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-mark-"))
  const topicsFile = join(dir, "topics.json")
  await writeFile(
    topicsFile,
    JSON.stringify(
      o.topics ?? {
        [key("ses_a")]: { thread: 11, name: "shop · a" },
        [key("agents/shop")]: { thread: 12, name: "shop · agents" },
      },
    ),
  )
  const clock = { t: Date.now() }
  const now = () => clock.t
  const open = new Set<string>()
  const host: Host = {
    session: async (id) => sessions.find((s) => s.id === id),
    root: (id) => id,
    replyForm: async () => {},
    prompt: async () => {},
    busy: () => false,
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
      headless: "project",
      closeIdle: false,
      closeHeadless: false,
      ...(o.markOpen === undefined ? {} : { markOpen: o.markOpen }),
    },
  })
  const cfg = parseConfig({
    channels: { telegram: { token: { env: "X" } } },
  }) as Config
  const router = new Router(cfg, async () => true)
  router.setAfk("on", Infinity)
  const bridge = new Bridge(
    cfg,
    host,
    [channel],
    new PendingStore(),
    router,
    now,
  )
  bridge.onOpenSessions(() => open)
  bridge.start()
  const renames = () =>
    tg
      .of("editForumTopic")
      .map((c) => [c.body.message_thread_id, c.body.name] as const)
  return {
    tg,
    channel,
    open,
    clock,
    renames,
    saved: async () => {
      await new Promise((r) => setTimeout(r, 100))
      return JSON.parse(await readFile(topicsFile, "utf8")) as Topics
    },
    async tick(advanceMs = 0) {
      clock.t += advanceMs
      await bridge.topicTick()
    },
    async done() {
      await bridge.stop()
      await tg.close()
    },
  }
}

describe("the open mark", () => {
  it("is added while a TUI shows the session and removed when none does", async () => {
    const r = await rig()
    await r.tick()
    assert.deepEqual(r.renames(), [], "nothing open, nothing to mark")
    r.open.add("ses_a")
    await r.tick(10 * SEC)
    assert.deepEqual(r.renames(), [[11, "🟢 shop · a"]])
    let saved = await r.saved()
    assert.equal(saved[key("ses_a")].name, "shop · a", "base name has no mark")
    assert.equal(saved[key("ses_a")].marked, true)
    r.open.clear()
    await r.tick(61 * SEC)
    assert.deepEqual(r.renames(), [
      [11, "🟢 shop · a"],
      [11, "shop · a"],
    ])
    saved = await r.saved()
    assert.equal(saved[key("ses_a")].name, "shop · a")
    assert.equal(saved[key("ses_a")].marked, undefined)
    await r.done()
  })

  it("never marks a shared topic", async () => {
    const r = await rig()
    r.open.add("agents/shop")
    await r.tick(10 * SEC)
    assert.deepEqual(r.renames(), [])
    await r.done()
  })

  it("is never doubled: reading the open set again renames nothing", async () => {
    const r = await rig()
    r.open.add("ses_a")
    for (let i = 0; i < 6; i++) await r.tick(61 * SEC)
    assert.equal(r.renames().length, 1)
    await r.done()
  })

  it("is never doubled when the name already has it, or the topic is already marked", async () => {
    const r = await rig({
      topics: {
        [key("ses_a")]: { thread: 11, name: "🟢 shop · a" },
        [key("ses_b")]: { thread: 13, name: "shop · b", marked: true },
      },
    })
    r.open.add("ses_a").add("ses_b")
    await r.tick(10 * SEC)
    for (const [, name] of r.renames()) assert.doesNotMatch(name ?? "", /🟢 🟢/)
    assert.ok(!r.renames().some(([t]) => t === 13), "already marked: no rename")
    await r.done()
  })

  it("is renamed at most once a minute per topic", async () => {
    const r = await rig()
    r.open.add("ses_a")
    await r.tick(10 * SEC)
    assert.equal(r.renames().length, 1)
    r.open.clear()
    await r.tick(10 * SEC)
    await r.tick(10 * SEC)
    await r.tick(30 * SEC)
    assert.equal(r.renames().length, 1, "40 s later: held back")
    await r.tick(15 * SEC)
    assert.equal(r.renames().length, 2, "after the minute")
    r.open.add("ses_a")
    await r.tick(10 * SEC)
    assert.equal(r.renames().length, 2, "flipping back is held too")
    await r.tick(55 * SEC)
    assert.equal(r.renames().length, 3)
    await r.done()
  })

  it("shares its pace with the rename that follows a session's title", async () => {
    const r = await rig()
    r.open.add("ses_a")
    await r.tick(10 * SEC)
    assert.equal(r.renames().length, 1)
    await r.channel.track({
      id: "ses_a",
      name: "shop · renamed",
      project: "shop",
      state: "idle",
      at: r.clock.t,
    })
    assert.equal(r.renames().length, 1, "the title waits for the minute")
    r.clock.t += 61 * SEC
    await r.channel.track({
      id: "ses_a",
      name: "shop · renamed",
      project: "shop",
      state: "idle",
      at: r.clock.t,
    })
    assert.deepEqual(r.renames().at(-1), [11, "🟢 shop · renamed"])
    assert.equal((await r.saved())[key("ses_a")].name, "shop · renamed")
    await r.done()
  })
})

describe("topics.markOpen: false", () => {
  it("renames nothing while a TUI shows the session", async () => {
    const r = await rig({ markOpen: false })
    r.open.add("ses_a")
    await r.tick(10 * SEC)
    await r.tick(120 * SEC)
    assert.deepEqual(r.renames(), [])
    await r.done()
  })

  it("takes the mark off a topic that has it, once", async () => {
    const r = await rig({
      markOpen: false,
      topics: {
        [key("ses_a")]: { thread: 11, name: "shop · a", marked: true },
      },
    })
    r.open.add("ses_a")
    await r.tick(10 * SEC)
    await r.tick(120 * SEC)
    assert.deepEqual(r.renames(), [[11, "shop · a"]])
    await r.done()
  })
})
