import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  Bridge,
  questionBody,
  toQuestions,
  type BridgeEvent,
  type Host,
  type SessionInfo,
} from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import type { Answer } from "./inbound.ts"
import { format } from "./messages.ts"
import {
  NtfyConnector,
  questionActions,
  replyHint,
  type Incoming,
  type Ntfy,
  type NtfyConfig,
  type Publish,
} from "./connectors/ntfy.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"

const cfg = (over: Record<string, unknown> = {}) =>
  parseConfig({
    server: "https://ntfy.example",
    topics: { out: "oc-out", in: "oc-in" },
    ...over,
  }) as Config

const sessions: Record<string, SessionInfo> = {
  root: {
    id: "root",
    agent: "coordinator",
    directory: "/w/shop",
    title: "Fix checkout",
  },
  child: {
    id: "child",
    parentID: "root",
    agent: "builder",
    directory: "/w/shop",
  },
}

function setup(over: Record<string, unknown> = {}) {
  let t = 1_700_000_000_000
  const now = () => t
  const c = cfg(over)
  const published: Publish[] = []
  const replies: Array<{ sessionID: string; formID: string; answer: Answer }> =
    []
  let replyError: Error | undefined
  let down = false
  const ntfy = {
    publish: async (p: Publish) => {
      if (down) return undefined
      published.push(p)
      return `m${published.length}`
    },
    subscribe: async () => {},
  } as unknown as Ntfy
  const host: Host = {
    session: async (id) => sessions[id],
    root: (id) => sessions[id]?.parentID ?? id,
    replyForm: async (sessionID, formID, answer) => {
      if (replyError) throw replyError
      replies.push({ sessionID, formID, answer })
    },
  }
  const router = new Router(c, async () => true, now)
  router.setAfk("on", Infinity)
  const store = new PendingStore()
  const channel = new NtfyConnector(
    "ntfy",
    ntfy,
    c.channels.ntfy.options as NtfyConfig,
  )
  const bridge = new Bridge(c, host, [channel], store, router, now)
  bridge.start()
  return {
    bridge,
    router,
    store,
    published,
    replies,
    advance: (ms: number) => (t += ms),
    now,
    failReplies: (e: Error) => (replyError = e),
    setDown: (v: boolean) => (down = v),
    inbound: (message: string, time = Math.floor(t / 1000)) =>
      channel.handle({ id: `in${time}`, time, message } satisfies Incoming),
  }
}

const form = (
  id: string,
  sessionID: string,
  fields: unknown[] = [
    {
      key: "q0",
      type: "string",
      title: "Deploy",
      description: "Deploy to staging now?",
      options: [
        { value: "Yes", label: "Yes" },
        { value: "No", label: "No" },
      ],
      custom: true,
    },
  ],
): BridgeEvent =>
  ({
    type: "form.created",
    data: {
      form: {
        id,
        sessionID,
        title: "Questions",
        metadata: { kind: "question" },
        fields,
      },
    },
  }) as BridgeEvent

