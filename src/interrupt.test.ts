import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { Bridge, type BridgeEvent, type Host } from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import { flushLog } from "./logger.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"

const CHAT = 4242
const MIN = 60_000

type Rig = Awaited<ReturnType<typeof rig>>

async function rig(
  o: {
    running?: boolean
    chat?: boolean
    interrupt?: () => Promise<boolean>
    queued?: () => Promise<number | undefined>
    chatCfg?: Record<string, unknown>
    operator?: string
  } = {},
) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-intr-"))
  const clock = { t: 1_700_000_000_000 }
  const now = () => clock.t
  const state = { running: o.running ?? true }
  const interrupts: string[] = []
  const prompts: Array<{ sessionID: string; text: string; delivery: string }> =
    []
  const host: Host = {
    session: async (id) => ({
      id,
      agent: "coord",
      directory: "/w/shop",
      title: "Fix",
      viewed: true,
    }),
    root: (id) => id,
    replyForm: async () => {},
    busy: () => state.running,
    prompt: async (sessionID, text, delivery) => {
      prompts.push({ sessionID, text, delivery })
    },
    interrupt: async (sessionID) => {
      interrupts.push(sessionID)
      return o.interrupt ? o.interrupt() : true
    },
    queued: o.queued,
  }
  const channel = new TelegramConnector({
    token: async () => tg.token,
    chatId: String(CHAT),
    operator: o.operator,
    apiBase: tg.url,
    topicsFile: join(dir, "topics.json"),
    offsetFile: join(dir, "offset.json"),
    pollSeconds: 1,
    backoff: { min: 10, max: 40 },
    rate: { gapMs: 0, perMinute: 600 },
    toastAfterMs: 50,
    now,
  })
  const cfg = parseConfig({
    channels: { telegram: { token: { env: "X" } } },
    chat: { queueSteerSeconds: 30, ...o.chatCfg },
  }) as Config
  const router = new Router(cfg, async () => true, now)
  router.setAfk("on", Infinity)
  const bridge = new Bridge(
    cfg,
    host,
    [channel],
    new PendingStore(),
    router,
    now,
  )
  bridge.start()
  const event = (type: string) =>
    bridge.onEvent({
      type,
      data: { sessionID: "root" },
    } as unknown as BridgeEvent)
  if (state.running) await event("session.execution.started")
  else await event("session.execution.succeeded")
  if (o.chat !== false) {
    const out = await bridge.setChat("root", true)
    assert.equal(out.ok, true, out.text)
  }
  const thread = await tg
    .waitFor(() => tg.of("createForumTopic")[0] && tg.of("sendMessage")[0])
    .then((c) => c.body.message_thread_id as number)
  const sends = () => tg.of("sendMessage").map((c) => c.body)
  const said = (re: RegExp) =>
    tg.waitFor(() => sends().find((b) => re.test(b.text)))
  const buttons = (body: { reply_markup?: { inline_keyboard?: any[][] } }) =>
    (body.reply_markup?.inline_keyboard ?? [])
      .flat()
      .map((b) => b.callback_data)
  return {
    tg,
    bridge,
    clock,
    state,
    interrupts,
    prompts,
    thread,
    event,
    sends,
    said,
    buttons,
    say: (text: string, sender?: number) =>
      tg.message(CHAT, text, undefined, thread, {}, sender),
    tap: (data: string, messageID: number, sender?: number) =>
      tg.callback(CHAT, messageID, data, thread, sender),
    /** The newest message with a yes/no menu, and the callback data of a choice. */
    async menu() {
      const m = await tg.waitFor(() =>
        tg
          .of("sendMessage")
          .filter((c) => /Interrupt the running turn\?/.test(c.body.text))
          .at(-1),
      )
      const keys = (m.body.reply_markup.inline_keyboard as any[][]).flat()
      return {
        yes: keys.find((k) => k.text === "yes").callback_data as string,
        no: keys.find((k) => k.text === "no").callback_data as string,
        id: tg.lastMessageId,
      }
    },
    async done() {
      await bridge.stop()
      await tg.close()
    },
  }
}

const OWNER = CHAT
const OTHER = 777

