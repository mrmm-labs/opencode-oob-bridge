import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ApiError } from "./api.js"
import { createController } from "./controller.js"
import * as F from "./form.js"

const detail = (over = {}) => ({
  id: "s1",
  title: "T",
  state: "working",
  pending: 0,
  watch: { mode: "auto" },
  tail: { value: [{ role: "user", text: "hi", at: 1 }], source: "server" },
  todos: { unavailable: "no source" },
  diff: { unavailable: "no source" },
  canAnswer: true,
  questions: [],
  permissions: [],
  ...over,
})

function rig(over = {}) {
  const calls = []
  const rec =
    (name, v) =>
    async (...a) => {
      calls.push(name + (a.length ? ":" + a.join(",") : ""))
      const r = typeof v === "function" ? v(...a) : v
      if (r instanceof Error) throw r
      return r
    }
  const api = {
    initData: "init",
    meta: rec("meta", { version: "1", actions: [], permissions: "off" }),
    status: rec("status", { pending: 0, channels: [] }),
    options: rec("options", { models: [], agents: [], projects: [] }),
    sessions: rec("sessions", {
      sessions: [{ id: "s1", state: "working", pending: 0 }],
      total: 1,
    }),
    session: rec("session", detail()),
    action: rec("action", { ok: true, text: "Done it." }),
    create: rec("create", { ok: true, text: "Started", id: "s9" }),
    endNight: rec("endNight", { ok: true, text: "Ended." }),
    digest: rec("digest", { enabled: true, text: "x" }),
    messages: rec("messages", { value: [] }),
    patch: rec("patch", "+a"),
    ...over,
  }
  let hooks
  const stops = []
  const ctl = createController({
    api,
    now: () => 1000,
    start: over.start,
    makeStream: (h) => (
      (hooks = h), { start() {}, stop: () => stops.push("stop") }
    ),
  })
  return { ctl, api, calls, hooks: () => hooks, stops }
}

const live = (r) => r.hooks().onState("live")
const err = (status) => new ApiError(status, "x")

describe("start", () => {
  it("says to open from Telegram when there is no init data, and asks the API nothing", async () => {
    const r = rig({ initData: "" })
    await r.ctl.boot()
    assert.equal(r.ctl.state.phase, "nolaunch")
    assert.deepEqual(r.calls, [])
  })

  it("loads nothing for another user", async () => {
    const r = rig({
      meta: async () => {
        throw err(403)
      },
    })
    await r.ctl.boot()
    assert.equal(r.ctl.state.phase, "forbidden")
    assert.deepEqual(r.ctl.state.sessions, [])
    assert.deepEqual(r.calls, [])
  })

  it("asks to reopen when the init data has expired, and when the Mac is offline", async () => {
    const a = rig({
      meta: async () => {
        throw err(401)
      },
    })
    await a.ctl.boot()
    assert.equal(a.ctl.state.phase, "expired")
    const b = rig({
      meta: async () => {
        throw err(503)
      },
    })
    await b.ctl.boot()
    assert.equal(b.ctl.state.phase, "offline")
  })

  it("lists the sessions and opens the one named in the start parameter", async () => {
    const r = rig({ start: "s1" })
    await r.ctl.boot()
    assert.equal(r.ctl.state.phase, "ready")
    assert.equal(r.ctl.state.sessions.length, 1)
    assert.deepEqual(r.ctl.state.route, { name: "session", id: "s1" })
    assert.equal(r.ctl.state.detail.id, "s1")
  })

  it("goes back to the list when the named session is gone", async () => {
    const r = rig({
      start: "gone",
      session: async () => {
        throw err(404)
      },
    })
    await r.ctl.boot()
    assert.equal(r.ctl.state.route.name, "list")
    assert.equal(r.ctl.state.toast.ok, false)
  })
})

describe("live updates and the disconnected state", () => {
  it("cannot act until the stream is live, and cannot again once it drops", async () => {
    const r = rig()
    await r.ctl.boot()
    assert.equal(r.ctl.state.conn, "connecting")
    assert.equal(r.ctl.canAct(), false)
    await r.ctl.act("stop", {}, "s1")
    assert.equal(
      r.calls.some((c) => c.startsWith("action")),
      false,
    )
    live(r)
    assert.equal(r.ctl.canAct(), true)
    r.hooks().onState("down")
    assert.equal(r.ctl.state.conn, "down")
    assert.equal(r.ctl.canAct(), false)
    r.ctl.ask("stop", "s1")
    assert.equal(r.ctl.state.confirm, undefined)
    live(r)
    assert.equal(r.ctl.canAct(), true)
  })

  it("keeps the time of the last update and takes a snapshot event as the list", async () => {
    const r = rig()
    await r.ctl.boot()
    assert.equal(r.ctl.state.updatedAt, 1000)
    r.hooks().onEvent({
      type: "snapshot",
      data: { sessions: [{ id: "n" }], total: 1 },
    })
    assert.deepEqual(r.ctl.state.sessions, [{ id: "n" }])
  })

  it("refreshes after an event, once for a burst", async () => {
    const r = rig()
    await r.ctl.boot()
    const before = r.calls.filter((c) => c === "sessions").length
    for (let i = 0; i < 5; i++)
      r.hooks().onEvent({ type: "session.idle", id: i })
    await new Promise((ok) => setTimeout(ok, 450))
    assert.equal(r.calls.filter((c) => c === "sessions").length, before + 1)
    r.ctl.stop()
  })

  it("shows the expired state when the stream says so", async () => {
    const r = rig()
    await r.ctl.boot()
    r.hooks().onState("down", "expired")
    assert.equal(r.ctl.state.phase, "expired")
  })
})

