import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { flushLog } from "../logger.ts"
import { sleep } from "../util.ts"
import { fakeTelegram } from "./fake-telegram.test-util.ts"
import { TelegramConnector, type TelegramOptions } from "./telegram.ts"

const GROUP = -1001234567890
const APP = {
  url: "https://app.example.com/app/",
  link: "https://t.me/examplebot/app",
}

const state = (over: Record<string, unknown> = {}) => ({
  id: "ses_abcdef123456",
  name: "shop · Fix",
  project: "shop",
  title: "Fix",
  agent: "coordinator",
  model: "opus",
  state: "working" as const,
  at: new Date(2026, 0, 1, 14, 2).getTime(),
  ...over,
})

let runs = 0

async function rig(
  over: Partial<TelegramOptions> = {},
  shared?: { dir: string },
) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = shared?.dir ?? (await mkdtemp(join(tmpdir(), "oobb-pin-")))
  const logFile = join(dir, `bridge-${++runs}.log`)
  process.env.OPENCODE_OOB_BRIDGE_LOG = logFile
  const channel = new TelegramConnector({
    token: async () => tg.token,
    chatId: String(GROUP),
    apiBase: tg.url,
    offsetFile: join(dir, "offset.json"),
    topicsFile: join(dir, "topics.json"),
    backoff: { min: 10, max: 40 },
    pollSeconds: 1,
    ...over,
  })
  const ac = new AbortController()
  channel.start(async () => undefined, ac.signal)
  return {
    tg,
    dir,
    channel,
    saved: async () =>
      JSON.parse(await readFile(join(dir, "topics.json"), "utf8")),
    lines: async (event: string) => {
      await flushLog()
      await sleep(50)
      const text = await readFile(logFile, "utf8").catch(() => "")
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((l) => l.event === event)
    },
    async done() {
      ac.abort()
      await tg.close()
    },
  }
}

const KEY = `${GROUP}:ses_abcdef123456`
const sent = (r: Awaited<ReturnType<typeof rig>>) =>
  r.tg.of("sendMessage").map((c) => c.body)
const appMessages = (r: Awaited<ReturnType<typeof rig>>) =>
  sent(r).filter((b) => b.text === "📱 Open app")

