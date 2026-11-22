import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { OFF } from "../approvals/config.ts"
import { Approvals, type ChannelPort } from "../approvals/engine.ts"
import { filterSecrets } from "../filter.ts"
import { newSigningKey, signAnswer } from "../approvals/sign.ts"
import { RecordStore } from "../approvals/store.ts"
import { code, step } from "../approvals/totp.ts"
import type { ApprovalView } from "../approvals/types.ts"
import { fakeTelegram } from "./fake-telegram.test-util.ts"
import { TelegramConnector, type TelegramOptions } from "./telegram.ts"
import type { Inbound } from "./types.ts"

const LAUNCH = {
  url: "https://app.example.com/app/",
  link: "https://t.me/examplebot/app",
}
const GROUP = -100777
const OPERATOR = 42
const SEED = Buffer.from("12345678901234567890")

const view = (over: Partial<ApprovalView> = {}): ApprovalView => ({
  id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  short: "zzzz",
  nonce: "abcdefgh",
  caller: "secrets-tool",
  requester: { session_id: "ses_1", agent: "build", tool: "secrets" },
  action_class: "secrets.write",
  level: 2,
  scope: "item <4f2a> & co",
  reason: "deploy",
  expiresAt: Date.now() + 120_000,
  ...over,
})

async function rig(over: Partial<TelegramOptions> = {}) {
  const tg = await fakeTelegram()
  const dir = await mkdtemp(join(tmpdir(), "oobb-tga-"))
  const channel = new TelegramConnector({
    token: async () => tg.token,
    chatId: String(GROUP),
    operator: String(OPERATOR),
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
    return undefined
  }, ac.signal)
  return {
    tg,
    channel,
    got,
    async done() {
      ac.abort()
      await tg.close()
    },
  }
}

