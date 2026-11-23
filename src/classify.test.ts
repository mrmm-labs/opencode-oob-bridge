import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { oneTap, plainLabel } from "./classify.ts"
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

const REC = " (Recommended)"

describe("one tap or the app", () => {
  it("a single-select field with two to four short options is one tap, typing allowed or not", () => {
    assert.equal(oneTap([q()]), true)
    assert.equal(oneTap([q({ custom: true })]), true)
    assert.equal(oneTap([q({ options: ["a", "b", "c", "d"] })]), true)
    assert.equal(oneTap([q({ options: ["x".repeat(48), "No"] })]), true)
  })

  it("options of real length are one tap, the suffix not counted", () => {
    const a = [
      "Apply the fix to the staging cluster now" + REC,
      "Wait for the release",
      "Skip this for now",
    ]
    assert.deepEqual(
      a.map((o) => plainLabel(o).length),
      [40, 20, 17],
    )
    assert.equal(oneTap([q({ options: a })]), true)
    const b = [
      "Re-run the failed pipeline with a clean cache" + REC,
      "Cancel the run and ask the owner.",
    ]
    assert.deepEqual(
      b.map((o) => plainLabel(o).length),
      [45, 33],
    )
    assert.equal(oneTap([q({ options: b })]), true)
    assert.equal(oneTap([q({ options: b, custom: true })]), true)
  })

  it("reads the suffix in any case, and the label alone decides", () => {
    assert.equal(plainLabel("Ship it (recommended)"), "Ship it")
    assert.equal(plainLabel("(Recommended) Ship it"), "Ship it")
    assert.equal(plainLabel("Ship it"), "Ship it")
    assert.equal(oneTap([q({ options: ["x".repeat(48) + REC, "No"] })]), true)
    assert.equal(oneTap([q({ options: ["x".repeat(49), "No"] })]), false)
  })

  it("everything else is answered in the app", () => {
    assert.equal(oneTap([q(), q({ key: "q1" })]), false, "two fields")
    const eight = Array.from({ length: 8 }, (_, i) =>
      q({ key: "q" + i, options: ["Yes", "No"] }),
    )
    assert.equal(oneTap(eight), false, "eight fields")
    assert.equal(oneTap([q({ multiple: true })]), false, "multi-select")
    assert.equal(oneTap([q({ options: [] })]), false, "free text only")
    assert.equal(oneTap([q({ options: ["Yes"] })]), false, "one option")
    assert.equal(
      oneTap([q({ options: ["a", "b", "c", "d", "e"] })]),
      false,
      "five options",
    )
    assert.equal(
      oneTap([q({ options: ["x".repeat(49), "No"] })]),
      false,
      "a very long option",
    )
    assert.equal(oneTap([]), false, "no fields")
  })
})
