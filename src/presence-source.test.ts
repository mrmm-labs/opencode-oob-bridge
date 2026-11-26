import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  Bridge,
  type BridgeEvent,
  type Host,
  type SessionInfo,
} from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import { flushLog } from "./logger.ts"
import { PendingStore } from "./pending.ts"
import { Router, type Source } from "./routing.ts"

const CHAT = 4242
const MIN = 60_000

const cfgOf = () =>
  parseConfig({
    channels: { telegram: { token: { env: "X" } } },
  }) as Config

describe("the router takes input by source", () => {
  const rig = () => {
    let t = 1_700_000_000_000
    const r = new Router(
      cfgOf(),
      async () => true,
      () => t,
    )
    return { r, advance: (ms: number) => (t += ms), now: () => t }
  }

  it("a TUI is here; the start of the bridge says so", () => {
    const { r, advance } = rig()
    assert.match(r.why(), /^here: bridge started 0s ago/)
    advance(MIN)
    r.input("tui")
    assert.equal(r.state().source, "tui")
    assert.match(r.why(), /^here: TUI input 0s ago/)
    advance(2 * MIN)
    assert.match(r.why(), /^here: TUI input 2m ago/)
  })

  for (const source of ["telegram", "app"] as Source[])
    it(`${source} is the phone: away, and why says so`, () => {
      const { r, advance } = rig()
      r.input(source)
      assert.equal(r.state().away, true)
      assert.equal(r.state().reason, "phone")
      assert.equal(r.state().source, source)
      advance(30_000)
      assert.match(r.why(), /^away: phone active 30s ago/)
    })

  for (const source of ["agent", "rpc"] as Source[])
    it(`${source} changes nothing`, () => {
      const { r, advance } = rig()
      advance(11 * MIN)
      assert.equal(r.state().reason, "idle")
      r.input(source)
      assert.equal(r.state().reason, "idle", "still idle")
      assert.equal(r.lastIgnored()?.source, source)
      r.input("telegram")
      r.input(source)
      assert.equal(r.state().reason, "phone")
    })

  it("a Telegram message never turns the state to here, however many", () => {
    const { r, advance } = rig()
    r.input("tui")
    assert.equal(r.state().away, false)
    for (let i = 0; i < 10; i++) {
      advance(20_000)
      r.input("telegram")
      assert.equal(r.state().away, true, "message " + i)
    }
    r.input("agent")
    r.input("app")
    r.input("rpc")
    assert.equal(r.state().away, true)
  })

  it("only continued input at the Mac ends the phone window", () => {
    const { r, advance } = rig()
    r.input("telegram")
    advance(5_000)
    r.input("tui")
    assert.equal(r.state().reason, "phone", "a glance")
    for (let i = 0; i < 7; i++) {
      advance(10_000)
      r.input("tui")
    }
    assert.equal(r.state().away, false)
    assert.equal(r.state().source, "tui")
  })
})

type Table = Map<string, SessionInfo>

