import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Bridge, type BridgeEvent, type Host } from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import {
  NtfyConnector,
  type Ntfy,
  type NtfyConfig,
  type Publish,
} from "./connectors/ntfy.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"

const MIN = 60_000

function setup() {
  let t = 1_700_000_000_000
  const now = () => t
  const cfg = parseConfig({
    server: "https://ntfy.example",
    topics: { out: "oc-out", in: "oc-in" },
  }) as Config
  const published: Publish[] = []
  const ntfy = {
    publish: async (p: Publish) => {
      published.push(p)
      return "m" + published.length
    },
    subscribe: async () => {},
    connected: true,
    error: () => undefined,
  } as unknown as Ntfy
  const host: Host = {
    session: async (id) => ({
      id,
      agent: "coordinator",
      directory: "/w/shop",
      title: "Fix checkout",
    }),
    root: (id) => id,
    replyForm: async () => {},
  }
  const router = new Router(cfg, async () => true, now)
  const channel = new NtfyConnector(
    "ntfy",
    ntfy,
    cfg.channels.ntfy.options as NtfyConfig,
  )
  const bridge = new Bridge(
    cfg,
    host,
    [channel],
    new PendingStore(),
    router,
    now,
  )
  bridge.start()
  return {
    bridge,
    router,
    published,
    advance: (ms: number) => (t += ms),
    text: () => published.map((p) => p.message).join("\n---\n"),
  }
}

const ask = (id: string): BridgeEvent =>
  ({
    type: "form.created",
    data: {
      form: {
        id,
        sessionID: "root",
        title: "Questions",
        metadata: { kind: "question" },
        fields: [
          {
            key: "q0",
            type: "string",
            description: "Deploy?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      },
    },
  }) as BridgeEvent

const done = (): BridgeEvent =>
  ({
    type: "session.execution.succeeded",
    data: { sessionID: "root" },
  }) as BridgeEvent

describe("quiet while present", () => {
  it("sends nothing while present, whatever the session mode", async () => {
    const s = setup()
    for (const mode of [undefined, true, false]) {
      s.router.set("root", mode)
      await s.bridge.onEvent(ask("frm_" + mode))
    }
    assert.equal(s.published.length, 0)
    s.bridge.stop()
  })

  it("a session on auto routes when away; off never does", async () => {
    const s = setup()
    s.advance(11 * MIN)
    await s.bridge.onEvent(ask("frm_1"))
    assert.equal(s.published.length, 1)
    s.router.set("root", false)
    await s.bridge.onEvent(ask("frm_2"))
    assert.equal(s.published.length, 1)
    s.bridge.stop()
  })

  it("a timed /afk sends while present, then stops by itself", async () => {
    const s = setup()
    s.router.setAfk("on", s.router.afkEnds() ?? Date.now() * 2)
    s.router.setAfk("on")
    await s.bridge.onEvent(ask("frm_1"))
    assert.equal(s.published.length, 1)
    s.advance(121 * MIN)
    s.router.touch()
    await s.bridge.onEvent(ask("frm_2"))
    assert.equal(s.published.length, 1, "the time-box ended")
    s.bridge.stop()
  })

  it("holds what happened while present, sends the held questions and one digest on going away", async () => {
    const s = setup()
    await s.bridge.onEvent(ask("frm_1"))
    await s.bridge.onEvent(ask("frm_2"))
    await s.bridge.onEvent(done())
    assert.equal(s.published.length, 0)
    assert.equal(s.bridge.status().quiet.held, 3)
    s.advance(11 * MIN)
    await s.bridge.presenceTick()
    const digests = s.published.filter((p) =>
      /While you were at the Mac/.test(p.message),
    )
    assert.equal(digests.length, 1)
    assert.ok(
      !/questions? waiting/.test(digests[0].message),
      "sent, not counted",
    )
    assert.match(digests[0].message, /1 finished/)
    const asked = s.published.filter(
      (p) => !/While you were|Routing on/.test(p.message),
    )
    assert.equal(asked.length, 2, "each held question is sent once")
    assert.equal(s.bridge.status().quiet.digests, 1)
    const before = s.published.length
    await s.bridge.presenceTick()
    s.advance(MIN)
    await s.bridge.presenceTick()
    assert.equal(s.published.length, before, "once, not again")
    s.bridge.stop()
  })

  it("sends no digest when nothing was held", async () => {
    const s = setup()
    s.advance(11 * MIN)
    await s.bridge.presenceTick()
    assert.ok(!/While you were/.test(s.text()))
    assert.equal(s.bridge.status().quiet.digests, 0)
    s.bridge.stop()
  })

  it("coming back sends nothing", async () => {
    const s = setup()
    s.advance(11 * MIN)
    await s.bridge.presenceTick()
    const before = s.published.length
    s.router.touch()
    await s.bridge.presenceTick()
    assert.equal(s.published.length, before)
    s.bridge.stop()
  })

  it("sends one line with the reason when a Telegram message makes it away, none when it ends", async () => {
    const tg = await fakeTelegram()
    let t = 1_700_000_000_000
    const now = () => t
    const cfg = parseConfig({
      channels: { telegram: { token: { env: "X" } } },
    }) as Config
    const router = new Router(cfg, async () => true, now)
    const bridge = new Bridge(
      cfg,
      {
        session: async (id) => ({ id, agent: "a", directory: "/w/shop" }),
        root: (id) => id,
        replyForm: async () => {},
      } as Host,
      [
        new TelegramConnector({
          token: async () => tg.token,
          chatId: "4242",
          apiBase: tg.url,
          rate: { gapMs: 0, perMinute: 600 },
        }),
      ],
      new PendingStore(),
      router,
      now,
    )
    bridge.start()
    router.phone()
    await bridge.presenceTick()
    const lines = tg
      .of("sendMessage")
      .filter((c) => /Routing on/.test(c.body.text))
    assert.equal(lines.length, 1)
    assert.match(lines[0].body.text, /phone active 0s ago, ends in 30 min/)
    t += 31 * MIN
    router.touch()
    const before = tg.of("sendMessage").length
    await bridge.presenceTick()
    assert.equal(tg.of("sendMessage").length, before, "present: no line")
    await bridge.stop()
    await tg.close()
  })
})

describe("every session at once", () => {
  it("setAllWatch sets every session and says how many", () => {
    const s = setup()
    s.router.set("a", true)
    s.router.set("b", false, "ntfy")
    assert.equal(s.bridge.setAllWatch("auto"), 2)
    assert.equal(s.router.mode("a"), "auto")
    assert.equal(s.router.mode("b"), "auto")
    assert.equal(s.router.channel("b"), "ntfy", "the channel is kept")
    s.router.set("a", true)
    assert.equal(s.bridge.setAllWatch("off"), 2)
    assert.equal(s.router.mode("a"), "off")
    s.bridge.stop()
  })

  it("a new session is on auto", () => {
    const s = setup()
    assert.equal(s.router.mode("fresh"), "auto")
    assert.equal(s.router.mode("child"), "auto")
    s.bridge.stop()
  })
})
