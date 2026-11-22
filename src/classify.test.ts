import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { oneTap } from "./classify.ts"
import type { Question } from "./inbound.ts"

const q = (over: Partial<Question> = {}): Question => ({
  key: "q0",
  header: "",
  text: "Go?",
  options: ["Yes", "No"],
  multiple: false,
  custom: false,
  ...over,
})

describe("one tap or the app", () => {
  it("a single-select field with two to four short options is one tap, typing allowed or not", () => {
    assert.equal(oneTap([q()]), true)
    assert.equal(oneTap([q({ custom: true })]), true)
    assert.equal(oneTap([q({ options: ["a", "b", "c", "d"] })]), true)
    assert.equal(oneTap([q({ options: ["x".repeat(24), "No"] })]), true)
  })

  it("everything else is answered in the app", () => {
    assert.equal(oneTap([q(), q({ key: "q1" })]), false, "two fields")
    assert.equal(oneTap([q({ multiple: true })]), false, "multi-select")
    assert.equal(oneTap([q({ options: [] })]), false, "free text only")
    assert.equal(oneTap([q({ options: ["Yes"] })]), false, "one option")
    assert.equal(
      oneTap([q({ options: ["a", "b", "c", "d", "e"] })]),
      false,
      "five options",
    )
    assert.equal(
      oneTap([q({ options: ["x".repeat(25), "No"] })]),
      false,
      "a long option",
    )
    assert.equal(oneTap([]), false, "no fields")
  })
})
