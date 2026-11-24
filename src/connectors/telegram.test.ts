import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { Bridge, toQuestions, type BridgeEvent } from "../bridge.ts"
import { parseConfig, type Config } from "../config.ts"
import { PendingStore } from "../pending.ts"
import { Router } from "../routing.ts"
import { sleep } from "../util.ts"
import { fakeTelegram } from "./fake-telegram.test-util.ts"
import { hash, TelegramConnector, type TelegramOptions } from "./telegram.ts"
import type { Connector, Inbound, Outcome } from "./types.ts"

const CHAT = 4242

/** What an inbound says, in the shape the old reply grammar had. */
const said = (g: Inbound) =>
  g.replyTo
    ? { ref: g.replyTo, text: g.text }
    : g.choice !== undefined
      ? { id: g.pendingId, choice: g.choice }
      : { id: g.pendingId, text: g.text }

const from = { connector: "ntfy", chat: "x" }

const yesNo = toQuestions([
  {
    key: "q0",
    type: "string",
    title: "Deploy",
    description: "Deploy <now> & go?",
    options: [{ label: "Yes" }, { label: "No" }],
  },
])
const pick = toQuestions([
  {
    key: "q0",
    type: "multiselect",
    description: "Which?",
    options: [{ label: "a" }, { label: "b" }, { label: "c" }],
  },
])

async function rig(
  over: Partial<TelegramOptions> = {},
  handler: (m: Inbound) => Promise<Outcome | undefined> | undefined = () =>
    undefined,
) {
  const tg = await fakeTelegram()
  const dir = await mkdtemp(join(tmpdir(), "oobb-tg-"))
  const channel = new TelegramConnector({
    token: async () => tg.token,
    chatId: String(CHAT),
    apiBase: tg.url,
    offsetFile: join(dir, "offset.json"),
    backoff: { min: 10, max: 40 },
    pollSeconds: 1,
    toastAfterMs: 400,
    ...over,
  })
  const got: Inbound[] = []
  const ac = new AbortController()
  channel.start(async (m) => {
    got.push(m)
    return handler(m)
  }, ac.signal)
  return {
    tg,
    dir,
    channel,
    got,
    ac,
    async done() {
      ac.abort()
      await tg.close()
    },
  }
}

describe("TelegramConnector outbound", () => {
  it("sends a question with one button per option, HTML-escaped", async () => {
    const r = await rig()
    const ref = await r.channel.send({
      title: "shop · agent asks",
      message: "Deploy <now> & go?\nkey=password: hunter2222",
      priority: 4,
      prompt: { id: "ab12", questions: yesNo },
    })
    assert.equal(ref, "501")
    const c = r.tg.of("sendMessage")[0].body
    assert.equal(c.chat_id, String(CHAT))
    assert.equal(c.parse_mode, "HTML")
    assert.equal(c.disable_notification, false)
    assert.match(c.text, /^<b>shop · agent asks<\/b>\n/)
    assert.match(c.text, /Deploy &lt;now&gt; &amp; go\?/)
    assert.doesNotMatch(c.text, /hunter2222/)
    assert.deepEqual(c.reply_markup.inline_keyboard, [
      [{ text: "1️⃣ Yes", callback_data: "ab12:1" }],
      [{ text: "2️⃣ No", callback_data: "ab12:2" }],
    ])
    assert.ok(
      c.reply_markup.inline_keyboard
        .flat()
        .every(
          (b: { callback_data: string }) =>
            Buffer.byteLength(b.callback_data) <= 64,
        ),
    )
    await r.done()
  })

  it("is silent for low priority and sends no keyboard without a prompt", async () => {
    const r = await rig()
    await r.channel.send({ title: "t", message: "m", priority: 2 })
    const c = r.tg.of("sendMessage")[0].body
    assert.equal(c.disable_notification, true)
    assert.equal(c.reply_markup, undefined)
    await r.done()
  })

  it("a question that is not one tap has no option buttons, and one button to the app when there is an app", async () => {
    const r = await rig()
    const two = [...yesNo, ...yesNo.map((q) => ({ ...q, key: "q1" }))]
    const many = toQuestions([
      {
        key: "q0",
        type: "string",
        options: Array.from({ length: 5 }, (_, i) => ({ label: `o${i}` })),
      },
    ])
    const long = toQuestions([
      {
        key: "q0",
        type: "string",
        options: [{ label: "Yes" }, { label: "x".repeat(49) }],
      },
    ])
    const send = (id: string, questions: typeof two) =>
      r.channel.send({ message: "m", prompt: { id, questions } })
    await send("ab12", two)
    await send("cd34", many)
    await send("ef56", pick)
    await send("gh78", long)
    assert.ok(r.tg.of("sendMessage").every((s) => !s.body.reply_markup))
    assert.match(r.channel.hint("ab12", two), /one answer per question/)
    assert.match(r.channel.hint("cd34", many), /number or text/)

    r.channel.launch({ url: "https://app.example.com/app/" })
    await send("ij90", two)
    await send("kl12", pick)
    await send("mn34", long)
    for (const s of r.tg.of("sendMessage").slice(4)) {
      const rows = s.body.reply_markup.inline_keyboard
      assert.equal(rows.length, 1)
      assert.equal(rows[0].length, 1)
      assert.equal(rows[0][0].text, "📱 Answer in app")
      assert.match(rows[0][0].web_app.url, /\?s=f_(ij90|kl12|mn34)$/)
    }
    assert.match(r.channel.hint("ab12", two), /Tap 📱 Answer in app, or reply/)
    await r.done()
  })

  it("a one-tap question that allows typing adds the app button under its options", async () => {
    const r = await rig()
    r.channel.launch({ url: "https://app.example.com/app/" })
    await r.channel.send({
      message: "m",
      prompt: { id: "ab12", questions: yesNo },
    })
    const rows = r.tg.of("sendMessage")[0].body.reply_markup.inline_keyboard
    assert.deepEqual(
      rows.map((x: Array<{ text: string }>) => x[0].text),
      ["1️⃣ Yes", "2️⃣ No", "📱 Answer in app"],
    )
    await r.done()
  })

  it("a one-tap question with no typing gets the session's 📱 Open on a row of its own", async () => {
    const r = await rig()
    r.channel.launch({ url: "https://app.example.com/app/" })
    await r.channel.send({
      message: "m",
      session: { id: "ses_1", name: "shop · Fix", project: "shop" },
      prompt: { id: "ab12", questions: [{ ...yesNo[0], custom: false }] },
      card: {
        kind: "question",
        agent: "a",
        project: "shop",
        questions: [
          { text: "Go?", options: [], multiple: false, custom: false },
        ],
      },
    })
    const rows = r.tg.of("sendMessage")[0].body.reply_markup.inline_keyboard
    assert.equal(rows.at(-1).length, 1)
    assert.equal(rows.at(-1)[0].text, "📱 Open")
    assert.match(rows.at(-1)[0].web_app.url, /\?s=s_ses_1$/)
    await r.done()
  })

  it("in a group the app button is the direct link with the question's start parameter", async () => {
    const r = await rig({ chatId: "-100123" })
    r.channel.launch({
      url: "https://app.example.com/app/",
      link: "https://t.me/bot/app",
    })
    await r.channel.send({
      message: "m",
      prompt: { id: "ab12", questions: pick },
    })
    const b = r.tg.of("sendMessage")[0].body.reply_markup.inline_keyboard[0][0]
    assert.deepEqual(b, {
      text: "📱 Answer in app",
      url: "https://t.me/bot/app?startapp=f_ab12",
    })
    await r.done()
  })

  it("update replaces the text and removes the keyboard", async () => {
    const r = await rig()
    const ref = await r.channel.send({
      message: "q",
      prompt: { id: "ab12", questions: yesNo },
    })
    await r.channel.update(ref!, { title: "Deploy", message: "Answered" })
    const c = r.tg.of("editMessageText")[0].body
    assert.equal(c.message_id, Number(ref))
    assert.match(c.text, /Answered/)
    assert.deepEqual(c.reply_markup, { inline_keyboard: [] })
    await r.done()
  })

  it("never sends without a paired chat, and a failed send returns undefined", async () => {
    const r = await rig({ chatId: undefined })
    assert.equal(await r.channel.send({ message: "m" }), undefined)
    assert.equal(r.tg.of("sendMessage").length, 0)
    r.channel.setChat(String(CHAT))
    r.tg.fail("sendMessage", 400)
    assert.equal(await r.channel.send({ message: "m" }), undefined)
    assert.match(r.channel.status().lastError ?? "", /sendMessage failed/)
    await r.done()
  })

  it("honours retry_after on 429", async () => {
    const r = await rig()
    r.tg.fail("sendMessage", 429, { parameters: { retry_after: 0 } })
    const ref = await r.channel.send({ message: "m" })
    assert.ok(ref)
    assert.equal(r.tg.of("sendMessage").length, 2)
    await r.done()
  })
})

