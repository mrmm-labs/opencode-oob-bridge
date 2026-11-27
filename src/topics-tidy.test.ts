import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
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
const H = 3_600_000
const OTHER = 777
const key = (id: string) => CHAT + ":" + id

type Topics = Record<
  string,
  { thread: number; name?: string; closed?: boolean }
>

const base: Topics = {
  [key("ses_old")]: { thread: 11, name: "shop · old" },
  [key("ses_fresh")]: { thread: 12, name: "shop · fresh" },
  [key("ses_gone")]: { thread: 13, name: "shop · gone" },
  [key("ses_busy")]: { thread: 14, name: "shop · busy" },
  [key("ses_ask")]: { thread: 15, name: "shop · ask" },
  [key("ses_noage")]: { thread: 16, name: "shop · noage" },
  [key("agents/shop")]: { thread: 17, name: "shop · agents" },
  [key("approvals")]: { thread: 18, name: "Approvals" },
  [key("ses_cur")]: { thread: 19, name: "shop · current" },
  [key("ses_closed_gone")]: { thread: 20, name: "shop · cg", closed: true },
  [key("ses_closed_live")]: { thread: 21, name: "shop · cl", closed: true },
}

async function rig(
  o: {
    topics?: Topics
    sessions?: SessionInfo[]
    busy?: string[]
    pending?: string
  } = {},
) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-tidy-"))
  const topicsFile = join(dir, "topics.json")
  await writeFile(topicsFile, JSON.stringify(o.topics ?? base))
  const at = (id: string, ageH: number | undefined): SessionInfo => ({
    id,
    directory: "/w/shop",
    title: id,
    viewed: true,
    activeAt: ageH === undefined ? undefined : Date.now() - ageH * H,
  })
  const table = new Map(
    (
      o.sessions ?? [
        at("ses_old", 48),
        at("ses_fresh", 2),
        at("ses_busy", 100),
        at("ses_ask", 100),
        at("ses_noage", undefined),
        at("ses_cur", 100),
        at("ses_closed_live", 100),
      ]
    ).map((s) => [s.id, s]),
  )
  const busy = new Set(o.busy ?? ["ses_busy"])
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
    topics: { headless: "session", closeHeadless: false },
  })
  const cfg = parseConfig({
    channels: { telegram: { token: { env: "X" } } },
  }) as Config
  const router = new Router(cfg, async () => true)
  router.setAfk("on", Infinity)
  const store = new PendingStore()
  const ask = o.pending ?? "ses_ask"
  store.put({
    id: "p1",
    kind: "question",
    requestID: "r1",
    sessionID: ask,
    rootSessionID: ask,
    title: "Q",
    askedAt: Date.now(),
    state: "pending",
  } as Pending)
  const bridge = new Bridge(cfg, host, [channel], store, router, Date.now)
  bridge.start()
  return {
    tg,
    bridge,
    dir,
    topicsFile,
    table,
    closes: () =>
      tg
        .of("closeForumTopic")
        .map((c) => c.body.message_thread_id as number)
        .sort(),
    saved: async () => JSON.parse(await readFile(topicsFile, "utf8")),
    say: (text: string, sender?: number) =>
      tg.message(CHAT, text, undefined, undefined, {}, sender),
    said: (re: RegExp) =>
      tg.waitFor(() =>
        tg.of("sendMessage").find((c) => re.test(c.body.text ?? "")),
      ),
    async quiet() {
      await new Promise((r) => setTimeout(r, 250))
    },
    async done() {
      assert.equal(tg.of("deleteForumTopic").length, 0, "never deletes")
      await bridge.stop()
      await tg.close()
    },
  }
}

describe("the verdict of each topic", () => {
  it("dry run: close for a gone or idle session; keep for the rest, with a reason", async () => {
    const r = await rig()
    const before = await readFile(r.topicsFile, "utf8")
    const out = await r.bridge.tidyTopics({
      apply: false,
      idleHours: 24,
      current: "ses_cur",
      source: "rpc",
    })
    assert.equal(out.ok, true)
    const lines = out.text.split("\n")
    assert.match(lines[0], /^Dry run \(idle limit 24 h\): 2 to close, 7 kept\./)
    const line = (n: string) => lines.find((l) => l.includes(n)) ?? ""
    assert.match(line("shop · old"), /idle 2 d|idle 48 h/)
    assert.match(line("shop · gone"), /session gone/)
    assert.match(line("shop · fresh"), /active 2 h ago/)
    assert.match(line("shop · busy"), /working/)
    assert.match(line("shop · ask"), /question or permission waits/)
    assert.match(line("shop · noage"), /age unknown/)
    assert.match(line("shop · current"), /this topic/)
    assert.match(line("shop · agents"), /shared topic/)
    assert.match(line("Approvals"), /approvals topic/)
    assert.ok(!out.text.includes("|"), "a list, not a table")
    const closeAt = lines.indexOf("close:")
    const keepAt = lines.indexOf("keep:")
    assert.ok(closeAt >= 0 && keepAt > closeAt)
    assert.deepEqual(r.closes(), [], "a dry run closes nothing")
    assert.equal(await readFile(r.topicsFile, "utf8"), before, "file untouched")
    assert.deepEqual(
      (await readdir(r.dir)).filter((f) => f.includes(".bak")),
      [],
      "no backup",
    )
    await r.done()
  })

  it("the idle limit is the one asked for", async () => {
    const r = await rig()
    const out = await r.bridge.tidyTopics({
      apply: false,
      idleHours: 72,
      current: "ses_cur",
      source: "rpc",
    })
    const old = out.text.split("\n").find((l) => l.includes("shop · old")) ?? ""
    assert.match(old, /active/)
    assert.match(out.text, /^Dry run \(idle limit 72 h\): 1 to close/)
    await r.done()
  })

  it("a session with chat on is kept", async () => {
    const r = await rig({
      sessions: [
        {
          id: "ses_chat",
          directory: "/w/shop",
          viewed: true,
          activeAt: Date.now() - 200 * H,
        },
      ],
      topics: { [key("ses_chat")]: { thread: 31, name: "shop · chat" } },
      pending: "ses_none",
    })
    assert.equal((await r.bridge.setChat("ses_chat", true)).ok, true)
    const out = await r.bridge.tidyTopics({
      apply: false,
      idleHours: 24,
      source: "rpc",
    })
    assert.match(out.text, /ses_chat: chat is on/)
    await r.done()
  })
})

