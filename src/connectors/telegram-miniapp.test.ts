import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { fakeTelegram } from "./fake-telegram.test-util.ts"
import { TelegramConnector } from "./telegram.ts"

const APP = {
  url: "https://app.example.com/app/",
  link: "https://t.me/examplebot/app",
}

async function rig(
  chatId: string,
  launch = true,
  who: { operator?: string; operatorFallback?: string } = { operator: "42" },
) {
  const tg = await fakeTelegram()
  const dir = await mkdtemp(join(tmpdir(), "oob-tgapp-"))
  const channel = new TelegramConnector({
    token: async () => tg.token,
    chatId,
    ...who,
    apiBase: tg.url,
    offsetFile: join(dir, "offset.json"),
    backoff: { min: 10, max: 40 },
    pollSeconds: 1,
  })
  if (launch) channel.launch(APP)
  const ac = new AbortController()
  channel.start(async () => undefined, ac.signal)
  return {
    tg,
    channel,
    async done() {
      ac.abort()
      await tg.close()
    },
  }
}

const ask = (id = "ses_1") => ({
  message: "Allow?",
  session: { id, name: "shop · x", project: "shop" },
  permission: { id: "p1", choices: ["once" as const] },
})

const buttons = (m: { body: any }) =>
  (m.body.reply_markup?.inline_keyboard ?? []).flat() as Array<
    Record<string, any>
  >

describe("Telegram Mini App launch", () => {
  it("offers a web_app button in a private chat, with the session in the query", async () => {
    const r = await rig("42")
    await r.channel.send(ask())
    const open = buttons(r.tg.of("sendMessage")[0]).find(
      (b) => b.text === "📱 Open",
    )
    assert.deepEqual(open?.web_app, {
      url: "https://app.example.com/app/?s=s_ses_1",
    })
    await r.done()
  })

  it("offers a t.me direct link in a group, because web_app buttons work only in private chats", async () => {
    const r = await rig("-100777")
    await r.channel.send(ask())
    const open = buttons(r.tg.of("sendMessage")[0]).find(
      (b) => b.text === "📱 Open",
    )
    assert.equal(open?.url, "https://t.me/examplebot/app?startapp=s_ses_1")
    assert.equal(open?.web_app, undefined)
    await r.done()
  })

  it("keeps the permission buttons next to the Open button", async () => {
    const r = await rig("-100777")
    await r.channel.send(ask())
    const texts = buttons(r.tg.of("sendMessage")[0]).map((b) => b.text)
    assert.ok(texts.includes("📱 Open"))
    assert.ok(texts.length > 1, "the decision buttons are still there")
    await r.done()
  })

  it("offers nothing in a group without a direct link, nor before launch is configured", async () => {
    const r = await rig("-100777", false)
    r.channel.launch({ url: APP.url })
    await r.channel.send(ask())
    assert.equal(
      buttons(r.tg.of("sendMessage")[0]).some((b) => b.text === "📱 Open"),
      false,
    )
    await r.done()
    const n = await rig("42", false)
    await n.channel.send(ask())
    assert.equal(
      buttons(n.tg.of("sendMessage")[0]).some((b) => b.text === "📱 Open"),
      false,
    )
    await n.done()
  })

  it("leaves out a session id that is not safe in a link", async () => {
    const r = await rig("-100777")
    await r.channel.send(ask("a b/c"))
    assert.equal(
      buttons(r.tg.of("sendMessage")[0]).some((b) => b.text === "📱 Open"),
      false,
    )
    await r.done()
  })

  it("sets the menu button in the private chat, once", async () => {
    const r = await rig("42")
    const call = await r.tg.waitFor(() => r.tg.of("setChatMenuButton")[0])
    assert.deepEqual(call.body.menu_button, {
      type: "web_app",
      text: "Open",
      web_app: { url: APP.url },
    })
    assert.equal(call.body.chat_id, 42)
    await r.channel.send(ask())
    assert.equal(r.tg.of("setChatMenuButton").length, 1)
    await r.done()
  })

  it("sets the menu button in the operator's own chat when paired to a group, once", async () => {
    const g = await rig("-100777")
    const call = await g.tg.waitFor(() => g.tg.of("setChatMenuButton")[0])
    assert.equal(call.body.chat_id, 42)
    assert.deepEqual(call.body.menu_button, {
      type: "web_app",
      text: "Open",
      web_app: { url: APP.url },
    })
    await g.channel.send(ask())
    await g.channel.send(ask("ses_2"))
    assert.equal(g.tg.of("setChatMenuButton").length, 1)
    await g.done()
  })

  it("takes the operator from the config file when pairing stored none", async () => {
    const g = await rig("-100777", true, { operatorFallback: "77" })
    const call = await g.tg.waitFor(() => g.tg.of("setChatMenuButton")[0])
    assert.equal(call.body.chat_id, 77)
    assert.equal(g.channel.operator(), "77")
    await g.done()
  })

  it("prefers the id stored at pairing over the config file", async () => {
    const g = await rig("-100777", true, {
      operator: "42",
      operatorFallback: "77",
    })
    const call = await g.tg.waitFor(() => g.tg.of("setChatMenuButton")[0])
    assert.equal(call.body.chat_id, 42)
    await g.done()
  })

  it("sets no menu button for a group when the operator is unknown", async () => {
    const g = await rig("-100777", true, {})
    await new Promise((ok) => setTimeout(ok, 150))
    assert.equal(g.tg.of("setChatMenuButton").length, 0)
    await g.done()
  })
})