describe("the Interrupt button on the status card", () => {
  it("shows while the session works with chat on, and goes when the turn ends", async () => {
    const r = await rig()
    // The card made before chat was on is edited when chat goes on.
    const card = await r.tg.waitFor(() =>
      r.tg
        .of("editMessageText")
        .find((c) => r.buttons(c.body).includes("ctl:interrupt")),
    )
    assert.match(card.body.text, /Working/)
    r.state.running = false
    await r.event("session.execution.succeeded")
    const edit = await r.tg.waitFor(() =>
      r.tg.of("editMessageText").find((c) => /Idle/.test(c.body.text)),
    )
    assert.ok(!r.buttons(edit.body).includes("ctl:interrupt"), "gone when idle")
    await r.done()
  })

  it("is not on the card when chat is off", async () => {
    const r = await rig({ chat: false })
    assert.ok(!r.buttons(r.sends()[0]).includes("ctl:interrupt"))
    await r.done()
  })

  it("is not on the card of an idle session", async () => {
    const r = await rig({ running: false })
    assert.ok(!r.buttons(r.sends()[0]).includes("ctl:interrupt"))
    await r.done()
  })
})

describe("/interrupt and its confirmation", () => {
  it("asks first; yes interrupts once and the topic gets the result", async () => {
    const r = await rig()
    r.say("/interrupt")
    const m = await r.menu()
    assert.deepEqual(r.interrupts, [], "nothing before the tap")
    r.tap(m.yes, m.id)
    await r.said(/Interrupted; send a message to continue/)
    assert.deepEqual(r.interrupts, ["root"])
    await r.done()
  })

  it("the card's button asks the same question; no interrupts nothing", async () => {
    const r = await rig()
    const card = await r.tg.waitFor(() => r.tg.of("sendMessage")[0])
    r.tap("ctl:interrupt", r.tg.lastMessageId)
    const m = await r.menu()
    void card
    r.tap(m.no, m.id)
    await r.said(/Left running/)
    assert.deepEqual(r.interrupts, [])
    await r.done()
  })

  it("refuses an idle session with a hint and shows no menu", async () => {
    const r = await rig({ running: false })
    r.say("/interrupt")
    await r.said(/idle: nothing to interrupt/)
    assert.ok(
      !r.sends().some((b) => /Interrupt the running turn\?/.test(b.text)),
    )
    assert.deepEqual(r.interrupts, [])
    await r.done()
  })

  it("a turn that ended before the tap is not interrupted", async () => {
    const r = await rig()
    r.say("/interrupt")
    const m = await r.menu()
    r.state.running = false
    r.tap(m.yes, m.id)
    await r.said(/idle: nothing to interrupt/)
    assert.deepEqual(r.interrupts, [])
    await r.done()
  })
})

describe("only the paired owner may interrupt", () => {
  it("refuses the command of another member", async () => {
    const r = await rig()
    r.say("/interrupt", OTHER)
    await r.said(/Only the paired owner/)
    assert.ok(
      !r.sends().some((b) => /Interrupt the running turn\?/.test(b.text)),
    )
    assert.deepEqual(r.interrupts, [])
    await r.done()
  })

  it("refuses the button of another member", async () => {
    const r = await rig()
    r.tap("ctl:interrupt", r.tg.lastMessageId, OTHER)
    const t = await r.tg.waitFor(() =>
      r.tg
        .of("answerCallbackQuery")
        .find((c) => /Only the paired owner/.test(c.body.text)),
    )
    assert.ok(t)
    assert.ok(
      !r.sends().some((b) => /Interrupt the running turn\?/.test(b.text)),
    )
    assert.deepEqual(r.interrupts, [])
    await r.done()
  })

  it("refuses the yes of another member, and the owner's yes still works", async () => {
    const r = await rig()
    r.say("/interrupt")
    const m = await r.menu()
    r.tap(m.yes, m.id, OTHER)
    await r.tg.waitFor(() =>
      r.tg
        .of("answerCallbackQuery")
        .find((c) => /Only the paired owner/.test(c.body.text)),
    )
    assert.deepEqual(r.interrupts, [])
    r.tap(m.yes, m.id, OWNER)
    await r.said(/Interrupted/)
    assert.deepEqual(r.interrupts, ["root"])
    await r.done()
  })

  it("refuses everyone when the owner is not known", async () => {
    const r = await rig()
    const ch = (r.bridge as unknown as { channels: any[] }).channels[0]
    ch.userId = undefined
    ch.chatId = "-1001234"
    assert.equal(ch.isOwner({ id: OWNER }), false)
    ch.chatId = String(CHAT)
    await r.done()
  })
})