describe("actions", () => {
  it("asks before stop, undo and resume, and does nothing on cancel", async () => {
    for (const kind of ["stop", "undo", "resume"]) {
      const r = rig()
      await r.ctl.boot()
      live(r)
      await r.ctl.open("s1")
      r.ctl.ask(kind)
      assert.equal(r.ctl.state.confirm.kind, kind)
      assert.equal(
        r.calls.some((c) => c.startsWith("action")),
        false,
        "nothing before the answer",
      )
      r.ctl.cancel()
      await r.ctl.confirmed()
      assert.equal(
        r.calls.some((c) => c.startsWith("action")),
        false,
      )
      r.ctl.ask(kind)
      await r.ctl.confirmed()
      assert.ok(r.calls.includes("action:s1," + kind + ",[object Object]"))
      assert.equal(r.ctl.state.toast.text, "Done it.")
    }
  })

  it("shows the core's refusal as it is", async () => {
    const r = rig({
      action: async () => ({
        ok: false,
        text: "Blocked by chat.deny (agent x).",
      }),
    })
    await r.ctl.boot()
    live(r)
    await r.ctl.open("s1")
    await r.ctl.act("compact")
    assert.deepEqual(r.ctl.state.toast, {
      text: "Blocked by chat.deny (agent x).",
      ok: false,
      at: 1000,
    })
  })

  it("ends the overnight plan only after the confirmation", async () => {
    const r = rig()
    await r.ctl.boot()
    live(r)
    r.ctl.ask("endNight")
    assert.equal(r.calls.includes("endNight"), false)
    await r.ctl.confirmed()
    assert.equal(r.calls.includes("endNight"), true)
  })

  it("starts a session and opens it", async () => {
    const r = rig()
    await r.ctl.boot()
    live(r)
    await r.ctl.create({ project: "shop", text: "go" })
    assert.deepEqual(r.ctl.state.route, { name: "session", id: "s9" })
  })

  it("sends a permission decision as the prompt id and the decision", async () => {
    const r = rig()
    await r.ctl.boot()
    live(r)
    await r.ctl.open("s1")
    await r.ctl.permission("p1", "once")
    assert.ok(r.calls.includes("action:s1,permission,[object Object]"))
  })
})

describe("forms", () => {
  const item = (key, options, o = {}) => ({
    key,
    header: key,
    text: key + "?",
    options,
    multiple: false,
    custom: false,
    ...o,
  })
  const prompt = (items) => ({ id: "q1", title: "Q", askedAt: 1, items })

  it("sends a single-select field at the tap", async () => {
    const sent = []
    const r = rig({
      action: async (...a) => (sent.push(a), { ok: true, text: "ok" }),
    })
    await r.ctl.boot()
    live(r)
    await r.ctl.open("s1")
    const q = prompt([item("a", ["Yes", "No"])])
    await r.ctl.step(q, F.pick, "No")
    assert.deepEqual(sent, [
      ["s1", "answer", { prompt: "q1", answers: { a: "No" } }],
    ])
  })

  it("sends nothing for a three-field form until Submit, then one reply", async () => {
    const sent = []
    const r = rig({
      action: async (...a) => (sent.push(a), { ok: true, text: "ok" }),
    })
    await r.ctl.boot()
    live(r)
    await r.ctl.open("s1")
    const q = prompt([item("a", ["x"]), item("b", ["y"]), item("c", ["z"])])
    await r.ctl.step(q, F.pick, "x")
    await r.ctl.step(q, F.pick, "y")
    assert.equal(sent.length, 0)
    await r.ctl.step(q, F.pick, "z")
    assert.equal(sent.length, 0, "the review step comes first")
    assert.equal(F.reviewing(r.ctl.form(q)), true)
    await r.ctl.submit(q)
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0][2].answers, { a: "x", b: "y", c: "z" })
    assert.equal(r.ctl.state.forms.q1, undefined)
  })

  it("sends nothing when the form is abandoned or cancelled", async () => {
    const sent = []
    const r = rig({
      action: async (...a) => (sent.push(a), { ok: true, text: "ok" }),
    })
    await r.ctl.boot()
    live(r)
    await r.ctl.open("s1")
    const q = prompt([item("a", ["x"]), item("b", ["y"])])
    await r.ctl.step(q, F.pick, "x")
    r.ctl.cancelForm(q)
    await r.ctl.submit(q)
    assert.equal(sent.length, 0)
  })
})
