import assert from "node:assert/strict"
import { describe, it } from "node:test"

class El {
  constructor(tag) {
    this.tag = tag
    this.attrs = {}
    this.kids = []
    this.style = { setProperty() {} }
  }
  setAttribute(k, v) {
    this.attrs[k] = v
  }
  addEventListener() {}
  append(...k) {
    this.kids.push(...k)
  }
  focus() {}
  text() {
    return this.kids
      .map((k) => (k instanceof El ? k.text() : String(k)))
      .join(" ")
  }
  all(tag) {
    const out = []
    const walk = (e) => {
      if (e.tag === tag) out.push(e)
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
const { stateLabel } = await import("./format.js")

describe("agents in the app", () => {
  it("the new session form sends the agent id and shows its label", () => {
    const v = render(
      {
        phase: "ready",
        conn: "live",
        route: { name: "new" },
        sessions: [],
        status: { pending: 0, channels: [] },
        meta: {},
        options: {
          models: [],
          agents: [{ id: "build", label: "Build" }],
          projects: [{ name: "shop" }],
        },
      },
      { build: "x", go() {}, canAct: () => true, create() {} },
      1000,
    )
    const opt = v.all("option").find((o) => o.text() === "Build")
    assert.ok(opt)
    assert.equal(opt.value, "build")
  })

  it("a session that did not start is labelled so", () => {
    assert.equal(
      stateLabel({ pending: 0, state: "unstarted" }).text,
      "Did not start",
    )
  })
})
