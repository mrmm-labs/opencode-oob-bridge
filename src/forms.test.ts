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

const asked = async (r: Awaited<ReturnType<typeof rig>>) => {
  await r.ev("form.created", threeFields)
  const m = await r.tg.waitFor(() =>
    r.sends().find((b) => /Which db/.test(b.text)),
  )
  const id = r.store.list()[0].id
  return { m, id }
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

const forget = (r: Awaited<ReturnType<typeof rig>>) => {
  const c = r.channel as unknown as {
    steppers: Map<string, unknown>
    prompts: Map<string, unknown>
  }
  c.steppers.clear()
  c.prompts.clear()
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

describe("forms: two fields, and a restart in between", () => {
  it("answers a two-field form: pick, pick, Send", async () => {
    const r = await rig()
    await r.ev("form.created", twoFields)
    await r.tg.waitFor(() =>
      r.sends().find((b) => /How do we land/.test(b.text)),
    )
    const id = r.store.list()[0].id
    r.tap(`s:${id}:o2`)
    await r.tg.waitFor(() => r.edits().find((e) => /2\/2/.test(e.text)))
    r.tap(`s:${id}:o1`)
    const review = await r.tg.waitFor(() =>
      r.edits().find((e) => /Review your answers/.test(e.text)),
    )
    assert.match(review.text, /re-record/)
    assert.equal(r.seen.forms.length, 0)
    r.tap(`s:${id}:ok`)
    await r.tg.waitFor(() => r.seen.forms[0])
    assert.deepEqual(r.seen.forms, [
      { formID: "frm_2", answer: { q0: "re-record", q1: "me" } },
    ])
    await r.done()
  })

  it("after a restart a tap starts the form again from question 1 and is not applied; then it can be answered", async () => {
    const r = await rig()
    await r.ev("form.created", twoFields)
    await r.tg.waitFor(() =>
      r.sends().find((b) => /How do we land/.test(b.text)),
    )
    const id = r.store.list()[0].id
    r.tap(`s:${id}:o2`)
    await r.tg.waitFor(() => r.edits().find((e) => /2\/2/.test(e.text)))
    forget(r)
    const before = r.edits().length
    r.tap(`s:${id}:o1`)
    const redrawn = await r.tg.waitFor(() =>
      r
        .edits()
        .slice(before)
        .find((e) => /1\/2/.test(e.text)),
    )
    assert.ok(redrawn)
    const toast = r.tg
      .of("answerCallbackQuery")
      .map((c) => String(c.body.text ?? ""))
      .find((t) => /restarted/.test(t))
    assert.ok(toast, "the person is told")
    assert.equal(r.seen.forms.length, 0, "the stale tap is not applied")
    assert.equal(r.store.list()[0].state, "pending")
    r.tap(`s:${id}:o2`)
    await r.tg.waitFor(() =>
      r
        .edits()
        .slice(before)
        .find((e) => /2\/2/.test(e.text)),
    )
    r.tap(`s:${id}:o2`)
    await r.tg.waitFor(() =>
      r
        .edits()
        .slice(before)
        .find((e) => /Review your answers/.test(e.text)),
    )
    r.tap(`s:${id}:ok`)
    await r.tg.waitFor(() => r.seen.forms[0])
    assert.deepEqual(r.seen.forms[0].answer, { q0: "re-record", q1: "you" })
    await r.done()
  })

  it("a tap on a form that is no longer open says so and changes nothing", async () => {
    const r = await rig()
    await r.ev("form.created", twoFields)
    await r.tg.waitFor(() =>
      r.sends().find((b) => /How do we land/.test(b.text)),
    )
    const id = r.store.list()[0].id
    await r.ev("form.replied", { id: "frm_2", sessionID: "root" })
    await r.tg.waitFor(() => r.edits().find((x) => /Answered/.test(x.text)))
    forget(r)
    r.tap(`s:${id}:o1`)
    const t = await r.tg.waitFor(() =>
      r.tg
        .of("answerCallbackQuery")
        .find((c) => /No longer active/.test(String(c.body.text))),
    )
    assert.ok(t)
    assert.equal(r.seen.forms.length, 0)
    await r.done()
  })

  it("a ticked single question also starts again after a restart", async () => {
    const r = await rig()
    await r.ev("form.created", {
      form: {
        id: "frm_3",
        sessionID: "root",
        metadata: { kind: "question" },
        fields: [
          {
            key: "t",
            type: "multiselect",
            title: "Tools",
            description: "Which tools?",
            options: [{ label: "a" }, { label: "b" }],
          },
        ],
      },
    })
    await r.tg.waitFor(() => r.sends().find((b) => /Which tools/.test(b.text)))
    const id = r.store.list()[0].id
    forget(r)
    r.tap(`${id}:t1`)
    await r.tg.waitFor(() =>
      r.tg
        .of("answerCallbackQuery")
        .find((c) => /restarted/.test(String(c.body.text))),
    )
    r.tap(`${id}:t2`)
    await sleep(100)
    r.tap(`${id}:d`)
    await r.tg.waitFor(() => r.seen.forms[0])
    assert.deepEqual(r.seen.forms[0].answer, { t: ["b"] })
    await r.done()
  })

  it("every tap and the reply are logged, without the answer text", async () => {
    await logged(async (lines) => {
      const r = await rig()
      await r.ev("form.created", twoFields)
      await r.tg.waitFor(() =>
        r.sends().find((b) => /How do we land/.test(b.text)),
      )
      const id = r.store.list()[0].id
      r.tap(`s:${id}:o2`)
      await r.tg.waitFor(() => r.edits().find((e) => /2\/2/.test(e.text)))
      r.tap(`s:${id}:o1`)
      await r.tg.waitFor(() =>
        r.edits().find((e) => /Review your answers/.test(e.text)),
      )
      r.tap(`s:${id}:ok`)
      await r.tg.waitFor(() => r.seen.forms[0])
      const l = await lines()
      const ev = (e: string) => l.filter((x) => x.event === e)
      assert.equal(ev("form_select").length, 2)
      assert.equal(ev("form_select")[0].outcome, "ok")
      assert.equal(ev("form_submit")[0].fields, 2)
      assert.equal(ev("form_reply_ok")[0].fields, 2)
      assert.ok(!JSON.stringify(l).includes("re-record"))
      await r.done()
    })
  })

  it("a reply the host refuses logs the reason", async () => {
    await logged(async (lines) => {
      const r = await rig({ formGone: true })
      await r.ev("form.created", twoFields)
      await r.tg.waitFor(() =>
        r.sends().find((b) => /How do we land/.test(b.text)),
      )
      const id = r.store.list()[0].id
      r.tap(`s:${id}:o1`)
      await r.tg.waitFor(() => r.edits().find((e) => /2\/2/.test(e.text)))
      r.tap(`s:${id}:o1`)
      await r.tg.waitFor(() =>
        r.edits().find((e) => /Review your answers/.test(e.text)),
      )
      r.tap(`s:${id}:ok`)
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

describe("forms: the stepper", () => {
  it("shows field 1 of 3 and answers all three with one reply after Submit", async () => {
    const r = await rig()
    const { m, id } = await asked(r)
    assert.match(m.text, /1\/3 · DB/)
    r.tap(`s:${id}:o2`)
    await r.tg.waitFor(() => r.edits().find((e) => /2\/3/.test(e.text)))
    r.tap(`s:${id}:t1`)
    r.tap(`s:${id}:t3`)
    await sleep(100)
    r.tap(`s:${id}:d`)
    await r.tg.waitFor(() => r.edits().find((e) => /3\/3/.test(e.text)))
    assert.equal(r.seen.forms.length, 0, "nothing before Submit")
    r.tap(`s:${id}:o1`)
    const review = await r.tg.waitFor(() =>
      r.edits().find((e) => /Review your answers/.test(e.text)),
    )
    assert.match(review.text, /mysql/)
    assert.equal(r.seen.forms.length, 0)
    r.tap(`s:${id}:ok`)
    await r.tg.waitFor(() => r.seen.forms[0])
    assert.deepEqual(r.seen.forms, [
      {
        formID: "frm_1",
        answer: { db: "mysql", tools: ["a", "c"], note: "none" },
      },
    ])
    await r.done()
  })

  it("an abandoned stepper sends nothing, and Cancel says so", async () => {
    const r = await rig()
    const { id } = await asked(r)
    r.tap(`s:${id}:o1`)
    await r.tg.waitFor(() => r.edits()[0])
    assert.equal(r.seen.forms.length, 0)
    r.tap(`s:${id}:x`)
    const c = await r.tg.waitFor(() =>
      r.edits().find((e) => /Cancelled here/.test(e.text)),
    )
    assert.deepEqual(c.reply_markup, { inline_keyboard: [] })
    assert.equal(r.seen.forms.length, 0)
    assert.equal(r.store.list()[0].state, "pending")
    await r.done()
  })

  it("✏️ asks for text, and the typed reply fills the field", async () => {
    const r = await rig()
    const { id } = await asked(r)
    const stepMsg = r.tg.lastMessageId
    r.tap(`s:${id}:o1`)
    r.tap(`s:${id}:t1`)
    await sleep(100)
    r.tap(`s:${id}:d`)
    await r.tg.waitFor(() => r.edits().find((e) => /3\/3/.test(e.text)))
    r.tap(`s:${id}:w`)
    await r.tg.waitFor(() =>
      r.sends().find((b) => /Type your answer for question 3/.test(b.text)),
    )
    r.tg.message(CHAT, "careful now", r.tg.lastMessageId, THREAD)
    await r.tg.waitFor(() =>
      r
        .edits()
        .find(
          (e) =>
            /Review your answers/.test(e.text) && /careful now/.test(e.text),
        ),
    )
    void stepMsg
    await r.done()
  })

  it("a form answered at the Mac while the stepper is open ends it, buttons gone", async () => {
    const r = await rig()
    await asked(r)
    await r.ev("form.replied", { id: "frm_1", sessionID: "root" })
    const e = await r.tg.waitFor(() =>
      r.edits().find((x) => /Answered/.test(x.text)),
    )
    assert.match(e.text, /Answered at the Mac/)
    assert.deepEqual(e.reply_markup, { inline_keyboard: [] })
    await r.done()
  })

  it("with no window open the card says to answer at the Mac and has no buttons", async () => {
    const r = await rig({ window: false })
    await r.ev("form.created", threeFields)
    const m = await r.tg.waitFor(() =>
      r.sends().find((b) => /Which db/.test(b.text)),
    )
    assert.match(m.text, /Answer this at the Mac/)
    assert.equal(m.reply_markup, undefined)
    await r.done()
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