describe("Bridge routing", () => {
  it("AC-1: /ntfy on pushes a question at once with title, buttons and hint", async () => {
    const s = setup()
    s.router.set("root", true)
    await s.bridge.onEvent(form("frm_1", "root"))
    assert.equal(s.published.length, 1)
    const p = s.published[0]
    assert.equal(p.title, "shop · coordinator asks")
    assert.equal(p.priority, 4)
    assert.match(p.message, /Fix checkout/)
    assert.match(p.message, /Deploy to staging now\?/)
    const id = s.store.list()[0].id
    assert.match(p.message, new RegExp(`#${id}`))
    assert.equal(p.actions?.length, 2)
    assert.deepEqual(JSON.parse(p.actions![1].body), { id, choice: 2 })
    assert.equal(p.actions![0].url, "https://ntfy.example/oc-in")
  })

  it("AC-2: away routes after idle minutes; input stops it", async () => {
    const s = setup({ away: { minutes: 10 } })
    s.router.setAfk("auto")
    await s.bridge.onEvent(form("frm_1", "root"))
    assert.equal(s.published.length, 0, "operator present")
    s.advance(10 * 60_000)
    await s.bridge.onEvent(form("frm_2", "root"))
    assert.equal(s.published.length, 1)
    await s.bridge.onEvent({
      type: "session.inbox.enqueued",
      data: { sessionID: "root", item: { type: "user" } },
    })
    await s.bridge.onEvent(form("frm_3", "root"))
    assert.equal(s.published.length, 1, "back at the keyboard")
  })

  it("AC-12: no stray update when the prompt's push never went out", async () => {
    const s = setup()
    s.router.set("root", true)
    s.setDown(true)
    await s.bridge.onEvent(form("frm_1", "root"))
    s.setDown(false)
    await s.bridge.onEvent({
      type: "form.replied",
      data: { id: "frm_1", sessionID: "root" },
    })
    assert.equal(s.published.length, 0)
    assert.equal(s.store.list()[0].state, "answered")
  })

  it("AC-2: a prompt answered in the TUI marks the push", async () => {
    const s = setup()
    s.router.set("root", true)
    await s.bridge.onEvent(form("frm_1", "root"))
    await s.bridge.onEvent({
      type: "form.replied",
      data: { id: "frm_1", sessionID: "root" },
    })
    const u = s.published[1]
    assert.equal(u.sequence_id, "m1")
    assert.match(u.message, /Answered in the TUI/)
    assert.equal(s.store.list()[0].answeredBy, "tui")
  })

  it("AC-3: rules pick which sessions route while away", async () => {
    const s = setup({ rules: [{ directory: "**/other" }] })
    s.advance(11 * 60_000)
    await s.bridge.onEvent(form("frm_1", "root"))
    assert.equal(s.published.length, 0)
    const t = setup({ rules: [{ agent: "^coordinator$" }] })
    t.advance(11 * 60_000)
    await t.bridge.onEvent(form("frm_1", "root"))
    assert.equal(t.published.length, 1)
  })

  it("AC-4: a subagent question routes by its top-level session and carries an agent tag", async () => {
    const s = setup()
    s.router.set("root", true)
    await s.bridge.onEvent(form("frm_1", "child"))
    const p = s.published[0]
    assert.equal(p.title, "shop · builder asks")
    assert.deepEqual(p.tags, ["question", "builder"])
    assert.match(p.message, /Fix checkout/)
    assert.equal(s.store.list()[0].rootSessionID, "root")
  })

  it("ignores forms that are not questions", async () => {
    const s = setup()
    s.router.set("root", true)
    await s.bridge.onEvent({
      type: "form.created",
      data: {
        form: {
          id: "f",
          sessionID: "root",
          metadata: { kind: "oauth" },
          fields: [],
        },
      },
    })
    assert.equal(s.published.length, 0)
  })
})

