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
    device: over.device,
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

  it("opens a session named with the s_ prefix, and still a bare id", async () => {
    const a = rig({ start: "s_s1" })
    await a.ctl.boot()
    assert.deepEqual(a.ctl.state.route, { name: "session", id: "s1" })
    assert.ok(a.calls.includes("session:s1"))
  })

  it("opens the enrolment screen with the scanned code, and does not act on it", async () => {
    const r = rig({ start: "enrol_ABCD2345" })
    await r.ctl.boot()
    assert.equal(r.ctl.state.route.name, "enroll")
    assert.equal(r.ctl.state.enrolCode, "ABCD2345")
    assert.ok(!r.calls.some((c) => c.startsWith("enrol")))
    assert.equal(r.ctl.canAct(), true)
  })

  it("falls back to the list for a start parameter it cannot read, with no toast", async () => {
    const r = rig({ start: "enrol_" })
    await r.ctl.boot()
    assert.equal(r.ctl.state.route.name, "list")
    assert.equal(r.ctl.state.toast, undefined)
  })

  it("goes back to the list when the named session is gone", async () => {
    for (const status of [404, 400]) {
      const r = rig({
        start: "s_gone",
        session: async () => {
          throw err(status)
        },
      })
      await r.ctl.boot()
      assert.equal(r.ctl.state.route.name, "list")
      assert.equal(r.ctl.state.toast.ok, false)
    }
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

describe("second factor of an approval", () => {
  const view = (over = {}) => ({
    id: "A1",
    short: "ab12",
    caller: "tool",
    action_class: "secrets.write",
    scope: "item 4f2a",
    request_hash: "h",
    challenge: "c1",
    factors: ["biometric", "passkey", "totp"],
    ...over,
  })
  const device = (support, over = {}) => ({
    support: async () => support,
    biometricProof: async () => ({ device: "dD", proof: "p" }),
    passkeyProof: async () => ({ credential: { id: "x" } }),
    ...over,
  })

  it("opens from a start parameter on the first factor this phone can use, in the bridge's order", async () => {
    const r = rig({
      start: "a_A1",
      approval: async () => view(),
      device: device({ biometric: true, passkey: true }),
    })
    await r.ctl.boot()
    const a = r.ctl.state.approval
    assert.equal(r.ctl.state.route.name, "approval")
    assert.deepEqual(a.factors, ["biometric", "passkey", "totp"])
    assert.equal(a.factors[a.index], "biometric")
    r.ctl.useAnother()
    assert.equal(
      r.ctl.state.approval.factors[r.ctl.state.approval.index],
      "passkey",
    )
    r.ctl.useAnother()
    r.ctl.useAnother()
    assert.equal(r.ctl.state.approval.index, 0)
  })

  it("skips what the phone cannot do and ends at the code", async () => {
    const r = rig({
      approval: async () => view(),
      device: device({ biometric: false, passkey: false }),
    })
    await r.ctl.openApproval("A1")
    assert.deepEqual(r.ctl.state.approval.factors, ["totp"])
  })

  it("keeps the code out when the bridge does not offer it", async () => {
    const r = rig({
      approval: async () => view({ factors: ["biometric"] }),
      device: device({ biometric: false }),
    })
    await r.ctl.openApproval("A1")
    assert.deepEqual(r.ctl.state.approval.factors, [])
  })

  it("sends the proof of the factor on screen and shows it done", async () => {
    const sent = []
    const r = rig({
      approval: async () => view(),
      approvalProof: async (id, b) => (
        sent.push([id, b]), { ok: true, text: "Approved." }
      ),
      device: device({ biometric: true }),
    })
    await r.ctl.openApproval("A1")
    await r.ctl.verify()
    assert.deepEqual(sent, [
      [
        "A1",
        { factor: "biometric", challenge: "c1", device: "dD", proof: "p" },
      ],
    ])
    assert.equal(r.ctl.state.approval.done, true)
    assert.equal(r.ctl.state.approval.text, "Approved.")
  })

  it("falls back to the code: another method, then a typed code", async () => {
    const sent = []
    const r = rig({
      approval: async () => view(),
      approvalProof: async (id, b) => (
        sent.push(b), { ok: true, text: "Approved." }
      ),
      device: device({ biometric: true }),
    })
    await r.ctl.openApproval("A1")
    r.ctl.useAnother()
    await r.ctl.verify("12")
    assert.match(r.ctl.state.approval.text, /6 digits/)
    assert.equal(sent.length, 0)
    await r.ctl.verify("123456")
    assert.deepEqual(sent, [{ factor: "totp", code: "123456" }])
  })

  it("asks for a new challenge after a wrong proof, and stops when the bridge denied", async () => {
    let n = 0
    const r = rig({
      approval: async () => view({ challenge: "c" + ++n }),
      approvalProof: async () => ({ ok: false, text: "Wrong: 2 left." }),
      device: device({ biometric: true }),
    })
    await r.ctl.openApproval("A1")
    await r.ctl.verify()
    assert.equal(r.ctl.state.approval.view.challenge, "c2")
    assert.equal(r.ctl.state.approval.text, "Wrong: 2 left.")
    assert.equal(r.ctl.state.approval.busy, false)
    const d = rig({
      approval: async () => view(),
      approvalProof: async () => ({
        ok: false,
        text: "Denied.",
        state: "denied",
      }),
      device: device({ biometric: true }),
    })
    await d.ctl.openApproval("A1")
    await d.ctl.verify()
    assert.equal(d.ctl.state.approval.done, true)
    assert.equal(d.ctl.state.approval.ok, false)
  })

  it("reports a refused Face ID without calling the bridge", async () => {
    const sent = []
    const r = rig({
      approval: async () => view(),
      approvalProof: async (id, b) => (sent.push(b), { ok: true }),
      device: device(
        { biometric: true },
        {
          biometricProof: async () => ({
            error: "Face ID did not release the secret.",
          }),
        },
      ),
    })
    await r.ctl.openApproval("A1")
    await r.ctl.verify()
    assert.equal(sent.length, 0)
    assert.match(r.ctl.state.approval.text, /Face ID/)
  })

  it("says so when the request is not waiting any more", async () => {
    const r = rig({
      approval: async () => {
        throw err(404)
      },
      device: device({}),
    })
    await r.ctl.openApproval("A1")
    assert.equal(r.ctl.state.approval.gone, true)
  })
})

describe("enrolling this phone", () => {
  const dev = (over = {}) => ({
    prepareBiometric: async () => ({}),
    saveToken: async () => true,
    createPasskey: async () => ({ credential: { id: "k" } }),
    ...over,
  })

  it("asks Telegram for Face ID before spending the code, then keeps the token", async () => {
    const order = []
    const r = rig({
      enrol: async () => (
        order.push("enrol"), { ok: true, device: "dD", token: "dD.s" }
      ),
      device: dev({
        prepareBiometric: async () => (order.push("prepare"), {}),
        saveToken: async (t) => (order.push("save:" + t), true),
      }),
    })
    await r.ctl.enroll("biometric", "ABCD-EFGH")
    assert.deepEqual(order, ["prepare", "enrol", "save:dD.s"])
    assert.equal(r.ctl.state.enrol.ok, true)
  })

  it("does not spend the code when Face ID is refused", async () => {
    const r = rig({
      enrol: async () => assert.fail("spent"),
      device: dev({ prepareBiometric: async () => ({ error: "No Face ID." }) }),
    })
    await r.ctl.enroll("biometric", "X")
    assert.equal(r.ctl.state.enrol.text, "No Face ID.")
  })

  it("names the device to revoke when Telegram did not keep the token", async () => {
    const r = rig({
      enrol: async () => ({ ok: true, device: "dD", token: "dD.s" }),
      device: dev({ saveToken: async () => false }),
    })
    await r.ctl.enroll("biometric", "X")
    assert.match(r.ctl.state.enrol.text, /Revoke dD/)
    assert.notEqual(r.ctl.state.enrol.ok, true)
  })

  it("enrols a passkey in two calls", async () => {
    const calls = []
    const r = rig({
      enrol: async (b) => (
        calls.push(b),
        b.credential
          ? { ok: true }
          : { ok: true, challenge: "ch", rp: {}, user: {} }
      ),
      device: dev(),
    })
    await r.ctl.enroll("passkey", "X")
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].credential, { id: "k" })
    assert.equal(r.ctl.state.enrol.ok, true)
  })

  it("shows the bridge's refusal of a wrong code", async () => {
    const r = rig({
      enrol: async () => ({ ok: false, text: "That code is not right." }),
      device: dev(),
    })
    await r.ctl.enroll("passkey", "X")
    assert.equal(r.ctl.state.enrol.text, "That code is not right.")
  })
})

