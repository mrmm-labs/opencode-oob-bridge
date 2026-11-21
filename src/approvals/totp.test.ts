import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { base32, code, match, newSeed, otpauth, step } from "./totp.ts"

// RFC 6238 appendix B, SHA-1 key "12345678901234567890", last 6 digits.
const KEY = Buffer.from("12345678901234567890")
const VECTORS: Array<[seconds: number, code: string]> = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
]

describe("totp", () => {
  for (const [t, want] of VECTORS)
    it(`matches the RFC 6238 vector at ${t}`, () =>
      assert.equal(code(KEY, step(t * 1000)), want))

  it("accepts one step either side and no more", () => {
    const t = 1_700_000_000_000
    const s = step(t)
    assert.equal(match(KEY, code(KEY, s), t), s)
    assert.equal(match(KEY, code(KEY, s - 1), t), s - 1)
    assert.equal(match(KEY, code(KEY, s + 1), t), s + 1)
    assert.equal(match(KEY, code(KEY, s - 2), t), undefined)
  })

  it("refuses anything that is not six digits", () => {
    const t = 1_700_000_000_000
    assert.equal(match(KEY, "12345", t), undefined)
    assert.equal(match(KEY, "abcdef", t), undefined)
    assert.equal(match(KEY, " 123456", t), undefined)
  })

  it("encodes base32 and builds the enrolment link", () => {
    assert.equal(base32(Buffer.from("foobar")), "MZXW6YTBOI")
    const seed = newSeed()
    assert.equal(seed.length, 20)
    assert.match(
      otpauth(seed, "me", "OpenCode OOB"),
      /^otpauth:\/\/totp\/OpenCode%20OOB:me\?secret=[A-Z2-7]+&issuer=OpenCode%20OOB&/,
    )
  })
})
