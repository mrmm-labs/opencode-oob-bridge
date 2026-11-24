import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
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
const THREAD = 9001

async function rig(
  o: {
    permissions?: unknown
    window?: boolean
    replyFails?: boolean
    formGone?: boolean
  } = {},
) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-forms-"))
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
    permissions: o.permissions,
  }) as Config
  const seen = {
    forms: [] as Array<{ formID: string; answer: unknown }>,
    permissions: [] as Array<{ requestID: string; decision: string }>,
  }
  const host: Host = {
    session: async (id) =>
      id === "root"
        ? { id, agent: "coord", directory: "/w/shop", title: "Fix" }
        : undefined,
    root: (id) => id,
    replyForm: async (_s, formID, answer) => {
      if (o.formGone) throw new Error("Form not found: " + formID)
      seen.forms.push({ formID, answer })
    },
    prompt: async () => {},
    busy: () => false,
    canReplyForm: () => o.window !== false,
    replyPermission: async (_s, requestID, decision) => {
      if (o.replyFails) throw new Error("gone")
      seen.permissions.push({ requestID, decision })
    },
  }
  const router = new Router(cfg, async () => true)
  router.setAfk("on", Infinity)
  router.set("root", true)
  const store = new PendingStore()
  const bridge = new Bridge(cfg, host, [channel], store, router)
  bridge.start()
  const ev = (type: string, data: Record<string, unknown>) =>
    bridge.onEvent({ type, data } as unknown as BridgeEvent)
  return {
    tg,
    channel,
    bridge,
    store,
    seen,
    ev,
    sends: () => tg.of("sendMessage").map((c) => c.body),
    edits: () => tg.of("editMessageText").map((c) => c.body),
    tap: (data: string) => tg.callback(CHAT, tg.lastMessageId, data, THREAD),
    async done() {
      await bridge.stop()
      await tg.close()
    },
  }
}

const threeFields = {
  form: {
    id: "frm_1",
    sessionID: "root",
    metadata: { kind: "question" },
    fields: [
      {
        key: "db",
        type: "string",
        title: "DB",
        description: "Which db?",
        options: [{ label: "pg" }, { label: "mysql" }],
      },
      {
        key: "tools",
        type: "multiselect",
        title: "Tools",
        description: "Which tools?",
        options: [{ label: "a" }, { label: "b" }, { label: "c" }],
      },
      {
        key: "note",
        type: "string",
        title: "Note",
        description: "Anything else?",
        options: [{ label: "none" }],
      },
    ],
  },
}

const twoFields = {
  form: {
    id: "frm_2",
    sessionID: "root",
    metadata: { kind: "question" },
    fields: [
      {
        key: "q0",
        type: "string",
        title: "Land",
        description: "How do we land it?",
        options: [{ label: "fix first" }, { label: "re-record" }],
        custom: true,
      },
      {
        key: "q1",
        type: "string",
        title: "Who",
        description: "Who does it?",
        options: [{ label: "me" }, { label: "you" }],
        custom: true,
      },
    ],
  },
}

const logged = async <T>(run: (lines: () => Promise<any[]>) => Promise<T>) => {
  const dir = await mkdtemp(join(tmpdir(), "oobb-formlog-"))
  const file = join(dir, "bridge.log")
  const was = process.env.OPENCODE_OOB_BRIDGE_LOG
  process.env.OPENCODE_OOB_BRIDGE_LOG = file
  try {
    return await run(async () => {
      await sleep(150)
      const text = await readFile(file, "utf8").catch(() => "")
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    })
  } finally {
    if (was === undefined) delete process.env.OPENCODE_OOB_BRIDGE_LOG
    else process.env.OPENCODE_OOB_BRIDGE_LOG = was
  }
}

const yesNoForm = {
  form: {
    id: "frm_3",
    sessionID: "root",
    metadata: { kind: "question" },
    fields: [
      {
        key: "go",
        type: "string",
        title: "Merge",
        description: "Merge now?",
        options: [{ label: "Yes" }, { label: "No" }],
        custom: false,
      },
    ],
  },
}

