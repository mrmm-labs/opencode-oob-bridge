import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Deadman, parseBeat, telegramSender, type Beat } from "./deadman.ts"
import { render } from "./metrics.ts"
import { setSink } from "./log.ts"

const MIN = 60_000
function rig(o: { sendOk?: () => boolean } = {}) {
  let t = 1_000_000_000_000
  const sent: string[] = []
  const d = new Deadman({
    now: () => t,
    send: async (x) => {
      if (o.sendOk && !o.sendOk()) return false
      sent.push(x)
      return true
    },
    intervalMs: 30_000,
    missed: 3,
    stoppingMs: 5 * MIN,
    reminderMs: 30 * MIN,
  })
  const up: Beat = { state: "up", reasons: [] }
  return {
    d,
    sent,
    up,
    at: (ms: number) => (t += ms),
    now: () => t,
  }
}

describe("dead-man receiver", () => {
  it("says nothing after a start until the first heartbeat", async () => {
    const r = rig()
    r.at(60 * MIN)
    await r.d.tick()
    assert.deepEqual(r.sent, [])
    assert.equal(r.d.shown(), "unknown")
    assert.equal(r.d.consecutiveMissed(), 0)
  })

  it("alerts once after three missed intervals and reminds every 30 minutes", async () => {
    const r = rig()
    r.d.beat(r.up)
    r.at(89_000)
    await r.d.tick()
    assert.deepEqual(r.sent, [])
    r.at(2_000)
    await r.d.tick()
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0], /No heartbeat from the bridge/)
    assert.equal(r.d.shown(), "silent")
    r.at(29 * MIN)
    await r.d.tick()
    assert.equal(r.sent.length, 1, "one alert per outage")
    r.at(2 * MIN)
    await r.d.tick()
    assert.equal(r.sent.length, 2)
    assert.match(r.sent[1], /Still down/)
  })

  it("sends one recovery message on the first up heartbeat", async () => {
    const r = rig()
    r.d.beat(r.up)
    r.at(5 * MIN)
    await r.d.tick()
    r.d.beat(r.up)
    r.d.beat(r.up)
    await r.d.tick()
    assert.equal(r.sent.length, 2)
    assert.match(r.sent[1], /Recovered/)
    assert.equal(r.d.shown(), "up")
  })

  it("alerts on two consecutive degraded beats, naming the reasons, and not on one", async () => {
    const r = rig()
    r.d.beat({ state: "degraded", reasons: ["channel_down:telegram"] })
    assert.deepEqual(r.sent, [])
    r.d.beat({ state: "degraded", reasons: ["channel_down:telegram"] })
    await r.d.tick()
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0], /degraded: channel_down:telegram/)
    r.d.beat({ state: "degraded", reasons: ["channel_down:telegram"] })
    assert.equal(r.sent.length, 1)
    r.d.beat({ state: "up", reasons: [] })
    await r.d.tick()
    assert.match(r.sent[1], /Recovered/)
  })

  it("an up beat between two degraded ones resets the count", async () => {
    const r = rig()
    r.d.beat({ state: "degraded", reasons: ["a"] })
    r.d.beat(r.up)
    r.d.beat({ state: "degraded", reasons: ["a"] })
    await r.d.tick()
    assert.deepEqual(r.sent, [])
  })

  it("does not alert for a planned stop that comes back within five minutes", async () => {
    const r = rig()
    r.d.beat(r.up)
    r.d.beat({ state: "stopping", reasons: [] })
    r.at(4 * MIN)
    await r.d.tick()
    assert.equal(r.d.shown(), "stopping")
    r.d.beat(r.up)
    await r.d.tick()
    assert.deepEqual(r.sent, [])
  })

  it("alerts when a planned stop does not come back in five minutes", async () => {
    const r = rig()
    r.d.beat({ state: "stopping", reasons: [] })
    r.at(5 * MIN + 1000)
    await r.d.tick()
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0], /stopped on purpose/)
  })

  it("goes from degraded to silent in one more message", async () => {
    const r = rig()
    r.d.beat({ state: "degraded", reasons: ["x"] })
    r.d.beat({ state: "degraded", reasons: ["x"] })
    r.at(2 * MIN)
    await r.d.tick()
    assert.equal(r.sent.length, 2)
    assert.match(r.sent[1], /any more/)
  })

  it("tries a message again every 30 seconds until Telegram takes it", async () => {
    let ok = false
    const r = rig({ sendOk: () => ok })
    setSink(() => {})
    r.d.beat(r.up)
    r.at(5 * MIN)
    await r.d.tick()
    assert.deepEqual(r.sent, [])
    r.at(10_000)
    await r.d.tick()
    assert.deepEqual(r.sent, [], "not yet")
    ok = true
    r.at(30_000)
    await r.d.tick()
    assert.equal(r.sent.length, 1)
    setSink((l) => void process.stdout.write(l + "\n"))
  })

  it("counts missed intervals and reports the three metrics", async () => {
    const r = rig()
    r.d.beat(r.up)
    r.at(95_000)
    assert.equal(r.d.consecutiveMissed(), 3)
    const text = render(r.d, { up: () => true, refused: () => ({ mac: 2 }) })
    assert.match(
      text,
      /^oob_bridge_last_heartbeat_timestamp_seconds 1000000000$/m,
    )
    assert.match(text, /^oob_bridge_state\{state="silent"\} 1$/m)
    assert.match(text, /^oob_bridge_state\{state="up"\} 0$/m)
    assert.match(text, /^oob_bridge_consecutive_missed 3$/m)
    assert.match(text, /^oob_relay_link_up 1$/m)
    assert.match(text, /oob_relay_frames_refused_total\{reason="mac"\} 2/)
  })
})

