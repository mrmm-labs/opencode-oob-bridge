import assert from "node:assert/strict"
import { describe, it } from "node:test"

class El {
  constructor(tag) {
    this.tag = tag
    this.attrs = {}
    this.kids = []
    this.style = { setProperty() {} }
    this.listeners = {}
  }
  setAttribute(k, v) {
    this.attrs[k] = v
  }
  addEventListener(k, fn) {
    this.listeners[k] = fn
  }
  append(...k) {
    this.kids.push(...k)
  }
  focus() {}
  text() {
    return this.kids
      .map((k) => (k instanceof El ? k.text() : String(k)))
      .join(" ")
  }
  find(tag, label) {
    const out = []
    const walk = (e) => {
      if (e.tag === tag && (!label || e.text() === label)) out.push(e)
      for (const k of e.kids) if (k instanceof El) walk(k)
    }
    walk(this)
    return out
  }
}
globalThis.document = {
  createElement: (t) => new El(t),
  createElementNS: (_ns, t) => new El(t),
}
const { render } = await import("./views.js")

const ctl = { build: "x", go() {}, enroll() {}, canAct: () => true }
const state = (enrol) => ({
  phase: "ready",
  conn: "live",
  route: { name: "enroll" },
  sessions: [],
  status: { pending: 0, channels: [] },
  meta: {},
  enrol,
})

describe("the enrol screen", () => {
  it("offers Face ID and Passkey before anything is done", () => {
    const v = render(state(undefined), ctl, 1000)
    assert.equal(v.find("button", "Face ID").length, 1)
    assert.equal(v.find("button", "Passkey").length, 1)
  })

  it("after success it shows the confirmation and the device, and offers neither button", () => {
    const e = {
      busy: false,
      ok: true,
      kind: "biometric",
      device: "dD",
      text: "✅ This phone is set up for Face ID",
    }
    const v = render(state(e), ctl, 1000)
    const t = v.text()
    assert.match(t, /✅ This phone is set up for Face ID/)
    assert.match(t, /dD/)
    assert.equal(v.find("button", "Face ID").length, 0)
    assert.equal(v.find("button", "Passkey").length, 0)
    assert.equal(v.find("button", "Done").length, 1)
  })

  it("a refusal keeps the form and shows the reason", () => {
    const v = render(
      state({ busy: false, ok: false, text: "That code is not right." }),
      ctl,
      1000,
    )
    assert.match(v.text(), /That code is not right/)
    assert.equal(v.find("button", "Face ID").length, 1)
  })
})
describe("the approval screen", () => {
  const screen = (level, factors) =>
    render(
      {
        ...state(undefined),
        route: { name: "approval", id: "A1" },
        approval: {
          id: "A1",
          index: 0,
          factors,
          view: {
            short: "ab12",
            caller: "secrets-tool",
            action_class: "secrets.write",
            scope: "item 4f2a",
            level,
            expires_at: "2026-11-22T12:00:00.000Z",
          },
        },
      },
      { ...ctl, decide() {}, verify() {}, useAnother() {} },
      1000,
    )

  it("shows who asks, what, the level, the expiry and where the value stays", () => {
    const t = screen(2, ["biometric"]).text()
    assert.match(t, /Who asks\s+secrets-tool/)
    assert.match(t, /What\s+item 4f2a/)
    assert.match(t, /Level\s+L2/)
    assert.match(t, /Expires\s+\d/)
    assert.match(t, /never goes to Telegram or the AI/)
  })

  it("a level 2 request is approved with the factor, and can be denied", () => {
    const v = screen(2, ["biometric", "totp"])
    assert.equal(v.find("button", "Approve with Face ID").length, 1)
    assert.equal(v.find("button", "Approve").length, 0)
    assert.equal(v.find("button", "Deny").length, 1)
  })

  it("a level 1 request is approved with one button, and can be denied", () => {
    const v = screen(1, [])
    assert.equal(v.find("button", "Approve").length, 1)
    assert.equal(v.find("button", "Deny").length, 1)
  })

  it("a level 2 request nothing can prove can still be denied", () => {
    const v = screen(2, [])
    assert.match(v.text(), /Answer at the Mac/)
    assert.equal(v.find("button", "Deny").length, 1)
  })
})