const withApp = (r: Awaited<ReturnType<typeof rig>>) =>
  r.channel.launch({ url: "https://app.example.com/app/" })

const appButton = (m: { reply_markup?: any }) => {
  const rows = m.reply_markup?.inline_keyboard ?? []
  return { rows, b: rows[0]?.[0] }
}

describe("forms: answered in the app", () => {
  it("edits the message to Answered in app with the short answers, masked and cut", async () => {
    const r = await rig()
    await r.ev("form.created", twoFields)
    await r.tg.waitFor(() =>
      r.sends().find((b) => /How do we land/.test(b.text)),
    )
    const id = r.store.list()[0].id
    const key = "sk-" + "a".repeat(30)
    const out = await r.bridge.answerFromClient(id, {
      answers: { q0: "fix first (Recommended)", q1: key },
    })
    assert.equal(out.ok, true)
    const e = await r.tg.waitFor(() =>
      r.edits().find((b) => /Answered in app/.test(b.text)),
    )
    assert.match(e.text, /✅ <b>Answered in app<\/b> · fix first · /)
    assert.doesNotMatch(e.text, /Recommended|sk-a/)
    assert.ok(!e.reply_markup?.inline_keyboard?.length, "no buttons")
    assert.equal(r.store.list()[0].state, "answered")
    await r.done()
  })

  it("cuts a long answer to 120 characters", async () => {
    const r = await rig()
    await r.ev("form.created", twoFields)
    await r.tg.waitFor(() =>
      r.sends().find((b) => /How do we land/.test(b.text)),
    )
    const id = r.store.list()[0].id
    await r.bridge.answerFromClient(id, {
      answers: { q0: "w".repeat(300), q1: "me" },
    })
    const e = await r.tg.waitFor(() =>
      r.edits().find((b) => /Answered in app/.test(b.text)),
    )
    const shown = /Answered in app<\/b> · (\S+)/.exec(e.text)![1]
    assert.ok(shown.length <= 120)
    assert.ok(shown.startsWith("w"))
    assert.doesNotMatch(e.text, /w{121}|· me/)
    await r.done()
  })
})

