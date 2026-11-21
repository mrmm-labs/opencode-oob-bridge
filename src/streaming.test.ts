import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { parseConfig, type Config } from "./config.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import { sleep } from "./util.ts"

const s = { id: "root", name: "shop · Fix", project: "shop" }

async function rig(o: { chat?: string; draftRefreshMs?: number } = {}) {
  const clock = { t: 1_000_000 }
  const tg = await fakeTelegram()
  tg.forum = o.chat === undefined
  const c = new TelegramConnector({
    token: async () => tg.token,
    chatId: o.chat ?? "-100123",
    apiBase: tg.url,
    now: () => clock.t,
    draftRefreshMs: o.draftRefreshMs,
    draft: o.draft ?? o.chat !== undefined,
  })
  const idle = () =>
    tg.waitFor(
      () =>
        !(
          c as unknown as { streams: Map<string, { running: boolean }> }
        ).streams.get(s.id)?.running,
    )
  return {
    tg,
    c,
    clock,
    idle,
    calls: () => tg.of("sendMessage").length + tg.of("editMessageText").length,
    async done() {
      await tg.close()
    },
  }
}

describe("streaming: the draft path", () => {
  it("a private chat gets one draft id with the whole text so far, then the final message", async () => {
    const r = await rig({ chat: "4242" })
    r.c.stream(s, "Hello")
    const d1 = await r.tg.waitFor(() => r.tg.of("sendMessageDraft")[0])
    await r.idle()
    r.clock.t += 1100
    r.c.stream(s, "Hello world")
    const d2 = await r.tg.waitFor(() => r.tg.of("sendMessageDraft")[1])
    assert.equal(d1.body.draft_id, d2.body.draft_id)
    assert.equal(d2.body.text, "Hello world")
    assert.equal(r.tg.of("editMessageText").length, 0)
    assert.equal(r.tg.of("sendMessage").length, 0, "the draft is not a message")
    await r.c.reply(s, "Hello world!")
    assert.equal(r.tg.of("sendMessage").length, 1)
    assert.equal(r.tg.of("sendMessage")[0].body.text, "Hello world!")
    await r.done()
  })

  it("the draft is sent again while the model is silent", async () => {
    const r = await rig({ chat: "4242", draftRefreshMs: 60 })
    r.c.stream(s, "Thinking")
    await r.tg.waitFor(() => r.tg.of("sendMessageDraft")[0])
    await r.tg.waitFor(() => r.tg.of("sendMessageDraft")[1])
    assert.equal(r.tg.of("sendMessageDraft")[1].body.text, "Thinking")
    await r.c.reply(s, "Done")
    const n = r.tg.of("sendMessageDraft").length
    await sleep(200)
    assert.equal(r.tg.of("sendMessageDraft").length, n, "stops with the reply")
    await r.done()
  })

  it("a private chat is streamed by edits until draft is switched on", async () => {
    const r = await rig({ chat: "4242", draft: false })
    r.c.stream(s, "Hello")
    await r.tg.waitFor(() => r.tg.of("sendMessage")[0])
    assert.equal(r.tg.of("sendMessageDraft").length, 0)
    await r.done()
  })

  it("a group is never sent a draft", async () => {
    const r = await rig()
    r.c.stream(s, "Hello")
    await r.tg.waitFor(() => r.tg.of("sendMessage")[0])
    assert.equal(r.tg.of("sendMessageDraft").length, 0)
    await r.done()
  })

  it("a refused draft falls back to edits for ten minutes", async () => {
    const r = await rig({ chat: "4242" })
    r.tg.fail("sendMessageDraft", 400, { description: "not supported" })
    r.c.stream(s, "Hello")
    await r.tg.waitFor(() => r.tg.of("sendMessage")[0])
    assert.equal(r.tg.of("sendMessageDraft").length, 1)
    await r.idle()
    r.clock.t += 1100
    r.c.stream(s, "Hello there")
    await r.tg.waitFor(() => r.tg.of("editMessageText")[0])
    assert.equal(r.tg.of("sendMessageDraft").length, 1, "no second try")
    await r.idle()
    r.clock.t += 11 * 60_000
    r.c.stream(s, "Hello there again")
    await r.tg.waitFor(() => r.tg.of("sendMessageDraft")[1])
    await r.done()
  })

  it("draft and edits show the same text", async () => {
    const md = "**bold** and code <tag> & more"
    const d = await rig({ chat: "4242" })
    d.c.stream(s, md)
    const draft = await d.tg.waitFor(() => d.tg.of("sendMessageDraft")[0])
    await d.done()
    const e = await rig()
    e.c.stream(s, md)
    const sent = await e.tg.waitFor(() => e.tg.of("sendMessage")[0])
    assert.equal(draft.body.text, sent.body.text)
    await e.done()
  })
})

describe("streaming: edit limits", () => {
  it("a 429 widens the gap, a quiet half minute narrows it, and the pause sends only the newest text", async () => {
    const r = await rig()
    r.c.stream(s, "a")
    await r.tg.waitFor(() => r.tg.of("sendMessage")[0])
    await r.idle()
    r.clock.t += 1100
    r.tg.fail("editMessageText", 429, { parameters: { retry_after: 1 } })
    r.c.stream(s, "a b")
    await r.tg.waitFor(() => r.tg.of("editMessageText")[0])
    await r.idle()
    r.c.stream(s, "a b c")
    r.c.stream(s, "a b c d")
    await sleep(60)
    assert.equal(r.tg.of("editMessageText").length, 1, "paused")
    r.clock.t += 1100
    r.c.stream(s, "a b c d e")
    await r.tg.waitFor(() => r.tg.of("editMessageText")[1])
    assert.equal(
      r.tg.of("editMessageText")[1].body.text,
      "a b c d e",
      "coalesced",
    )
    await r.idle()
    r.clock.t += 1100
    r.c.stream(s, "a b c d e f")
    await sleep(60)
    assert.equal(r.tg.of("editMessageText").length, 2, "the gap is 2 s now")
    r.clock.t += 1000
    r.c.stream(s, "a b c d e f g")
    await r.tg.waitFor(() => r.tg.of("editMessageText")[2])
    await r.idle()
    r.clock.t += 31_000
    r.c.stream(s, "a b c d e f g h")
    await r.tg.waitFor(() => r.tg.of("editMessageText")[3])
    await r.idle()
    r.clock.t += 1100
    r.c.stream(s, "a b c d e f g h i")
    await r.tg.waitFor(() => r.tg.of("editMessageText")[4])
    await r.done()
  })

  it("never makes more than the budget in a minute, and carries on when the minute moves", async () => {
    const r = await rig()
    for (let i = 0; i < 8; i++) {
      r.c.stream(s, "word ".repeat(i + 1), 800, 3)
      await sleep(40)
      await r.idle()
      r.clock.t += 1100
    }
    assert.equal(r.calls(), 3, "3 in the first minute")
    r.clock.t += 60_000
    r.c.stream(s, "word ".repeat(20), 800, 3)
    await r.tg.waitFor(() => (r.calls() > 3 ? true : undefined))
    await r.done()
  })
})

describe("streaming: config", () => {
  const base = { channels: { telegram: { token: { env: "X" } } } }
  it("chat.streamBudget is 30 by default, and a whole number from 1 to 600", () => {
    const c = (streamBudget?: unknown) =>
      parseConfig({ ...base, chat: { streamBudget } }) as Config
    assert.equal(c().chat.streamBudget, 30)
    assert.equal(c(10).chat.streamBudget, 10)
    for (const bad of [0, 601, 1.5, "30"])
      assert.ok("error" in (c(bad) as object), String(bad))
  })
})