describe("apply", () => {
  it("closes exactly the close topics and forgets closed topics of deleted sessions", async () => {
    const r = await rig()
    const out = await r.bridge.tidyTopics({
      apply: true,
      idleHours: 24,
      current: "ses_cur",
      source: "rpc",
    })
    assert.equal(out.ok, true)
    assert.deepEqual(r.closes(), [11, 13])
    assert.match(out.text, /^Closed 2 topics, kept 7\./)
    assert.match(out.text, /Forgot 1 closed topic of deleted sessions/)
    const saved = await r.saved()
    assert.equal(saved[key("ses_closed_gone")], undefined, "dropped")
    assert.ok(saved[key("ses_closed_live")], "its session exists: kept")
    assert.equal(
      saved[key("ses_gone")].closed,
      true,
      "closed now, kept until next",
    )
    assert.equal(saved[key("ses_old")].closed, true)
    for (const id of [
      "ses_fresh",
      "ses_busy",
      "ses_ask",
      "ses_noage",
      "ses_cur",
      "agents/shop",
      "approvals",
    ])
      assert.ok(!saved[key(id)].closed, id + " stays open")
    const backups = (await readdir(r.dir)).filter((f) => f.includes(".bak-"))
    assert.equal(backups.length, 1, "one backup")
    const bak = JSON.parse(await readFile(join(r.dir, backups[0]), "utf8"))
    assert.ok(bak[key("ses_closed_gone")], "the backup still has it")
    assert.equal(r.tg.of("editMessageText").length, 0, "no message touched")
    await r.done()
  })

  it("a question or a working turn that appears is never closed, whatever its age", async () => {
    const r = await rig()
    const out = await r.bridge.tidyTopics({
      apply: true,
      idleHours: 1,
      source: "rpc",
    })
    assert.equal(out.ok, true)
    assert.ok(!r.closes().includes(14), "busy")
    assert.ok(!r.closes().includes(15), "pending question")
    await r.done()
  })

  it("refuses when the host knows none of the sessions", async () => {
    const r = await rig({ sessions: [] })
    const out = await r.bridge.tidyTopics({
      apply: true,
      idleHours: 24,
      source: "rpc",
    })
    assert.equal(out.ok, false)
    assert.match(out.text, /host knows none/)
    assert.deepEqual(r.closes(), [])
    assert.deepEqual(
      (await readdir(r.dir)).filter((f) => f.includes(".bak")),
      [],
    )
    await r.done()
  })

  it("a second run closes nothing more", async () => {
    const r = await rig()
    await r.bridge.tidyTopics({ apply: true, idleHours: 24, source: "rpc" })
    const n = r.closes().length
    await r.bridge.tidyTopics({ apply: true, idleHours: 24, source: "rpc" })
    assert.equal(r.closes().length, n)
    await r.done()
  })
})

describe("/topics in a chat", () => {
  it("is a dry run by default, and any member may ask", async () => {
    const r = await rig()
    r.say("/topics", OTHER)
    await r.said(/^Dry run/)
    assert.deepEqual(r.closes(), [])
    await r.done()
  })

  it("apply: another member is refused; the owner closes", async () => {
    const r = await rig()
    r.say("/topics apply", OTHER)
    await r.said(/Only the paired owner can close topics/)
    await r.quiet()
    assert.deepEqual(r.closes(), [])
    r.say("/topics apply")
    await r.said(/^Closed 3 topics/)
    assert.deepEqual(r.closes(), [11, 13, 19], "no current topic in General")
    await r.done()
  })

  it("takes the hours, and refuses what it does not understand", async () => {
    const r = await rig()
    r.say("/topics 72")
    await r.said(/idle limit 72 h/)
    r.say("/topics soon")
    await r.said(/Usage: \/topics \[apply\] \[hours\]/)
    await r.done()
  })
})
