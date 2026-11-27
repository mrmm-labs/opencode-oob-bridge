import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
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
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"
import { lastLine, renderSub, subDescription } from "./subcards.ts"

const CHAT = 4242
const THREAD = 11

const ROOT: SessionInfo = {
  id: "ses_root",
  agent: "coord",
  directory: "/w/shop",
  title: "Shop",
  viewed: true,
}
const CHILD: SessionInfo = {
  id: "ses_c1",
  parentID: "ses_root",
  agent: "explore",
  directory: "/w/shop",
  title: "Find the cache (@explore subagent)",
}
const GRAND: SessionInfo = {
  id: "ses_g1",
  parentID: "ses_c1",
  agent: "general",
  directory: "/w/shop",
  title: "Read the config (@general subagent)",
}

async function rig(
  o: {
    sessions?: SessionInfo[]
    topic?: boolean
    gapMs?: number
    config?: object
    slowSendMs?: number
  } = {},
) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-sub-"))
  const topicsFile = join(dir, "topics.json")
  if (o.topic !== false)
    await writeFile(
      topicsFile,
      JSON.stringify({
        [CHAT + ":ses_root"]: { thread: THREAD, name: "shop · Shop" },
      }),
    )
  const table = new Map(
    (o.sessions ?? [ROOT, CHILD, GRAND]).map((s) => [s.id, s]),
  )
  const replied: Array<[string, string]> = []
  const host: Host = {
    session: async (id) => table.get(id),
    root: (id) => {
      let cur = id
      for (let i = 0; i < 8 && table.get(cur)?.parentID; i++)
        cur = table.get(cur)!.parentID!
      return cur
    },
    replyForm: async (sessionID, formID) => {
      replied.push([sessionID, formID])
    },
    prompt: async () => {},
    busy: () => false,
  }
  const channel = new TelegramConnector({
    token: async () => tg.token,
    chatId: String(CHAT),
    apiBase: tg.url,
    topicsFile,
    offsetFile: join(dir, "offset.json"),
    pollSeconds: 1,
    backoff: { min: 10, max: 40 },
    rate: { gapMs: 0, perMinute: 600 },
    topics: { headless: "project" },
  })
  if (o.slowSendMs) {
    const send = channel.send.bind(channel)
    channel.send = async (p) => {
      const ref = await send(p)
      await new Promise((res) => setTimeout(res, o.slowSendMs))
      return ref
    }
  }
  const cfg = parseConfig({
    channels: { telegram: { token: { env: "X" } } },
    ...o.config,
  }) as Config
  const router = new Router(cfg, async () => true)
  router.setAfk("on", Infinity)
  const bridge = new Bridge(
    cfg,
    host,
    [channel],
    new PendingStore(),
    router,
    Date.now,
  )
  bridge.subDebounceMs = 20
  bridge.subGapMs = o.gapMs ?? 150
  bridge.start()
  const ev = (type: string, sessionID: string, data: object = {}) =>
    bridge.onEvent({
      type,
      data: { sessionID, ...data },
    } as unknown as BridgeEvent)
  const sends = () => tg.of("sendMessage").map((c) => c.body)
  const edits = () => tg.of("editMessageText").map((c) => c.body)
  const cards = () => sends().filter((b) => /^<b>(↳+ )?🤖/.test(b.text))
  const question = (sessionID: string, text: string, id = "frm_1") =>
    bridge.onEvent({
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
  return {
    tg,
    bridge,
    ev,
    sends,
    edits,
    cards,
    question,
    replied,
    wait: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    async done() {
      assert.equal(tg.of("deleteMessage").length, 0, "a card is never deleted")
      await bridge.stop()
      await tg.close()
    },
  }
}

describe("the text of a card", () => {
  it("shows agent, description, status, time and the last line", () => {
    const base = { agent: "explore", desc: "Find it", depth: 1 } as const
    const t = renderSub({ ...base, status: "running", ms: 5_000 })
    assert.equal(t.title, "🤖 explore: Find it")
    assert.equal(t.message, "🟢 running · under 1 min")
    assert.match(
      renderSub({ ...base, status: "running", ms: 190_000 }).message,
      /running · 3 min$/,
    )
    const done = renderSub({
      ...base,
      status: "done",
      ms: 190_000,
      last: "Found it in cache.ts",
    })
    assert.equal(done.message, "✅ done · 3m 10s\nFound it in cache.ts")
    assert.match(
      renderSub({ ...base, status: "waiting", ms: 0 }).message,
      /^⏳ waiting for an answer/,
    )
    assert.match(
      renderSub({ ...base, status: "error", ms: 0 }).message,
      /^❌ error/,
    )
    assert.match(
      renderSub({ ...base, status: "idle", ms: 0 }).message,
      /^💤 idle/,
    )
  })

  it("leads a grandchild with an arrow, one per level below the first", () => {
    const v = { agent: "a", desc: "", status: "running", ms: 0 } as const
    assert.equal(renderSub({ ...v, depth: 1 }).title, "🤖 a")
    assert.equal(renderSub({ ...v, depth: 2 }).title, "↳ 🤖 a")
    assert.equal(renderSub({ ...v, depth: 3 }).title, "↳↳ 🤖 a")
  })

  it("trims the description and the last line", () => {
    const long = "x".repeat(300)
    const t = renderSub({
      agent: "a",
      desc: long,
      depth: 1,
      status: "done",
      ms: 0,
      last: long,
    })
    assert.ok(t.title.length < 100)
    assert.ok(t.message.split("\n")[1].length <= 160)
    assert.equal(subDescription("Find it (@explore subagent)"), "Find it")
    assert.equal(subDescription(undefined), "")
    assert.equal(lastLine("intro\n\n- first\n## Result: ok  \n"), "Result: ok")
  })
})

describe("the card of a subagent", () => {
  it("is posted once in the root's topic when the subagent starts", async () => {
    const r = await rig()
    await r.ev("session.execution.started", "ses_c1")
    const card = await r.tg.waitFor(() => r.cards()[0])
    assert.equal(card.message_thread_id, THREAD)
    assert.match(card.text, /explore: Find the cache/)
    assert.match(card.text, /running/)
    assert.deepEqual(card.reply_markup, { inline_keyboard: [] })
    await r.ev("session.execution.started", "ses_c1")
    await r.wait(150)
    assert.equal(r.cards().length, 1, "one card, not two")
    await r.done()
  })

  it("is edited in place to the result, and nothing is posted or deleted", async () => {
    const r = await rig()
    await r.ev("session.execution.started", "ses_c1")
    await r.tg.waitFor(() => r.cards()[0])
    await r.ev("session.text.ended", "ses_c1", {
      assistantMessageID: "m1",
      ordinal: 0,
      text: "Looked around.\nThe cache lives in cache.ts",
    })
    await r.ev("session.execution.succeeded", "ses_c1")
    const edit = await r.tg.waitFor(() =>
      r.edits().find((b) => /done/.test(b.text)),
    )
    assert.match(edit.text, /The cache lives in cache\.ts/)
    assert.match(edit.text, /explore: Find the cache/)
    assert.equal(r.cards().length, 1)
    await r.done()
  })

  it("changes that arrive while the card is being posted are not held for the retry time", async () => {
    const r = await rig({ slowSendMs: 300 })
    await r.ev("session.execution.started", "ses_c1")
    await r.tg.waitFor(() => r.cards()[0])
    await r.ev("session.text.ended", "ses_c1", { text: "All set" })
    await r.ev("session.execution.succeeded", "ses_c1")
    const edit = await r.tg.waitFor(() =>
      r.edits().find((b) => /done/.test(b.text)),
    )
    assert.match(edit.text, /All set/)
    assert.equal(r.cards().length, 1)
    await r.done()
  })

  it("shows a failure, and an interrupted subagent as idle", async () => {
    const r = await rig()
    await r.ev("session.execution.started", "ses_c1")
    await r.tg.waitFor(() => r.cards()[0])
    await r.ev("session.execution.failed", "ses_c1")
    await r.tg.waitFor(() => r.edits().find((b) => /error/.test(b.text)))
    await r.ev("session.execution.interrupted", "ses_c1")
    await r.tg.waitFor(() => r.edits().find((b) => /idle/.test(b.text)))
    await r.done()
  })

  it("a burst of changes is one edit with the latest text, and the gap is kept", async () => {
    const r = await rig({ gapMs: 400 })
    await r.ev("session.execution.started", "ses_c1")
    await r.tg.waitFor(() => r.cards()[0])
    const at = Date.now()
    await r.ev("session.text.ended", "ses_c1", { text: "first" })
    await r.ev("session.text.ended", "ses_c1", { text: "second" })
    await r.ev("session.execution.succeeded", "ses_c1")
    await r.wait(150)
    assert.equal(r.edits().length, 0, "held back by the gap")
    const first = await r.tg.waitFor(() => r.edits()[0])
    assert.ok(Date.now() - at >= 350, "not before the gap")
    assert.match(first.text, /done/)
    assert.match(first.text, /second/)
    assert.doesNotMatch(first.text, /first/)
    await r.wait(150)
    assert.equal(r.edits().length, 1, "one edit for the burst")
    await r.ev("session.execution.succeeded", "ses_c1")
    await r.wait(500)
    assert.equal(r.edits().length, 1, "same text is not sent again")
    await r.done()
  })

  it("a grandchild has its own card in the root's topic, led by an arrow", async () => {
    const r = await rig()
    await r.ev("session.execution.started", "ses_c1")
    await r.ev("session.execution.started", "ses_g1")
    await r.tg.waitFor(() => r.cards().length === 2 || undefined)
    const [child, grand] = r.cards()
    assert.equal(child.message_thread_id, THREAD)
    assert.equal(grand.message_thread_id, THREAD)
    assert.doesNotMatch(child.text, /↳/)
    assert.match(grand.text, /↳ 🤖 general: Read the config/)
    await r.done()
  })

  it("a root session gets no card of its own", async () => {
    const r = await rig()
    await r.ev("session.execution.started", "ses_root")
    await r.ev("session.execution.succeeded", "ses_root")
    await r.wait(150)
    assert.equal(r.cards().length, 0)
    await r.done()
  })
})

describe("the prompts of a subagent", () => {
  it("a question is a reply to its card, the card waits, and the answer reaches the child", async () => {
    const r = await rig()
    await r.ev("session.execution.started", "ses_c1")
    await r.tg.waitFor(() => r.cards()[0])
    await r.question("ses_c1", "Use the cache?")
    const q = await r.tg.waitFor(() =>
      r.sends().find((b) => /Use the cache\?/.test(b.text)),
    )
    const waiting = await r.tg.waitFor(() =>
      r.edits().find((b) => /waiting for an answer/.test(b.text)),
    )
    assert.equal(q.reply_parameters.message_id, waiting.message_id)
    assert.equal(q.message_thread_id, THREAD)
    const btn = q.reply_markup.inline_keyboard
      .flat()
      .find((b: { text: string }) => /Yes/.test(b.text))
    r.tg.callback(CHAT, 700, btn.callback_data, THREAD)
    await r.tg.waitFor(() => r.replied[0])
    assert.deepEqual(r.replied[0], ["ses_c1", "frm_1"])
    await r.tg.waitFor(
      () =>
        r.edits().filter((b) => /running/.test(b.text)).length > 0 || undefined,
    )
    await r.done()
  })

  it("a question makes the card first when the subagent had none", async () => {
    const r = await rig()
    await r.question("ses_c1", "Use the cache?")
    await r.tg.waitFor(() =>
      r.sends().find((b) => /Use the cache\?/.test(b.text)),
    )
    const card = r.cards()[0]
    assert.ok(card, "the card exists")
    const q = r.sends().find((b) => /Use the cache\?/.test(b.text))
    assert.ok(r.sends().indexOf(card) < r.sends().indexOf(q), "card first")
    assert.ok(q.reply_parameters.message_id > 0)
    await r.done()
  })

  it("a permission is a reply to its card", async () => {
    const r = await rig({ config: { permissions: { notify: "all" } } })
    await r.ev("session.execution.started", "ses_c1")
    await r.tg.waitFor(() => r.cards()[0])
    await r.bridge.onEvent({
      type: "permission.asked",
      data: {
        id: "per_1",
        sessionID: "ses_c1",
        action: "bash",
        resources: ["ls"],
      },
    } as unknown as BridgeEvent)
    const p = await r.tg.waitFor(() =>
      r.sends().find((b) => /bash/.test(b.text) && !b.text.startsWith("<b>🤖")),
    )
    const waiting = await r.tg.waitFor(() =>
      r.edits().find((b) => /waiting for an answer/.test(b.text)),
    )
    assert.equal(p.reply_parameters.message_id, waiting.message_id)
    await r.done()
  })

  it("a question of the root is not a reply to anything", async () => {
    const r = await rig()
    await r.question("ses_root", "Ship it?")
    const q = await r.tg.waitFor(() =>
      r.sends().find((b) => /Ship it\?/.test(b.text)),
    )
    assert.equal(q.reply_parameters, undefined)
    await r.done()
  })
})

describe("a parent without a topic of its own", () => {
  it("gets no card, and its subagent's question goes to the shared topic as before", async () => {
    const r = await rig({
      topic: false,
      sessions: [{ ...ROOT, viewed: false }, CHILD],
    })
    await r.ev("session.execution.started", "ses_c1")
    await r.ev("session.execution.succeeded", "ses_c1")
    await r.wait(200)
    assert.equal(r.cards().length, 0, "no card")
    await r.question("ses_c1", "Use the cache?")
    const q = await r.tg.waitFor(() =>
      r.sends().find((b) => /Use the cache\?/.test(b.text)),
    )
    const made = r.tg.of("createForumTopic").map((c) => c.body.name)
    assert.equal(made.length, 1)
    assert.match(made[0], /agents/)
    assert.ok(q.message_thread_id !== undefined)
    assert.equal(q.reply_parameters, undefined)
    assert.equal(r.cards().length, 0)
    assert.equal(r.edits().length, 0)
    await r.done()
  })
})