describe("Bridge outbound", () => {
  it("AC-5: redacts and filters the body; >3 options become a numbered list", async () => {
    const s = setup({ redact: "head:40" })
    s.router.set("root", true)
    const options = ["a", "b", "c", "d"].map((v) => ({ value: v, label: v }))
    await s.bridge.onEvent(
      form("frm_1", "root", [
        {
          key: "q0",
          type: "string",
          title: "Pick",
          description:
            "Use password=hunter22 to pick one of these long options",
          options,
        },
      ]),
    )
    const p = s.published[0]
    assert.equal(p.actions, undefined)
    assert.doesNotMatch(p.message, /hunter22/)
    assert.match(p.message, /…/)
    assert.match(
      p.message,
      /Reply by number: post `#\w{4} <n or text>` to topic oc-in/,
    )
  })

  it("reads the OpenCode 2.3 option shape (value, label, description) and other shapes", () => {
    const real = toQuestions([
      {
        key: "q0",
        title: "ntfy test",
        description: "Which fix first?",
        type: "string",
        options: [
          { value: "Read cap", label: "Read cap", description: "Cap reads" },
          { value: "Nothing", label: "Nothing" },
        ],
        custom: true,
      },
    ])
    assert.deepEqual(real[0].options, ["Read cap", "Nothing"])
    assert.deepEqual(real[0].details, ["Cap reads", ""])
    const other = toQuestions([
      { key: "a", type: "select", choices: ["x", { title: "y", detail: "d" }] },
      { key: "b", enum: [{ name: "n" }, { value: "v" }], multiple: true },
    ])
    assert.deepEqual(
      other.map((q) => q.options),
      [
        ["x", "y"],
        ["n", "v"],
      ],
    )
    assert.equal(other[0].details![1], "d")
    assert.equal(other[1].multiple, true)
  })

  it("renders a numbered option list, short buttons and a one-line hint", () => {
    const qs = toQuestions([
      {
        key: "q0",
        type: "string",
        title: "Fixes",
        description: "Which context fixes should I apply first?",
        options: [
          {
            value: "Read cap + prefix trim (Recommended)",
            label: "Read cap + prefix trim (Recommended)",
            description:
              "Cap file reads at 2000 lines and trim the repeated prefix of every tool result",
          },
          { value: "Also compaction tuning", label: "Also compaction tuning" },
          { value: "Nothing yet", label: "Nothing yet", description: "Wait" },
        ],
      },
    ])
    const id = "ab12"
    const message = format("question", {
      thread: "[A very long session title that keeps go…]\n",
      body: questionBody(qs),
      hint: replyHint(id, qs, "oc-in"),
    }).message
    const actions = questionActions("https://ntfy.example", "oc-in", id, qs)
    assert.equal(
      message,
      [
        "[A very long session title that keeps go…]",
        "Which context fixes should I apply first?",
        "1. Read cap + prefix trim (Recommended) — Cap file reads at 2000 lines and trim the repeated prefix o…",
        "2. Also compaction tuning",
        "3. Nothing yet — Wait",
        "",
        "Tap a button, or post `#ab12 <n or text>` to topic oc-in",
      ].join("\n"),
    )
    assert.deepEqual(
      actions!.map((a) => a.label),
      ["Read cap + prefix trim…", "Also compaction tuning", "Nothing yet"],
    )
    assert.ok(actions!.every((a) => a.label.length <= 24))
  })

  it("AC-5: title redaction hides the question", async () => {
    const s = setup({ redact: "title" })
    s.router.set("root", true)
    await s.bridge.onEvent(form("frm_1", "root"))
    assert.doesNotMatch(s.published[0].message, /staging/)
  })

  it("AC-6: finished and failed top-level sessions send one low-priority push", async () => {
    const s = setup()
    s.router.set("root", true)
    await s.bridge.onEvent({
      type: "session.execution.succeeded",
      data: { sessionID: "root" },
    })
    await s.bridge.onEvent({
      type: "session.execution.failed",
      data: { sessionID: "root" },
    })
    await s.bridge.onEvent({
      type: "session.execution.succeeded",
      data: { sessionID: "child" },
    })
    assert.equal(s.published.length, 2)
    assert.equal(s.published[0].priority, 2)
    assert.match(s.published[0].title!, /finished/)
    assert.match(s.published[1].title!, /failed/)
  })
})

