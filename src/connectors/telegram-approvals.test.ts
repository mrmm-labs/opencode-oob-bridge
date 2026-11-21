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
import type { ApprovalHandler, ApprovalView } from "../approvals/types.ts"
import { fakeTelegram } from "./fake-telegram.test-util.ts"
import { TelegramConnector, type TelegramOptions } from "./telegram.ts"
import type { Inbound } from "./types.ts"

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

  it("posts the request with Approve and Deny, escaped, then rewrites it and drops the buttons", async () => {
    const r = await rig()
    const ref = await r.channel.approvalRequest(view())
    assert.ok(ref)
    const m = r.tg.of("sendMessage")[0].body
    assert.equal(m.parse_mode, "HTML")
    assert.match(m.text, /Approval #zzzz<\/b> · L2/)
    assert.match(
      m.text,
      /secrets-tool<\/b> asks for <code>secrets.write<\/code>/,
    )
    assert.match(m.text, /item &lt;4f2a&gt; &amp; co/)
    assert.match(m.text, /Tap Approve, then type the 6-digit code/)
    const row = m.reply_markup.inline_keyboard[0]
    assert.deepEqual(
      row.map((b: { text: string }) => b.text),
      ["Approve", "Deny"],
    )
    assert.equal(
      row[0].callback_data,
      "ap:01HZZZZZZZZZZZZZZZZZZZZZZZ:abcdefgh:y",
    )
    assert.ok(Buffer.byteLength(row[0].callback_data) <= 64)
    await r.channel.approvalSettle(ref!, view(), {
      decision: "approve",
      level: 2,
      by: "42",
    })
    const e = r.tg.of("editMessageText")[0].body
    assert.match(e.text, /✅ Approved · L2/)
    assert.deepEqual(e.reply_markup.inline_keyboard, [])
    assert.doesNotMatch(e.text, /Tap Approve/)
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
  it("passes the user id of the tapper, not the chat id, to the handler", async () => {
    const r = await rig()
    const taps: Array<{
      userId: string
      id: string
      nonce: string
      action: string
    }> = []
    const handler: ApprovalHandler = {
      tap: async (t) => (
        taps.push(t),
        { ok: false, text: "Only the paired operator can answer." }
      ),
      typed: async () => "ignored",
    }
    r.channel.onApproval(handler)
    r.tg.callback(
      GROUP,
      5,
      "ap:01HZZZZZZZZZZZZZZZZZZZZZZZ:abcdefgh:y",
      undefined,
      99,
    )
    await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.deepEqual(taps, [
      {
        channel: "telegram",
        userId: "99",
        id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
        nonce: "abcdefgh",
        action: "approve",
      },
    ])
    assert.equal(
      r.tg.of("answerCallbackQuery")[0].body.text,
      "Only the paired operator can answer.",
    )
    await r.done()
  })

  it("says approvals are off when nothing handles them", async () => {
    const r = await rig()
    r.tg.callback(GROUP, 5, "ap:01HZZZZZZZZZZZZZZZZZZZZZZZ:abcdefgh:n")
    const t = await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.equal(t.body.text, "Approvals are off.")
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
  it("a second member pressing Approve changes nothing; the operator then answers with a code", async () => {
    const r = await rig()
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
    const made = await engine.create("secrets-tool", {
      idempotency_key: "k",
      action_class: "secrets.write",
      scope_summary: "item 4f2a",
    })
    const id = (made.body as { id: string }).id
    const sent = r.tg.of("sendMessage")[0].body
    const data = sent.reply_markup.inline_keyboard[0][0].callback_data as string
    const state = () =>
      (engine.get("secrets-tool", id).body as { state: string }).state

    r.tg.callback(GROUP, 501, data, undefined, 99)
    const toast = await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.equal(toast.body.text, "Only the paired operator can answer.")
    assert.equal(state(), "pending")

    r.tg.callback(GROUP, 501, data, undefined, OPERATOR)
    await r.tg.waitFor(() => state() === "awaiting_code")
    const prompt = await r.tg.waitFor(() => r.tg.of("sendMessage")[1])
    assert.match(prompt.body.text, /Type the 6-digit code/)

    r.tg.message(
      GROUP,
      code(SEED, step(Date.now())),
      undefined,
      undefined,
      {},
      99,
    )
    await new Promise((x) => setTimeout(x, 150))
    assert.equal(
      state(),
      "awaiting_code",
      "another member's digits are ignored",
    )

    r.tg.message(
      GROUP,
      code(SEED, step(Date.now())),
      undefined,
      undefined,
      {},
      OPERATOR,
    )
    await r.tg.waitFor(() => state() === "approved")
    const del = await r.tg.waitFor(() => r.tg.of("deleteMessage")[0])
    assert.ok(del.body.message_id > 0)
    const edit = await r.tg.waitFor(() => r.tg.of("editMessageText")[0])
    assert.match(edit.body.text, /Approved · L2/)
    assert.equal(r.got.length, 0, "nothing reached a session")
    await r.done()
  })
})
