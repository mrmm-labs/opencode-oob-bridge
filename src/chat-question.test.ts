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
import { sleep } from "./util.ts"

const CHAT = 4242

async function rig() {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-gate-"))
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
    chat: {},
  }) as Config
  const prompts: Array<{ text: string; delivery: string }> = []
  const host: Host = {
    session: async (id) => ({ id, agent: "coord", directory: "/w/shop" }),
    root: (id) => id,
    replyForm: async () => {},
    replyPermission: async () => {},
    prompt: async (_id, text, delivery) => {
      prompts.push({ text, delivery })
    },
    busy: () => false,
  } as unknown as Host
  const bridge = new Bridge(
    cfg,
    host,
    [channel],
    new PendingStore(),
    new Router(cfg, async () => true),
    Date.now,
  )
  bridge.start()
  const out = await bridge.setChat("root", true)
  assert.equal(out.ok, true)
  await tg.waitFor(() => tg.of("sendMessage")[0])
  await bridge.onEvent({
    type: "form.created",
    data: {
      form: {
        id: "frm_1",
        sessionID: "root",
        metadata: { kind: "question" },
        fields: [
          {
            key: "q0",
            type: "string",
            description: "Go?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      },
    },
  } as unknown as BridgeEvent)
  const sends = () => tg.of("sendMessage").map((c) => c.body)
  await tg.waitFor(() => sends().find((b) => /Go\?/.test(b.text)))
  const gate = async () => {
    tg.message(CHAT, "run the tests", undefined, 9001)
    return tg.waitFor(() =>
      sends().find((b) => /waiting on a question/.test(b.text)),
    )
  }
  const tap = (menu: { reply_markup: any }, label: RegExp) => {
    const btn = menu.reply_markup.inline_keyboard
      .flat()
      .find((b: { text: string }) => label.test(b.text))
    tg.callback(CHAT, 700, btn.callback_data, 9001)
  }
  return {
    tg,
    bridge,
    prompts,
    sends,
    gate,
    tap,
    async done() {
      await bridge.stop()
      await tg.close()
    },
  }
}

describe("a message for a session that waits on a question", () => {
  it("is held, not sent and not dropped: the topic offers answer, skip and send anyway", async () => {
    const r = await rig()
    const menu = await r.gate()
    assert.equal(menu.message_thread_id, 9001)
    assert.deepEqual(
      menu.reply_markup.inline_keyboard.flat().map((b: any) => b.text),
      [
        "Answer: show the question again",
        "Skip: do not send my message",
        "Send anyway: steer it in",
      ],
    )
    await sleep(100)
    assert.deepEqual(r.prompts, [])
    await r.tg.waitFor(() =>
      r.tg.of("setMessageReaction").length >= 2 ? true : undefined,
    )
    assert.deepEqual(
      r.tg.of("setMessageReaction").map((c) => c.body.reaction[0].emoji),
      ["👀", "🤷"],
    )
    await r.done()
  })

  it("Send anyway steers the kept message into the session", async () => {
    const r = await rig()
    r.tap(await r.gate(), /Send anyway/)
    await r.tg.waitFor(() => r.prompts[0])
    assert.deepEqual(r.prompts, [{ text: "run the tests", delivery: "steer" }])
    await r.tg.waitFor(() =>
      r.sends().find((b) => /Sent anyway, steered in/.test(b.text)),
    )
    await r.done()
  })

  it("Skip sends nothing and says so", async () => {
    const r = await rig()
    r.tap(await r.gate(), /Skip/)
    await r.tg.waitFor(() =>
      r.sends().find((b) => /your message was not sent/.test(b.text)),
    )
    assert.deepEqual(r.prompts, [])
    await r.done()
  })

  it("Answer posts the question again at the bottom of the topic", async () => {
    const r = await rig()
    const before = r.sends().filter((b) => /Go\?/.test(b.text)).length
    r.tap(await r.gate(), /Answer/)
    await r.tg.waitFor(() =>
      r.sends().filter((b) => /Go\?/.test(b.text)).length > before
        ? true
        : undefined,
    )
    assert.deepEqual(r.prompts, [])
    await r.done()
  })

  it("a message that starts with ! still steers at once", async () => {
    const r = await rig()
    r.tg.message(CHAT, "!stop that", undefined, 9001)
    await r.tg.waitFor(() => r.prompts[0])
    assert.deepEqual(r.prompts, [{ text: "stop that", delivery: "steer" }])
    await r.done()
  })
})