describe("Telegram: the pinned app message of a topic", () => {
  it("is posted and pinned without a sound when a topic is bound, and the card keeps the bar", async () => {
    const r = await rig()
    r.channel.launch(APP)
    await r.channel.track(state())
    const apps = appMessages(r)
    assert.equal(apps.length, 1)
    assert.equal(apps[0].message_thread_id, 9001)
    assert.equal(apps[0].disable_notification, true)
    const button = apps[0].reply_markup.inline_keyboard[0][0]
    assert.equal(apps[0].reply_markup.inline_keyboard.length, 1)
    assert.equal(
      button.url,
      APP.link + "?startapp=s_ses_abcdef123456",
      "the link form that works in a group",
    )
    const ids = r.tg.of("sendMessage").map((_c, i) => 501 + i)
    const pins = r.tg.of("pinChatMessage").map((c) => c.body)
    assert.equal(pins.length, 3, "card, app message, card again")
    assert.ok(pins.every((p) => p.disable_notification === true))
    assert.deepEqual(
      pins.map((p) => p.message_id),
      [ids[0], ids[1], ids[0]],
    )
    const saved = (await r.saved())[KEY]
    assert.equal(saved.app, ids[1])
    assert.equal(saved.appPinned, true)
    assert.deepEqual(
      (await r.lines("topic_pin")).map((l) => [l.thread, l.outcome]),
      [[9001, "pinned"]],
    )
    await r.done()
  })

  it("is posted once however often the session reports", async () => {
    const r = await rig()
    r.channel.launch(APP)
    await Promise.all([r.channel.track(state()), r.channel.track(state())])
    await r.channel.track(state({ state: "idle" }))
    assert.equal(appMessages(r).length, 1)
    await r.done()
  })

  it("is not posted without a deep link, and not for the Approvals topic", async () => {
    const r = await rig()
    await r.channel.track(state())
    assert.equal(appMessages(r).length, 0, "no app configured")
    await r.done()

    const dir = await mkdtemp(join(tmpdir(), "oobb-pin-"))
    await writeFile(
      join(dir, "topics.json"),
      JSON.stringify({ [`${GROUP}:approvals`]: { thread: 9100 } }),
    )
    const a = await rig({}, { dir })
    a.channel.launch(APP)
    await sleep(150)
    assert.equal(sent(a).length, 0)
    assert.equal(a.tg.of("pinChatMessage").length, 0)
    await a.done()
  })

  it("is edited in place after a restart, not posted or pinned again", async () => {
    const first = await rig()
    first.channel.launch(APP)
    await first.channel.track(state())
    const id = (await first.saved())[KEY].app
    await first.done()

    const second = await rig({}, { dir: first.dir })
    second.channel.launch(APP)
    const e = await second.tg.waitFor(() => second.tg.of("editMessageText")[0])
    assert.equal(e.body.message_id, id)
    assert.equal(e.body.text, "📱 Open app")
    await sleep(100)
    assert.equal(sent(second).length, 0, "nothing posted")
    assert.equal(second.tg.of("pinChatMessage").length, 0, "nothing pinned")
    assert.equal((await second.saved())[KEY].app, id)
    assert.deepEqual(
      (await second.lines("topic_pin")).map((l) => l.outcome),
      ["edited"],
    )
    await second.done()
  })

  it("is posted and pinned again when Telegram no longer has it", async () => {
    const first = await rig()
    first.channel.launch(APP)
    await first.channel.track(state())
    const old = (await first.saved())[KEY].app
    await first.done()

    const second = await rig({}, { dir: first.dir })
    second.tg.fail("editMessageText", 400, {
      description: "Bad Request: message to edit not found",
    })
    second.channel.launch(APP)
    const made = await second.tg.waitFor(() => appMessages(second)[0])
    assert.equal(made.message_thread_id, 9001)
    const pin = await second.tg.waitFor(() => second.tg.of("pinChatMessage")[0])
    assert.notEqual(pin.body.message_id, old)
    assert.equal(pin.body.disable_notification, true)
    await sleep(100)
    const saved = (await second.saved())[KEY]
    assert.equal(saved.app, pin.body.message_id)
    assert.equal(saved.appPinned, true)
    assert.deepEqual(
      (await second.lines("topic_pin")).map((l) => l.outcome),
      ["recreated"],
    )
    await second.done()
  })

  it("stays unpinned and logs why when the bot may not pin, and tries the pin again after a restart", async () => {
    const first = await rig({ statusCard: false })
    first.tg.fail("pinChatMessage", 400, {
      description: "Bad Request: not enough rights to pin a message",
    })
    first.channel.launch(APP)
    await first.channel.track(state())
    assert.equal(appMessages(first).length, 1)
    const saved = (await first.saved())[KEY]
    assert.equal(saved.appPinned, false)
    const failed = await first.lines("topic_pin_failed")
    assert.equal(failed.length, 1)
    assert.equal(failed[0].thread, 9001)
    assert.equal(failed[0].reason, "no_pin_right")
    assert.deepEqual(
      (await first.lines("topic_pin")).map((l) => l.outcome),
      ["unpinned"],
    )
    await first.done()

    const second = await rig({ statusCard: false }, { dir: first.dir })
    second.channel.launch(APP)
    const pin = await second.tg.waitFor(() => second.tg.of("pinChatMessage")[0])
    assert.equal(pin.body.message_id, saved.app)
    assert.equal(sent(second).length, 0, "the message is not posted again")
    await sleep(100)
    assert.equal((await second.saved())[KEY].appPinned, true)
    await second.done()
  })
})
