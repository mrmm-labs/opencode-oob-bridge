import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { flushLog } from "../logger.ts"
import { sleep } from "../util.ts"
import { fakeTelegram } from "./fake-telegram.test-util.ts"
import { TelegramConnector } from "./telegram.ts"

const CHAT = 4242

describe("one poller per bot", () => {
  it("a restarted connector waits for the one it replaces: getUpdates never overlap", async () => {
    const tg = await fakeTelegram()
    let live = 0
    let most = 0
    // An aborted request lingers a moment before it ends, as it does on Telegram's side.
    const counted: typeof fetch = async (url, init) => {
      const poll = String(url).endsWith("/getUpdates")
      if (poll) most = Math.max(most, ++live)
      try {
        return await fetch(url, init)
      } catch (err) {
        if (poll) await sleep(300)
        throw err
      } finally {
        if (poll) live--
      }
    }
    const make = () =>
      new TelegramConnector({
        token: async () => tg.token,
        chatId: String(CHAT),
        apiBase: tg.url,
        pollSeconds: 1,
        backoff: { min: 10, max: 40 },
        fetch: counted,
      })
    const a = new AbortController()
    make().start(async () => undefined, a.signal)
    await tg.waitFor(() => tg.of("getUpdates")[0])
    // The bridge restarts: the old loop is told to stop and a new one starts at once.
    const b = new AbortController()
    a.abort()
    make().start(async () => undefined, b.signal)
    await tg.waitFor(() => (tg.of("getUpdates").length > 3 ? true : undefined))
    assert.equal(most, 1)
    b.abort()
    await sleep(50)
    await tg.close()
  })

  it("a 409 is logged once as a conflict, shown in the status, and clears when polling resumes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oobb-409-"))
    const file = join(dir, "bridge.log")
    const prev = process.env.OPENCODE_OOB_BRIDGE_LOG
    process.env.OPENCODE_OOB_BRIDGE_LOG = file
    const tg = await fakeTelegram()
    const seen: string[] = []
    const c = new TelegramConnector({
      token: async () => tg.token,
      chatId: String(CHAT),
      apiBase: tg.url,
      pollSeconds: 1,
      backoff: { min: 10, max: 20 },
    })
    const ac = new AbortController()
    const body = {
      description: "Conflict: terminated by other getUpdates request",
    }
    for (let i = 0; i < 3; i++) tg.fail("getUpdates", 409, body)
    c.start(async (m) => {
      seen.push(m.text)
      return undefined
    }, ac.signal)
    await tg.waitFor(() =>
      /HTTP 409/.test(c.status().lastError ?? "") ? true : undefined,
    )
    tg.message(CHAT, "still heard", 501)
    await tg.waitFor(() => seen[0])
    assert.equal(c.status().lastError, undefined)
    assert.equal(c.status().connected, true)
    ac.abort()
    await flushLog()
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean)
    assert.equal(
      lines.filter((l) => l.includes("telegram_poll_conflict")).length,
      1,
    )
    assert.equal(lines.filter((l) => l.includes("telegram_error")).length, 0)
    if (prev === undefined) delete process.env.OPENCODE_OOB_BRIDGE_LOG
    else process.env.OPENCODE_OOB_BRIDGE_LOG = prev
    await tg.close()
  })
})