describe("forms: one tap in the chat, the rest in the app", () => {
  it("a yes or no keeps its buttons, and a tap answers it", async () => {
    const r = await rig()
    await r.ev("form.created", yesNoForm)
    const m = await r.tg.waitFor(() =>
      r.sends().find((b) => /Merge now/.test(b.text)),
    )
    const id = r.store.list()[0].id
    assert.deepEqual(
      m.reply_markup.inline_keyboard.map((x: any[]) => x[0].callback_data),
      [`${id}:1`, `${id}:2`],
    )
    r.tap(`${id}:2`)
    await r.tg.waitFor(() => r.seen.forms[0])
    assert.deepEqual(r.seen.forms, [{ formID: "frm_3", answer: { go: "No" } }])
    await r.done()
  })

  it("long options with a recommended one keep their buttons: one per row, starred, cut with …, and a tap answers the full option", async () => {
    const REC = "Apply the fix to the staging cluster now (Recommended)"
    const r = await rig()
    withApp(r)
    await r.ev("form.created", {
      form: {
        id: "frm_4",
        sessionID: "root",
        metadata: { kind: "question" },
        fields: [
          {
            key: "go",
            type: "string",
            title: "Fix",
            description: "What next?",
            options: [
              { label: REC },
              { label: "Wait for the release" },
              { label: "Skip this for now" },
            ],
            custom: true,
          },
        ],
      },
    })
    const m = await r.tg.waitFor(() =>
      r.sends().find((b) => /What next/.test(b.text)),
    )
    const id = r.store.list()[0].id
    const rows = m.reply_markup.inline_keyboard
    assert.equal(rows.length, 4, "three options and the app row")
    assert.ok(rows.every((x: any[]) => x.length === 1))
    assert.deepEqual(
      rows.slice(0, 3).map((x: any[]) => x[0].callback_data),
      [`${id}:1`, `${id}:2`, `${id}:3`],
    )
    const first = rows[0][0].text as string
    assert.match(first, /^1️⃣ ★ Apply the fix/)
    assert.ok(first.endsWith("…") && first.length <= 40, first)
    assert.doesNotMatch(first, /Recommended/)
    assert.equal(rows[1][0].text, "2️⃣ Wait for the release")
    assert.equal(rows[2][0].text, "3️⃣ Skip this for now")
    assert.equal(rows[3][0].text, "📱 Answer in app")
    assert.match(m.text, /★ Apply the fix to the staging cluster now/)
    r.tap(`${id}:1`)
    await r.tg.waitFor(() => r.seen.forms[0])
    assert.deepEqual(r.seen.forms, [{ formID: "frm_4", answer: { go: REC } }])
    await r.done()
  })

  it("two fields get one 📱 Answer in app button to that question, and no option buttons", async () => {
    const r = await rig()
    withApp(r)
    await r.ev("form.created", twoFields)
    const m = await r.tg.waitFor(() =>
      r.sends().find((b) => /How do we land/.test(b.text)),
    )
    const id = r.store.list()[0].id
    const { rows, b } = appButton(m)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].length, 1)
    assert.equal(b.text, "📱 Answer in app")
    assert.equal(b.web_app.url, `https://app.example.com/app/?s=f_${id}`)
    await r.done()
  })

  it("three fields, and a multi-select, get the same single button", async () => {
    const r = await rig()
    withApp(r)
    await r.ev("form.created", threeFields)
    const m = await r.tg.waitFor(() =>
      r.sends().find((b) => /Which db/.test(b.text)),
    )
    assert.equal(appButton(m).b.text, "📱 Answer in app")
    assert.equal(appButton(m).rows.length, 1)
    await r.done()
  })

  it("with no app configured a multi-field form has no buttons and says to reply", async () => {
    const r = await rig()
    await r.ev("form.created", twoFields)
    const m = await r.tg.waitFor(() =>
      r.sends().find((b) => /How do we land/.test(b.text)),
    )
    assert.equal(m.reply_markup, undefined)
    assert.match(m.text, /Reply to this message with one answer per question/)
    await r.done()
  })

  it("a reply with one answer per question still answers a two-field form", async () => {
    const r = await rig()
    await r.ev("form.created", twoFields)
    await r.tg.waitFor(() =>
      r.sends().find((b) => /How do we land/.test(b.text)),
    )
    r.tg.message(CHAT, "2 | 1", r.tg.lastMessageId, THREAD)
    await r.tg.waitFor(() => r.seen.forms[0])
    assert.deepEqual(r.seen.forms, [
      { formID: "frm_2", answer: { q0: "re-record", q1: "me" } },
    ])
    await r.done()
  })

  it("the stepper buttons of an earlier version do nothing and say where the question went", async () => {
    const r = await rig()
    await r.ev("form.created", twoFields)
    await r.tg.waitFor(() =>
      r.sends().find((b) => /How do we land/.test(b.text)),
    )
    const id = r.store.list()[0].id
    r.tap(`s:${id}:o1`)
    r.tap(`${id}:t1`)
    r.tap(`${id}:d`)
    await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[2])
    for (const t of r.tg.of("answerCallbackQuery"))
      assert.match(String(t.body.text), /moved to the app/)
    assert.equal(r.seen.forms.length, 0)
    assert.equal(r.store.list()[0].state, "pending")
    await r.done()
  })

  it("a tap on a one-tap question that is already answered is refused", async () => {
    const r = await rig()
    await r.ev("form.created", yesNoForm)
    await r.tg.waitFor(() => r.sends().find((b) => /Merge now/.test(b.text)))
    const id = r.store.list()[0].id
    r.tap(`${id}:1`)
    await r.tg.waitFor(() => r.seen.forms[0])
    r.tap(`${id}:2`)
    await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[1])
    assert.equal(r.seen.forms.length, 1)
    await r.done()
  })

  it("every tap and the reply are logged, without the answer text", async () => {
    await logged(async (lines) => {
      const r = await rig()
      await r.ev("form.created", yesNoForm)
      await r.tg.waitFor(() => r.sends().find((b) => /Merge now/.test(b.text)))
      const id = r.store.list()[0].id
      r.tap(`${id}:2`)
      await r.tg.waitFor(() => r.seen.forms[0])
      const l = await lines()
      const ev = (e: string) => l.filter((x) => x.event === e)
      assert.equal(ev("form_select")[0].outcome, "ok")
      assert.equal(ev("form_reply_ok")[0].fields, 1)
      assert.ok(!JSON.stringify(l).includes('"No"'))
      await r.done()
    })
  })

  it("a reply the host refuses logs the reason", async () => {
    await logged(async (lines) => {
      const r = await rig({ formGone: true })
      await r.ev("form.created", yesNoForm)
      await r.tg.waitFor(() => r.sends().find((b) => /Merge now/.test(b.text)))
      const id = r.store.list()[0].id
      r.tap(`${id}:1`)
      await sleep(300)
      try {
        const f = (await lines()).find((x) => x.event === "form_reply_failed")
        assert.equal(f?.reason, "not-found")
      } finally {
        await r.done()
      }
    })
  })
})

