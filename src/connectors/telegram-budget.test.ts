import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Muted, SendBudget } from "./telegram-budget.ts"

const budget = (gapMs: number, perMinute: number, muted = () => false) =>
  new SendBudget({ gapMs, perMinute }, Date.now, muted)

const msg = (text: string, extra: Record<string, unknown> = {}) => ({
  chat_id: 1,
  text,
  ...extra,
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("the send budget", () => {
  it("paces only calls to a chat", () => {
    assert.equal(SendBudget.paced("sendMessage", { chat_id: 1 }), true)
    assert.equal(SendBudget.paced("sendChatAction", { chat_id: 1 }), true)
    assert.equal(SendBudget.paced("getUpdates", { timeout: 5 }), false)
    assert.equal(SendBudget.paced("answerCallbackQuery", { chat_id: 1 }), false)
    assert.equal(SendBudget.paced("sendMessage", {}), false)
  })

  it("spaces calls to one chat by the gap, in order, and never fails them", async () => {
    const b = budget(40, 100)
    const at: number[] = []
    const order: string[] = []
    const run = (text: string) => async (body: Record<string, unknown>) => {
      at.push(Date.now())
      order.push(String(body.text))
      return text
    }
    const buttons = { reply_markup: { inline_keyboard: [] } }
    const all = await Promise.all(
      ["a", "b", "c", "d"].map((t) =>
        b.run("sendMessage", msg(t, buttons), run(t)),
      ),
    )
    assert.deepEqual(all, ["a", "b", "c", "d"])
    assert.deepEqual(order, ["a", "b", "c", "d"])
    for (let i = 1; i < at.length; i++)
      assert.ok(at[i] - at[i - 1] >= 35, "gap " + (at[i] - at[i - 1]))
  })

  it("lets another chat go at once", async () => {
    const b = budget(200, 100)
    const t0 = Date.now()
    await b.run("sendMessage", msg("a"), async () => 1)
    await b.run("sendMessage", { chat_id: 2, text: "b" }, async () => 2)
    assert.ok(Date.now() - t0 < 150)
  })

  it("holds calls over the per-minute cap instead of sending them", async () => {
    const b = budget(0, 3)
    let sent = 0
    const buttons = { reply_markup: { inline_keyboard: [] } }
    const calls = Array.from({ length: 5 }, (_, i) =>
      b
        .run("sendMessage", msg("m" + i, buttons), async () => ++sent)
        .catch((e) => e),
    )
    await sleep(80)
    assert.equal(sent, 3, "three go, two wait")
    b.drop()
    const rest = (await Promise.all(calls)).slice(3)
    assert.ok(rest.every((e) => e instanceof Muted))
    assert.equal(sent, 3)
  })

  it("merges queued plain messages into one call, and keeps their order", async () => {
    const b = budget(60, 100)
    const sent: string[] = []
    const run = async (body: Record<string, unknown>) => {
      sent.push(String(body.text))
      return sent.length
    }
    const all = await Promise.all([
      b.run("sendMessage", msg("first"), run),
      b.run("sendMessage", msg("one"), run),
      b.run("sendMessage", msg("two"), run),
      b.run("sendMessage", msg("three"), run),
    ])
    assert.deepEqual(sent, ["first", "one\n\ntwo\n\nthree"])
    assert.deepEqual(all, [1, 2, 2, 2], "every caller gets the one answer")
    assert.equal(b.stats.coalesced, 2)
  })

  it("does not merge a message with buttons, or one that would be too long", async () => {
    const b = budget(40, 100)
    const sent: string[] = []
    const run = async (body: Record<string, unknown>) => {
      sent.push(String(body.text))
    }
    await Promise.all([
      b.run("sendMessage", msg("first"), run),
      b.run("sendMessage", msg("ask", { reply_markup: { x: 1 } }), run),
      b.run("sendMessage", msg("x".repeat(2000)), run),
      b.run("sendMessage", msg("y".repeat(2000)), run),
    ])
    assert.equal(sent.length, 4)
    assert.equal(b.stats.coalesced, 0)
  })

  it("replaces a queued edit of the same message with the newest text", async () => {
    const b = budget(60, 100)
    const sent: string[] = []
    const run = async (body: Record<string, unknown>) => {
      sent.push(String(body.text))
    }
    const edit = (text: string, id = 7) => ({
      chat_id: 1,
      message_id: id,
      text,
    })
    await Promise.all([
      b.run("sendMessage", msg("first"), run),
      b.run("editMessageText", edit("v1"), run),
      b.run("editMessageText", edit("v2"), run),
      b.run("editMessageText", edit("v3"), run),
      b.run("editMessageText", edit("other", 8), run),
    ])
    assert.deepEqual(sent, ["first", "v3", "other"])
  })

  it("drops a typing indicator when the chat is busy", async () => {
    const b = budget(60, 100)
    let typed = 0
    const act = () =>
      b.run("sendChatAction", { chat_id: 1 }, async () => ++typed)
    await b.run("sendMessage", msg("a"), async () => 1)
    await act()
    assert.equal(typed, 0, "inside the gap")
    await sleep(70)
    await act()
    assert.equal(typed, 1, "idle chat")
  })

  it("waits out a 429 retry_after for the whole chat", async () => {
    const b = budget(0, 100)
    b.cool(1, 0.12)
    const t0 = Date.now()
    await b.run("sendMessage", msg("a"), async () => 1)
    assert.ok(Date.now() - t0 >= 100, "waited " + (Date.now() - t0))
  })

  it("rejects what is queued with Muted when the person is present", async () => {
    let present = false
    const b = budget(50, 100, () => present)
    const first = b.run("sendMessage", msg("a"), async () => "ok")
    const second = b
      .run("sendMessage", msg("b", { reply_markup: {} }), async () => "late")
      .catch((e) => e)
    assert.equal(await first, "ok")
    present = true
    assert.ok((await second) instanceof Muted)
  })
})
