import assert from "node:assert/strict"
import { describe, it } from "node:test"

import * as F from "./form.js"

const single = {
  key: "a",
  header: "A",
  text: "Ship?",
  options: ["Yes (Recommended)", "No"],
  multiple: false,
  custom: false,
}
const multi = {
  key: "b",
  header: "B",
  text: "Which?",
  options: ["x, y", "z (recommended)", "w"],
  multiple: true,
  custom: true,
}
const items = [single, multi]

describe("recommended options", () => {
  it("tags and strips the suffix in any case", () => {
    assert.equal(F.isRecommended("Yes (Recommended)"), true)
    assert.equal(F.isRecommended("z (recommended)"), true)
    assert.equal(F.isRecommended("No"), false)
    assert.equal(F.plain("Yes (Recommended)"), "Yes")
    assert.equal(F.plain("No"), "No")
  })

  it("starts with the recommended options chosen, one for a single-select question", () => {
    const d = F.newDraft(items)
    assert.deepEqual(d[0].chosen, ["Yes (Recommended)"])
    assert.deepEqual(d[1].chosen, ["z (recommended)"])
    const two = F.newDraft([
      { ...single, options: ["a (Recommended)", "b (Recommended)"] },
    ])
    assert.equal(two[0].chosen.length, 1)
  })
})

describe("choosing", () => {
  it("a single-select question takes one answer and drops the typed one", () => {
    let d = F.newDraft(items)
    d = F.pick(d, 0, single, "No")
    assert.deepEqual(d[0].chosen, ["No"])
    assert.equal(
      F.pick(d, 0, single, "nope"),
      d,
      "an unknown option changes nothing",
    )
  })

  it("a multi-select question toggles, and keeps what was typed", () => {
    let d = F.newDraft(items)
    d = F.other(d, 1, multi, "  my   own ")
    d = F.pick(d, 1, multi, "w")
    d = F.pick(d, 1, multi, "z (recommended)")
    assert.deepEqual(d[1].chosen, ["w"])
    assert.equal(d[1].other, "my own")
  })

  it("typing replaces the choice of a single-select question, and only where typing is allowed", () => {
    const custom = { ...single, custom: true }
    let d = F.newDraft([custom])
    d = F.other(d, 0, custom, "mine")
    assert.deepEqual(d[0], { chosen: [], other: "mine" })
    d = F.pick(d, 0, custom, "No")
    assert.deepEqual(d[0], { chosen: ["No"], other: "" })
    const none = F.newDraft([single])
    assert.equal(F.other(none, 0, single, "x"), none)
  })
})

describe("sending", () => {
  it("is ready only when every question has an answer", () => {
    let d = F.newDraft(items)
    d = F.pick(d, 0, single, "No")
    d = F.pick(d, 1, multi, "z (recommended)")
    assert.equal(F.ready(items, d), false)
    d = F.pick(d, 1, multi, "w")
    assert.equal(F.ready(items, d), true)
    assert.equal(F.ready([], []), false)
  })

  it("sends one value per question, the option as it is named", () => {
    let d = F.newDraft(items)
    d = F.other(d, 1, multi, "mine")
    assert.deepEqual(F.body("p1", items, d), {
      prompt: "p1",
      answers: { a: "Yes (Recommended)", b: ["z (recommended)", "mine"] },
    })
  })
})

describe("a draft kept on the phone", () => {
  it("is read back when it fits, and refused when the questions changed", () => {
    const d = F.newDraft(items)
    assert.deepEqual(F.restore(JSON.parse(JSON.stringify(d)), items), d)
    assert.equal(F.restore(d, [single]), undefined)
    assert.equal(
      F.restore([{ chosen: ["gone"], other: "" }, d[1]], items),
      undefined,
    )
    assert.equal(
      F.restore(
        [d[0], { chosen: [], other: "typed" }],
        [single, { ...multi, custom: false }],
      ),
      undefined,
    )
    assert.equal(F.restore("junk", items), undefined)
    assert.equal(F.restore(undefined, items), undefined)
  })
})