describe("what the interrupt says and does", () => {
  const ask = async (r: Rig) => {
    r.say("/interrupt")
    const m = await r.menu()
    r.tap(m.yes, m.id)
  }

  it("the host stops nothing: says the turn may belong to another process", async () => {
    const r = await rig({ interrupt: async () => false })
    await ask(r)
    await r.said(/another OpenCode process/)
    await r.done()
  })

  it("the host call fails: shows a short reason and logs the failure", async () => {
    const r = await rig({
      interrupt: async () => {
        throw new Error("socket hang up")
      },
    })
    await ask(r)
    await r.said(/Could not interrupt: socket hang up/)
    await r.done()
  })

  it("reports what waits in the host's inbox, and does not re-send it", async () => {
    const r = await rig({ queued: async () => 3 })
    await ask(r)
    const out = await r.said(/Interrupted/)
    assert.match(out.text, /3 messages wait in the session/)
    assert.match(out.text, /Resume/)
    assert.deepEqual(r.prompts, [])
    await r.done()
  })

  it("an inbox that does not answer is left out of the result", async () => {
    const r = await rig({ queued: async () => undefined })
    await ask(r)
    const out = await r.said(/Interrupted/)
    assert.ok(!/wait in the session/.test(out.text))
    await r.done()
  })

  it("a message the bridge holds goes on as one new prompt when the interrupt event arrives", async () => {
    const r = await rig()
    r.say("steer this please")
    await r.tg.waitFor(() => r.tg.of("setMessageReaction")[0])
    assert.deepEqual(r.prompts, [], "held behind the busy turn")
    await ask(r)
    const out = await r.said(/Interrupted/)
    assert.match(
      out.text,
      /1 message waiting in the bridge go on as a new turn/,
    )
    await r.event("session.execution.interrupted")
    await r.tg.waitFor(() => r.prompts[0])
    assert.deepEqual(r.prompts, [
      { sessionID: "root", text: "steer this please", delivery: "queue" },
    ])
    await r.done()
  })

  it("writes one audit line with the trace id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oobb-intr-log-"))
    const file = join(dir, "log.jsonl")
    const old = process.env.OPENCODE_OOB_BRIDGE_LOG
    process.env.OPENCODE_OOB_BRIDGE_LOG = file
    try {
      const r = await rig({ queued: async () => 2 })
      await ask(r)
      await r.said(/Interrupted/)
      await flushLog()
      const line = (await readFile(file, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .find((l) => l.event === "interrupt")
      assert.ok(line, "an interrupt line")
      assert.equal(line.session, "root")
      assert.equal(line.source, "chat")
      assert.equal(line.outcome, "interrupted")
      assert.equal(line.parked, 2)
      assert.match(line.trace, /^[0-9a-f]{32}$/)
      await r.done()
    } finally {
      if (old === undefined) delete process.env.OPENCODE_OOB_BRIDGE_LOG
      else process.env.OPENCODE_OOB_BRIDGE_LOG = old
    }
  })
})

describe("a stuck turn is flagged on the card", () => {
  const tick = async (r: Rig, ms: number) => {
    r.clock.t += ms
    await r.bridge.presenceTick()
  }
  const flagged = (r: Rig) =>
    r.tg
      .of("editMessageText")
      .filter((c) => /no progress for/.test(c.body.text))

  it("after chat.stuckMinutes with no event: busy and quiet times on the card", async () => {
    const r = await rig()
    await tick(r, 10 * MIN)
    assert.equal(flagged(r).length, 0, "not yet")
    await tick(r, 35 * MIN)
    const edit = await r.tg.waitFor(() => flagged(r)[0])
    assert.match(edit.body.text, /Busy for 45 min, no progress for 45 min/)
    assert.ok(r.buttons(edit.body).includes("ctl:interrupt"))
    await r.done()
  })

  it("an event of the session clears it", async () => {
    const r = await rig()
    await tick(r, 45 * MIN)
    await r.tg.waitFor(() => flagged(r)[0])
    r.bridge.activity("root")
    await tick(r, 31_000)
    await r.tg.waitFor(() =>
      r.tg
        .of("editMessageText")
        .filter(
          (c) =>
            !/no progress for/.test(c.body.text) && /Working/.test(c.body.text),
        )
        .at(-1),
    )
    await r.done()
  })

  it("is off with chat.stuckMinutes 0", async () => {
    const r = await rig({ chatCfg: { stuckMinutes: 0 } })
    await tick(r, 5 * 60 * MIN)
    await new Promise((res) => setTimeout(res, 100))
    assert.equal(flagged(r).length, 0)
    await r.done()
  })

  it("an idle session is never flagged", async () => {
    const r = await rig({ running: false })
    await tick(r, 5 * 60 * MIN)
    await new Promise((res) => setTimeout(res, 100))
    assert.equal(flagged(r).length, 0)
    await r.done()
  })
})
