import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  checkAnswers,
  parseReply,
  resolveAnswer,
  type Question,
} from "./inbound.ts"

const q = (over: Partial<Question> = {}): Question => ({
  key: "q0",
  header: "Deploy",
  text: "Deploy now?",
  options: ["Yes", "No", "Later"],
  multiple: false,
  custom: true,
  ...over,
})

describe("parseReply", () => {
  it("reads button bodies and text replies", () => {
    assert.deepEqual(parseReply('{"id":"ab12","choice":2}'), {
      id: "ab12",
      choice: 2,
    })
    assert.deepEqual(parseReply("#ab12 2"), { id: "ab12", text: "2" })
    assert.deepEqual(parseReply("  #ab12   go ahead \n"), {
      id: "ab12",
      text: "go ahead",
    })
  })

  it("ignores anything else", () => {
    for (const m of [
      "hello",
      "#ab12",
      '{"id":1}',
      '{"id":"a","choice":1.5}',
      "{bad",
    ])
      assert.equal(parseReply(m), undefined, m)
  })
})

describe("resolveAnswer", () => {
  it("maps a button choice to the option label", () => {
    assert.deepEqual(resolveAnswer([q()], { id: "x", choice: 2 }), { q0: "No" })
    assert.equal(resolveAnswer([q()], { id: "x", choice: 4 }), undefined)
  })

  it("maps numbers, labels and free text", () => {
    assert.deepEqual(resolveAnswer([q()], { id: "x", text: "3" }), {
      q0: "Later",
    })
    assert.deepEqual(resolveAnswer([q()], { id: "x", text: "yes" }), {
      q0: "Yes",
    })
    assert.deepEqual(resolveAnswer([q()], { id: "x", text: "in an hour" }), {
      q0: "in an hour",
    })
    assert.equal(
      resolveAnswer([q({ custom: false })], { id: "x", text: "maybe" }),
      undefined,
    )
  })

  it("a literal answer is text even when it looks like an option number", () => {
    assert.deepEqual(
      resolveAnswer([q()], { id: "x", text: "2", literal: true }),
      {
        q0: "2",
      },
    )
    assert.deepEqual(resolveAnswer([q()], { id: "x", text: "2" }), {
      q0: "No",
    })
    assert.equal(
      resolveAnswer([q({ custom: false })], {
        id: "x",
        text: "2",
        literal: true,
      }),
      undefined,
    )
  })

  it("handles multiselect and several questions", () => {
    assert.deepEqual(
      resolveAnswer([q({ multiple: true })], { id: "x", text: "1, 3" }),
      {
        q0: ["Yes", "Later"],
      },
    )
    const two = [q(), q({ key: "q1", options: ["A", "B"] })]
    assert.deepEqual(resolveAnswer(two, { id: "x", text: "1 | B" }), {
      q0: "Yes",
      q1: "B",
    })
    assert.equal(resolveAnswer(two, { id: "x", text: "1" }), undefined)
    assert.equal(resolveAnswer(two, { id: "x", choice: 1 }), undefined)
  })
})

describe("checkAnswers", () => {
  const two = [
    q({ key: "a", options: ["Yes", "No"], custom: false }),
    q({ key: "b", options: ["x, y", "z"], multiple: true, custom: true }),
  ]

  it("takes one value per field, options with commas whole", () => {
    assert.deepEqual(checkAnswers(two, { a: "No", b: ["x, y", "free"] }), {
      a: "No",
      b: ["x, y", "free"],
    })
  })

  it("does not read a typed number as an option number", () => {
    assert.deepEqual(checkAnswers([q()], { q0: "3" }), { q0: "3" })
  })

  it("refuses a missing field, an extra key, a wrong shape or an unknown value", () => {
    for (const given of [
      { a: "Yes" },
      { a: "Yes", b: ["z"], c: "x" },
      { a: ["Yes"], b: ["z"] },
      { a: "Yes", b: "z" },
      { a: "Maybe", b: ["z"] },
      { a: "Yes", b: [] },
      { a: "Yes", b: ["  "] },
      { a: 1, b: ["z"] },
      "Yes",
      null,
    ])
      assert.equal(checkAnswers(two, given), undefined, JSON.stringify(given))
    assert.equal(checkAnswers([], {}), undefined)
  })

  it("refuses a very long typed answer", () => {
    assert.equal(checkAnswers([q()], { q0: "x".repeat(2001) }), undefined)
  })
})
