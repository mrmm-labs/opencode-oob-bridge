import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { Bridge, type BridgeEvent, type Host } from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"
import { sleep } from "./util.ts"

const CHAT = 4242

async function rig(o: { stale?: boolean } = {}) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-gate-"))
  const channel = new TelegramConnector({
    token: async () => tg.token,
    chatId: String(CHAT),
    apiBase: tg.url,
    topicsFile: join(dir, "topics.json"),
    offsetFile: join(dir, "offset.json"),
    pollSeconds: 1,
    backoff: { min: 10, max: 40 },
  })
  const cfg = parseConfig({
    channels: { telegram: { token: { env: "X" } } },
    chat: {},
  }) as Config
  const prompts: Array<{ text: string; delivery: string }> = []
  /** What OpenCode says of each request, and what its form reply does. */
  const live = {
    states: new Map<
      string,
      "open" | "answered" | "cancelled" | "gone" | undefined
    >(),
    asked: [] as string[],
    lists: new Map<string, Set<string> | undefined>(),
    replyError: undefined as string | undefined,
  }
  const skew = { ms: 0 }
  const host: Host = {
    session: async (id) => ({ id, agent: "coord", directory: "/w/shop" }),
    root: (id) => (id.startsWith("ses_") ? "root" : id),
    openRequests: async (_kind, sid) => live.lists.get(sid),
    replyForm: async () => {
      if (live.replyError) throw new Error(live.replyError)
    },
    requestState: async (kind, _sid, rid) => {
      live.asked.push(kind + ":" + rid)
      return live.states.has(rid) ? live.states.get(rid) : "open"
    },
    replyPermission: async () => {},
    prompt: async (_id, text, delivery) => {
      prompts.push({ text, delivery })
    },
    busy: () => false,
  } as unknown as Host
  const store = new PendingStore()
  if (o.stale) {
    store.put({
      id: "old1",
      kind: "question",
      requestID: "frm_old",
      sessionID: "root",
      rootSessionID: "root",
      title: "asked before the restart",
      askedAt: Date.now() - 3_600_000,
      state: "pending",
    })
    live.states.set("frm_old", "answered")
  }
  const bridge = new Bridge(
    cfg,
    host,
    [channel],
    store,
    new Router(cfg, async () => true),
    () => Date.now() + skew.ms,
  )
  bridge.start()
  const out = await bridge.setChat("root", true)
  assert.equal(out.ok, true)
  await tg.waitFor(() => tg.of("sendMessage")[0])
  await bridge.onEvent({
    type: "form.created",
    data: {
      form: {
        id: "frm_1",
        sessionID: "root",
        metadata: { kind: "question" },
        fields: [
          {
            key: "q0",
            type: "string",
            description: "Go?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      },
    },
  } as unknown as BridgeEvent)
  const sends = () => tg.of("sendMessage").map((c) => c.body)
  await tg.waitFor(() => sends().find((b) => /Go\?/.test(b.text)))
  const gate = async () => {
    tg.message(CHAT, "run the tests", undefined, 9001)
    return tg.waitFor(() =>
      sends().find((b) => /waiting on a question/.test(b.text)),
    )
  }
  const form = async (id: string, sessionID: string, text: string) => {
    await bridge.onEvent({
      type: "form.created",
      data: {
        form: {
          id,
          sessionID,
          metadata: { kind: "question" },
          fields: [
            {
              key: "q0",
              type: "string",
              description: text,
              options: [{ label: "Yes" }, { label: "No" }],
            },
          ],
        },
      },
    } as unknown as BridgeEvent)
    await tg.waitFor(() => sends().find((b) => b.text.includes(text)))
  }
  const tap = (menu: { reply_markup: any }, label: RegExp) => {
    const btn = menu.reply_markup.inline_keyboard
      .flat()
      .find((b: { text: string }) => label.test(b.text))
    tg.callback(CHAT, 700, btn.callback_data, 9001)
  }
  return {
    tg,
    bridge,
    store,
    live,
    skew,
    prompts,
    sends,
    gate,
    form,
    tap,
    async done() {
      await bridge.stop()
      await tg.close()
    },
  }
}

describe("a message for a session that waits on a question", () => {
  it("is held, not sent and not dropped: the topic offers answer, skip and send anyway", async () => {
    const r = await rig()
    const menu = await r.gate()
    assert.equal(menu.message_thread_id, 9001)
    assert.deepEqual(
      menu.reply_markup.inline_keyboard.flat().map((b: any) => b.text),
      [
        "Answer: show the question again",
        "Skip: do not send my message",
        "Send anyway: steer it in",
      ],
    )
    await sleep(100)
    assert.deepEqual(r.prompts, [])
    await r.tg.waitFor(() =>
      r.tg.of("setMessageReaction").length >= 2 ? true : undefined,
    )
    assert.deepEqual(
      r.tg.of("setMessageReaction").map((c) => c.body.reaction[0].emoji),
      ["👀", "🤷"],
    )
    await r.done()
  })

  it("Send anyway steers the kept message into the session", async () => {
    const r = await rig()
    r.tap(await r.gate(), /Send anyway/)
    await r.tg.waitFor(() => r.prompts[0])
    assert.deepEqual(r.prompts, [{ text: "run the tests", delivery: "steer" }])
    await r.tg.waitFor(() =>
      r.sends().find((b) => /Sent anyway, steered in/.test(b.text)),
    )
    await r.done()
  })

  it("Skip sends nothing and says so", async () => {
    const r = await rig()
    r.tap(await r.gate(), /Skip/)
    await r.tg.waitFor(() =>
      r.sends().find((b) => /your message was not sent/.test(b.text)),
    )
    assert.deepEqual(r.prompts, [])
    await r.done()
  })

  it("Answer posts the question again at the bottom of the topic", async () => {
    const r = await rig()
    const before = r.sends().filter((b) => /Go\?/.test(b.text)).length
    r.tap(await r.gate(), /Answer/)
    await r.tg.waitFor(() =>
      r.sends().filter((b) => /Go\?/.test(b.text)).length > before
        ? true
        : undefined,
    )
    assert.deepEqual(r.prompts, [])
    await r.done()
  })

  it("a message that starts with ! still steers at once", async () => {
    const r = await rig()
    r.tg.message(CHAT, "!stop that", undefined, 9001)
    await r.tg.waitFor(() => r.prompts[0])
    assert.deepEqual(r.prompts, [{ text: "stop that", delivery: "steer" }])
    await r.done()
  })
})

describe("a question OpenCode no longer holds", () => {
  const edits = (r: Awaited<ReturnType<typeof rig>>) =>
    r.tg.of("editMessageText").map((c) => c.body)
  const gone = (r: Awaited<ReturnType<typeof rig>>) => {
    r.live.states.set("frm_1", "answered")
    r.skew.ms = 60_000
  }

  it("is closed as already answered at the Mac, buttons gone", async () => {
    const r = await rig()
    gone(r)
    assert.equal(await r.bridge.reconcile(), 1)
    const p = r.store.list().find((x) => x.requestID === "frm_1")!
    assert.equal(p.state, "answered")
    assert.equal(p.answeredBy, "unknown (reconciled)")
    const e = await r.tg.waitFor(() =>
      edits(r).find((b) => /Already answered at the Mac/.test(b.text)),
    )
    assert.ok(!e.reply_markup?.inline_keyboard?.length, "no buttons")
    assert.equal(await r.bridge.reconcile(), 0, "closed once")
    await r.done()
  })

  it("is left alone while OpenCode holds it, when it cannot say, and while it is young", async () => {
    const r = await rig()
    r.skew.ms = 60_000
    assert.equal(await r.bridge.reconcile(), 0, "open")
    r.live.states.set("frm_1", undefined)
    assert.equal(await r.bridge.reconcile(), 0, "unknown")
    r.skew.ms = 0
    r.live.states.set("frm_1", "answered")
    assert.equal(await r.bridge.reconcile(), 0, "too young to judge")
    assert.equal(
      r.store.list().find((x) => x.requestID === "frm_1")!.state,
      "pending",
    )
    await r.done()
  })

  it("is closed when the bridge starts, before anything is asked of it", async () => {
    const r = await rig({ stale: true })
    await r.tg.waitFor(() =>
      r.store.get("old1")?.state === "answered" ? true : undefined,
    )
    assert.equal(r.store.get("old1")!.answeredBy, "unknown (reconciled)")
    await r.done()
  })

  it("a message held behind it is sent, and the topic shows it", async () => {
    const r = await rig()
    const menu = await r.gate()
    assert.ok(menu)
    gone(r)
    assert.equal(await r.bridge.reconcile(), 1)
    assert.deepEqual(r.prompts, [{ text: "run the tests", delivery: "queue" }])
    await r.tg.waitFor(() =>
      edits(r).find((b) =>
        /no longer open: your message was sent/.test(b.text),
      ),
    )
    const emojis = () =>
      r.tg.of("setMessageReaction").map((c) => c.body.reaction[0].emoji)
    await r.tg.waitFor(() => (emojis().includes("⚡") ? true : undefined))
    assert.deepEqual(emojis().slice(0, 3), ["👀", "🤷", "⚡"])
    await r.done()
  })

  it("a message sent after it is delivered at once, after OpenCode is asked", async () => {
    const r = await rig()
    r.live.states.set("frm_1", "answered")
    r.tg.message(CHAT, "run the tests", undefined, 9001)
    await r.tg.waitFor(() => r.prompts[0])
    assert.deepEqual(r.prompts, [{ text: "run the tests", delivery: "queue" }])
    assert.ok(r.live.asked.includes("question:frm_1"))
    assert.ok(
      !r.sends().some((b) => /waiting on a question/.test(b.text)),
      "no hold",
    )
    await r.done()
  })

  it("is still held when OpenCode holds it", async () => {
    const r = await rig()
    await r.gate()
    assert.ok(r.live.asked.includes("question:frm_1"))
    await sleep(100)
    assert.deepEqual(r.prompts, [])
    await r.done()
  })

  it("Answer sends the kept message when the question is gone, and posts nothing again", async () => {
    const r = await rig()
    const menu = await r.gate()
    const before = r.sends().filter((b) => /Go?/.test(b.text)).length
    r.live.states.set("frm_1", "answered")
    r.tap(menu, /Answer/)
    await r.tg.waitFor(() => r.prompts[0])
    assert.deepEqual(r.prompts, [{ text: "run the tests", delivery: "queue" }])
    await r.tg.waitFor(() =>
      r
        .sends()
        .find((b) => /no longer open: your message was sent/.test(b.text)),
    )
    assert.equal(r.sends().filter((b) => /Go?/.test(b.text)).length, before)
    await r.done()
  })

  it("a tap whose reply OpenCode refuses as not found withdraws it instead of failing", async () => {
    const r = await rig()
    const q = r.sends().find((b) => /Go?/.test(b.text))!
    r.live.replyError = "Form not found: frm_1"
    r.tap(q, /Yes/)
    await r.tg.waitFor(() =>
      edits(r).find((b) =>
        /Withdrawn.*the session stopped asking/.test(b.text),
      ),
    )
    const p = r.store.list().find((x) => x.requestID === "frm_1")!
    assert.equal(p.state, "withdrawn")
    assert.equal(p.answeredBy, undefined)
    await r.done()
  })

  it("a form OpenCode dropped without saying why is withdrawn, not answered, and its buttons go", async () => {
    const r = await rig()
    r.live.states.set("frm_1", "gone")
    r.skew.ms = 60_000
    assert.equal(await r.bridge.reconcile(), 1)
    const p = r.store.list().find((x) => x.requestID === "frm_1")!
    assert.equal(p.state, "withdrawn")
    assert.equal(p.answeredBy, undefined)
    const e = await r.tg.waitFor(() =>
      edits(r).find((b) => /Withdrawn/.test(b.text)),
    )
    assert.match(e.text, /⚪ <b>Withdrawn<\/b>: the session stopped asking/)
    assert.doesNotMatch(e.text, /answered/i)
    assert.ok(!e.reply_markup?.inline_keyboard?.length, "no buttons")
    assert.equal(await r.bridge.reconcile(), 0, "closed once")
    await r.done()
  })

  const AJ6H = {
    id: "frm_207d9220e001qszdppOkRjCcyp",
    session: "ses_eaf5640a2ffeYqvSogl3Omy3T1",
  }
  const MTKE = {
    id: "frm_207d9baef001DDjUFCA7Sr4SJ4",
    session: "ses_eca821321ffeFk0j0g51hFjWhO",
  }

  it("two forms OpenCode lists as none are withdrawn and no longer counted as open", async () => {
    const r = await rig()
    await r.form(AJ6H.id, AJ6H.session, "First?")
    await r.form(MTKE.id, MTKE.session, "Second?")
    r.live.states.set("frm_1", "answered")
    r.live.lists.set(AJ6H.session, new Set())
    r.live.lists.set(MTKE.session, new Set())
    assert.equal(r.bridge.drain().questions, 3, "young: counted")
    r.skew.ms = 60_000
    assert.equal(await r.bridge.reconcile(), 3)
    for (const f of [AJ6H, MTKE]) {
      const p = r.store.list().find((x) => x.requestID === f.id)!
      assert.equal(p.state, "withdrawn")
      assert.equal(p.answeredBy, undefined)
    }
    await r.tg.waitFor(
      () =>
        edits(r).filter((b) => /⚪ <b>Withdrawn<\/b>/.test(b.text)).length >= 2,
    )
    assert.deepEqual(r.bridge.drain(), {
      questions: 0,
      permissions: 0,
      unverified: 0,
    })
    assert.equal(r.tg.of("deleteMessage").length, 0, "never deleted")
    await r.done()
  })

  it("a form OpenCode still lists stays pending and counts as open", async () => {
    const r = await rig()
    await r.form(AJ6H.id, AJ6H.session, "First?")
    r.live.lists.set(AJ6H.session, new Set([AJ6H.id]))
    r.live.states.set("frm_1", "answered")
    r.skew.ms = 60_000
    assert.equal(await r.bridge.reconcile(), 1)
    assert.equal(
      r.store.list().find((x) => x.requestID === AJ6H.id)!.state,
      "pending",
    )
    assert.equal(r.bridge.drain().questions, 1)
    await r.done()
  })

  it("a form OpenCode cannot be asked about stays pending but is not counted as open", async () => {
    const r = await rig()
    r.live.states.set("frm_1", undefined)
    r.skew.ms = 60_000
    assert.equal(await r.bridge.reconcile(), 0)
    assert.equal(
      r.store.list().find((x) => x.requestID === "frm_1")!.state,
      "pending",
    )
    assert.deepEqual(r.bridge.drain(), {
      questions: 0,
      permissions: 0,
      unverified: 1,
    })
    await r.done()
  })

  it("a message held behind a withdrawn form is sent", async () => {
    const r = await rig()
    const menu = await r.gate()
    assert.ok(menu)
    r.live.states.set("frm_1", "gone")
    r.skew.ms = 60_000
    assert.equal(await r.bridge.reconcile(), 1)
    assert.deepEqual(r.prompts, [{ text: "run the tests", delivery: "queue" }])
    await r.done()
  })

  it("a form found cancelled keeps that state", async () => {
    const r = await rig()
    r.live.states.set("frm_1", "cancelled")
    r.skew.ms = 60_000
    assert.equal(await r.bridge.reconcile(), 1)
    assert.equal(
      r.store.list().find((x) => x.requestID === "frm_1")!.state,
      "cancelled",
    )
    await r.done()
  })
})