describe("TelegramConnector inbound", () => {
  it("a button tap answers the callback and hands the choice on", async () => {
    const r = await rig({}, async () => ({ ok: true, text: "Answered: No" }))
    const ref = await r.channel.send({
      message: "q",
      prompt: { id: "ab12", questions: yesNo },
    })
    r.tg.callback(CHAT, Number(ref), "ab12:2")
    await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.equal(r.got[0].inline, true)
    assert.deepEqual(said(r.got[0]), { id: "ab12", choice: 2 })
    assert.equal(r.tg.of("answerCallbackQuery")[0].body.text, "Answered: No")
    await r.done()
  })

  it("clears the spinner at once when the outcome is slow", async () => {
    const r = await rig({ toastAfterMs: 20 }, async () => {
      await sleep(300)
      return { ok: true, text: "late" }
    })
    r.tg.callback(CHAT, 1, "ab12:1")
    const t = await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.equal(t.body.text, "Sending…")
    await r.done()
  })

  it("the toggle, Done, type and stepper buttons of an earlier version only point to the app", async () => {
    const r = await rig()
    for (const data of ["ab12:t1", "ab12:d", "ab12:x", "s:ab12:o1"])
      r.tg.callback(CHAT, 501, data)
    await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[3])
    for (const t of r.tg.of("answerCallbackQuery"))
      assert.match(t.body.text, /moved to the app/)
    assert.equal(r.got.length, 0)
    await r.done()
  })

  it("a text reply to the message, or #id text, becomes a reply", async () => {
    const r = await rig()
    r.tg.message(CHAT, "later", 501)
    r.tg.message(CHAT, "#ab12 2 | yes")
    r.tg.message(CHAT, "#cd34 1", 501)
    r.tg.message(CHAT, "just chatting")
    await r.tg.waitFor(() => r.got[2])
    assert.deepEqual(r.got.map(said), [
      { ref: "501", text: "later" },
      { id: "ab12", text: "2 | yes" },
      { id: "cd34", text: "1" },
    ])
    assert.ok(r.got.every((g) => !g.inline))
    await r.done()
  })

  it("hears only the paired chat", async () => {
    const r = await rig()
    r.tg.message(999, "#ab12 1")
    r.tg.message(999, "hi", 501)
    r.tg.callback(999, 501, "ab12:1")
    r.tg.message(CHAT, "#ab12 1")
    await r.tg.waitFor(() => r.got[0])
    assert.equal(r.got.length, 1)
    assert.equal(r.tg.of("answerCallbackQuery").length, 0)
    await r.done()
  })

  it("keeps polling through errors and resumes from the stored offset", async () => {
    const r = await rig()
    r.tg.fail("getUpdates", 502)
    r.tg.message(CHAT, "#ab12 1")
    await r.tg.waitFor(() => r.got[0])
    assert.equal(r.channel.status().connected, true)
    // waitFor takes a plain function: a promise would always count as done.
    // The file may be seen half written, so wait until it parses.
    const saved = await r.tg.waitFor(() => {
      try {
        return JSON.parse(readFileSync(join(r.dir, "offset.json"), "utf8"))
      } catch {}
    })
    assert.equal(typeof saved.offset, "number")
    r.ac.abort()
    await sleep(50)
    const before = r.tg.of("getUpdates").length
    await sleep(300)
    assert.ok(r.tg.of("getUpdates").length - before <= 1, "stopped polling")

    const again = new TelegramConnector({
      token: async () => r.tg.token,
      chatId: String(CHAT),
      apiBase: r.tg.url,
      offsetFile: join(r.dir, "offset.json"),
      pollSeconds: 1,
    })
    const ac = new AbortController()
    again.start(async () => undefined, ac.signal)
    const last = await r.tg.waitFor(() => r.tg.of("getUpdates").at(-1))
    await r.tg.waitFor(
      () =>
        r.tg.of("getUpdates").at(-1)!.body.offset === saved.offset || undefined,
    )
    assert.ok(last)
    ac.abort()
    await r.tg.close()
  })
})

describe("TelegramConnector pairing", () => {
  it("stores the chat that sends the one-time code and ignores others", async () => {
    const paired: string[] = []
    const r = await rig({
      chatId: undefined,
      onPaired: (c) => paired.push(c),
    })
    const p = await r.channel.pair()
    assert.match(p.code, /^[A-Z2-9]{6}$/)
    assert.equal(p.link, `https://t.me/oob_test_bot?start=${p.code}`)
    assert.ok(p.expiresAt > Date.now())
    r.tg.message(777, "WRONG1")
    r.tg.message(777, "hello")
    r.tg.message(888, `/start ${p.code.toLowerCase()}`)
    assert.equal(await p.done, true)
    assert.deepEqual(paired, ["888"])
    assert.equal(r.channel.paired(), true)
    assert.equal(r.got.length, 0, "no reply reached the bridge")
    const hello = await r.tg.waitFor(() => r.tg.of("sendMessage")[0])
    assert.equal(hello.body.chat_id, "888")
    // Now only that chat is heard, and the code is spent.
    r.tg.message(777, p.code)
    r.tg.message(888, "#ab12 1")
    await r.tg.waitFor(() => r.got[0])
    assert.equal(r.got.length, 1)
    assert.equal(r.channel.status().lastError, undefined)
    await r.done()
  })

  it("the code expires", async () => {
    const r = await rig({ chatId: undefined, pairTtlMs: 30 })
    const p = await r.channel.pair()
    assert.equal(await p.done, false)
    r.tg.message(777, p.code)
    await sleep(100)
    assert.equal(r.channel.paired(), false)
    await r.done()
  })

  it("does not poll while unpaired and not pairing", async () => {
    const r = await rig({ chatId: undefined })
    await sleep(100)
    assert.equal(r.tg.of("getUpdates").length, 0)
    assert.equal(r.channel.status().lastError, "not paired")
    await r.done()
  })
})

