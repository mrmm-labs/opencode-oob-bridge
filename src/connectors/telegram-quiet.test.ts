import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { fakeTelegram } from "./fake-telegram.test-util.ts"
import { TelegramConnector } from "./telegram.ts"

const CHAT = "4242"

async function rig() {
  const tg = await fakeTelegram()
  let present = true
  let t = 1_000_000
  const c = new TelegramConnector({
    token: async () => tg.token,
    chatId: CHAT,
    apiBase: tg.url,
    rate: { gapMs: 0, perMinute: 600 },
    now: () => t,
  })
  c.mute(() => present)
  const push = { title: "t", message: "hello", priority: 3 as const }
  return {
    tg,
    c,
    push,
    setPresent: (v: boolean) => (present = v),
    advance: (ms: number) => (t += ms),
    call: (m: string, b: Record<string, unknown>) =>
      (c as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)
        .call(m, b)
        .catch((e: Error) => e),
  }
}

describe("Telegram while the person is present", () => {
  it("sends nothing: no message, no typing indicator, no edit", async () => {
    const r = await rig()
    await r.c.send(r.push)
    for (const [m, b] of [
      ["sendChatAction", { chat_id: CHAT, action: "typing" }],
      ["editMessageText", { chat_id: CHAT, message_id: 5, text: "x" }],
      ["sendMessage", { chat_id: CHAT, text: "x" }],
    ] as const)
      assert.match(String(await r.call(m, { ...b })), /muted while present/)
    assert.equal(r.tg.calls.filter((c) => c.method !== "getMe").length, 0)
    const out = r.c.status().out!
    assert.equal(out.sent, 0)
    assert.ok(out.suppressed >= 3, "suppressed " + out.suppressed)
    await r.tg.close()
  })

  it("sends again once the person is away, and counts what it sent", async () => {
    const r = await rig()
    await r.c.send(r.push)
    assert.equal(r.tg.of("sendMessage").length, 0)
    r.setPresent(false)
    await r.c.send(r.push)
    assert.equal(r.tg.of("sendMessage").length, 1)
    assert.equal(r.c.status().out!.sent, 1)
    await r.tg.close()
  })

  it("answers a push the operator asked for, for a short window only", async () => {
    const r = await rig()
    await r.c.send({ ...r.push, explicit: true })
    assert.equal(r.tg.of("sendMessage").length, 1, "a test push goes out")
    await r.c.send(r.push)
    assert.equal(r.tg.of("sendMessage").length, 2, "inside the window")
    r.advance(31_000)
    await r.c.send(r.push)
    assert.equal(r.tg.of("sendMessage").length, 2, "window over: quiet again")
    await r.tg.close()
  })

  it("still answers a button tap, which is never muted", async () => {
    const r = await rig()
    await r.call("answerCallbackQuery", { callback_query_id: "q" })
    assert.equal(r.tg.of("answerCallbackQuery").length, 1)
    await r.tg.close()
  })

  it("hush drops what is queued for the chat", async () => {
    const r = await rig()
    r.setPresent(false)
    const slow = new TelegramConnector({
      token: async () => r.tg.token,
      chatId: CHAT,
      apiBase: r.tg.url,
      rate: { gapMs: 300, perMinute: 600 },
    })
    let present = false
    slow.mute(() => present)
    await slow.send(r.push)
    const later = slow.send({ ...r.push, message: "later" })
    present = true
    slow.hush()
    await later
    assert.equal(r.tg.of("sendMessage").length, 1, "the queued one never went")
    await r.tg.close()
  })

  it("counts a 429 and keeps to retry_after", async () => {
    const r = await rig()
    r.setPresent(false)
    r.tg.fail("sendMessage", 429, { parameters: { retry_after: 0 } })
    await r.c.send(r.push)
    assert.equal(r.c.status().out!.rateLimited, 1)
    assert.equal(r.tg.of("sendMessage").length >= 1, true)
    await r.tg.close()
  })
})