const permission = {
  id: "per_1",
  sessionID: "root",
  action: "bash",
  resources: ["rm -rf build"],
}
const keys = (m: { reply_markup?: any }) =>
  (m.reply_markup?.inline_keyboard?.[0] ?? []).map(
    (k: { text: string }) => k.text,
  )

describe("forms: permissions", () => {
  it("has no buttons while permissions.remote is off, and refuses a forged tap", async () => {
    const r = await rig()
    await r.ev("permission.asked", permission)
    const m = await r.tg.waitFor(() =>
      r.sends().find((b) => /bash/.test(b.text)),
    )
    assert.deepEqual(keys(m), [])
    const id = r.store.list()[0].id
    r.tap(`p:${id}:o`)
    await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.equal(r.seen.permissions.length, 0)
    assert.equal(r.store.list()[0].state, "pending")
    await r.done()
  })

  it("once: Allow once and Deny, and an Allow once reaches the host and marks the message", async () => {
    const r = await rig({ permissions: { remote: "once" } })
    await r.ev("permission.asked", permission)
    const m = await r.tg.waitFor(() =>
      r.sends().find((b) => /bash/.test(b.text)),
    )
    assert.deepEqual(keys(m), ["Allow once", "Deny"])
    const id = r.store.list()[0].id
    r.tap(`p:${id}:o`)
    await r.tg.waitFor(() => r.seen.permissions[0])
    assert.deepEqual(r.seen.permissions, [
      { requestID: "per_1", decision: "once" },
    ])
    const e = await r.tg.waitFor(() =>
      r.edits().find((x) => /Allowed once/.test(x.text)),
    )
    assert.match(e.text, /Answered in Telegram/)
    await r.done()
  })

  it("once has no Always, and a forged Always is refused", async () => {
    const r = await rig({ permissions: { remote: "once" } })
    await r.ev("permission.asked", permission)
    await r.tg.waitFor(() => r.sends().find((b) => /bash/.test(b.text)))
    const id = r.store.list()[0].id
    r.tap(`p:${id}:a`)
    await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.match(
      r.tg.of("answerCallbackQuery")[0].body.text,
      /Always needs permissions.remote: all/,
    )
    assert.equal(r.seen.permissions.length, 0)
    await r.done()
  })

  it("all adds Always, Deny is a reject, and each answer is logged with the channel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oobb-plog-"))
    const file = join(dir, "log.jsonl")
    const old = process.env.OPENCODE_OOB_BRIDGE_LOG
    process.env.OPENCODE_OOB_BRIDGE_LOG = file
    try {
      const r = await rig({ permissions: { remote: "all" } })
      await r.ev("permission.asked", permission)
      const m = await r.tg.waitFor(() =>
        r.sends().find((b) => /bash/.test(b.text)),
      )
      assert.deepEqual(keys(m), ["Allow once", "Always", "Deny"])
      const id = r.store.list()[0].id
      r.tap(`p:${id}:r`)
      await r.tg.waitFor(() => r.seen.permissions[0])
      assert.deepEqual(r.seen.permissions, [
        { requestID: "per_1", decision: "reject" },
      ])
      await sleep(200)
      const line = (await readFile(file, "utf8"))
        .split("\n")
        .find((l) => l.includes("permission_answered"))
      assert.ok(line, "a log line")
      assert.match(line, /"decision":"reject"/)
      assert.match(line, /"channel":"telegram"/)
      assert.match(line, /"action":"bash"/)
      await r.done()
    } finally {
      if (old === undefined) delete process.env.OPENCODE_OOB_BRIDGE_LOG
      else process.env.OPENCODE_OOB_BRIDGE_LOG = old
    }
  })

  it("the first answer wins: a second tap is told it is answered", async () => {
    const r = await rig({ permissions: { remote: "once" } })
    await r.ev("permission.asked", permission)
    await r.tg.waitFor(() => r.sends().find((b) => /bash/.test(b.text)))
    const id = r.store.list()[0].id
    r.tap(`p:${id}:o`)
    await r.tg.waitFor(() => r.seen.permissions[0])
    r.tap(`p:${id}:r`)
    await sleep(200)
    assert.equal(r.seen.permissions.length, 1)
    await r.done()
  })
})