// The bridge around real channel objects.
function stubChannel(id: string) {
  const sent: Array<{ message: string; title?: string; prompt?: unknown }> = []
  const updates: Array<{ ref: string; message: string }> = []
  let onInbound: ((m: Inbound) => Promise<Outcome | undefined>) | undefined
  const ch: Connector = {
    id,
    type: id,
    capabilities: {
      buttons: true,
      edit: true,
      multiselect: false,
      rich: false,
      threads: false,
      pairing: false,
      inboundPrompt: false,
    },
    enabled: true,
    start: (cb) => void (onInbound = cb),
    hint: () => `answer via ${id}`,
    send: async (p) => {
      sent.push(p)
      return `${id}${sent.length}`
    },
    update: async (ref, p) => {
      updates.push({ ref, message: p.message })
      return true
    },
    status: () => ({}),
  }
  return { ch, sent, updates, reply: (m: Inbound) => onInbound!(m) }
}

async function bridgeRig(
  over: Record<string, unknown> = {},
  tgOver: Partial<TelegramOptions> = {},
  title = "Fix",
) {
  const t = await rig({ statusCard: false, ...tgOver })
  const cfg = parseConfig({
    channels: {
      ntfy: { server: "https://ntfy.example", topics: { out: "o", in: "i" } },
      telegram: { token: { env: "X" } },
    },
    ...over,
  }) as Config
  const stub = stubChannel("ntfy")
  const replies: unknown[] = []
  const sessions: Record<
    string,
    {
      id: string
      agent: string
      directory: string
      title: string
      model?: string
    }
  > = {
    root: {
      id: "root",
      agent: "coord",
      directory: "/w/shop",
      title,
      model: "opus",
    },
  }
  const router = new Router(cfg, async () => true)
  router.setAfk("on", Infinity)
  router.set("root", true)
  const store = new PendingStore()
  const bridge = new Bridge(
    cfg,
    {
      session: async (id) => sessions[id],
      root: (id) => id,
      replyForm: async (sessionID, formID, answer) => {
        replies.push({ sessionID, formID, answer })
      },
    },
    [stub.ch, t.channel],
    store,
    router,
  )
  bridge.start()
  const ask = (id: string, fields: unknown[]) =>
    bridge.onEvent({
      type: "form.created",
      data: {
        form: {
          id,
          sessionID: "root",
          metadata: { kind: "question" },
          fields,
        },
      },
    } as BridgeEvent)
  return { ...t, stub, replies, bridge, store, ask, router }
}

const yesNoField = {
  key: "q0",
  type: "string",
  description: "Go?",
  options: [{ label: "Yes" }, { label: "No" }],
}