describe("parseBeat", () => {
  it("reads the state and the reasons, and drops what is not a reason code", () => {
    assert.deepEqual(
      parseBeat({
        state: "degraded",
        seq: 3,
        reasons: ["ok_1", "bad reason!", 5, "x".repeat(80)],
      }),
      {
        state: "degraded",
        seq: 3,
        reasons: ["ok_1"],
      },
    )
    assert.equal(parseBeat({ state: "weird" }), undefined)
    assert.equal(parseBeat(null), undefined)
    assert.equal(parseBeat("up"), undefined)
    assert.equal(parseBeat({ state: "up" })?.reasons.length, 0)
  })

  it("keeps at most eight reasons", () => {
    const b = parseBeat({
      state: "degraded",
      reasons: Array.from({ length: 20 }, (_, i) => "r" + i),
    })
    assert.equal(b?.reasons.length, 8)
  })
})

describe("telegramSender", () => {
  it("calls sendMessage with the alert bot's token and nothing else, and never logs the URL", async () => {
    const calls: Array<{ url: string; body: string }> = []
    const lines: string[] = []
    setSink((l) => lines.push(l))
    const fetchFn = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body })
      return new Response("{}", { status: 400 })
    }) as unknown as typeof fetch
    const send = telegramSender({
      token: "111:ALERT-TOKEN",
      chatId: "55",
      apiBase: "http://tg.test",
      fetch: fetchFn,
    })
    assert.equal(await send("hello"), false)
    assert.equal(calls[0].url, "http://tg.test/bot111:ALERT-TOKEN/sendMessage")
    assert.deepEqual(JSON.parse(calls[0].body), {
      chat_id: "55",
      text: "hello",
      disable_web_page_preview: true,
    })
    assert.ok(!lines.join("").includes("ALERT-TOKEN"))
    assert.match(lines.join(""), /alert_send_failed/)
    setSink((l) => void process.stdout.write(l + "\n"))
  })

  it("only logs when no alert bot is configured", async () => {
    setSink(() => {})
    const send = telegramSender({ apiBase: "http://tg.test" })
    assert.equal(await send("x"), true)
    setSink((l) => void process.stdout.write(l + "\n"))
  })
})
