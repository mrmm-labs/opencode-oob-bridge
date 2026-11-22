import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { enrolLink } from "./link.ts"

describe("the enrolment link", () => {
  it("puts the code in the start parameter of the direct link", () => {
    assert.equal(
      enrolLink("https://t.me/examplebot/app", "ABCD2345"),
      "https://t.me/examplebot/app?startapp=enrol_ABCD2345",
    )
  })

  it("gives none without a direct link, or for a code Telegram would refuse", () => {
    assert.equal(enrolLink(undefined, "ABCD2345"), undefined)
    assert.equal(enrolLink("https://t.me/b/a", "AB CD"), undefined)
    assert.equal(enrolLink("https://t.me/b/a", "A".repeat(60)), undefined)
  })
})