describe("Bridge with telegram and another channel", () => {
  it("fans a question out to both channels, each with its own hint", async () => {
    const b = await bridgeRig()
    await b.ask("frm_1", [yesNoField])
    const id = b.store.list()[0].id
    assert.match(b.stub.sent[0].message, /answer via ntfy/)
    const tgMsg = b.tg.of("sendMessage")[0].body
    assert.match(tgMsg.text, /Tap a button, or reply/)
    assert.equal(
      tgMsg.reply_markup.inline_keyboard[0][0].callback_data,
      `${id}:1`,
    )
    assert.deepEqual(b.store.list()[0].refs, { ntfy: "ntfy1", telegram: "501" })
    await b.done()
  })

  it("a tap on telegram answers the form and marks both messages", async () => {
    const b = await bridgeRig()
    await b.ask("frm_1", [yesNoField])
    const id = b.store.list()[0].id
    b.tg.callback(CHAT, 501, `${id}:1`)
    await b.tg.waitFor(() => b.tg.of("editMessageText")[0])
    await b.tg.waitFor(() => b.tg.of("answerCallbackQuery")[0])
    assert.deepEqual(b.replies, [
      { sessionID: "root", formID: "frm_1", answer: { q0: "Yes" } },
    ])
    const toast = b.tg.of("answerCallbackQuery")[0].body.text
    assert.equal(toast, "Answered: Yes")
    const edit = b.tg.of("editMessageText")[0].body
    assert.match(edit.text, /Answered in Telegram<\/b>: Yes\n<i>\d\d:\d\d<\/i>/)
    assert.deepEqual(edit.reply_markup, { inline_keyboard: [] })
    // The other channel is marked after the edit: wait for it.
    await b.tg.waitFor(() => b.stub.updates[0])
    assert.deepEqual(b.stub.updates, [
      { ref: "ntfy1", message: "Answered from telegram: Yes" },
    ])
    assert.equal(b.store.get(id)!.answeredVia, "telegram")

    // A second tap is refused with a toast, not applied.
    b.tg.callback(CHAT, 501, `${id}:2`)
    await b.tg.waitFor(() => b.tg.of("answerCallbackQuery")[1])
    assert.match(
      b.tg.of("answerCallbackQuery")[1].body.text,
      /already answered/,
    )
    assert.equal(b.replies.length, 1)
    assert.equal(b.tg.of("sendMessage").length, 1, "no notice for a tap")
    await b.done()
  })

  it("an answer from the other channel updates the telegram message", async () => {
    const b = await bridgeRig()
    await b.ask("frm_1", [yesNoField])
    const id = b.store.list()[0].id
    await b.stub.reply({
      kind: "answer",
      id: "n1",
      time: Math.floor(Date.now() / 1000),
      pendingId: id,
      text: "2",
      from,
    })
    assert.deepEqual(b.replies, [
      { sessionID: "root", formID: "frm_1", answer: { q0: "No" } },
    ])
    const edit = b.tg.of("editMessageText")[0].body
    assert.match(edit.text, /Answered<\/b> · No\n<i>via ntfy/)
    await b.done()
  })

  it("an answer in the TUI updates both, and a late tap is refused", async () => {
    const b = await bridgeRig()
    await b.ask("frm_1", [yesNoField])
    const id = b.store.list()[0].id
    await b.bridge.onEvent({
      type: "form.replied",
      data: { id: "frm_1", sessionID: "root" },
    })
    assert.match(
      b.tg.of("editMessageText")[0].body.text,
      /Answered at the Mac<\/b>\n<i>\d\d:\d\d<\/i>/,
    )
    assert.match(b.stub.updates[0].message, /Answered in the TUI/)
    b.tg.callback(CHAT, 501, `${id}:1`)
    await b.tg.waitFor(() => b.tg.of("answerCallbackQuery")[0])
    assert.match(
      b.tg.of("answerCallbackQuery")[0].body.text,
      /already answered/,
    )
    assert.equal(b.replies.length, 0)
    await b.done()
  })

  it("a text reply to the telegram message answers it, even a custom answer", async () => {
    const b = await bridgeRig()
    await b.ask("frm_1", [yesNoField])
    b.tg.message(CHAT, "tomorrow", 501)
    await b.tg.waitFor(() => b.replies[0])
    assert.deepEqual(b.replies[0], {
      sessionID: "root",
      formID: "frm_1",
      answer: { q0: "tomorrow" },
    })
    await b.done()
  })

  it("a reply the bridge cannot read gets a notice in the chat it came from only", async () => {
    const b = await bridgeRig()
    await b.ask("frm_1", [{ ...yesNoField, custom: false }])
    b.tg.message(CHAT, "maybe", 501)
    const n = await b.tg.waitFor(() => b.tg.of("sendMessage")[1])
    assert.match(n.body.text, /could not read that answer/)
    assert.equal(b.stub.sent.length, 1, "ntfy heard nothing about it")
    await b.done()
  })

  it("several questions: no buttons, and one numbered reply still answers all", async () => {
    const b = await bridgeRig()
    await b.ask("frm_1", [
      { ...yesNoField, key: "q0", title: "A" },
      { ...yesNoField, key: "q1", title: "B" },
    ])
    assert.equal(b.tg.of("sendMessage")[0].body.reply_markup, undefined)
    b.tg.message(CHAT, "1 | no", 501)
    await b.tg.waitFor(() => b.replies[0])
    assert.deepEqual((b.replies[0] as { answer: unknown }).answer, {
      q0: "Yes",
      q1: "No",
    })
    await b.done()
  })

  it("permissions: message without buttons, never answerable", async () => {
    const b = await bridgeRig({ permissions: { notify: "all" } })
    await b.bridge.onEvent({
      type: "permission.asked",
      data: {
        id: "per_1",
        sessionID: "root",
        action: "bash",
        resources: ["rm -rf x"],
      },
    })
    const m = b.tg.of("sendMessage")[0].body
    assert.equal(m.reply_markup, undefined)
    assert.match(m.text, /bash: rm -rf x/)
    assert.match(m.text, /Answer in the OpenCode TUI/)
    b.tg.message(CHAT, "1", 501)
    const n = await b.tg.waitFor(() => b.tg.of("sendMessage")[1])
    assert.match(n.body.text, /only be answered in the OpenCode TUI/)
    assert.equal(b.replies.length, 0)
    await b.done()
  })

  it("finished pushes reach every channel; a disabled channel is skipped", async () => {
    const b = await bridgeRig()
    await b.bridge.onEvent({
      type: "session.execution.succeeded",
      data: { sessionID: "root" },
    })
    assert.equal(b.stub.sent.length, 1)
    assert.equal(b.tg.of("sendMessage").length, 1)
    b.bridge.setEnabled("telegram", false)
    await b.bridge.onEvent({
      type: "session.execution.succeeded",
      data: { sessionID: "root" },
    })
    assert.equal(b.stub.sent.length, 2)
    assert.equal(b.tg.of("sendMessage").length, 1)
    assert.deepEqual(
      b.bridge.status().channels.map((c) => [c.id, c.enabled]),
      [
        ["ntfy", true],
        ["telegram", false],
      ],
    )
    assert.deepEqual(await b.bridge.test(), [{ id: "ntfy", ok: true }])
    b.bridge.setEnabled("telegram", true)
    assert.deepEqual(await b.bridge.test(), [
      { id: "ntfy", ok: true },
      { id: "telegram", ok: true },
    ])
    await b.done()
  })

  it("one channel failing does not stop the other", async () => {
    const b = await bridgeRig()
    b.tg.fail("sendMessage", 500)
    await b.ask("frm_1", [yesNoField])
    assert.equal(b.stub.sent.length, 1)
    assert.deepEqual(b.store.list()[0].refs, { ntfy: "ntfy1" })
    await b.done()
  })
})

const finish = (b: Awaited<ReturnType<typeof bridgeRig>>) =>
  b.bridge.onEvent({
    type: "session.execution.succeeded",
    data: { sessionID: "root" },
  })

describe("Bridge channel choice", () => {
  it("uses every enabled channel by default", async () => {
    const b = await bridgeRig()
    await finish(b)
    assert.equal(b.stub.sent.length, 1)
    assert.equal(b.tg.of("sendMessage").length, 1)
    await b.done()
  })

  it("defaultChannel limits pushes to that channel", async () => {
    const b = await bridgeRig({ defaultChannel: "telegram" })
    await finish(b)
    await b.ask("frm_1", [yesNoField])
    assert.equal(b.stub.sent.length, 0)
    assert.equal(b.tg.of("sendMessage").length, 2)
    assert.deepEqual(b.store.list()[0].refs, { telegram: "502" })
    await b.done()
  })

  it("a session's own channel beats the default, and subagents follow their root", async () => {
    const b = await bridgeRig({ defaultChannel: "telegram" })
    b.router.set("root", true, "ntfy")
    await finish(b)
    assert.equal(b.stub.sent.length, 1)
    assert.equal(b.tg.of("sendMessage").length, 0)
    b.router.set("root", true, "all")
    await finish(b)
    assert.equal(b.stub.sent.length, 2)
    assert.equal(b.tg.of("sendMessage").length, 1)
    b.router.set("root", true)
    await finish(b)
    assert.equal(b.stub.sent.length, 2, "back to the default: telegram only")
    assert.equal(b.tg.of("sendMessage").length, 2)
    await b.done()
  })

  it("a chosen channel that is switched off gets nothing, and the others stay quiet", async () => {
    const b = await bridgeRig()
    b.router.set("root", true, "telegram")
    b.bridge.setEnabled("telegram", false)
    await finish(b)
    assert.equal(b.stub.sent.length, 0)
    assert.equal(b.tg.of("sendMessage").length, 0)
    await b.done()
  })

  it("replies are taken from any channel whatever the session chose", async () => {
    const b = await bridgeRig()
    b.router.set("root", true, "telegram")
    await b.ask("frm_1", [yesNoField])
    const id = b.store.list()[0].id
    await b.stub.reply({
      kind: "answer",
      id: "n1",
      time: Math.floor(Date.now() / 1000),
      pendingId: id,
      text: "1",
      from,
    })
    assert.equal(b.replies.length, 1)
    await b.done()
  })
})

