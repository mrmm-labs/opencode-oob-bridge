import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { Bridge, type BridgeEvent, type Host } from "./bridge.ts"
import type { InboundFile } from "./connectors/types.ts"
import { parseConfig, type Config } from "./config.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import {
  TelegramConnector,
  type TelegramOptions,
} from "./connectors/telegram.ts"
import { Telemetry } from "./otel.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"
import { traces } from "./trace.ts"
import { sleep } from "./util.ts"

const CHAT = 4242
const SECRET = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"

type Rig = Awaited<ReturnType<typeof chatRig>>

const emojis = (r: Rig) =>
  r.tg.of("setMessageReaction").map((c) => c.body.reaction[0].emoji as string)
const reactions = (r: Rig, n: number) =>
  r.tg.waitFor(() => (emojis(r).length >= n ? emojis(r) : undefined))

async function chatRig(
  o: {
    chat?: Record<string, unknown>
    redact?: string
    tg?: Partial<TelegramOptions>
    busy?: boolean
    directory?: string
    posts?: string[]
    agent?: string
    failPrompt?: boolean | number
  } = {},
) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-chat-"))
  const tel = o.posts
    ? new Telemetry(
        { endpoint: "https://otel.example" },
        async (_url, init) => {
          o.posts!.push(String(init.body))
          return new Response("{}", { status: 200 })
        },
        60_000,
      )
    : undefined
  const channel = new TelegramConnector({
    token: async () => tg.token,
    chatId: String(CHAT),
    apiBase: tg.url,
    topicsFile: join(dir, "topics.json"),
    offsetFile: join(dir, "offset.json"),
    pollSeconds: 1,
    backoff: { min: 10, max: 40 },
    typingMs: 25,
    tel,
    reactGapMs: 5,
    ...o.tg,
  })
  const cfg = parseConfig({
    channels: { telegram: { token: { env: "X" } } },
    // These tests are about the host's own queue; the held-message path has its own file.
    chat: { queueSteerSeconds: 0, ...o.chat },
    redact: o.redact,
  }) as Config
  const prompts: Array<{
    sessionID: string
    text: string
    files?: InboundFile[]
  }> = []
  const deliveries: string[] = []
  const replies: unknown[] = []
  const state = { busy: o.busy ?? false }
  let failures = 0
  const host: Host = {
    session: async (id) =>
      id === "root"
        ? {
            id,
            agent: o.agent ?? "coord",
            directory: o.directory ?? "/w/shop",
            title: "Fix",
          }
        : undefined,
    root: (id) => id,
    replyForm: async (sessionID, formID, answer) => {
      replies.push({ sessionID, formID, answer })
    },
    prompt: async (sessionID, text, delivery, files) => {
      if (o.failPrompt === true || (o.failPrompt && failures++ < o.failPrompt))
        throw new Error("boom")
      prompts.push({ sessionID, text, ...(files ? { files } : {}) })
      deliveries.push(delivery)
    },
    busy: () => state.busy,
  }
  const router = new Router(cfg, async () => true)
  const store = new PendingStore()
  const bridge = new Bridge(cfg, host, [channel], store, router, Date.now, tel)
  bridge.start()
  const ev = (type: string, data: Record<string, unknown> = {}) =>
    bridge.onEvent({
      type,
      data: { sessionID: "root", ...data },
    } as unknown as BridgeEvent)
  return {
    tg,
    router,
    bridge,
    store,
    prompts,
    deliveries,
    replies,
    state,
    ev,
    tel,
    cfg,
    channel,
    sends: () => tg.of("sendMessage").map((c) => c.body),
    async done() {
      await bridge.stop()
      await tg.close()
    },
  }
}

const chatOn = async (r: Rig) => {
  const out = await r.bridge.setChat("root", true)
  assert.equal(out.ok, true, out.text)
  await r.tg.waitFor(() => r.tg.of("sendMessage")[0])
}

