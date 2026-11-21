import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  checkInitData,
  fromHeader,
  parseInitData,
  signInitData,
} from "./initdata.ts"

const TOKEN = "123456:TEST-TOKEN-NOT-REAL"
const OP = 4242
const NOW = 1_800_000_000_000
const fields = (over: Record<string, string> = {}) => ({
  auth_date: String(NOW / 1000 - 10),
  query_id: "AAH",
  user: JSON.stringify({ id: OP, first_name: "A" }),
  ...over,
})
const o = { operator: OP, maxAgeSeconds: 3600, now: () => NOW }

describe("init data", () => {
  it("accepts fresh init data of the operator, with and without a token", () => {
    const s = signInitData(TOKEN, fields())
    assert.deepEqual(checkInitData(s, { ...o, token: TOKEN }), {
      ok: true,
      userId: OP,
    })
    assert.equal(checkInitData(s, o).ok, true)
  })

  it("refuses a changed field when the token is known (401), and cannot tell without it", () => {
    const s = signInitData(TOKEN, fields()).replace(
      "query_id=AAH",
      "query_id=BBB",
    )
    assert.deepEqual(checkInitData(s, { ...o, token: TOKEN }), {
      ok: false,
      status: 401,
      why: "hash",
    })
    assert.equal(
      checkInitData(s, o).ok,
      true,
      "the pre-filter does not claim the hash",
    )
  })

  it("refuses another token", () => {
    const s = signInitData("999:OTHER", fields())
    assert.equal(checkInitData(s, { ...o, token: TOKEN }).ok, false)
  })

  it("answers 403 for another user with a valid hash, and 401 when the hash is bad", () => {
    const f = fields({ user: JSON.stringify({ id: 7 }) })
    const s = signInitData(TOKEN, f)
    assert.deepEqual(checkInitData(s, { ...o, token: TOKEN }), {
      ok: false,
      status: 403,
      why: "user",
    })
    assert.equal(
      checkInitData(s, o).ok === false &&
        (checkInitData(s, o) as { status: number }).status,
      403,
    )
    const forged = s.replace(/hash=[0-9a-f]{64}/, "hash=" + "0".repeat(64))
    assert.equal(
      (checkInitData(forged, { ...o, token: TOKEN }) as { status: number })
        .status,
      401,
    )
  })

  it("refuses stale and far-future auth_date", () => {
    const old = signInitData(
      TOKEN,
      fields({ auth_date: String(NOW / 1000 - 7200) }),
    )
    assert.deepEqual(checkInitData(old, { ...o, token: TOKEN }), {
      ok: false,
      status: 401,
      why: "age",
    })
    const future = signInitData(
      TOKEN,
      fields({ auth_date: String(NOW / 1000 + 600) }),
    )
    assert.equal(checkInitData(future, o).ok, false)
    assert.equal(checkInitData(old, { ...o, maxAgeSeconds: 86_400 }).ok, true)
  })

  it("refuses what is not init data", () => {
    for (const s of [
      undefined,
      "",
      "garbage",
      "hash=" + "0".repeat(64),
      signInitData(TOKEN, { auth_date: "1", user: "{bad" }),
      signInitData(TOKEN, { auth_date: "x", user: JSON.stringify({ id: 1 }) }),
      signInitData(TOKEN, fields({ user: JSON.stringify({ id: "4242" }) })),
      "a=".repeat(3000),
    ])
      assert.equal(checkInitData(s, o).ok, false, String(s).slice(0, 20))
    assert.equal(parseInitData("x"), undefined)
  })

  it("reads the credential from an Authorization header", () => {
    assert.equal(fromHeader("tma abc=1&hash=2"), "abc=1&hash=2")
    assert.equal(fromHeader("Bearer abc"), undefined)
    assert.equal(fromHeader(undefined), undefined)
    assert.equal(fromHeader("tma "), undefined)
  })
})