describe("TelegramConnector forum topics", () => {
  const session = { id: "root", name: "shop · Fix checkout" }

  it("outside a forum posts to the main chat with no thread", async () => {
    const r = await rig()
    await r.channel.send({ message: "m", session })
    assert.equal(r.tg.of("createForumTopic").length, 0)
    assert.equal(r.tg.of("sendMessage")[0].body.message_thread_id, undefined)
    await r.channel.send({ message: "again", session })
    assert.equal(r.tg.of("getChat").length, 1, "asked once")
    await r.done()
  })

  it("in a forum, one topic per session, named project · title, reused", async () => {
    const r = await rig({ topicsFile: undefined })
    r.tg.forum = true
    await Promise.all([
      r.channel.send({ message: "a", session }),
      r.channel.send({ message: "b", session }),
    ])
    await r.channel.send({
      message: "c",
      session: { id: "other", name: "api · Docs" },
    })
    const topics = r.tg.of("createForumTopic")
    assert.deepEqual(
      topics.map((t) => t.body.name),
      ["shop · Fix checkout", "api · Docs"],
    )
    const threads = r.tg.of("sendMessage").map((c) => c.body.message_thread_id)
    assert.deepEqual(threads, [9001, 9001, 9002])
    await r.done()
  })

  it("remembers topics across restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oobb-topics-"))
    const topicsFile = join(dir, "topics.json")
    const first = await rig({ topicsFile })
    first.tg.forum = true
    await first.channel.send({ message: "a", session })
    const saved = JSON.parse(await readFile(topicsFile, "utf8"))
    assert.equal(saved[`${CHAT}:root`].thread, 9001)
    assert.equal(saved[`${CHAT}:root`].name, "shop · Fix checkout")
    await first.done()

    const second = await rig({ topicsFile })
    second.tg.forum = true
    await second.channel.send({ message: "b", session })
    assert.equal(second.tg.of("createForumTopic").length, 0)
    assert.equal(second.tg.of("sendMessage")[0].body.message_thread_id, 9001)
    await second.done()
  })

  it("makes a new topic when the old one was deleted, once", async () => {
    const r = await rig()
    r.tg.forum = true
    await r.channel.send({ message: "a", session })
    r.tg.fail("sendMessage", 400, {
      description: "Bad Request: message thread not found",
    })
    const ref = await r.channel.send({ message: "b", session })
    assert.ok(ref)
    assert.equal(r.tg.of("createForumTopic").length, 2)
    assert.equal(r.tg.of("sendMessage").at(-1)!.body.message_thread_id, 9002)
    await r.done()
  })

  it("falls back to the main chat when the topic cannot be created", async () => {
    const r = await rig()
    r.tg.forum = true
    r.tg.fail("createForumTopic", 400, { description: "not enough rights" })
    // A poll that succeeds clears the last error: stop polling so only the send speaks.
    r.ac.abort()
    await sleep(30)
    const ref = await r.channel.send({ message: "a", session })
    assert.ok(ref)
    assert.equal(r.tg.of("sendMessage")[0].body.message_thread_id, undefined)
    assert.match(r.channel.status().lastError ?? "", /not enough rights/)
    await r.done()
  })

  it("a plain message in a topic is not a reply, a real reply and #id still are", async () => {
    const r = await rig()
    r.tg.message(CHAT, "hello", 9001, 9001)
    r.tg.message(CHAT, "later", 777, 9001)
    r.tg.message(CHAT, "#ab12 1", 9001, 9001)
    await r.tg.waitFor(() => r.got[1])
    assert.deepEqual(r.got.map(said), [
      { ref: "777", text: "later" },
      { id: "ab12", text: "1" },
    ])
    await r.done()
  })

  it("the bridge names a topic after the project and session, or the project alone when hidden", async () => {
    const a = await bridgeRig()
    a.tg.forum = true
    await a.bridge.onEvent({
      type: "session.execution.succeeded",
      data: { sessionID: "root" },
    })
    assert.equal(a.tg.of("createForumTopic")[0].body.name, "shop · Fix")
    await a.done()
    const b = await bridgeRig({ redact: "title" })
    b.tg.forum = true
    await b.bridge.onEvent({
      type: "session.execution.succeeded",
      data: { sessionID: "root" },
    })
    assert.equal(b.tg.of("createForumTopic")[0].body.name, "shop")
    await b.done()
  })
})

describe("pending store refs", () => {
  it("reads the pre-channel ntfyMessageID field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oobb-pend-"))
    const file = join(dir, "pending.jsonl")
    await writeFile(
      file,
      `${JSON.stringify({ id: "ab12", kind: "question", requestID: "f", sessionID: "s", rootSessionID: "s", title: "t", askedAt: Date.now(), state: "pending", ntfyMessageID: "m9" })}\n`,
    )
    const store = new PendingStore(file)
    await store.load()
    assert.deepEqual(store.get("ab12")!.refs, { ntfy: "m9" })
    assert.equal(store.byRef("ntfy", "m9")!.id, "ab12")
  })
})

const ev = (type: string, data: Record<string, unknown> = {}) =>
  ({ type, data: { sessionID: "root", ...data } }) as unknown as BridgeEvent

describe("Telegram: typed answers and groups", () => {
  it("a typing field has no ✏️ button, and a reply to the message still answers", async () => {
    const b = await bridgeRig()
    await b.ask("frm_1", [yesNoField])
    const kb = b.tg.of("sendMessage")[0].body.reply_markup.inline_keyboard
    assert.equal(kb.length, 2)
    b.tg.message(CHAT, "2", 501)
    await b.tg.waitFor(() => b.replies[0])
    assert.deepEqual((b.replies[0] as { answer: unknown }).answer, { q0: "No" })
    await b.done()
  })

  it("no ✏️ button when the question takes no custom answer", async () => {
    const b = await bridgeRig()
    await b.ask("frm_1", [{ ...yesNoField, custom: false }])
    const kb = b.tg.of("sendMessage")[0].body.reply_markup.inline_keyboard
    assert.equal(kb.length, 2)
    await b.done()
  })

  it("pairs from a group by /start@bot CODE or a bare code, and says it is a topics group", async () => {
    const r = await rig({ chatId: undefined })
    const p = await r.channel.pair()
    assert.equal(p.link, `https://t.me/oob_test_bot?start=${p.code}`)
    assert.equal(
      p.links![0].url,
      `https://t.me/oob_test_bot?startgroup=${p.code}`,
    )
    r.tg.message(-100, `/start@oob_test_bot ${p.code}`, undefined, undefined, {
      type: "supergroup",
      title: "Ops <room>",
      is_forum: true,
    })
    assert.equal(await p.done, true)
    const hi = await r.tg.waitFor(() => r.tg.of("sendMessage")[0])
    assert.equal(hi.body.chat_id, "-100")
    assert.equal(
      hi.body.text,
      "Paired with Ops &lt;room&gt;. One topic per session.",
    )

    const q = await rig({ chatId: undefined })
    const p2 = await q.channel.pair()
    q.tg.message(-200, p2.code.toLowerCase(), undefined, undefined, {
      type: "group",
      title: "Plain",
    })
    assert.equal(await p2.done, true)
    const hi2 = await q.tg.waitFor(() => q.tg.of("sendMessage")[0])
    assert.equal(hi2.body.text, "Paired with Plain.")
    await r.done()
    await q.done()
  })
})