async function rig(
  o: {
    sessions?: SessionInfo[]
    attached?: boolean
    openIds?: Set<string>
  } = {},
) {
  const tg = await fakeTelegram()
  const dir = await mkdtemp(join(tmpdir(), "oobb-presence-"))
  let t = 1_700_000_000_000
  const now = () => t
  const table: Table = new Map(
    (
      o.sessions ?? [
        { id: "root", agent: "coord", directory: "/w/shop", title: "Fix" },
      ]
    ).map((s) => [s.id, s]),
  )
  const prompts: string[] = []
  const host: Host = {
    session: async (id) => table.get(id),
    root: (id) => {
      let cur = id
      for (let i = 0; i < 8 && table.get(cur)?.parentID; i++)
        cur = table.get(cur)!.parentID!
      return cur
    },
    replyForm: async () => {},
    prompt: async (_id, text) => {
      prompts.push(text)
    },
    busy: () => false,
    openRequests: async () => o.openIds,
  }
  const channel = new TelegramConnector({
    token: async () => tg.token,
    chatId: String(CHAT),
    apiBase: tg.url,
    topicsFile: join(dir, "topics.json"),
    offsetFile: join(dir, "offset.json"),
    pollSeconds: 1,
    backoff: { min: 10, max: 40 },
    rate: { gapMs: 0, perMinute: 600 },
    now,
  })
  const cfg = cfgOf()
  const router = new Router(cfg, async () => true, now)
  router.setPresence(() => o.attached ?? true)
  const bridge = new Bridge(
    cfg,
    host,
    [channel],
    new PendingStore(),
    router,
    now,
  )
  bridge.start()
  const ev = (type: string, data: object) =>
    bridge.onEvent({ type, data } as unknown as BridgeEvent)
  const prompt = (sessionID: string, text: string, inboxID: string) =>
    ev("session.inbox.enqueued", {
      sessionID,
      inboxID,
      item: { type: "user", payload: { text } },
    })
  const ask = (id: string, sessionID = "root") =>
    ev("form.created", {
      form: {
        id,
        sessionID,
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
    })
  return {
    tg,
    bridge,
    router,
    table,
    prompts,
    ev,
    prompt,
    ask,
    advance: (ms: number) => (t += ms),
    asked: () =>
      tg.of("sendMessage").filter((c) => /Deploy\?/.test(c.body.text ?? "")),
    async phoneMessage() {
      tg.message(CHAT, "/version")
      await tg.waitFor(() => router.state().reason === "phone" || undefined)
    },
    async done() {
      await bridge.stop()
      await tg.close()
    },
  }
}

describe("which prompts are the person at the Mac", () => {
  const idle = async (r: Awaited<ReturnType<typeof rig>>) => {
    r.advance(11 * MIN)
    assert.equal(r.router.state().reason, "idle")
    return r.router.lastInputAt()
  }

  it("a prompt typed into a viewed top-level session with a TUI attached is", async () => {
    const r = await rig({
      sessions: [{ id: "root", directory: "/w/shop", viewed: true }],
    })
    await idle(r)
    await r.prompt("root", "typed by hand", "i1")
    assert.equal(r.router.state().reason, "input")
    assert.equal(r.router.state().source, "tui")
    await r.done()
  })

  it("a subagent's prompt is not", async () => {
    const r = await rig({
      sessions: [
        { id: "root", directory: "/w/shop", viewed: true },
        { id: "child", parentID: "root", directory: "/w/shop" },
      ],
    })
    const before = await idle(r)
    await r.prompt("child", "from a subagent", "i1")
    assert.equal(r.router.lastInputAt(), before)
    assert.equal(r.router.state().reason, "idle")
    assert.equal(r.router.lastIgnored()?.source, "agent")
    await r.done()
  })

  it("a prompt into an unviewed (headless) session is not", async () => {
    const r = await rig({
      sessions: [{ id: "root", directory: "/w/shop", viewed: false }],
    })
    const before = await idle(r)
    await r.prompt("root", "from a script", "i1")
    assert.equal(r.router.lastInputAt(), before)
    assert.equal(r.router.lastIgnored()?.source, "agent")
    await r.done()
  })

  it("a prompt the bridge sent (Telegram, app, rpc) is not", async () => {
    const r = await rig({
      sessions: [{ id: "root", directory: "/w/shop", viewed: true }],
    })
    const before = await idle(r)
    await r.bridge.actions.prompt("root", "sent from the phone", "queue")
    await r.prompt("root", "sent from the phone", "i1")
    assert.equal(r.router.lastInputAt(), before)
    assert.equal(r.router.state().reason, "idle")
    await r.done()
  })

  it("with no TUI attached nothing is typed at the Mac", async () => {
    const r = await rig({
      attached: false,
      sessions: [{ id: "root", directory: "/w/shop", viewed: true }],
    })
    const before = r.router.lastInputAt()
    await r.prompt("root", "who typed this", "i1")
    assert.equal(r.router.lastInputAt(), before)
    assert.equal(r.router.state().reason, "no-tui")
    await r.done()
  })

  it("an answer to a form or permission is not", async () => {
    const r = await rig()
    const before = await idle(r)
    await r.ev("form.replied", { id: "frm_x", answer: {} })
    await r.ev("form.cancelled", { id: "frm_y" })
    await r.ev("permission.replied", { requestID: "per_x", reply: "once" })
    assert.equal(r.router.lastInputAt(), before)
    assert.equal(r.router.state().reason, "idle")
    await r.done()
  })
})

describe("the phone is away, and the log says which source decided", () => {
  it("a Telegram message turns auto to away; its replies never turn it back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oobb-presence-log-"))
    const file = join(dir, "log.jsonl")
    const old = process.env.OPENCODE_OOB_BRIDGE_LOG
    process.env.OPENCODE_OOB_BRIDGE_LOG = file
    try {
      const r = await rig({
        sessions: [{ id: "root", directory: "/w/shop", viewed: true }],
      })
      assert.equal(r.router.state().away, false)
      await r.phoneMessage()
      await r.bridge.presenceTick()
      for (let i = 0; i < 3; i++) {
        r.tg.message(CHAT, "/version")
        await new Promise((res) => setTimeout(res, 50))
        assert.equal(r.router.state().away, true)
      }
      assert.match(r.router.why(), /^away: phone active/)
      await flushLog()
      const line = (await readFile(file, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .find((l) => l.event === "presence_change" && l.away === true)
      assert.ok(line, "a presence_change line")
      assert.equal(line.reason, "phone")
      assert.equal(line.source, "telegram")
      assert.match(line.why, /^away: phone active/)
      await r.done()
    } finally {
      if (old === undefined) delete process.env.OPENCODE_OOB_BRIDGE_LOG
      else process.env.OPENCODE_OOB_BRIDGE_LOG = old
    }
  })
})

describe("a question held while the state said here", () => {
  it("is sent once, with its buttons, when the state turns away", async () => {
    const r = await rig()
    await r.ask("frm_1")
    assert.equal(r.asked().length, 0, "held while here")
    await r.phoneMessage()
    await r.bridge.presenceTick()
    const sent = await r.tg.waitFor(() => r.asked()[0])
    assert.ok(
      (sent.body.reply_markup?.inline_keyboard ?? []).flat().length > 0,
      "with buttons",
    )
    await r.bridge.presenceTick()
    r.advance(31 * MIN)
    await r.bridge.presenceTick()
    await new Promise((res) => setTimeout(res, 100))
    assert.equal(r.asked().length, 1, "once")
    await r.done()
  })

  it("is not sent when it was answered in the meantime", async () => {
    const r = await rig()
    await r.ask("frm_1")
    await r.ev("form.replied", { id: "frm_1", answer: { q0: ["Yes"] } })
    await r.phoneMessage()
    await r.bridge.presenceTick()
    await new Promise((res) => setTimeout(res, 150))
    assert.equal(r.asked().length, 0)
    await r.done()
  })

  it("is not sent when OpenCode no longer lists it as open", async () => {
    const r = await rig({ openIds: new Set() })
    await r.ask("frm_1")
    await r.phoneMessage()
    await r.bridge.presenceTick()
    await new Promise((res) => setTimeout(res, 150))
    assert.equal(r.asked().length, 0)
    await r.done()
  })
})