describe("chat from Telegram: access", () => {
  it("is off by default: a message in the topic is not sent, and the hint comes once an hour", async () => {
    const r = await chatRig()
    r.router.set("root", true)
    await r.ev("session.execution.started")
    await r.tg.waitFor(() => r.tg.of("createForumTopic")[0])
    r.tg.message(CHAT, "do the thing", undefined, 9001)
    const hint = await r.tg.waitFor(() =>
      r.sends().find((b) => /Chat is off for this session/.test(b.text)),
    )
    assert.match(hint.text, /run \/oob chat on in the TUI/)
    assert.equal(hint.message_thread_id, 9001)
    r.tg.message(CHAT, "again", undefined, 9001)
    await sleep(150)
    assert.equal(r.sends().filter((b) => /Chat is off/.test(b.text)).length, 1)
    assert.deepEqual(r.prompts, [])
    await r.done()
  })

  it("maps the topic to its session and acknowledges with a reaction only", async () => {
    const r = await chatRig()
    await chatOn(r)
    const before = r.sends().length
    r.tg.message(CHAT, "run the tests", undefined, 9001)
    await r.tg.waitFor(() => r.prompts[0])
    assert.deepEqual(r.prompts, [{ sessionID: "root", text: "run the tests" }])
    assert.deepEqual(await reactions(r, 2), ["👀", "⚡"])
    assert.ok(
      r.tg
        .of("setMessageReaction")
        .every((c) => c.body.message_id === r.tg.lastMessageId),
    )
    await sleep(100)
    assert.equal(r.sends().length, before, "no 'sent to' line")
    await r.done()
  })

  it("the sent reaction is ⚡; a configured agent emoji replaces it, a disallowed one does not", async () => {
    const emojiFor = async (agent: string, cfg?: Record<string, unknown>) => {
      const r = await chatRig({ agent, tg: { reactions: cfg } as never })
      await chatOn(r)
      r.tg.message(CHAT, "hi", undefined, 9001)
      const seen = await reactions(r, 2)
      await r.done()
      return seen[1]
    }
    assert.equal(await emojiFor("build"), "⚡")
    assert.equal(await emojiFor("Coordinator"), "⚡")
    assert.equal(
      await emojiFor("coord", { agents: { coord: "🎯" } }),
      "⚡",
      "🎯 is not allowed for bots",
    )
    assert.equal(await emojiFor("coord", { agents: { coord: "🔥" } }), "🔥")
    assert.equal(await emojiFor("build", { agents: { build: "🤓" } }), "🤓")
  })

  it("a busy session gets the queued reaction, and still sends the prompt", async () => {
    const r = await chatRig({ busy: true })
    await chatOn(r)
    const before = r.sends().length
    r.tg.message(CHAT, "and then this", undefined, 9001)
    assert.deepEqual(await reactions(r, 2), ["👀", "✍"])
    assert.equal(r.prompts.length, 1)
    await sleep(100)
    assert.equal(r.sends().length, before, "no 'queued for' line")
    await r.done()
  })

  it("a reaction Telegram refuses falls back to the old line, so the sender still learns where it went", async () => {
    const r = await chatRig()
    await chatOn(r)
    // The 👀 and the ⚡ are both refused; delivery is not affected.
    for (let i = 0; i < 2; i++)
      r.tg.fail("setMessageReaction", 400, { description: "REACTION_INVALID" })
    r.tg.message(CHAT, "run it", undefined, 9001)
    const line = await r.tg.waitFor(() =>
      r.sends().find((b) => /→ sent to coord · shop/.test(b.text)),
    )
    assert.equal(line.message_thread_id, 9001)
    assert.equal(r.prompts.length, 1)
    await r.done()
  })

  it("a prompt that could not be sent still gets a text message", async () => {
    const r = await chatRig({ failPrompt: true })
    await chatOn(r)
    r.tg.message(CHAT, "run it", undefined, 9001)
    await r.tg.waitFor(() =>
      r.sends().find((b) => /Could not send that to the session/.test(b.text)),
    )
    assert.deepEqual(await reactions(r, 2), ["👀", "💔"])
    await r.done()
  })

  it("a prompt that fails once is kept, the topic is told, and the retry reaches the session", async () => {
    const r = await chatRig({ failPrompt: 1, tg: { retryMs: [30] } })
    await chatOn(r)
    r.tg.message(CHAT, "run it", undefined, 9001)
    const notice = await r.tg.waitFor(() =>
      r
        .sends()
        .find((b) => /Not delivered \(Could not send.*boom/.test(b.text)),
    )
    assert.equal(notice.message_thread_id, 9001)
    await r.tg.waitFor(() => r.prompts[0])
    assert.equal(r.prompts[0].text, "run it")
    await r.tg.waitFor(() => r.tg.of("setMessageReaction")[0])
    await r.done()
  })

  it("a reply to one of the session's bot messages is a prompt too, outside the topic", async () => {
    const r = await chatRig()
    await chatOn(r)
    const card = Number(
      (await r.tg.waitFor(() => r.tg.of("sendMessage")[0])).body && 501,
    )
    r.tg.message(CHAT, "via reply", card)
    await r.tg.waitFor(() => r.prompts[0])
    assert.equal(r.prompts[0].text, "via reply")
    await r.done()
  })

  it("ignores another chat, an unknown topic, and a plain message outside any topic", async () => {
    const r = await chatRig()
    await chatOn(r)
    r.tg.message(999, "intruder", undefined, 9001)
    r.tg.message(CHAT, "nobody's topic", undefined, 4444)
    r.tg.message(CHAT, "general chatter")
    await sleep(200)
    assert.deepEqual(r.prompts, [])
    const sent = r.sends().map((b) => b.text)
    assert.equal(sent.length, 3, "the card and a notice for each unowned topic")
    assert.equal(sent.filter((t) => /No session here/.test(t)).length, 2)
    await r.done()
  })

  it("answers still answer: a reply to a question is the answer, not a prompt", async () => {
    const r = await chatRig()
    await chatOn(r)
    await r.bridge.onEvent({
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
    const q = await r.tg.waitFor(() =>
      r.sends().find((b) => /Go\?/.test(b.text)),
    )
    assert.ok(q)
    const ref = Number(r.store.list()[0].refs!.telegram)
    r.tg.message(CHAT, "2", ref, 9001)
    await r.tg.waitFor(() => r.replies[0])
    assert.deepEqual((r.replies[0] as { answer: unknown }).answer, { q0: "No" })
    assert.deepEqual(r.prompts, [])
    // A plain message in the same topic is a prompt.
    r.tg.message(CHAT, "next step", undefined, 9001)
    await r.tg.waitFor(() => r.prompts[0])
    await r.done()
  })

  it("permissions are never answered from a chat", async () => {
    const r = await chatRig()
    await chatOn(r)
    await r.bridge.onEvent({
      type: "permission.asked",
      data: {
        id: "per_1",
        sessionID: "root",
        action: "bash",
        resources: ["rm x"],
      },
    } as unknown as BridgeEvent)
    const p = await r.tg.waitFor(() =>
      r.sends().find((b) => /needs permission/.test(b.text)),
    )
    assert.equal(p.reply_markup, undefined)
    const ref = Number(r.store.list()[0].refs!.telegram)
    r.tg.message(CHAT, "1", ref, 9001)
    await r.tg.waitFor(() =>
      r
        .sends()
        .find((b) => /only be answered in the OpenCode TUI/.test(b.text)),
    )
    assert.deepEqual(r.replies, [])
    assert.deepEqual(r.prompts, [])
    await r.done()
  })
})

describe("chat from Telegram: deny list and the Stop button", () => {
  it("chat.deny blocks /oob chat on and explains why", async () => {
    const r = await chatRig({ chat: { deny: [{ directory: "**/shop" }] } })
    const out = await r.bridge.setChat("root", true)
    assert.equal(out.ok, false)
    assert.match(out.text, /blocked .* chat\.deny/)
    assert.equal(r.bridge.chatEnabled("root"), false)
    await r.done()
  })

  it("chat.deny also blocks a session whose chat was restored from settings", async () => {
    const r = await chatRig({ chat: { deny: [{ agent: "^coord$" }] } })
    r.bridge.restoreChat("root")
    r.router.set("root", true)
    await r.ev("session.execution.started")
    await r.tg.waitFor(() => r.tg.of("createForumTopic")[0])
    r.tg.message(CHAT, "sneak", undefined, 9001)
    await r.tg.waitFor(() =>
      r
        .sends()
        .find((b) => /blocked for this session by chat\.deny/.test(b.text)),
    )
    assert.deepEqual(r.prompts, [])
    await r.done()
  })

  it("the card carries a Stop chat button while chat is on; tapping it turns chat off and removes the button", async () => {
    const r = await chatRig()
    await chatOn(r)
    const card = r.sends()[0]
    assert.deepEqual(card.reply_markup, {
      inline_keyboard: [[{ text: "🛑 Stop chat", callback_data: "chatoff" }]],
    })
    assert.match(card.text.split("\n")[0], /💬 on — /)
    r.tg.callback(CHAT, 501, "chatoff", 9001)
    await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.equal(r.bridge.chatEnabled("root"), false)
    assert.match(r.tg.of("answerCallbackQuery")[0].body.text, /Chat is off/)
    r.tg.message(CHAT, "hello?", undefined, 9001)
    await r.tg.waitFor(() =>
      r.sends().find((b) => /Chat is off for this session/.test(b.text)),
    )
    assert.deepEqual(r.prompts, [])
    await r.done()
  })

  it("no chat without a channel that can chat selected", async () => {
    const r = await chatRig()
    r.bridge.setEnabled("telegram", false)
    const out = await r.bridge.setChat("root", true)
    assert.equal(out.ok, false)
    assert.match(out.text, /No channel that can chat/)
    await r.done()
  })
})

describe("chat from Telegram: replies", () => {
  const turn = async (r: Rig, text: string, id = "m1") => {
    await r.ev("session.execution.started")
    await r.ev("session.text.started", { assistantMessageID: id, ordinal: 0 })
    await r.ev("session.text.ended", {
      assistantMessageID: id,
      ordinal: 0,
      text,
    })
    await r.ev("session.execution.succeeded")
  }

  it("posts the final text of a turn as formatted HTML, escaped, in the topic", async () => {
    const r = await chatRig({ chat: { stream: false } })
    await chatOn(r)
    await turn(r, "Done: **ok** <b>& `x<y`\n\n```html\n<p>a & b</p>\n```")
    const m = await r.tg.waitFor(() =>
      r.sends().find((b) => /Done:/.test(b.text)),
    )
    assert.equal(m.parse_mode, "HTML")
    assert.equal(m.message_thread_id, 9001)
    assert.equal(
      m.text,
      'Done: <b>ok</b> &lt;b&gt;&amp; <code>x&lt;y</code>\n<pre><code class="language-html">&lt;p&gt;a &amp; b&lt;/p&gt;</code></pre>',
    )
    await r.done()
  })

  it("a prompt preview limit does not cut replies: chat.redact applies, full by default", async () => {
    const long = `${"word ".repeat(200)}END`
    const r = await chatRig({ redact: "head:300", chat: { stream: false } })
    await chatOn(r)
    await turn(r, long)
    const m = await r.tg.waitFor(() =>
      r.sends().find((b) => /END/.test(b.text)),
    )
    assert.ok(m.text.endsWith("END"))
    await r.done()

    const cut = await chatRig({ chat: { stream: false, redact: "head:50" } })
    await chatOn(cut)
    await turn(cut, long, "m2")
    const c = await cut.tg.waitFor(() =>
      cut.sends().find((b) => b.text.startsWith("word")),
    )
    assert.ok(c.text.length <= 60)
    assert.ok(!c.text.includes("END"))
    await cut.done()
  })

  it("only the last assistant message of the turn counts, and secrets are filtered", async () => {
    const r = await chatRig({ chat: { stream: false } })
    await chatOn(r)
    await r.ev("session.execution.started")
    await r.ev("session.text.ended", {
      assistantMessageID: "m1",
      ordinal: 0,
      text: "step one, thinking aloud",
    })
    await r.ev("session.text.ended", {
      assistantMessageID: "m2",
      ordinal: 0,
      text: `final answer ${SECRET}`,
    })
    await r.ev("session.execution.succeeded")
    const m = await r.tg.waitFor(() =>
      r.sends().find((b) => /final answer/.test(b.text)),
    )
    assert.doesNotMatch(m.text, /ghp_/)
    assert.equal(r.sends().filter((b) => /step one/.test(b.text)).length, 0)
    await r.done()
  })

  it("redact title hides the reply text", async () => {
    const r = await chatRig({ chat: { stream: false }, redact: "title" })
    await chatOn(r)
    await turn(r, "secret plan")
    const m = await r.tg.waitFor(() =>
      r.sends().find((b) => /details hidden/.test(b.text)),
    )
    assert.doesNotMatch(m.text, /secret plan/)
    await r.done()
  })

  it("splits a long reply on paragraphs into at most 3 messages, then a document for the rest", async () => {
    const r = await chatRig({ chat: { stream: false } })
    await chatOn(r)
    const text = Array.from(
      { length: 200 },
      (_, i) => `Paragraph ${i} ${"word ".repeat(40)}`,
    ).join("\n\n")
    await turn(r, text)
    const doc = await r.tg.waitFor(() => r.tg.of("sendDocument")[0])
    assert.equal(doc.body.multipart, true)
    assert.equal(doc.body.fields.caption, "📄 Full reply")
    assert.equal(doc.body.fields.message_thread_id, "9001")
    assert.equal(doc.body.fields.document, text.trim())
    const parts = r.sends().filter((b) => b.text.startsWith("Paragraph"))
    assert.equal(parts.length, 3)
    for (const p of parts) assert.ok(p.text.length <= 4096)
    await r.done()
  })

  it("a reply that fits in three messages sends no document", async () => {
    const r = await chatRig({ chat: { stream: false } })
    await chatOn(r)
    await turn(
      r,
      Array.from({ length: 50 }, (_, i) => `P${i} ${"word ".repeat(40)}`).join(
        "\n\n",
      ),
    )
    await r.tg.waitFor(
      () => r.sends().filter((b) => /^P\d/.test(b.text)).length >= 2,
    )
    await sleep(100)
    assert.equal(r.tg.of("sendDocument").length, 0)
    await r.done()
  })

  it("mirrors a reply to a turn started from the TUI by default, and not under remote-only", async () => {
    const a = await chatRig({ chat: { stream: false } })
    await chatOn(a)
    await turn(a, "from the tui")
    await a.tg.waitFor(() => a.sends().find((b) => /from the tui/.test(b.text)))
    await a.done()

    const b = await chatRig({ chat: { stream: false, mirror: "remote-only" } })
    await chatOn(b)
    await turn(b, "tui turn, not mirrored")
    await sleep(150)
    assert.equal(b.sends().filter((x) => /not mirrored/.test(x.text)).length, 0)
    b.tg.message(CHAT, "from the phone", undefined, 9001)
    await b.tg.waitFor(() => b.prompts[0])
    await turn(b, "phone turn, mirrored", "m9")
    await b.tg.waitFor(() =>
      b.sends().find((x) => /phone turn, mirrored/.test(x.text)),
    )
    await b.done()
  })

  it("posts nothing for a session with chat off", async () => {
    const r = await chatRig({ chat: { stream: false } })
    await r.ev("session.execution.started")
    await r.ev("session.text.ended", {
      assistantMessageID: "m1",
      ordinal: 0,
      text: "hi",
    })
    await r.ev("session.execution.succeeded")
    await sleep(100)
    assert.equal(r.sends().filter((b) => b.text === "hi").length, 0)
    await r.done()
  })

  it("a failed turn posts no reply", async () => {
    const r = await chatRig({ chat: { stream: false } })
    await chatOn(r)
    await r.ev("session.execution.started")
    await r.ev("session.text.ended", {
      assistantMessageID: "m1",
      ordinal: 0,
      text: "half done",
    })
    await r.ev("session.execution.failed")
    await sleep(100)
    assert.equal(r.sends().filter((b) => /half done/.test(b.text)).length, 0)
    await r.done()
  })
})

describe("chat from Telegram: typing indicator", () => {
  it("starts when the session works and stops when it goes idle", async () => {
    const r = await chatRig()
    await chatOn(r)
    await r.ev("session.execution.started")
    const first = await r.tg.waitFor(() => r.tg.of("sendChatAction")[0])
    assert.deepEqual(first.body, {
      chat_id: String(CHAT),
      message_thread_id: 9001,
      action: "typing",
    })
    await r.tg.waitFor(() => r.tg.of("sendChatAction").length >= 3)
    await r.ev("session.execution.succeeded")
    const n = r.tg.of("sendChatAction").length
    await sleep(120)
    assert.equal(r.tg.of("sendChatAction").length, n, "stopped")
    await r.done()
  })

  it("is not sent for a session with chat off", async () => {
    const r = await chatRig()
    r.router.set("root", true)
    await r.ev("session.execution.started")
    await r.tg.waitFor(() => r.tg.of("sendMessage")[0])
    await sleep(100)
    assert.equal(r.tg.of("sendChatAction").length, 0)
    await r.done()
  })
})

describe("chat from Telegram: streaming", () => {
  const session = { id: "root", name: "shop · Fix", project: "shop" }
  const rigWithClock = async () => {
    const clock = { t: 1_000_000 }
    const tg = await fakeTelegram()
    tg.forum = true
    const c = new TelegramConnector({
      token: async () => tg.token,
      chatId: String(CHAT),
      apiBase: tg.url,
      now: () => clock.t,
    })
    return { tg, c, clock }
  }
  // Until the fake has heard nothing new for a moment.
  const settle = async (tg: { calls: unknown[] }) => {
    let n = -1
    while (tg.calls.length !== n) {
      n = tg.calls.length
      await sleep(50)
    }
  }

  it("sends on the first text, then edits at most once every 1.5 s", async () => {
    const { tg, c, clock } = await rigWithClock()
    c.stream(session, "Hel")
    await settle(tg)
    assert.equal(tg.of("sendMessage").length, 1)
    assert.equal(tg.of("sendMessage")[0].body.text, "Hel")

    c.stream(session, "Hello wor")
    c.stream(session, "Hello world")
    await settle(tg)
    assert.equal(tg.of("editMessageText").length, 0, "within the gap")

    clock.t += 1600
    c.stream(session, "Hello world!")
    await settle(tg)
    const edits = tg.of("editMessageText")
    assert.equal(edits.length, 1)
    assert.equal(edits[0].body.text, "Hello world!")
    assert.equal(edits[0].body.message_id, 501)
    await tg.close()
  })

  it("a change that came too soon is applied later by a timer, not lost", async () => {
    const tg = await fakeTelegram()
    tg.forum = true
    const c = new TelegramConnector({
      token: async () => tg.token,
      chatId: String(CHAT),
      apiBase: tg.url,
    })
    c.stream(session, "a")
    await tg.waitFor(() => tg.of("sendMessage")[0])
    c.stream(session, "a b")
    const e = await tg.waitFor(() => tg.of("editMessageText")[0], 4000)
    assert.equal(e.body.text, "a b")
    await tg.close()
  })

  it("closes an open code fence in the partial render and escapes the text", async () => {
    const { tg, c } = await rigWithClock()
    c.stream(session, "Look:\n```js\nif (a < b && c) {")
    await settle(tg)
    assert.equal(
      tg.of("sendMessage")[0].body.text,
      'Look:\n<pre><code class="language-js">if (a &lt; b &amp;&amp; c) {</code></pre>',
    )
    await tg.close()
  })

  it("passes about 3,800 characters: freezes that message and continues in a new one, at most 3", async () => {
    const { tg, c, clock } = await rigWithClock()
    const para = (i: number) => `Paragraph ${i} ${"word ".repeat(40)}`
    let text = ""
    for (let i = 0; i < 100; i++) {
      text += `${i ? "\n\n" : ""}${para(i)}`
      if (i % 5 === 0) {
        c.stream(session, text)
        clock.t += 1600
        await settle(tg)
      }
    }
    c.stream(session, text)
    clock.t += 1600
    await settle(tg)
    const sent = tg.of("sendMessage")
    assert.equal(sent.length, 3, "three messages at most")
    assert.ok(sent[0].body.text.length <= 3800)
    // The first message was frozen: it is not edited after the second exists.
    const firstEdits = tg
      .of("editMessageText")
      .filter((e) => e.body.message_id === 501)
    const secondAt = tg.calls.findIndex(
      (x) => x.method === "sendMessage" && x.body.text !== sent[0].body.text,
    )
    const lastFirstEdit = tg.calls.findLastIndex(
      (x) => x.method === "editMessageText" && x.body.message_id === 501,
    )
    assert.ok(firstEdits.length === 0 || lastFirstEdit < secondAt + 1)
    await tg.close()
  })

  it("honours 429 retry_after: no edit before it, then the same text goes through", async () => {
    const { tg, c, clock } = await rigWithClock()
    c.stream(session, "one")
    await settle(tg)
    clock.t += 1600
    tg.fail("editMessageText", 429, { parameters: { retry_after: 5 } })
    c.stream(session, "one two")
    await settle(tg)
    assert.equal(tg.of("editMessageText").length, 1, "the rejected try")
    clock.t += 2000
    c.stream(session, "one two three")
    await settle(tg)
    assert.equal(tg.of("editMessageText").length, 1, "still backing off")
    clock.t += 4000
    c.stream(session, "one two three")
    await tg.waitFor(() => tg.of("editMessageText")[1])
    assert.equal(tg.of("editMessageText")[1].body.text, "one two three")
    await tg.close()
  })

  it("through the bridge: streams while the turn runs and ends with the full text in the same message", async () => {
    const r = await chatRig()
    await chatOn(r)
    await r.ev("session.execution.started")
    await r.ev("session.text.started", { assistantMessageID: "m1", ordinal: 0 })
    await r.ev("session.text.delta", {
      assistantMessageID: "m1",
      ordinal: 0,
      delta: "Working on ",
    })
    const first = await r.tg.waitFor(() =>
      r.sends().find((b) => b.text === "Working on"),
    )
    assert.ok(first)
    await r.ev("session.text.delta", {
      assistantMessageID: "m1",
      ordinal: 0,
      delta: "**it**",
    })
    await r.ev("session.text.ended", {
      assistantMessageID: "m1",
      ordinal: 0,
      text: "Working on **it**",
    })
    await r.ev("session.execution.succeeded")
    const edit = await r.tg.waitFor(() =>
      r.tg
        .of("editMessageText")
        .find((e) => e.body.text === "Working on <b>it</b>"),
    )
    assert.equal(edit.body.message_id, 502)
    assert.equal(
      r.sends().filter((b) => /Working on/.test(b.text)).length,
      1,
      "one message, not two",
    )
    await r.done()
  })

  it("chat.stream false: only the final reply, once", async () => {
    const r = await chatRig({ chat: { stream: false } })
    await chatOn(r)
    await r.ev("session.execution.started")
    await r.ev("session.text.delta", {
      assistantMessageID: "m1",
      ordinal: 0,
      delta: "partial",
    })
    await sleep(350)
    assert.equal(r.sends().filter((b) => /partial/.test(b.text)).length, 0)
    await r.ev("session.text.ended", {
      assistantMessageID: "m1",
      ordinal: 0,
      text: "partial and done",
    })
    await r.ev("session.execution.succeeded")
    await r.tg.waitFor(() =>
      r.sends().find((b) => b.text === "partial and done"),
    )
    await r.done()
  })
})

describe("chat from Telegram: telemetry carries no text", () => {
  it("records prompts, outcomes, replies and stream edits as counts and kinds only", async () => {
    const posts: string[] = []
    const r = await chatRig({ posts })
    await chatOn(r)
    const PROMPT = "please rotate the quarterly payroll keys"
    const REPLY = "rotated the payroll keys"
    r.tg.message(CHAT, PROMPT, undefined, 9001)
    await r.tg.waitFor(() => r.prompts[0])
    await r.ev("session.execution.started")
    await r.ev("session.text.delta", {
      assistantMessageID: "m1",
      ordinal: 0,
      delta: REPLY,
    })
    await sleep(350)
    await r.ev("session.text.ended", {
      assistantMessageID: "m1",
      ordinal: 0,
      text: REPLY,
    })
    await r.ev("session.execution.succeeded")
    await r.tg.waitFor(() => r.sends().find((b) => /rotated/.test(b.text)))
    await sleep(100)
    await r.tel!.flush()
    const dump = posts.join("\n")
    for (const bad of [
      PROMPT,
      REPLY,
      "payroll",
      "quarterly",
      "/w/shop",
      SECRET,
    ])
      assert.ok(!dump.includes(bad), `exported ${bad}`)
    assert.match(dump, /oob\.prompts/)
    assert.match(dump, /oob\.replies/)
    assert.match(dump, /oob\.reply/)
    assert.match(dump, /"stringValue":"prompt"/)
    assert.match(dump, /"stringValue":"sent"/)
    assert.match(dump, /oob\.stream\.edits/)
    await r.done()
  })

  it("counts denied, off and queued prompts by outcome", async () => {
    const posts: string[] = []
    const r = await chatRig({ posts, busy: true })
    r.router.set("root", true)
    await r.ev("session.execution.started")
    await r.tg.waitFor(() => r.tg.of("createForumTopic")[0])
    r.tg.message(CHAT, "off one", undefined, 9001)
    await r.tg.waitFor(() => r.sends().find((b) => /Chat is off/.test(b.text)))
    await chatOn(r)
    r.tg.message(CHAT, "queued one", undefined, 9001)
    await r.tg.waitFor(() => r.prompts[0])
    await r.tel!.flush()
    const dump = posts.join("\n")
    assert.match(dump, /"stringValue":"off"/)
    assert.match(dump, /"stringValue":"queued"/)
    await r.done()
  })
})

describe("chat from Telegram: steering", () => {
  it("queues by default; a leading ! is stripped and always steers, and the ack says so", async () => {
    const r = await chatRig({ busy: true })
    await chatOn(r)
    r.tg.message(CHAT, "plain one", undefined, 9001)
    await r.tg.waitFor(() => r.prompts[0])
    await reactions(r, 2)
    r.tg.message(CHAT, "!  change course", undefined, 9001)
    await r.tg.waitFor(() => r.prompts[1])
    assert.equal(r.prompts[1].text, "change course")
    assert.deepEqual(r.deliveries, ["queue", "steer"])
    assert.deepEqual(await reactions(r, 4), ["👀", "✍", "👀", "⚡"])
    assert.equal(
      r.tg.of("setMessageReaction")[3].body.message_id,
      r.tg.lastMessageId,
    )
    await r.done()
  })

  it("an idle session just gets the message: → sent", async () => {
    const r = await chatRig({ busy: false })
    await chatOn(r)
    r.tg.message(CHAT, "!now", undefined, 9001)
    const react = await r.tg.waitFor(() => r.tg.of("setMessageReaction")[0])
    assert.deepEqual(react.body.reaction, [{ type: "emoji", emoji: "👀" }])
    assert.deepEqual(r.deliveries, ["steer"])
    await r.done()
  })

  it("a lone ! is no prompt", async () => {
    const r = await chatRig({ busy: true })
    await chatOn(r)
    r.tg.message(CHAT, "!", undefined, 9001)
    await sleep(150)
    assert.deepEqual(r.prompts, [])
    await r.done()
  })

  it("chat.delivery steer steers a busy session and leaves an idle one plain", async () => {
    const r = await chatRig({ busy: true, chat: { delivery: "steer" } })
    await chatOn(r)
    r.tg.message(CHAT, "one", undefined, 9001)
    await r.tg.waitFor(() => r.prompts[0])
    r.state.busy = false
    r.tg.message(CHAT, "two", undefined, 9001)
    await r.tg.waitFor(() => r.prompts[1])
    assert.deepEqual(r.deliveries, ["steer", "queue"])
    await r.done()
  })

  it("a per-session override beats chat.delivery, and clearing it goes back", async () => {
    const r = await chatRig({ busy: true })
    await chatOn(r)
    assert.equal(r.bridge.delivery("root"), "queue")
    r.bridge.setDelivery("root", "steer")
    assert.equal(r.bridge.delivery("root"), "steer")
    assert.equal(r.bridge.deliveryOverride("root"), "steer")
    r.tg.message(CHAT, "go", undefined, 9001)
    await r.tg.waitFor(() => r.prompts[0])
    assert.deepEqual(r.deliveries, ["steer"])
    r.bridge.setDelivery("root", undefined)
    assert.equal(r.bridge.delivery("root"), "queue")
    r.tg.message(CHAT, "again", undefined, 9001)
    await r.tg.waitFor(() => r.prompts[1])
    assert.deepEqual(r.deliveries, ["steer", "queue"])
    await r.done()
  })

  it("counts a steered prompt by outcome", async () => {
    const posts: string[] = []
    const r = await chatRig({ posts, busy: true })
    await chatOn(r)
    r.tg.message(CHAT, "!hello", undefined, 9001)
    await r.tg.waitFor(() => r.prompts[0])
    await r.tel!.flush()
    assert.match(posts.join("\n"), /"stringValue":"steered"/)
    assert.doesNotMatch(posts.join("\n"), /hello/)
    await r.done()
  })
})

// A stream is `running` while one of its sends or edits is in flight.
const streamOf = (c: TelegramConnector, id: string) =>
  (c as unknown as { streams: Map<string, { running: boolean }> }).streams.get(
    id,
  )

describe("chat from Telegram: faster streaming", () => {
  it("the first text of a turn is shown at once, not after a wait", async () => {
    const r = await chatRig()
    await chatOn(r)
    await r.ev("session.execution.started")
    const t0 = Date.now()
    await r.ev("session.text.delta", {
      assistantMessageID: "m1",
      ordinal: 0,
      delta: "Hello",
    })
    await r.tg.waitFor(() => r.sends().find((b) => b.text === "Hello"))
    // The wait this guards against is streamMs (1 s): well under that is "at once", and a slow machine must not fail it.
    assert.ok(Date.now() - t0 < 600, `${Date.now() - t0} ms`)
    await r.done()
  })

  it("edits at most once per streamMs, 1 s by default, and honours a longer one", async () => {
    const clock = { t: 1_000_000 }
    const tg = await fakeTelegram()
    tg.forum = true
    const c = new TelegramConnector({
      token: async () => tg.token,
      chatId: String(CHAT),
      apiBase: tg.url,
      now: () => clock.t,
    })
    const s = { id: "root", name: "shop · Fix", project: "shop" }
    // The mock clock moves only once the connector has finished the call it
    // is making: its next edit is counted from then.
    const idle = () => tg.waitFor(() => !streamOf(c, s.id)?.running)
    c.stream(s, "a")
    await tg.waitFor(() => tg.of("sendMessage")[0])
    await idle()
    clock.t += 900
    c.stream(s, "a b")
    await sleep(80)
    assert.equal(tg.of("editMessageText").length, 0, "inside 1 s")
    clock.t += 200
    c.stream(s, "a b c")
    await tg.waitFor(() => tg.of("editMessageText")[0])
    assert.equal(tg.of("editMessageText")[0].body.text, "a b c")
    await idle()
    // A longer gap, as chat.streamMs sets it: counted from the edit it follows.
    clock.t += 1500
    c.stream(s, "a b c d", 3000)
    await tg.waitFor(() => tg.of("editMessageText")[1])
    await idle()
    clock.t += 2000
    c.stream(s, "a b c d e", 3000)
    await sleep(80)
    assert.equal(tg.of("editMessageText").length, 2, "3 s not over yet")
    clock.t += 1100
    c.stream(s, "a b c d e f", 3000)
    await tg.waitFor(() => tg.of("editMessageText")[2])
    await tg.close()
  })

  it("the bridge hands chat.streamMs to the connector", async () => {
    const r = await chatRig({ chat: { streamMs: 2500 } })
    await chatOn(r)
    const gaps: Array<number | undefined> = []
    const orig = r.channel.stream.bind(r.channel)
    r.channel.stream = (s, t, g) => {
      gaps.push(g)
      orig(s, t, g)
    }
    await r.ev("session.execution.started")
    await r.ev("session.text.delta", {
      assistantMessageID: "m1",
      ordinal: 0,
      delta: "Hi",
    })
    await r.tg.waitFor(() => gaps[0] || undefined)
    assert.equal(gaps[0], 2500)
    await r.done()
  })
})

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n")

describe("chat from Telegram: files", () => {
  const notice = (r: Rig, re: RegExp) =>
    r.tg.waitFor(() => r.sends().find((b) => re.test(b.text)))

  it("a photo goes into the session as an inline file, its caption is the prompt", async () => {
    const r = await chatRig()
    await chatOn(r)
    r.tg.file("p-big", JPEG)
    r.tg.file("p-small", new Uint8Array([1]))
    r.tg.media(
      CHAT,
      {
        photo: [
          { file_id: "p-small", file_size: 1, width: 10, height: 10 },
          { file_id: "p-big", file_size: JPEG.length, width: 800, height: 600 },
        ],
      },
      "what is wrong here?",
      9001,
    )
    await r.tg.waitFor(() => r.prompts[0])
    assert.equal(r.prompts[0].text, "what is wrong here?")
    const f = r.prompts[0].files![0]
    assert.match(f.name, /^photo-\d+\.jpg$/)
    assert.equal(f.mime, "image/jpeg")
    assert.equal(f.data, Buffer.from(JPEG).toString("base64"))
    assert.deepEqual(r.tg.downloads, ["p-big"], "only the largest size")
    const react = await r.tg.waitFor(() => r.tg.of("setMessageReaction")[0])
    assert.deepEqual(react.body.reaction, [{ type: "emoji", emoji: "👀" }])
    await r.done()
  })

  it("a document with no caption is announced to the session by name", async () => {
    const r = await chatRig()
    await chatOn(r)
    r.tg.file("d1", PDF)
    r.tg.media(
      CHAT,
      {
        document: {
          file_id: "d1",
          file_name: "../../etc/spec.pdf",
          mime_type: "application/pdf",
          file_size: PDF.length,
        },
      },
      undefined,
      9001,
    )
    await r.tg.waitFor(() => r.prompts[0])
    assert.equal(r.prompts[0].text, "Attached: spec.pdf")
    assert.equal(r.prompts[0].files![0].mime, "application/pdf")
    await r.done()
  })

  it("refuses a file over the limit, or of a type not allowed, before downloading it", async () => {
    const r = await chatRig({
      tg: { media: { maxBytes: 100, mimes: ["application/pdf"] } },
    })
    await chatOn(r)
    r.tg.file("big", new Uint8Array(500))
    r.tg.media(
      CHAT,
      {
        document: {
          file_id: "big",
          mime_type: "application/pdf",
          file_size: 500,
        },
      },
      undefined,
      9001,
    )
    await notice(r, /the limit is/)
    r.tg.file("zip", new Uint8Array(10))
    r.tg.media(
      CHAT,
      {
        document: {
          file_id: "zip",
          mime_type: "application/zip",
          file_size: 10,
        },
      },
      undefined,
      9001,
    )
    await notice(r, /application\/zip are not accepted/)
    assert.deepEqual(r.tg.downloads, [])
    assert.equal(r.prompts.length, 0)
    await r.done()
  })

  it("does not trust a declared type: a PDF that is not one, a binary called text, a photo that is not a picture", async () => {
    const r = await chatRig()
    await chatOn(r)
    r.tg.file("fake", new Uint8Array([1, 2, 3, 4]))
    r.tg.media(
      CHAT,
      {
        document: {
          file_id: "fake",
          mime_type: "application/pdf",
          file_size: 4,
        },
      },
      undefined,
      9001,
    )
    await notice(r, /not really application\/pdf/)
    r.tg.file("bin", new Uint8Array([104, 105, 0, 0]))
    r.tg.media(
      CHAT,
      { document: { file_id: "bin", mime_type: "text/plain", file_size: 4 } },
      undefined,
      9001,
    )
    await notice(r, /not really text\/plain/)
    r.tg.file("pic", new Uint8Array([9, 9, 9, 9]))
    r.tg.media(
      CHAT,
      { photo: [{ file_id: "pic", file_size: 4 }] },
      undefined,
      9001,
    )
    await notice(r, /does not look like a picture/)
    assert.equal(r.prompts.length, 0)
    await r.done()
  })

  it("answers voice and video with not supported, and sends nothing to the session", async () => {
    const r = await chatRig()
    await chatOn(r)
    r.tg.media(CHAT, { voice: { file_id: "v", duration: 3 } }, undefined, 9001)
    await notice(r, /Voice and video messages are not supported/)
    r.tg.media(CHAT, { video: { file_id: "v2", duration: 3 } }, undefined, 9001)
    await r.tg.waitFor(
      () => r.sends().filter((b) => /not supported/.test(b.text)).length === 2,
    )
    assert.equal(r.prompts.length, 0)
    await r.done()
  })

  it("a file still needs chat to be on for the session", async () => {
    const r = await chatRig()
    r.router.set("root", true)
    await r.ev("session.execution.started")
    await r.tg.waitFor(() => r.tg.of("createForumTopic")[0])
    r.tg.file("p", JPEG)
    r.tg.media(CHAT, { photo: [{ file_id: "p", file_size: 8 }] }, "hi", 9001)
    await notice(r, /Chat is off for this session/)
    assert.equal(r.prompts.length, 0)
    await r.done()
  })
})

describe("chat from Telegram: the reaction follows the message", () => {
  const turn = async (r: Rig, text: string) => {
    await r.ev("session.execution.started")
    await r.ev("session.text.ended", {
      assistantMessageID: "m1",
      ordinal: 0,
      text,
    })
    await r.ev("session.execution.succeeded")
  }

  it("👀 received, ⚡ sent, then 👌 on the same message once the session replies", async () => {
    const r = await chatRig({ chat: { stream: false } })
    await chatOn(r)
    r.tg.message(CHAT, "run the tests", undefined, 9001)
    assert.deepEqual(await reactions(r, 2), ["👀", "⚡"])
    await turn(r, "all green")
    assert.deepEqual(await reactions(r, 3), ["👀", "⚡", "👌"])
    const ids = new Set(
      r.tg.of("setMessageReaction").map((c) => c.body.message_id),
    )
    assert.equal(ids.size, 1, "one message wore all three")
    await r.done()
  })

  it("a queued message shows ✍, and 👌 when the session replies", async () => {
    const r = await chatRig({ busy: true, chat: { stream: false } })
    await chatOn(r)
    r.tg.message(CHAT, "after this", undefined, 9001)
    assert.deepEqual(await reactions(r, 2), ["👀", "✍"])
    await turn(r, "done")
    assert.deepEqual(await reactions(r, 3), ["👀", "✍", "👌"])
    await r.done()
  })

  it("a message in a topic with no session shows 🙈 and is not sent", async () => {
    const r = await chatRig()
    await chatOn(r)
    r.tg.message(CHAT, "nobody's topic", undefined, 4444)
    assert.deepEqual(await reactions(r, 1), ["🙈"])
    await sleep(100)
    assert.deepEqual(r.prompts, [])
    await r.done()
  })

  it("a refused message (chat is off for the session) shows 🙈 after 👀", async () => {
    const r = await chatRig()
    r.router.set("root", true)
    await r.ev("session.execution.started")
    await r.tg.waitFor(() => r.tg.of("createForumTopic")[0])
    r.tg.message(CHAT, "hello", undefined, 9001)
    assert.deepEqual(await reactions(r, 2), ["👀", "🙈"])
    assert.deepEqual(r.prompts, [])
    await r.done()
  })

  it("a reaction that cannot be set never stops the delivery", async () => {
    const r = await chatRig()
    await chatOn(r)
    for (let i = 0; i < 3; i++)
      r.tg.fail("setMessageReaction", 400, { description: "REACTION_INVALID" })
    r.tg.message(CHAT, "still goes", undefined, 9001)
    await r.tg.waitFor(() => r.prompts[0])
    assert.equal(r.prompts[0].text, "still goes")
    await r.done()
  })

  it("the stage emoji can be configured, and a disallowed one falls back", async () => {
    const r = await chatRig({
      tg: { reactions: { received: "🤓", sent: "🎯", done: "🔥" } as never },
    })
    await chatOn(r)
    r.tg.message(CHAT, "hi", undefined, 9001)
    assert.deepEqual(await reactions(r, 2), ["🤓", "👀"])
    await r.done()
  })

  it("two reactions are never closer than the gap", async () => {
    const times: number[] = []
    const r = await chatRig({
      tg: {
        reactGapMs: 120,
        fetch: (async (url: string, init: RequestInit) => {
          if (String(url).endsWith("/setMessageReaction"))
            times.push(Date.now())
          return fetch(url, init)
        }) as never,
      },
    })
    await chatOn(r)
    r.tg.message(CHAT, "one", undefined, 9001)
    r.tg.message(CHAT, "two", undefined, 9001)
    await reactions(r, 4)
    for (let i = 1; i < times.length; i++)
      assert.ok(
        times[i] - times[i - 1] >= 100,
        "spaced: " + (times[i] - times[i - 1]),
      )
    await r.done()
  })
})

describe("chat from Telegram: tracing", () => {
  const turn = async (r: Rig, text: string) => {
    await r.ev("session.execution.started")
    await r.ev("session.text.ended", {
      assistantMessageID: "m1",
      ordinal: 0,
      text,
    })
    await r.ev("session.execution.succeeded")
  }

  it("an update leaves one trace with its path, and the session's reply joins it", async () => {
    const r = await chatRig({ chat: { stream: false } })
    await chatOn(r)
    r.tg.message(CHAT, "trace me", undefined, 9001)
    await reactions(r, 2)
    const mine = () =>
      traces
        .recent(20)
        .find(
          (t) =>
            t.dir === "in" &&
            t.done &&
            t.message_id === r.tg.lastMessageId &&
            t.session === "root",
        )
    const inbound = await r.tg.waitFor(mine)
    assert.equal(inbound.outcome, "delivered")
    assert.equal(inbound.state, "sent")
    const path = inbound.steps.map((s) => s.step)
    for (const step of ["queued", "route", "deliver", "handle"])
      assert.ok(path.includes(step), step + " in " + path.join(","))
    assert.match(inbound.id, /^[0-9a-f]{32}$/)
    await turn(r, "all green")
    const reply = await r.tg.waitFor(() =>
      traces
        .recent(20)
        .find(
          (t) => t.dir === "out" && t.kind === "reply" && t.id === inbound.id,
        ),
    )
    assert.equal(reply.outcome, "sent")
    assert.equal(reply.session, "root")
    assert.equal(reply.parent, inbound.spanId)
    await r.done()
  })

  it("/trace in a topic lists the last updates and sends with their outcome", async () => {
    const r = await chatRig({ chat: { stream: false } })
    await chatOn(r)
    r.tg.message(CHAT, "something first", undefined, 9001)
    await r.tg.waitFor(() => r.prompts[0])
    r.tg.message(CHAT, "/trace 5", undefined, 9001)
    const out = await r.tg.waitFor(() =>
      r.sends().find((b) => /← text/.test(b.text)),
    )
    assert.match(out.text, /delivered/)
    await r.done()
  })
})
