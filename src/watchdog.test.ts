import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import { selfCheck } from "./deadman.ts"
import { flushLog } from "./logger.ts"
import { sleep, STALL_MS } from "./util.ts"
import { startWatchdog, type WatchChannel } from "./watchdog.ts"

const up = { id: "telegram", enabled: true, connected: true }

describe("the receive-loop watchdog", () => {
  it("restarts the bridge once a loop is silent past the limit, and says which step", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oobb-wd-"))
    const file = join(dir, "bridge.log")
    const prev = process.env.OPENCODE_OOB_BRIDGE_LOG
    process.env.OPENCODE_OOB_BRIDGE_LOG = file
    let silent = 1000
    let restarts = 0
    const stop = startWatchdog({
      channels: () => [
        { ...up, silentMs: silent, pollOkAt: Date.now() - 5000 },
      ],
      restart: async () => void restarts++,
      stallMs: 5000,
      everyMs: 10,
    })
    await sleep(60)
    assert.equal(restarts, 0, "a loop that steps is left alone")
    silent = 9000
    await sleep(80)
    stop()
    assert.equal(restarts, 1, "restarted once, not on every tick")
    await flushLog()
    const line = (await readFile(file, "utf8"))
      .split("\n")
      .filter((l) => l.includes("bridge_stalled"))
      .map((l) => JSON.parse(l))[0]
    assert.equal(line.channel, "telegram")
    assert.equal(line.step, "receive loop")
    assert.equal(line.silent_s, 9)
    if (prev === undefined) delete process.env.OPENCODE_OOB_BRIDGE_LOG
    else process.env.OPENCODE_OOB_BRIDGE_LOG = prev
  })

  it("ignores a channel that is off or has no loop to watch", async () => {
    let restarts = 0
    const rows: WatchChannel[] = [
      { ...up, enabled: false, silentMs: 1e9 },
      { id: "ntfy", enabled: true },
    ]
    const stop = startWatchdog({
      channels: () => rows,
      restart: async () => void restarts++,
      stallMs: 5,
      everyMs: 10,
    })
    await sleep(60)
    stop()
    assert.equal(restarts, 0)
  })
})

describe("a wedged Telegram loop", () => {
  it("shows as silent while sends still work, and the dead-man check turns degraded", async () => {
    const tg = await fakeTelegram()
    let hung = false
    const channel = new TelegramConnector({
      // Once set, a token request never returns, as a hung secret command would.
      token: async () => (hung ? new Promise<string>(() => {}) : tg.token),
      chatId: "42",
      apiBase: tg.url,
      pollSeconds: 1,
      backoff: { min: 10, max: 40 },
    })
    const ac = new AbortController()
    channel.start(async () => undefined, ac.signal)
    await tg.waitFor(() => channel.status().pollOkAt)
    assert.ok(channel.status().pollOkAt)
    hung = true
    await sleep(1500)
    const st = channel.status()
    assert.ok((st.silentMs ?? 0) >= 100, "the loop made no step since")
    const wedged = {
      id: "telegram",
      enabled: true,
      connected: true,
      silentMs: STALL_MS + 1,
    }
    const health = await selfCheck({
      snapshot: () => ({}),
      rpcRegistered: () => true,
      lockHeld: async () => true,
      channels: () => [wedged],
    })
    assert.equal(health.state, "degraded")
    assert.deepEqual(health.reasons, ["poll_stalled:telegram"])
    assert.equal(health.channels.telegram, false)
    ac.abort()
    await tg.close()
  })

  it("records the time of the last accepted send", async () => {
    const tg = await fakeTelegram()
    const channel = new TelegramConnector({
      token: async () => tg.token,
      chatId: "42",
      apiBase: tg.url,
      pollSeconds: 1,
    })
    assert.equal(channel.status().sendOkAt, undefined)
    await channel.send({ title: "t", message: "m", priority: 3 })
    assert.ok(channel.status().sendOkAt)
    await tg.close()
  })
})
