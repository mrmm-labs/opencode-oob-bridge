import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { fakeTelegram } from "./fake-telegram.test-util.ts"
import { TelegramConnector } from "./telegram.ts"

describe("a Telegram call that hangs on a dead connection", () => {
  it("is tried once more on a new one, so a message is not lost", async () => {
    const tg = await fakeTelegram()
    let failed = 0
    const flaky: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/sendMessage") && failed++ === 0)
        throw new TypeError("fetch failed")
      return fetch(url, init)
    }
    const c = new TelegramConnector({
      token: async () => tg.token,
      chatId: "4242",
      apiBase: tg.url,
      fetch: flaky,
    })
    const ref = await c.send({ title: "t", message: "hello", priority: 3 })
    assert.ok(ref !== false && ref !== undefined)
    assert.equal(failed, 2, "one failure, one retry")
    assert.equal(tg.of("sendMessage").length, 1)
    await tg.close()
  })

  it("is given up after the second failure", async () => {
    const tg = await fakeTelegram()
    let calls = 0
    const dead: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/sendMessage")) {
        calls++
        throw new TypeError("fetch failed")
      }
      return fetch(url, init)
    }
    const c = new TelegramConnector({
      token: async () => tg.token,
      chatId: "4242",
      apiBase: tg.url,
      fetch: dead,
    })
    const ref = await c.send({ title: "t", message: "hello", priority: 3 })
    assert.ok(ref === false || ref === undefined)
    assert.equal(calls, 2)
    await tg.close()
  })
})
