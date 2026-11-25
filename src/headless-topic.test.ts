import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
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
import {
  TelegramConnector,
  type TelegramOptions,
} from "./connectors/telegram.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"

const CHAT = 4242

const info = (
  id: string,
  title: string,
  over: Partial<SessionInfo> = {},
): SessionInfo => ({
  id,
  agent: "reviewer",
  directory: "/w/shop",
  title,
  viewed: false,
  ...over,
})

async function rig(
  o: {
    sessions: SessionInfo[]
    tg?: Partial<TelegramOptions>
    redact?: string
  } = { sessions: [] },
) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-head-"))
  const table = new Map(o.sessions.map((s) => [s.id, s]))
  const replies: Array<{ sessionID: string; formID: string }> = []
  const prompts: Array<{ sessionID: string; text: string }> = []
  const host: Host = {
    session: async (id) => table.get(id),
    root: (id) => {
      let cur = id
      for (let i = 0; i < 8 && table.get(cur)?.parentID; i++)
        cur = table.get(cur)!.parentID!
      return cur
    },
    replyForm: async (sessionID, formID) => {
      replies.push({ sessionID, formID })
    },
    prompt: async (sessionID, text) => {
      prompts.push({ sessionID, text })
    },
    busy: () => false,
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
    ...o.tg,
  })
  const cfg = parseConfig({
    channels: { telegram: { token: { env: "X" } } },
    redact: o.redact,
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
  bridge.start()
  let n = 0
  const ask = async (sessionID: string, text = "Deploy?") =>
    bridge.onEvent({
      type: "form.created",
      data: {
        form: {
          id: "frm_" + ++n,
          sessionID,
          title: "Questions",
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
  const asked = () =>
    tg.of("sendMessage").filter((c) => c.body.reply_markup?.inline_keyboard)
  const topics = () => tg.of("createForumTopic").map((c) => c.body.name)
  return {
    tg,
    table,
    bridge,
    router,
    replies,
    prompts,
    ask,
    asked,
    topics,
    async done() {
      await bridge.stop()
      await tg.close()
    },
  }
}

describe("headless sessions share one topic per project", () => {
  it("a parentless session no TUI viewed posts to <project> · agents, not to a topic of its own", async () => {
    const r = await rig({
      sessions: [
        info("a", "reviewer-security/bold-gecko"),
        info("b", "verifier/lively-ibex"),
      ],
    })
    await r.ask("a")
    await r.ask("b")
    assert.deepEqual(r.topics(), ["shop · agents"])
    const [x, y] = r.asked()
    assert.equal(x.body.message_thread_id, y.body.message_thread_id)
    assert.match(x.body.text, /^🏷 <i>reviewer-security\/bold-gecko<\/i>\n/)
    assert.match(y.body.text, /^🏷 <i>verifier\/lively-ibex<\/i>\n/)
    await r.done()
  })

  it("a parentless session a TUI viewed gets a topic of its own", async () => {
    const r = await rig({
      sessions: [info("c", "UI redesign", { viewed: true })],
    })
    await r.ask("c")
    assert.deepEqual(r.topics(), ["shop · UI redesign"])
    assert.ok(!/🏷/.test(r.asked()[0].body.text))
    await r.done()
  })

  it("the sessions of two projects get a shared topic each", async () => {
    const r = await rig({
      sessions: [info("a", "one"), info("b", "two", { directory: "/w/docs" })],
    })
    await r.ask("a")
    await r.ask("b")
    assert.deepEqual(r.topics().sort(), ["docs · agents", "shop · agents"])
    await r.done()
  })

  it("a child of a parentless session asks in the shared topic, tagged with the root's title", async () => {
    const r = await rig({
      sessions: [
        info("a", "reviewer-code/calm-otter"),
        info("kid", "task", { parentID: "a", agent: "general" }),
      ],
    })
    await r.ask("kid")
    assert.deepEqual(r.topics(), ["shop · agents"])
    assert.match(r.asked()[0].body.text, /^🏷 <i>reviewer-code\/calm-otter<\/i>/)
    await r.done()
  })

  it("a child of a viewed session still goes to the root's own topic", async () => {
    const r = await rig({
      sessions: [
        info("c", "UI redesign", { viewed: true }),
        info("kid", "task", { parentID: "c", agent: "general" }),
      ],
    })
    await r.ask("kid")
    assert.deepEqual(r.topics(), ["shop · UI redesign"])
    await r.done()
  })

  it("topics.headless session keeps a topic for each", async () => {
    const r = await rig({
      sessions: [info("a", "one"), info("b", "two")],
      tg: { topics: { headless: "session" } },
    })
    await r.ask("a")
    await r.ask("b")
    assert.deepEqual(r.topics().sort(), ["shop · one", "shop · two"])
    await r.done()
  })

  it("redacted titles tag with the end of the id, and no title is sent", async () => {
    const r = await rig({
      sessions: [info("ses_abcdef123456", "secret plan")],
      redact: "title",
    })
    await r.ask("ses_abcdef123456")
    assert.ok(!/secret plan/.test(JSON.stringify(r.tg.calls)))
    assert.match(r.asked()[0].body.text, /^🏷 <i>123456<\/i>/)
    await r.done()
  })

  it("a session with chat on posts to a topic of its own", async () => {
    const r = await rig({ sessions: [info("a", "talk")] })
    assert.equal((await r.bridge.setChat("a", true)).ok, true)
    await r.ask("a")
    assert.ok(r.topics().includes("shop · talk"))
    assert.ok(!r.topics().includes("shop · agents"))
    await r.done()
  })
})

describe("a session that is viewed later", () => {
  it("posts to a topic of its own from then on; what was sent stays and no topic is touched", async () => {
    const r = await rig({ sessions: [info("a", "reviewer/early-bird")] })
    await r.ask("a")
    const first = r.asked()[0]
    const shared = first.body.message_thread_id
    r.table.set("a", info("a", "reviewer/early-bird", { viewed: true }))
    await r.ask("a")
    assert.deepEqual(r.topics(), [
      "shop · agents",
      "shop · reviewer/early-bird",
    ])
    assert.notEqual(r.asked()[1].body.message_thread_id, shared)
    for (const m of [
      "deleteForumTopic",
      "editForumTopic",
      "closeForumTopic",
      "deleteMessage",
      "editMessageText",
    ])
      assert.equal(r.tg.of(m).length, 0, m)
    await r.done()
  })

  it("a session that has its own topic keeps it if it is unviewed again", async () => {
    const r = await rig({
      sessions: [info("a", "own", { viewed: true })],
    })
    await r.ask("a")
    r.table.set("a", info("a", "own", { viewed: false }))
    await r.ask("a")
    assert.deepEqual(r.topics(), ["shop · own"])
    await r.done()
  })

  it("a session that gains a parent follows its root", async () => {
    const r = await rig({
      sessions: [
        info("a", "worker"),
        info("boss", "UI redesign", { viewed: true }),
      ],
    })
    await r.ask("a")
    r.table.set("a", info("a", "worker", { parentID: "boss" }))
    await r.ask("a")
    assert.deepEqual(r.topics(), ["shop · agents", "shop · UI redesign"])
    await r.done()
  })

  it("the shared topic gets no card, rename or typing indicator", async () => {
    const r = await rig({ sessions: [info("a", "worker")] })
    await r.bridge.onEvent({
      type: "session.execution.started",
      data: { sessionID: "a" },
    } as unknown as BridgeEvent)
    await new Promise((res) => setTimeout(res, 100))
    assert.deepEqual(r.topics(), [], "working alone makes no topic")
    await r.ask("a")
    await new Promise((res) => setTimeout(res, 100))
    assert.equal(r.tg.of("pinChatMessage").length, 0)
    assert.equal(r.tg.of("editForumTopic").length, 0)
    assert.equal(r.tg.of("sendChatAction").length, 0)
    await r.done()
  })
})

describe("replies in the shared topic", () => {
  it("a reply to one agent's question answers that agent's question", async () => {
    const r = await rig({
      sessions: [info("a", "first"), info("b", "second")],
    })
    await r.ask("a")
    await r.ask("b")
    const [qa, qb] = r.asked()
    const thread = qa.body.message_thread_id
    const refB = (await r.tg.waitFor(() => r.tg.lastMessageId)) as number
    assert.ok(refB)
    r.tg.message(CHAT, "Yes", refB, thread)
    await r.tg.waitFor(() => r.replies[0])
    assert.deepEqual(
      r.replies.map((x) => x.sessionID),
      ["b"],
    )
    void qb
    await r.done()
  })

  it("a free-text reply goes to the session of the message, when chat is on for it", async () => {
    const r = await rig({
      sessions: [info("a", "first"), info("b", "second")],
    })
    const fail = (id: string) =>
      r.bridge.onEvent({
        type: "session.execution.failed",
        data: { sessionID: id },
      } as unknown as BridgeEvent)
    const notes = () =>
      r.tg.of("sendMessage").filter((c) => c.body.text.startsWith("🏷"))
    await fail("a")
    await r.tg.waitFor(() => notes()[0])
    const refA = r.tg.lastMessageId
    const thread = notes()[0].body.message_thread_id
    await fail("b")
    await r.tg.waitFor(() => notes()[1])
    assert.match(notes()[1].body.text, /second/)
    assert.equal((await r.bridge.setChat("a", true)).ok, true)
    r.tg.message(CHAT, "carry on", refA, thread)
    await r.tg.waitFor(() => r.prompts[0])
    assert.deepEqual(r.prompts, [{ sessionID: "a", text: "carry on" }])
    await r.done()
  })

  it("a message that replies to no message is refused with a hint and reaches no session", async () => {
    const r = await rig({
      sessions: [info("a", "first"), info("b", "second")],
    })
    await r.ask("a")
    const thread = r.asked()[0].body.message_thread_id
    r.tg.message(CHAT, "hello agents", undefined, thread)
    const hint = await r.tg.waitFor(() =>
      r.tg
        .of("sendMessage")
        .find((c) => /Reply to one agent/.test(c.body.text)),
    )
    assert.equal(hint.body.message_thread_id, thread)
    assert.deepEqual(r.prompts, [])
    assert.deepEqual(r.replies, [])
    await r.done()
  })

  it("a reply to a message the bridge does not know is refused with the hint too", async () => {
    const r = await rig({ sessions: [info("a", "first")] })
    await r.ask("a")
    const thread = r.asked()[0].body.message_thread_id
    r.tg.message(CHAT, "what about this", 987654, thread)
    await r.tg.waitFor(() =>
      r.tg
        .of("sendMessage")
        .find((c) => /Reply to one agent/.test(c.body.text)),
    )
    assert.deepEqual(r.prompts, [])
    await r.done()
  })

  it("an edit of a tagged question keeps the tag", async () => {
    const r = await rig({ sessions: [info("a", "reviewer/keeps-tag")] })
    await r.ask("a")
    const ref = await r.tg.waitFor(() => r.tg.lastMessageId)
    const ch = (r.bridge as unknown as { channels: TelegramConnector[] })
      .channels[0]
    await ch.update(String(ref), { message: "done", title: "Answered" })
    const edit = r.tg.of("editMessageText").at(-1)!
    assert.match(edit.body.text, /^🏷 <i>reviewer\/keeps-tag<\/i>\n/)
    await r.done()
  })
})