describe("Telegram: message layout", () => {
  it("a question and its answered edit, as the person reads them", async () => {
    const b = await bridgeRig({}, {}, "Fix checkout")
    await b.ask("frm_1", [
      {
        ...yesNoField,
        options: [
          { label: "Ship it (Recommended)", description: "Deploy to <prod>" },
          { label: "Wait" },
        ],
      },
    ])
    const id = b.store.list()[0].id
    const q = b.tg.of("sendMessage")[0].body
    assert.equal(
      q.text,
      [
        "❓ <b>coord</b> asks · <i>shop</i>",
        "📌 Fix checkout",
        "",
        "<b>Go?</b>",
        "",
        "1️⃣ <b>★ Ship it</b>",
        "      <i>Deploy to &lt;prod&gt;</i>",
        "2️⃣ <b>Wait</b>",
        "",
        "<i>Tap a button, or reply.</i>",
      ].join("\n"),
    )
    assert.equal(q.reply_markup.inline_keyboard[0][0].text, "1️⃣ ★ Ship it")
    b.tg.callback(CHAT, 501, `${id}:1`)
    const e = await b.tg.waitFor(() => b.tg.of("editMessageText")[0])
    assert.match(
      e.body.text,
      /^✅ <b>Answered in Telegram<\/b>: Ship it \(Recommended\)\n<i>\d\d:\d\d<\/i>\n\n<blockquote>Go\?<\/blockquote>$/,
    )
    await b.done()
  })

  it("in a topic the session title is left out of the question: the topic names it", async () => {
    const b = await bridgeRig()
    b.tg.forum = true
    await b.ask("frm_1", [yesNoField])
    const q = b.tg.of("sendMessage")[0].body
    assert.equal(q.message_thread_id, 9001)
    assert.doesNotMatch(q.text, /📌/)
    await b.done()
  })

  it("keeps the user's own text for a kind they customised, in plain HTML", async () => {
    const b = await bridgeRig({
      messages: { question: { title: "{{agent}} <asks>" } },
    })
    await b.ask("frm_1", [yesNoField])
    assert.match(
      b.tg.of("sendMessage")[0].body.text,
      /^<b>coord &lt;asks&gt;<\/b>\n\[Fix\]\nGo\?/,
    )
    await b.done()
  })

  it("a title already in brackets is not bracketed again, on ntfy too", async () => {
    const a = await bridgeRig({}, {}, "[wip] fix")
    await a.ask("frm_1", [yesNoField])
    assert.match(a.stub.sent[0].message, /^\[wip\] fix\nGo\?/)
    await a.done()
    const b = await bridgeRig({}, {}, "Fix")
    await b.ask("frm_1", [yesNoField])
    assert.match(b.stub.sent[0].message, /^\[Fix\]\nGo\?/)
    await b.done()
  })
})

describe("Telegram: closing a question", () => {
  it("answered in the TUI, the question message itself is edited, in its topic, with no new message", async () => {
    const b = await bridgeRig()
    b.tg.forum = true
    await b.ask("frm_1", [yesNoField])
    assert.deepEqual(b.store.list()[0].refs, { ntfy: "ntfy1", telegram: "501" })
    await b.bridge.onEvent({
      type: "form.replied",
      data: { id: "frm_1", sessionID: "root" },
    })
    const edit = b.tg.of("editMessageText")
    assert.equal(edit.length, 1)
    assert.equal(edit[0].body.message_id, 501)
    assert.match(
      edit[0].body.text,
      /^✅ <b>Answered at the Mac<\/b>\n<i>\d\d:\d\d<\/i>/,
    )
    assert.deepEqual(edit[0].body.reply_markup, { inline_keyboard: [] })
    assert.equal(b.tg.of("sendMessage").length, 1, "no follow-up")
    await b.done()
  })

  it("when the edit really fails, a follow-up message goes to the same topic", async () => {
    const b = await bridgeRig()
    b.tg.forum = true
    await b.ask("frm_1", [yesNoField])
    b.tg.fail("editMessageText", 400, {
      description: "message can't be edited",
    })
    await b.bridge.onEvent({
      type: "form.replied",
      data: { id: "frm_1", sessionID: "root" },
    })
    const sent = b.tg.of("sendMessage")
    assert.equal(sent.length, 2)
    assert.equal(sent[1].body.message_thread_id, 9001)
    assert.match(sent[1].body.text, /Answered/)
    await b.done()
  })

  it("answered in the TUI while the message was still being sent: marked once the send lands", async () => {
    const cfg = parseConfig({
      channels: {
        ntfy: { server: "https://ntfy.example", topics: { out: "o", in: "i" } },
      },
    }) as Config
    const stub = stubChannel("ntfy")
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const send = stub.ch.send
    stub.ch.send = async (p) => {
      await gate
      return send(p)
    }
    const router = new Router(cfg, async () => true)
    router.setAfk("on", Infinity)
    router.set("root", true)
    const bridge = new Bridge(
      cfg,
      {
        session: async () => ({ id: "root", agent: "a", directory: "/w/p" }),
        root: (id) => id,
        replyForm: async () => {},
      },
      [stub.ch],
      new PendingStore(),
      router,
    )
    const asking = bridge.onEvent({
      type: "form.created",
      data: {
        form: {
          id: "frm_1",
          sessionID: "root",
          metadata: { kind: "question" },
          fields: [yesNoField],
        },
      },
    } as BridgeEvent)
    await sleep(20)
    await bridge.onEvent(ev("form.replied", { id: "frm_1" }))
    assert.equal(stub.updates.length, 0)
    release()
    await asking
    assert.equal(stub.updates.length, 1)
    assert.match(stub.updates[0].message, /Answered in the TUI/)
  })
})

describe("Telegram: topic rights", () => {
  const session = { id: "root", name: "shop · Fix" }
  const denied = {
    description: "Bad Request: not enough rights to create a topic",
  }
  const notices = (r: Awaited<ReturnType<typeof rig>>) =>
    r.tg.of("sendMessage").filter((c) => /Manage Topics/.test(c.body.text))

  it("says so once an hour, retries every five minutes, and shows the condition", async () => {
    const clock = { t: 1_000_000 }
    const r = await rig({ now: () => clock.t })
    r.tg.forum = true
    r.tg.fail("createForumTopic", 400, denied)
    await r.channel.send({ message: "a", session })
    assert.equal(notices(r).length, 1)
    assert.match(
      notices(r)[0].body.text,
      /^⚠️ I need the Manage Topics admin right to give each session its own topic\. Posting in General until then\.$/,
    )
    assert.equal(
      r.tg.of("sendMessage").at(-1)!.body.message_thread_id,
      undefined,
    )
    assert.match(r.channel.status().warning ?? "", /Manage Topics/)

    clock.t += 60_000
    await r.channel.send({ message: "b", session })
    assert.equal(
      r.tg.of("createForumTopic").length,
      1,
      "not before five minutes",
    )

    r.tg.fail("createForumTopic", 400, denied)
    clock.t += 5 * 60_000
    await r.channel.send({ message: "c", session })
    assert.equal(r.tg.of("createForumTopic").length, 2)
    assert.equal(notices(r).length, 1, "no second notice within the hour")

    r.tg.fail("createForumTopic", 400, denied)
    clock.t += 60 * 60_000
    await r.channel.send({ message: "d", session })
    assert.equal(notices(r).length, 2, "again after an hour")

    // The right is granted: the next try works, with no restart.
    clock.t += 5 * 60_000
    await r.channel.send({ message: "e", session })
    assert.equal(r.tg.of("sendMessage").at(-1)!.body.message_thread_id, 9001)
    assert.equal(r.channel.status().warning, undefined)
    await r.done()
  })

  it("an error that is not about rights sends no notice", async () => {
    const r = await rig()
    r.tg.forum = true
    r.tg.fail("createForumTopic", 500)
    await r.channel.send({ message: "a", session })
    assert.equal(notices(r).length, 0)
    assert.equal(r.channel.status().warning, undefined)
    await r.done()
  })
})