describe("Bridge inbound", () => {
  it("AC-7: a button tap or text reply answers the form", async () => {
    const s = setup()
    s.router.set("root", true)
    await s.bridge.onEvent(form("frm_1", "root"))
    const id = s.store.list()[0].id
    await s.inbound(JSON.stringify({ id, choice: 1 }))
    assert.deepEqual(s.replies, [
      { sessionID: "root", formID: "frm_1", answer: { q0: "Yes" } },
    ])
    assert.match(s.published.at(-1)!.message, /Answered from ntfy: Yes/)
    assert.equal(s.published.at(-1)!.sequence_id, "m1")

    await s.bridge.onEvent(form("frm_2", "child"))
    const id2 = s.store.byRequest("frm_2")!.id
    await s.inbound(`#${id2} ship it tomorrow`)
    assert.deepEqual(s.replies[1], {
      sessionID: "child",
      formID: "frm_2",
      answer: { q0: "ship it tomorrow" },
    })
  })

  it("AC-8: first answer wins; later, unknown and unreadable replies get a push", async () => {
    const s = setup()
    s.router.set("root", true)
    await s.bridge.onEvent(form("frm_1", "root"))
    const id = s.store.list()[0].id
    await s.bridge.onEvent({
      type: "form.replied",
      data: { id: "frm_1", sessionID: "root" },
    })
    s.advance(5000)
    await s.inbound(`#${id} 1`)
    assert.equal(s.replies.length, 0)
    assert.match(s.published.at(-1)!.message, /already answered/)

    await s.inbound("#zzzz 1")
    assert.match(s.published.at(-1)!.message, /unknown or expired/)

    await s.bridge.onEvent(
      form("frm_2", "root", [
        {
          key: "q0",
          type: "string",
          description: "?",
          options: [{ label: "A" }],
          custom: false,
        },
      ]),
    )
    const id2 = s.store.byRequest("frm_2")!.id
    await s.inbound(`#${id2} B`)
    assert.match(s.published.at(-1)!.message, /could not read/)
    assert.equal(s.store.get(id2)!.state, "pending")
  })

  it("AC-8: the phone answer wins over a later TUI event, and replays are silent", async () => {
    const s = setup()
    s.router.set("root", true)
    await s.bridge.onEvent(form("frm_1", "root"))
    const id = s.store.list()[0].id
    await s.inbound(`#${id} 2`)
    const count = s.published.length
    await s.bridge.onEvent({
      type: "form.replied",
      data: { id: "frm_1", sessionID: "root" },
    })
    await s.inbound(`#${id} 2`, Math.floor(s.now() / 1000) - 1)
    assert.equal(s.published.length, count, "no update for own echo or replay")
    assert.equal(s.replies.length, 1)
  })

  it("AC-8: a reply the server refuses is reported and not retried", async () => {
    const s = setup()
    s.router.set("root", true)
    await s.bridge.onEvent(form("frm_1", "root"))
    const id = s.store.list()[0].id
    s.failReplies(new Error("form not pending"))
    await s.inbound(`#${id} 1`)
    assert.match(s.published.at(-1)!.message, /not applied/)
    assert.equal(s.store.get(id)!.state, "failed")
  })

  it("expires prompts after a day", async () => {
    const s = setup()
    s.router.set("root", true)
    await s.bridge.onEvent(form("frm_1", "root"))
    const id = s.store.list()[0].id
    s.advance(25 * 3600_000)
    await s.inbound(`#${id} 1`)
    assert.equal(s.replies.length, 0)
    assert.match(s.published.at(-1)!.message, /expired/)
  })
})

describe("Bridge permissions (tier 3)", () => {
  it("AC-9: pushes with a hint and never applies a reply", async () => {
    const s = setup()
    s.router.set("root", true)
    await s.bridge.onEvent({
      type: "permission.asked",
      data: {
        id: "per_1",
        sessionID: "child",
        action: "bash",
        resources: ["rm -rf build"],
      },
    })
    const p = s.published[0]
    assert.equal(p.title, "shop · builder needs permission")
    assert.match(p.message, /bash: rm -rf build/)
    assert.match(p.message, /Answer in the OpenCode TUI/)
    assert.equal(p.actions, undefined)
    const id = s.store.list()[0].id
    await s.inbound(`#${id} 1`)
    await s.inbound(JSON.stringify({ id, choice: 1 }))
    assert.equal(s.replies.length, 0)
    assert.match(
      s.published.at(-1)!.message,
      /only be answered in the OpenCode TUI/,
    )
    assert.equal(s.store.get(id)!.state, "pending")

    await s.bridge.onEvent({
      type: "permission.replied",
      data: { requestID: "per_1", sessionID: "child" },
    })
    assert.match(s.published.at(-1)!.message, /Answered in the TUI/)
  })
})
