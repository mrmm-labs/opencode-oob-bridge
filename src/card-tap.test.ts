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

async function rig(
  o: {
    running?: boolean
    prompt?: (text: string, n: number) => Promise<void>
    deadlineMs?: number
  } = {},
) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-tap-"))
  const state = { running: o.running ?? false }
  const prompts: Array<{ text: string; delivery: string }> = []
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
    prompt: async (_id, text, delivery) => {
      prompts.push({ text, delivery })
      await o.prompt?.(text, prompts.length)
    },
    interrupt: async () => true,
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
    reactGapMs: 0,
  })
  const cfg = parseConfig({
    channels: { telegram: { token: { env: "X" } } },
    chat: { queueSteerSeconds: 30 },
  }) as Config
  const router = new Router(cfg, async () => true)
  router.setAfk("on", Infinity)
  const bridge = new Bridge(cfg, host, [channel], new PendingStore(), router)
  if (o.deadlineMs) bridge.cardDeadlineMs = o.deadlineMs
  bridge.start()
  await bridge.onEvent({
    type: state.running
      ? "session.execution.started"
      : "session.execution.succeeded",
    data: { sessionID: "root" },
  } as unknown as BridgeEvent)
  assert.equal((await bridge.setChat("root", true)).ok, true)
  const thread = await tg
    .waitFor(() => tg.of("createForumTopic")[0] && tg.of("sendMessage")[0])
    .then((c) => c.body.message_thread_id as number)
  const card = tg.lastMessageId
  const sends = () => tg.of("sendMessage").map((c) => c.body)
  return {
    tg,
    bridge,
    state,
    prompts,
    thread,
    card,
    sends,
    said: (re: RegExp) =>
      tg.waitFor(() => sends().find((b) => re.test(b.text))),
    toast: (re: RegExp) =>
      tg.waitFor(() =>
        tg.of("answerCallbackQuery").find((c) => re.test(c.body.text ?? "")),
      ),
    reaction: (id: number, emoji: string) =>
      tg.waitFor(() =>
        tg
          .of("setMessageReaction")
          .find(
            (c) =>
              c.body.message_id === id && c.body.reaction[0]?.emoji === emoji,
          ),
      ),
    tap: (data: string) => tg.callback(CHAT, card, data, thread),
    async done() {
      await bridge.stop()
      await tg.close()
    },
  }
}

const hang = () => {
  let release: () => void = () => {}
  const p = new Promise<void>((r) => (release = r))
  return { p, release }
}

async function withLog<T>(fn: (lines: () => Promise<any[]>) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "oobb-tap-log-"))
  const file = join(dir, "log.jsonl")
  const old = process.env.OPENCODE_OOB_BRIDGE_LOG
  process.env.OPENCODE_OOB_BRIDGE_LOG = file
  try {
    return await fn(async () => {
      await flushLog()
      return (await readFile(file, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    })
  } finally {
    if (old === undefined) delete process.env.OPENCODE_OOB_BRIDGE_LOG
    else process.env.OPENCODE_OOB_BRIDGE_LOG = old
  }
}

describe("a card button is answered before its work", () => {
  it("shows the toast while the host has not answered, then the state", async () => {
    const gate = hang()
    const r = await rig({ prompt: () => gate.p })
    r.tap("ctl:qa")
    await r.toast(/⏳ QA sent to /)
    await r.tg.waitFor(() => r.prompts[0])
    assert.equal(r.tg.of("setMessageReaction").length, 0, "no state yet")
    gate.release()
    await r.reaction(r.card, "⚡")
    await r.done()
  })

  it("does not wait for a message of the topic that waits on the host", async () => {
    const gate = hang()
    const r = await rig({
      prompt: (text) => (text === "slow hello" ? gate.p : Promise.resolve()),
    })
    r.tg.message(CHAT, "slow hello", undefined, r.thread)
    await r.tg.waitFor(() => r.prompts[0])
    r.tap("ctl:update")
    await r.toast(/⏳ Update sent to /)
    await r.reaction(r.card, "⚡")
    gate.release()
    await r.done()
  })

  it("runs two taps one after the other, answering both at once", async () => {
    const gate = hang()
    const r = await rig({
      prompt: (_t, n) => (n === 1 ? gate.p : undefined) as any,
    })
    r.tap("ctl:qa")
    await r.tg.waitFor(() => r.prompts[0])
    r.tap("ctl:qa")
    await r.tg.waitFor(
      () => r.tg.of("answerCallbackQuery").length >= 2 || undefined,
    )
    assert.equal(r.prompts.length, 1, "the second waits for the first")
    gate.release()
    await r.tg.waitFor(() => r.prompts[1])
    await r.done()
  })
})

describe("the state of a delivery on the tapped message", () => {
  it("idle: sent", async () => {
    const r = await rig()
    r.tap("ctl:qa")
    await r.reaction(r.card, "⚡")
    assert.equal(r.prompts[0].delivery, "steer")
    await r.done()
  })

  it("busy: steered, and the log says so", async () => {
    await withLog(async (lines) => {
      const r = await rig({ running: true })
      r.tap("ctl:qa")
      await r.reaction(r.card, "⚡")
      await new Promise((res) => setTimeout(res, 100))
      const l = (await lines()).find(
        (x) => x.event === "telegram_inbound" && x.kind === "callback",
      )
      assert.ok(l, "a callback line")
      assert.equal(l.action, "qa")
      assert.equal(l.result, "steered")
      assert.equal(typeof l.ack_ms, "number")
      assert.equal(l.outcome, "handled")
      await r.done()
    })
  })

  it("Continue behind a busy turn: queued", async () => {
    const r = await rig({ running: true })
    r.tap("ctl:continue")
    await r.reaction(r.card, "✍")
    assert.equal(r.prompts[0].delivery, "queue")
    await r.done()
  })

  it("Stop keeps its result toast and gets no reaction", async () => {
    const r = await rig({ running: true })
    r.tap("ctl:stop")
    await r.toast(/Stopped the running turn/)
    assert.equal(r.tg.of("setMessageReaction").length, 0)
    await r.done()
  })
})

describe("a tap that fails says so", () => {
  it("the host refuses: a line with the reason, the failed reaction and the log", async () => {
    await withLog(async (lines) => {
      const r = await rig({
        prompt: async () => {
          throw new Error("boom")
        },
      })
      r.tap("ctl:qa")
      const m = await r.said(/QA not delivered/)
      assert.match(m.text, /boom|failed/)
      await r.reaction(r.card, "💔")
      await new Promise((res) => setTimeout(res, 100))
      const l = (await lines()).find(
        (x) => x.event === "telegram_inbound" && x.kind === "callback",
      )
      assert.equal(l.action, "qa")
      assert.equal(l.result, "failed")
      assert.equal(l.outcome, "failed")
      assert.ok(l.reason)
      await r.done()
    })
  })

  it("no answer in time: says it may still arrive", async () => {
    const gate = hang()
    const r = await rig({ prompt: () => gate.p, deadlineMs: 1000 })
    r.tap("ctl:update")
    const m = await r.said(/Update not delivered/)
    assert.match(m.text, /No answer from OpenCode in 1 s\. It may still arrive/)
    await r.reaction(r.card, "💔")
    gate.release()
    await r.done()
  })

  it("chat off: the refusal is shown in the topic", async () => {
    const r = await rig()
    await r.bridge.setChat("root", false)
    r.tap("ctl:qa")
    await r.said(/QA not delivered: Chat is off/)
    assert.deepEqual(r.prompts, [])
    await r.done()
  })
})