describe("Telegram: status card, rename and icons", () => {
  const state = (over: Record<string, unknown> = {}) => ({
    id: "ses_abcdef123456",
    name: "shop · Fix",
    project: "shop",
    title: "Fix",
    agent: "coordinator",
    model: "opus",
    state: "working" as const,
    at: new Date(2026, 0, 1, 14, 2).getTime(),
    ...over,
  })

  it("keeps one pinned card per topic and edits it at most every ten seconds", async () => {
    const clock = { t: 1_000_000 }
    const r = await rig({ now: () => clock.t })
    r.tg.forum = true
    await r.channel.track(state())
    const card = r.tg.of("sendMessage")[0].body
    assert.equal(card.message_thread_id, 9001)
    assert.equal(card.disable_notification, true)
    assert.match(
      card.text,
      /^🟢 <b>Working<\/b>\n📌 Fix\n🤖 coordinator · opus\n📁 shop .+\n🆔 <code>123456<\/code>\n🕐 14:02$/,
    )
    const pin = r.tg.of("pinChatMessage")[0].body
    assert.deepEqual(pin, {
      chat_id: String(CHAT),
      message_id: 501,
      disable_notification: true,
    })

    clock.t += 3000
    await r.channel.track(
      state({ state: "idle", at: new Date(2026, 0, 1, 14, 5).getTime() }),
    )
    assert.equal(r.tg.of("editMessageText").length, 0, "too soon")

    clock.t += 8000
    await r.channel.track(
      state({ state: "idle", at: new Date(2026, 0, 1, 14, 5).getTime() }),
    )
    const edit = r.tg.of("editMessageText")
    assert.equal(edit.length, 1)
    assert.equal(edit[0].body.message_id, 501)
    assert.match(edit[0].body.text, /💤 <b>Idle<\/b> 14:05/)
    assert.equal(r.tg.of("sendMessage").length, 1, "still one card")
    assert.equal(r.tg.of("pinChatMessage").length, 1)
    await r.done()
  })

  it("remembers the card with the topic across restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oobb-card-"))
    const topicsFile = join(dir, "t.json")
    const a = await rig({ topicsFile })
    a.tg.forum = true
    await a.channel.track(state())
    const saved = JSON.parse(await readFile(topicsFile, "utf8"))
    assert.equal(saved[`${CHAT}:ses_abcdef123456`].card, 501)
    assert.equal(saved[`${CHAT}:ses_abcdef123456`].thread, 9001)
    await a.done()

    const clock = { t: 5_000_000 }
    const b = await rig({ topicsFile, now: () => clock.t })
    b.tg.forum = true
    await b.channel.track(state({ state: "idle" }))
    assert.equal(b.tg.of("createForumTopic").length, 0)
    assert.equal(b.tg.of("editMessageText")[0].body.message_id, 501)
    assert.equal(b.tg.of("sendMessage").length, 0, "no second card")
    await b.done()
  })

  it("no card outside a forum, or with statusCard off", async () => {
    const a = await rig()
    await a.channel.track(state())
    assert.equal(a.tg.of("sendMessage").length, 0)
    await a.done()
    const b = await rig({ statusCard: false })
    b.tg.forum = true
    await b.channel.track(state())
    assert.equal(b.tg.of("sendMessage").length, 0)
    await b.done()
  })

  it("through the bridge: the card replaces 'finished' on Telegram, 'failed' still notifies, ntfy is unchanged", async () => {
    const clock = { t: Date.now() }
    const b = await bridgeRig({}, { statusCard: true, now: () => clock.t })
    b.tg.forum = true
    await b.bridge.onEvent(ev("session.execution.started"))
    assert.match(b.tg.of("sendMessage")[0].body.text, /Working/)
    assert.match(b.tg.of("sendMessage")[0].body.text, /🤖 coord · opus/)
    await b.bridge.onEvent(ev("session.execution.succeeded"))
    assert.equal(b.tg.of("sendMessage").length, 1, "no finished message")
    assert.equal(b.stub.sent.length, 1, "ntfy still says finished")

    clock.t += 11_000
    await b.bridge.onEvent(ev("session.execution.failed"))
    const sent = b.tg.of("sendMessage")
    assert.equal(sent.length, 2)
    assert.match(sent[1].body.text, /^❌ <b>Failed<\/b> · <i>shop<\/i>/)
    assert.equal(sent[1].body.disable_notification, false)
    assert.match(b.tg.of("editMessageText")[0].body.text, /❌ <b>Failed<\/b>/)
    await b.done()
  })

  it("notify can switch 'finished' back on, or 'failed' off", async () => {
    const a = await bridgeRig(
      {},
      { statusCard: true, notify: { finished: true } },
    )
    a.tg.forum = true
    await a.bridge.onEvent(ev("session.execution.succeeded"))
    assert.match(
      a.tg
        .of("sendMessage")
        .map((c) => c.body.text)
        .join("\n"),
      /Finished/,
    )
    await a.done()
    const b = await bridgeRig({}, { notify: { failed: false } })
    await b.bridge.onEvent(ev("session.execution.failed"))
    assert.equal(b.tg.of("sendMessage").length, 0)
    assert.equal(b.stub.sent.length, 1)
    await b.done()
  })

  it("renames the topic when the session is renamed, at most once a minute, and edits the card", async () => {
    const clock = { t: 1_000_000 }
    const b = await bridgeRig({}, { statusCard: true, now: () => clock.t })
    b.tg.forum = true
    await b.bridge.onEvent(ev("session.execution.started"))
    await b.bridge.onEvent(ev("session.renamed", { title: "Plan the move" }))
    const first = b.tg.of("editForumTopic")
    assert.equal(first.length, 1)
    assert.equal(first[0].body.message_thread_id, 9001)
    assert.equal(first[0].body.name, "shop · Plan the move")

    clock.t += 20_000
    await b.bridge.onEvent(
      ev("session.renamed", { title: "Plan the move, v2" }),
    )
    assert.equal(b.tg.of("editForumTopic").length, 1, "too soon")
    clock.t += 41_000
    await b.bridge.onEvent(
      ev("session.renamed", { title: "Plan the move, v2" }),
    )
    assert.equal(
      b.tg.of("editForumTopic")[1].body.name,
      "shop · Plan the move, v2",
    )
    assert.match(
      b.tg.of("editMessageText").at(-1)!.body.text,
      /📌 Plan the move, v2/,
    )
    await b.done()
  })

  it("the topic keeps its plain name; the card's first line shows the watch state and follows a change", async () => {
    const clock = { t: 1_000_000 }
    const b = await bridgeRig({}, { statusCard: true, now: () => clock.t })
    b.tg.forum = true
    await b.bridge.onEvent(ev("session.execution.started"))
    assert.equal(b.tg.of("createForumTopic")[0].body.name, "shop · Fix")
    const firstLine = (t: string) => t.split("\n")[0].replace(/<\/?b>/g, "")
    assert.equal(
      firstLine(b.tg.of("sendMessage")[0].body.text),
      "👁 on · 💬 off — 🟢 Working",
    )

    // The card follows at once, even inside the ten-second gap; the topic is never renamed.
    clock.t += 1000
    b.router.set("root", undefined)
    await b.bridge.retrack("root")
    assert.equal(
      firstLine(b.tg.of("editMessageText").at(-1)!.body.text),
      "⏱ auto · 💬 off — 🟢 Working",
    )
    clock.t += 1000
    b.router.set("root", false)
    await b.bridge.retrack("root")
    assert.equal(
      firstLine(b.tg.of("editMessageText").at(-1)!.body.text),
      "🔕 off · 💬 off — 🟢 Working",
    )
    assert.equal(
      b.tg.of("editForumTopic").length,
      0,
      "no rename for a watch change",
    )
    await b.done()
  })

  it("a topic that 0.12.0 renamed gets its plain name back on the next update, then waits the rename gap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oobb-rename-"))
    const topicsFile = join(dir, "t.json")
    await writeFile(
      topicsFile,
      JSON.stringify({
        [CHAT + ":ses_abcdef123456"]: {
          thread: 9001,
          card: 501,
          name: "👁 on·telegram 💬 · shop · Fix",
        },
      }),
    )
    const clock = { t: 5_000_000 }
    const r = await rig({ topicsFile, now: () => clock.t })
    r.tg.forum = true
    await r.channel.track(state())
    const edits = r.tg.of("editForumTopic")
    assert.equal(edits.length, 1)
    assert.equal(edits[0].body.name, "shop · Fix")
    assert.equal(edits[0].body.message_thread_id, 9001)
    assert.equal(r.tg.of("createForumTopic").length, 0)
    const saved = JSON.parse(await readFile(topicsFile, "utf8"))
    assert.equal(saved[CHAT + ":ses_abcdef123456"].name, "shop · Fix")

    clock.t += 1000
    await r.channel.track(state({ title: "Fix 2", name: "shop · Fix 2" }))
    assert.equal(r.tg.of("editForumTopic").length, 1, "inside the rename gap")
    await r.done()
  })

  it("switching a session off opens no topic for it, but a session already shown keeps its topic", async () => {
    const r = await rig()
    r.tg.forum = true
    const off = { mode: "off" as const, channel: "all", minutes: 10 }
    await r.channel.track(state({ watch: off }))
    assert.equal(r.tg.of("createForumTopic").length, 0)
    assert.equal(r.tg.of("sendMessage").length, 0)
    await r.channel.track(
      state({ watch: { ...off, mode: "on", channel: "telegram" } }),
    )
    assert.equal(r.tg.of("createForumTopic")[0].body.name, "shop · Fix")
    await r.done()
  })

  const topicBody = (r: Awaited<ReturnType<typeof rig>>) =>
    r.tg.of("createForumTopic")[0].body

  it("picks the same icon and color for the same session every time, and one project's sessions stay in a family", async () => {
    const pick = async (id: string, project = "shop") => {
      const r = await rig()
      r.tg.forum = true
      await r.channel.send({
        message: "m",
        session: { id, name: `${project} · x`, project },
      })
      const body = topicBody(r)
      await r.done()
      return body
    }
    const a1 = await pick("s1")
    const a2 = await pick("s1")
    assert.equal(a1.icon_custom_emoji_id, a2.icon_custom_emoji_id)
    assert.equal(a1.icon_color, a2.icon_color)
    assert.ok(
      [7322096, 16766590, 13338331, 9367192, 16749490, 16478047].includes(
        a1.icon_color,
      ),
    )
    const base = hash("shop")
    const near = new Set([0, 1, 2, 3].map((i) => `e${(base + i) % 12}`))
    for (const id of ["s1", "s2", "s3", "s4", "s5", "s6"]) {
      const b = await pick(id)
      assert.ok(near.has(b.icon_custom_emoji_id), `${id} within the family`)
      assert.equal(b.icon_color, a1.icon_color, "color follows the project")
    }
  })

  it("a configured emoji wins: by agent regex, or by project glob", async () => {
    const r = await rig({ icons: { "^coord": "🎯", "api*": "🛠" } })
    r.tg.forum = true
    await r.channel.send({
      message: "m",
      session: {
        id: "a",
        name: "shop · x",
        project: "shop",
        agent: "coordinator",
      },
    })
    await r.channel.send({
      message: "m",
      session: { id: "b", name: "api · x", project: "api", agent: "builder" },
    })
    const [x, y] = r.tg.of("createForumTopic")
    assert.equal(x.body.icon_custom_emoji_id, "e0", "🎯")
    assert.equal(y.body.icon_custom_emoji_id, "e1", "🛠")
    await r.done()
  })

  it("falls back to the color alone when the icon list cannot be had", async () => {
    const r = await rig()
    r.tg.forum = true
    r.tg.fail("getForumTopicIconStickers", 500)
    const ref = await r.channel.send({
      message: "m",
      session: { id: "a", name: "shop · x", project: "shop" },
    })
    assert.ok(ref)
    const body = topicBody(r)
    assert.equal(body.icon_custom_emoji_id, undefined)
    assert.equal(typeof body.icon_color, "number")
    await r.done()
  })

  it("the status card shows the topic's emoji with the project", async () => {
    const r = await rig({ icons: { "^coord": "🎯" } })
    r.tg.forum = true
    await r.channel.track(state())
    assert.match(r.tg.of("sendMessage")[0].body.text, /\n📁 shop 🎯\n/)
    await r.done()
  })

  it("changes the topic's icon when the configured pick changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oobb-icon-"))
    const topicsFile = join(dir, "t.json")
    const a = await rig({ topicsFile, statusCard: false })
    a.tg.forum = true
    await a.channel.track(state())
    const first = topicBody(a).icon_custom_emoji_id
    await a.done()

    const b = await rig({
      topicsFile,
      statusCard: false,
      icons: { "^coord": first === "e2" ? "🛠" : "🔥" },
    })
    b.tg.forum = true
    await b.channel.track(state())
    const edit = b.tg.of("editForumTopic")
    assert.equal(edit.length, 1)
    assert.equal(edit[0].body.message_thread_id, 9001)
    assert.equal(edit[0].body.name, undefined, "only the icon changed")
    assert.notEqual(edit[0].body.icon_custom_emoji_id, first)
    await b.done()
  })
})