describe("Telegram approvals: messages", () => {
  it("declares what it can prove", () => {
    const c = new TelegramConnector({ token: async () => "x" })
    assert.deepEqual(c.capabilities.approvals, {
      buttons: true,
      approver: "verified",
      replyText: true,
    })
  })

  it("posts the request to the operator's private chat with one Review & approve button, then rewrites it", async () => {
    const r = await rig()
    r.channel.launch(LAUNCH)
    const ref = await r.channel.approvalRequest(view())
    assert.equal(ref, `${OPERATOR}:${r.tg.lastMessageId}`)
    const m = r.tg.of("sendMessage")[0].body
    assert.equal(m.chat_id, String(OPERATOR))
    assert.equal(m.parse_mode, "HTML")
    assert.match(m.text, /Approval #zzzz<\/b> · L2/)
    assert.match(
      m.text,
      /secrets-tool<\/b> asks for <code>secrets.write<\/code>/,
    )
    assert.match(m.text, /item &lt;4f2a&gt; &amp; co/)
    assert.match(m.text, /never goes to Telegram or the AI/)
    const buttons = m.reply_markup.inline_keyboard.flat()
    assert.equal(buttons.length, 1)
    assert.equal(buttons[0].text, "📱 Review & approve")
    assert.equal(buttons[0].web_app.url, LAUNCH.url + "?s=a_" + view().id)
    assert.equal(buttons[0].callback_data, undefined)
    await r.channel.approvalSettle(ref!, view(), {
      decision: "approve",
      level: 2,
      by: "42",
    })
    const e = r.tg.of("editMessageText")[0].body
    assert.equal(e.chat_id, String(OPERATOR))
    assert.equal(e.message_id, r.tg.lastMessageId)
    assert.match(e.text, /✅ Approved · L2/)
    assert.deepEqual(e.reply_markup.inline_keyboard, [])
    await r.done()
  })

  it("still edits a message whose ref is the bare id of the paired chat", async () => {
    const r = await rig()
    await r.channel.approvalSettle("77", view(), { decision: "deny", level: 1 })
    const e = r.tg.of("editMessageText")[0].body
    assert.equal(e.chat_id, String(GROUP))
    assert.equal(e.message_id, 77)
    await r.done()
  })

  it("goes to an Approvals topic when the private chat refuses, and leaves the private chat alone for ten minutes", async () => {
    const clock = { now: 1_000 }
    const r = await rig({ now: () => clock.now })
    r.tg.forum = true
    r.channel.launch(LAUNCH)
    r.tg.fail("sendMessage", 403, {
      description: "Forbidden: bot can't initiate conversation with a user",
    })
    const ref = await r.channel.approvalRequest(view())
    const sent = () => r.tg.of("sendMessage").map((c) => c.body)
    assert.equal(sent().length, 2)
    assert.equal(sent()[0].chat_id, String(OPERATOR))
    const topics = r.tg.of("createForumTopic")
    assert.equal(topics.length, 1)
    assert.equal(topics[0].body.name, "Approvals")
    assert.equal(sent()[1].chat_id, String(GROUP))
    assert.ok(sent()[1].message_thread_id > 0, "never General")
    assert.ok(ref!.startsWith(GROUP + ":"))
    assert.equal(
      sent()[1].reply_markup.inline_keyboard[0][0].url,
      LAUNCH.link + "?startapp=a_" + view().id,
    )

    await r.channel.approvalRequest(view({ id: "01HYYYYYYYYYYYYYYYYYYYYYYY" }))
    assert.equal(sent().length, 3)
    assert.equal(
      sent()[2].chat_id,
      String(GROUP),
      "no second try of the private chat",
    )
    assert.equal(sent()[2].message_thread_id, sent()[1].message_thread_id)
    assert.equal(r.tg.of("createForumTopic").length, 1, "topic made once")

    clock.now += 10 * 60_000 + 1
    await r.channel.approvalRequest(view({ id: "01HXXXXXXXXXXXXXXXXXXXXXXX" }))
    assert.equal(
      sent()[3].chat_id,
      String(OPERATOR),
      "tried again after ten minutes",
    )
    await r.done()
  })

  it("posts nothing to General or a session topic when neither place works", async () => {
    const r = await rig()
    r.channel.launch(LAUNCH)
    r.tg.fail("sendMessage", 403, { description: "Forbidden" })
    assert.equal(await r.channel.approvalRequest(view()), undefined)
    assert.equal(r.tg.of("sendMessage").length, 1, "only the private try")
    await r.done()
  })

  it("has nothing to send when the app is not on offer", async () => {
    const r = await rig()
    assert.equal(await r.channel.approvalRequest(view()), undefined)
    assert.equal(r.tg.of("sendMessage").length, 0)
    await r.done()
  })

  it("says why a request ended", async () => {
    const r = await rig()
    for (const [reason, decision, text] of [
      ["present", "expired", /you are at the Mac/],
      ["timeout", "expired", /Expired/],
      ["cooldown", "deny", /asked again too soon/],
      ["bad_code", "deny", /three wrong codes/],
    ] as const) {
      await r.channel.approvalSettle("9", view(), {
        decision,
        level: 0,
        reason,
      })
      const e = r.tg.of("editMessageText").at(-1)!.body
      assert.match(e.text, text)
    }
    await r.done()
  })

  it("asks for the code with a force reply, and deletes messages", async () => {
    const r = await rig()
    await r.channel.approvalCode(view())
    const m = r.tg.of("sendMessage")[0].body
    assert.match(m.text, /Type the 6-digit code for #zzzz/)
    assert.equal(m.reply_markup.force_reply, true)
    await r.channel.deleteMessage("77")
    assert.equal(r.tg.of("deleteMessage")[0].body.message_id, 77)
    await r.done()
  })
})

describe("Telegram approvals: second factor prompt", () => {
  const APP = {
    url: "https://app.example.com/app/",
    link: "https://t.me/examplebot/app",
  }

  it("opens the app from the prompt in a private chat and still takes a typed code", async () => {
    const r = await rig({ chatId: "42" })
    r.channel.launch(APP)
    assert.equal(r.channel.appOpen(), true)
    await r.channel.approvalCode(view({ factors: ["biometric", "totp"] }))
    const m = r.tg.of("sendMessage")[0].body
    assert.match(m.text, /Verify #zzzz.*open the app, or type the 6-digit code/)
    assert.equal(m.reply_markup.force_reply, undefined)
    const b = m.reply_markup.inline_keyboard.flat()[0]
    assert.equal(b.web_app.url, APP.url + "?s=a_01HZZZZZZZZZZZZZZZZZZZZZZZ")
    await r.done()
  })

  it("uses the direct link in a group, and says nothing about a code when totp is not listed", async () => {
    const r = await rig()
    r.channel.launch(APP)
    await r.channel.approvalCode(view({ factors: ["biometric"] }))
    const m = r.tg.of("sendMessage")[0].body
    assert.doesNotMatch(m.text, /code/)
    const b = m.reply_markup.inline_keyboard.flat()[0]
    assert.equal(b.url, APP.link + "?startapp=a_01HZZZZZZZZZZZZZZZZZZZZZZZ")
    await r.done()
  })

  it("asks for the code only when the app is not on offer or not launched", async () => {
    const r = await rig({ chatId: "42" })
    assert.equal(r.channel.appOpen(), false)
    await r.channel.approvalCode(view({ factors: ["totp"] }))
    const m = r.tg.of("sendMessage")[0].body
    assert.match(m.text, /Type the 6-digit code for #zzzz/)
    assert.equal(m.reply_markup.force_reply, true)
    await r.done()
  })
})

describe("Telegram approvals: who answers", () => {
  it("an Approve or Deny button of an earlier message decides nothing and points to the app", async () => {
    const r = await rig()
    let taps = 0
    r.channel.onApproval({
      tap: async () => (taps++, { ok: true, text: "x" }),
      typed: async () => "ignored",
    })
    const data = "ap:01HZZZZZZZZZZZZZZZZZZZZZZZ:abcdefgh:"
    r.tg.callback(GROUP, 5, data + "y", undefined, 99)
    r.tg.callback(GROUP, 6, data + "n", undefined, OPERATOR)
    await r.tg.waitFor(() =>
      r.tg.of("answerCallbackQuery").length === 2 ? true : undefined,
    )
    for (const c of r.tg.of("answerCallbackQuery"))
      assert.equal(c.body.text, "This moved to the app: use the 📱 button.")
    assert.equal(taps, 0)
    await r.done()
  })

  it("ignores a tap from another chat", async () => {
    const r = await rig()
    let called = 0
    r.channel.onApproval({
      tap: async () => (called++, { ok: true, text: "x" }),
      typed: async () => "ignored",
    })
    r.tg.callback(555, 5, "ap:01HZZZZZZZZZZZZZZZZZZZZZZZ:abcdefgh:y")
    await new Promise((x) => setTimeout(x, 150))
    assert.equal(called, 0)
    await r.done()
  })

  it("keeps a typed code from reaching a session, and lets other digits through", async () => {
    const r = await rig()
    const seen: string[] = []
    r.channel.onApproval({
      tap: async () => ({ ok: true, text: "" }),
      typed: async (t) => (
        seen.push(`${t.userId}:${t.text}:${t.messageRef}`),
        t.text === "123456" ? "consumed" : "ignored"
      ),
    })
    r.tg.message(GROUP, "123456", undefined, undefined, {}, OPERATOR)
    r.tg.message(GROUP, "654321", undefined, undefined, {}, OPERATOR)
    r.tg.message(GROUP, "hello", undefined, undefined, {}, OPERATOR)
    await r.tg.waitFor(() => seen.length === 2 && r.got.length >= 0 && seen)
    await new Promise((x) => setTimeout(x, 150))
    assert.equal(seen.length, 2, "only six digits are offered to approvals")
    assert.ok(seen[0].startsWith("42:123456:"))
    assert.equal(r.got.filter((g) => g.text === "123456").length, 0)
    await r.done()
  })

  it("stores the user id of whoever pairs, and finds the operator", async () => {
    const paired: Array<[string, string | undefined]> = []
    const r = await rig({
      chatId: undefined,
      operator: undefined,
      onPaired: (c, u) => paired.push([c, u]),
    })
    assert.equal(r.channel.operator(), undefined)
    const p = await r.channel.pair()
    r.tg.message(
      -1001,
      `/start@oob_test_bot ${p.code}`,
      undefined,
      undefined,
      {},
      31337,
    )
    assert.equal(await p.done, true)
    assert.deepEqual(paired, [["-1001", "31337"]])
    assert.equal(r.channel.operator(), "31337")
    await r.done()
  })

  it("counts the owner of a private chat paired before user ids were stored, and nobody in an old group", () => {
    const priv = new TelegramConnector({ token: async () => "x", chatId: "42" })
    assert.equal(priv.operator(), "42")
    const group = new TelegramConnector({
      token: async () => "x",
      chatId: "-100",
    })
    assert.equal(group.operator(), undefined)
  })
})

describe("Telegram approvals: with the engine", () => {
  it("is answered only in the app: an old button decides nothing, the app approves with a factor or denies", async () => {
    const r = await rig()
    r.channel.launch(LAUNCH)
    const key = newSigningKey()
    const port = (): ChannelPort => ({
      id: r.channel.id,
      type: "telegram",
      caps: r.channel.capabilities.approvals!,
      up: () => true,
      operator: () => r.channel.operator(),
      request: (v) => r.channel.approvalRequest(v),
      askCode: (v) => r.channel.approvalCode(v),
      settle: (ref, v, s) => r.channel.approvalSettle(ref, v, s),
      remove: (ref) => r.channel.deleteMessage(ref),
    })
    const engine = new Approvals({
      cfg: () => ({
        ...OFF,
        enabled: true,
        classes: {
          "secrets.write": { level: 2, channels: ["telegram"], maxTtl: 600 },
        },
        callers: { "secrets-tool": { classes: ["secrets.write"] } },
      }),
      now: Date.now,
      mode: () => "afk",
      channels: () => [port()],
      sign: async (a) => signAnswer(key, a),
      signingReady: async () => true,
      seed: async () => SEED,
      store: new RecordStore(),
      mask: filterSecrets,
    })
    r.channel.onApproval(engine)
    const ask = async (k: string) => {
      const made = await engine.create("secrets-tool", {
        idempotency_key: k,
        action_class: "secrets.write",
        scope_summary: "item 4f2a",
      })
      return (made.body as { id: string }).id
    }
    const state = (id: string) =>
      (engine.get("secrets-tool", id).body as { state: string }).state

    const id = await ask("k1")
    const sent = r.tg.of("sendMessage")[0].body
    assert.equal(sent.chat_id, String(OPERATOR))
    assert.equal(
      sent.reply_markup.inline_keyboard[0][0].web_app.url,
      LAUNCH.url + "?s=a_" + id,
    )
    r.tg.callback(GROUP, 501, `ap:${id}:abcdefgh:y`, undefined, OPERATOR)
    await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.equal(state(id), "pending", "the old button decided nothing")

    const wrong = await engine.appProof(id, { factor: "totp", code: "000000" })
    assert.equal(wrong.status, 422)
    const ok = await engine.appProof(id, {
      factor: "totp",
      code: code(SEED, step(Date.now())),
    })
    assert.equal(ok.status, 200)
    assert.equal(state(id), "approved")
    const edit = await r.tg.waitFor(() => r.tg.of("editMessageText")[0])
    assert.equal(edit.body.chat_id, String(OPERATOR))
    assert.match(edit.body.text, /Approved · L2/)

    const id2 = await ask("k2")
    assert.equal(
      (await engine.appDecide(id2, { action: "approve" })).status,
      409,
    )
    assert.equal(state(id2), "pending", "level 2 needs a factor")
    assert.equal((await engine.appDecide(id2, { action: "deny" })).status, 200)
    assert.equal(state(id2), "denied")
    assert.equal(r.got.length, 0, "nothing reached a session")
    await r.done()
  })
})