describe("permissions with an approvals gate", () => {
  it("asks the gate with the action, the decision and the sender, and a refusal reaches nobody", async () => {
    const r = await rig({ permissions: { remote: "all" } })
    const asked: unknown[] = []
    r.bridge.setPermissionGate((o) => {
      asked.push({ action: o.action, decision: o.decision, id: o.channel?.id })
      return { kind: "refuse", text: "This one is answered at the Mac." }
    })
    await r.ev("permission.asked", permission)
    await r.tg.waitFor(() => r.sends().find((b) => /bash/.test(b.text)))
    r.tap(`p:${r.store.list()[0].id}:a`)
    await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.deepEqual(asked, [
      { action: "bash", decision: "always", id: "telegram" },
    ])
    assert.match(
      r.tg.of("answerCallbackQuery")[0].body.text,
      /answered at the Mac/,
    )
    assert.equal(r.seen.permissions.length, 0)
    assert.equal(r.store.list()[0].state, "pending")
    await r.done()
  })

  it("allow answers at once", async () => {
    const r = await rig({ permissions: { remote: "once" } })
    r.bridge.setPermissionGate(() => ({ kind: "allow" }))
    await r.ev("permission.asked", permission)
    await r.tg.waitFor(() => r.sends().find((b) => /bash/.test(b.text)))
    r.tap(`p:${r.store.list()[0].id}:o`)
    await r.tg.waitFor(() => r.seen.permissions[0])
    assert.deepEqual(r.seen.permissions, [
      { requestID: "per_1", decision: "once" },
    ])
    await r.done()
  })

  it("a code gate waits for the code, applies once it is approved, and never applies when it is not", async () => {
    const r = await rig({ permissions: { remote: "once" } })
    let release: (v: "approved" | "denied") => void = () => {}
    r.bridge.setPermissionGate(() => ({
      kind: "code",
      wait: new Promise<"approved" | "denied">((res) => (release = res)),
    }))
    await r.ev("permission.asked", permission)
    await r.tg.waitFor(() => r.sends().find((b) => /bash/.test(b.text)))
    r.tap(`p:${r.store.list()[0].id}:o`)
    await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.equal(r.seen.permissions.length, 0, "nothing before the code")
    release("denied")
    await r.tg.waitFor(() =>
      r.sends().find((b) => /no valid code, not applied/.test(b.text)),
    )
    assert.equal(r.seen.permissions.length, 0)
    r.tap(`p:${r.store.list()[0].id}:o`)
    await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[1])
    release("approved")
    await r.tg.waitFor(() => r.seen.permissions[0])
    assert.deepEqual(r.seen.permissions, [
      { requestID: "per_1", decision: "once" },
    ])
    await r.done()
  })
})
