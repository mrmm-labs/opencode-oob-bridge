import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { Bridge, type BridgeEvent, type Host } from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"

const away = (r: Router) => (r.setAfk("on", Infinity), r)
import { sleep } from "./util.ts"

const CHAT = 4242

async function rig(chat: Record<string, unknown> = { queueSteerSeconds: 1 }) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-queue-"))
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
    chat,
  }) as Config
  const prompts: Array<{ text: string; delivery: string }> = []
  const state = { busy: true }
  const host: Host = {
    session: async (id) => ({ id, agent: "coord", directory: "/w/shop" }),
    root: (id) => id,
    replyForm: async () => {},
    replyPermission: async () => {},
    prompt: async (_id, text, delivery) => {
      prompts.push({ text, delivery })
    },
    busy: () => state.busy,
  } as unknown as Host
  const bridge = new Bridge(
    cfg,
    host,
    [channel],
    new PendingStore(),
    away(new Router(cfg, async () => true)),
    Date.now,
  )
  bridge.start()
  const out = await bridge.setChat("root", true)
  assert.equal(out.ok, true)
  await tg.waitFor(() => tg.of("sendMessage")[0])
  const sends = () => tg.of("sendMessage").map((c) => c.body)
  return {
    tg,
    bridge,
    prompts,
    state,
    sends,
    say: (text: string) => tg.message(CHAT, text, undefined, 9001),
    async done() {
      await bridge.stop()
      await tg.close()
    },
  }
}

describe("a message queued behind a busy session", () => {
  it("is steered in when it still waits after the set time, and the thread says so", async () => {
    const r = await rig()
    r.say("run the tests")
    await sleep(300)
    assert.deepEqual(r.prompts, [], "kept, not sent yet")
    await r.tg.waitFor(() => r.prompts[0])
    assert.deepEqual(r.prompts, [{ text: "run the tests", delivery: "steer" }])
    await r.tg.waitFor(() =>
      r.sends().find((b) => /steered in after \d+s/.test(b.text)),
    )
    await r.done()
  })

  it("keeps the order of several messages", async () => {
    const r = await rig()
    r.say("first")
    await sleep(150)
    r.say("second")
    await r.tg.waitFor(() => (r.prompts.length === 2 ? true : undefined))
    assert.deepEqual(
      r.prompts.map((p) => p.text),
      ["first", "second"],
    )
    assert.ok(r.prompts.every((p) => p.delivery === "steer"))
    await r.done()
  })

  it("goes in as a normal prompt when the session frees up first, with no steer notice", async () => {
    const r = await rig({ queueSteerSeconds: 30 })
    r.say("when you are done")
    await sleep(300)
    assert.deepEqual(r.prompts, [])
    r.state.busy = false
    await r.bridge.onEvent({
      type: "session.execution.succeeded",
      data: { sessionID: "root" },
    } as unknown as BridgeEvent)
    await r.tg.waitFor(() => r.prompts[0])
    assert.deepEqual(r.prompts, [
      { text: "when you are done", delivery: "queue" },
    ])
    assert.equal(
      r.sends().filter((b) => /steered in after/.test(b.text)).length,
      0,
    )
    await r.done()
  })

  it("is handed to the session's queue, not lost, when the bridge stops", async () => {
    const r = await rig({ queueSteerSeconds: 30 })
    r.say("do not lose me")
    await sleep(300)
    assert.deepEqual(r.prompts, [])
    await r.bridge.stop()
    assert.deepEqual(r.prompts, [{ text: "do not lose me", delivery: "queue" }])
    await r.tg.close()
  })

  it("waits for the turn to end as before when queueSteerSeconds is 0", async () => {
    const r = await rig({ queueSteerSeconds: 0 })
    r.say("later")
    await r.tg.waitFor(() => r.prompts[0])
    assert.deepEqual(r.prompts, [{ text: "later", delivery: "queue" }])
    await r.done()
  })

  it("is steered at once when the session's delivery is steer, and a plain ! still steers", async () => {
    const r = await rig({ queueSteerSeconds: 30, delivery: "steer" })
    r.say("now")
    await r.tg.waitFor(() => r.prompts[0])
    assert.deepEqual(r.prompts, [{ text: "now", delivery: "steer" }])
    await r.done()
  })
})

describe("chat.queueSteerSeconds", () => {
  const parse = (chat: unknown) =>
    parseConfig({ channels: { telegram: { token: { env: "X" } } }, chat })

  it("defaults to 30 and accepts 0 to 86400", () => {
    assert.equal((parse({}) as Config).chat.queueSteerSeconds, 30)
    assert.equal(
      (parse({ queueSteerSeconds: 0 }) as Config).chat.queueSteerSeconds,
      0,
    )
  })

  it("refuses a negative, fractional or huge value", () => {
    for (const v of [-1, 1.5, 86_401, "5"])
      assert.match(
        (parse({ queueSteerSeconds: v }) as { error: string }).error,
        /queueSteerSeconds/,
      )
  })
})
