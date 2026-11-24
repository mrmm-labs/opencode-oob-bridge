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
  buttons(label) {
    const out = []
    const walk = (e) => {
      if (e.tag === "button" && e.text() === label) out.push(e)
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

const screen = (o = {}, ctl = {}) => {
  const acts = []
  const view = render(
    {
      phase: "ready",
      conn: "live",
      route: { name: "session", id: "s1" },
      sessions: [],
      status: { pending: 0, channels: [] },
      meta: o.meta ?? {},
      older: [],
      detail: {
        id: "s1",
        title: "Fix",
        state: "idle",
        pending: 0,
        stuck: false,
        chat: true,
        watch: { mode: "auto" },
        questions: [],
        permissions: [],
        tail: { unavailable: "x" },
        diff: { unavailable: "x" },
        todos: { unavailable: "x" },
        ...o.detail,
      },
    },
    {
      canAct: () => true,
      act: (...a) => acts.push(a),
      ask() {},
      go() {},
      send() {},
      ...ctl,
    },
    1000,
  )
  return { view, acts }
}

describe("the QA and Update actions of the session screen", () => {
  it("are shown with chat on, and a tap runs the action on the action endpoint", () => {
    const { view, acts } = screen()
    const qa = view.buttons("QA")
    const update = view.buttons("Update")
    assert.equal(qa.length, 1)
    assert.equal(update.length, 1)
    qa[0].listeners.click()
    update[0].listeners.click()
    assert.deepEqual(acts, [["qa"], ["update"]])
  })

  it("are left out with chat off", () => {
    const { view } = screen({ detail: { chat: false } })
    assert.equal(view.buttons("QA").length, 0)
    assert.equal(view.buttons("Update").length, 0)
  })

  it("are disabled for a blocked session, when the bridge says they are off, and when nothing can act", () => {
    const blocked = screen({ detail: { blocked: "directory" } })
    assert.ok("disabled" in blocked.view.buttons("QA")[0].attrs)
    const off = screen({
      meta: { actions: [{ name: "update", available: false, reason: "no" }] },
    })
    assert.ok("disabled" in off.view.buttons("Update")[0].attrs)
    assert.ok(!("disabled" in off.view.buttons("QA")[0].attrs))
    const idle = screen({}, { canAct: () => false })
    assert.ok("disabled" in idle.view.buttons("QA")[0].attrs)
  })
})