describe("refusals and what does not need the stream", () => {
  it("keeps the bridge's reason when it refuses, and shows it instead of 'expired'", async () => {
    const r = rig({
      meta: async () => {
        throw new ApiError(401, "x", "no_operator")
      },
    })
    await r.ctl.boot()
    assert.equal(r.ctl.state.phase, "expired")
    assert.equal(r.ctl.state.reason, "no_operator")
    const f = rig({
      meta: async () => {
        throw new ApiError(403, "x", "not_operator")
      },
    })
    await f.ctl.boot()
    assert.equal(f.ctl.state.phase, "forbidden")
    assert.equal(f.ctl.state.reason, "not_operator")
  })

  it("keeps the reason when the stream is the one refused", async () => {
    const r = rig()
    await r.ctl.boot()
    r.hooks().onState("down", "expired", "too_old")
    assert.equal(r.ctl.state.phase, "expired")
    assert.equal(r.ctl.state.reason, "too_old")
  })

  it("lets approvals and enrolment act while the stream is down, and nothing else", async () => {
    const r = rig()
    await r.ctl.boot()
    assert.equal(r.ctl.state.conn, "connecting")
    assert.equal(r.ctl.canAct(), false)
    await r.ctl.go("enroll")
    assert.equal(r.ctl.canAct(), true)
    await r.ctl.go("info")
    assert.equal(r.ctl.canAct(), false)
    r.hooks().onState("down")
    await r.ctl.openApproval("01ARZ3NDEKTSV4RRFFQ69G5FAV")
    assert.equal(r.ctl.canAct(), true)
    await r.ctl.go("list")
    assert.equal(r.ctl.canAct(), false)
  })
})
