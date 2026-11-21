import assert from "node:assert/strict"
import { describe, it } from "node:test"

import * as F from "./form.js"

const single = {
  key: "a",
  header: "A",
  text: "Ship?",
  options: ["Yes", "No"],
  multiple: false,
  custom: false,
}
const multi = {
  key: "b",
  header: "B",
  text: "Which?",
  options: ["x, y", "z"],
  multiple: true,
  custom: true,
}
const typed = {
  key: "c",
  header: "C",
  text: "Name?",
  options: ["1", "2"],
  multiple: false,
  custom: true,
}

describe("form steps", () => {
  it("answers one single-select field with one tap", () => {
    assert.equal(F.oneTap([single]), true)
    const f = F.pick(F.newForm([single]), "No")
    assert.equal(F.reviewing(f), true)
    assert.deepEqual(F.body(f, "p1"), { prompt: "p1", answers: { a: "No" } })
  })

  it("is not one tap for a multi-select field or several fields", () => {
    assert.equal(F.oneTap([multi]), false)
    assert.equal(F.oneTap([single, single]), false)
  })

  it("keeps a multi-select choice across fields and sends options with commas whole", () => {
    let f = F.newForm([single, multi])
    f = F.pick(f, "Yes")
    assert.equal(f.at, 1)
    f = F.pick(F.pick(f, "x, y"), "z")
    assert.equal(F.reviewing(f), false)
    f = F.next(f)
    assert.equal(F.reviewing(f), true)
    assert.deepEqual(F.body(f, "p").answers, { a: "Yes", b: ["x, y", "z"] })
    f = F.pick(F.restart(f), "No")
    assert.deepEqual(f.chosen[1], ["x, y", "z"], "Edit keeps the other choices")
  })

  it("unticks a multi-select option and will not go on with none", () => {
    let f = F.newForm([multi])
    f = F.pick(F.pick(f, "z"), "z")
    assert.deepEqual(f.chosen[0], [])
    assert.equal(F.next(f).at, 0)
  })

  it("takes typed text only where allowed, and sends a typed number as text", () => {
    assert.equal(F.type(F.newForm([single]), "Maybe").at, 0)
    const f = F.type(F.newForm([typed]), " 2 ")
    assert.deepEqual(F.body(f, "p").answers, { c: "2" })
    assert.equal(F.type(F.newForm([typed]), "   ").at, 0)
  })

  it("drops separators from typed text", () => {
    const f = F.type(F.newForm([typed]), "a | b, c")
    assert.deepEqual(f.chosen[0], ["a b c"])
  })

  it("is complete only when every field has an answer, and goes back", () => {
    let f = F.newForm([single, single])
    assert.equal(F.complete(f), false)
    f = F.pick(f, "Yes")
    assert.equal(F.complete(f), false)
    assert.equal(F.back(f).at, 0)
    assert.equal(F.back(F.newForm([single])).at, 0)
  })

  it("ignores an option the field does not have", () => {
    const f = F.newForm([single])
    assert.equal(F.pick(f, "Maybe"), f)
  })
})
