import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { renderStepper } from "./connectors/telegram-render.ts"
import type { Question } from "./inbound.ts"
import { newStepper, parseAct, replyText, step } from "./stepper.ts"

const q = (
  key: string,
  options: string[],
  o: Partial<Question> = {},
): Question => ({
  key,
  header: key.toUpperCase(),
  text: "Pick " + key,
  options,
  multiple: false,
  custom: false,
  ...o,
})
const three = () =>
  newStepper(
    "ab12",
    [
      q("db", ["pg", "mysql"]),
      q("tools", ["a", "b", "c"], { multiple: true }),
      q("note", ["none"], { custom: true }),
    ],
    "Question",
  )

describe("the form stepper", () => {
  it("moves on after a single choice, and Back returns", () => {
    const s = three()
    step(s, { t: "pick", n: 2 })
    assert.equal(s.at, 1)
    step(s, { t: "back" })
    assert.equal(s.at, 0)
    assert.deepEqual(s.chosen[0], ["mysql"])
  })

  it("a multi-select toggles and needs one tick before Done", () => {
    const s = three()
    step(s, { t: "pick", n: 1 })
    assert.equal(step(s, { t: "done" }).toast, "Tick at least one option.")
    step(s, { t: "toggle", n: 1 })
    step(s, { t: "toggle", n: 3 })
    step(s, { t: "toggle", n: 1 })
    assert.deepEqual(s.chosen[1], ["c"])
    step(s, { t: "done" })
    assert.equal(s.at, 2)
  })

  it("a typed answer fills a field that allows it, and not one that does not", () => {
    const s = three()
    assert.ok(step(s, { t: "text", text: "x" }).toast)
    step(s, { t: "pick", n: 1 })
    step(s, { t: "toggle", n: 2 })
    step(s, { t: "done" })
    step(s, { t: "text", text: "take care, | now" })
    assert.deepEqual(s.chosen[2], ["take care now"])
    assert.equal(s.at, 3)
  })

  it("review, then Submit makes one reply of option numbers and typed text", () => {
    const s = three()
    assert.equal(step(s, { t: "submit" }).toast, "Finish the fields first.")
    step(s, { t: "pick", n: 2 })
    step(s, { t: "toggle", n: 1 })
    step(s, { t: "toggle", n: 3 })
    step(s, { t: "done" })
    step(s, { t: "text", text: "careful" })
    assert.match(renderStepper(s).text, /Review your answers/)
    assert.deepEqual(step(s, { t: "submit" }), { reply: "2 | 1,3 | careful" })
  })

  it("Edit goes back to the first field, Cancel sends nothing", () => {
    const s = three()
    step(s, { t: "pick", n: 1 })
    step(s, { t: "edit" })
    assert.equal(s.at, 0)
    assert.deepEqual(step(s, { t: "cancel" }), { cancel: true })
  })

  it("answers nothing until Submit", () => {
    const s = three()
    for (const a of [
      { t: "pick", n: 1 },
      { t: "toggle", n: 1 },
      { t: "done" },
    ] as const)
      assert.equal(step(s, a).reply, undefined)
  })

  it("pages more than eight options and keeps a tick across pages", () => {
    const options = Array.from({ length: 20 }, (_, i) => "opt" + (i + 1))
    const s = newStepper("zz", [q("many", options, { multiple: true })], "Q")
    assert.equal(
      renderStepper(s).rows.filter((r) => /o?t\d+$/.test(r[0].callback_data))
        .length,
      8,
    )
    step(s, { t: "toggle", n: 3 })
    step(s, { t: "page", n: 1 })
    const p2 = renderStepper(s)
    assert.match(p2.text, /Page 2\/3/)
    assert.equal(p2.rows[0][0].callback_data, "s:zz:t9")
    step(s, { t: "page", n: 0 })
    assert.match(renderStepper(s).rows[2][0].text, /^✓ /)
    step(s, { t: "page", n: 99 })
    assert.equal(s.page, 2)
  })

  it("shows the field, its progress and its buttons", () => {
    const s = three()
    step(s, { t: "pick", n: 1 })
    const v = renderStepper(s)
    assert.match(v.text, /2\/3 · TOOLS/)
    const data = v.rows.flat().map((k) => k.callback_data)
    assert.ok(data.includes("s:ab12:b") && data.includes("s:ab12:d"))
    assert.ok(data.every((d) => d.length <= 64))
    assert.ok(!data.includes("s:ab12:w"), "no ✏️ on a field without free text")
  })

  it("reads button data back", () => {
    assert.deepEqual(parseAct("s:ab12:o3"), {
      id: "ab12",
      act: { t: "pick", n: 3 },
    })
    assert.deepEqual(parseAct("s:ab12:ok"), {
      id: "ab12",
      act: { t: "submit" },
    })
    assert.equal(parseAct("s:ab12:w")?.act, "write")
    assert.equal(parseAct("s:ab12:zz"), undefined)
    assert.equal(replyText(three()), " |  | ")
  })
})
