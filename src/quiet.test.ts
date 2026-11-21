import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  digestDue,
  isQuiet,
  localTime,
  parseClock,
  validZone,
} from "./quiet.ts"

const night = { from: 23 * 60, to: 7 * 60, timezone: "UTC", breakthrough: [] }
const at = (h: number, m = 0, d = 1) => Date.UTC(2027, 5, d, h, m)

describe("quiet hours", () => {
  it("parses HH:MM and rejects the rest", () => {
    assert.equal(parseClock("07:30"), 450)
    assert.equal(parseClock("7:05"), 425)
    for (const bad of ["24:00", "07:60", "7", "", 7, undefined])
      assert.equal(parseClock(bad), undefined, String(bad))
  })

  it("knows zones", () => {
    assert.ok(validZone("Europe/Paris"))
    assert.ok(!validZone("Mars/Base"))
  })

  it("a window that crosses midnight covers both sides of it", () => {
    assert.equal(isQuiet(night, at(23, 0)), true)
    assert.equal(isQuiet(night, at(2, 0)), true)
    assert.equal(isQuiet(night, at(6, 59)), true)
    assert.equal(isQuiet(night, at(7, 0)), false)
    assert.equal(isQuiet(night, at(12, 0)), false)
    assert.equal(isQuiet(night, at(22, 59)), false)
  })

  it("a window inside one day works too", () => {
    const lunch = { ...night, from: 12 * 60, to: 14 * 60 }
    assert.equal(isQuiet(lunch, at(13, 0)), true)
    assert.equal(isQuiet(lunch, at(14, 0)), false)
  })

  it("reads the clock of the zone, not of the host", () => {
    const paris = { ...night, timezone: "Europe/Paris" }
    // 23:30 UTC is 01:30 in Paris in June: quiet. 05:30 UTC is 07:30 there: not.
    assert.equal(isQuiet(paris, at(23, 30)), true)
    assert.equal(isQuiet(paris, at(5, 30)), false)
    assert.equal(isQuiet(paris, at(4, 30)), true)
  })

  it("spring forward does not move the end of the window off 07:00 local", () => {
    const paris = { ...night, timezone: "Europe/Paris" }
    // The clocks of Paris moved forward on 2027-03-28, so 07:00 is 05:00 UTC after it, 06:00 UTC before it.
    assert.equal(isQuiet(paris, Date.UTC(2027, 2, 28, 4, 59)), true)
    assert.equal(isQuiet(paris, Date.UTC(2027, 2, 28, 5, 0)), false)
    assert.equal(isQuiet(paris, Date.UTC(2027, 2, 27, 5, 59)), true)
    assert.equal(isQuiet(paris, Date.UTC(2027, 2, 27, 6, 0)), false)
    assert.equal(
      localTime(Date.UTC(2027, 2, 28, 5, 0), "Europe/Paris").minutes,
      420,
    )
  })

  it("a digest is due once a day, after its time", () => {
    const o = { at: 7 * 60, timezone: "UTC" }
    assert.equal(digestDue({ ...o, last: 0, now: at(6, 59) }), false)
    assert.equal(digestDue({ ...o, last: 0, now: at(7, 0) }), true)
    assert.equal(digestDue({ ...o, last: at(7, 0), now: at(7, 1) }), false)
    assert.equal(digestDue({ ...o, last: at(7, 0), now: at(23, 0) }), false)
    assert.equal(digestDue({ ...o, last: at(7, 0), now: at(7, 0, 2) }), true)
  })
})
