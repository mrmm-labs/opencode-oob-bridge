import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { appLine, LineGate } from "./applog.ts"

describe("a diagnostic line from the app", () => {
  it("takes a name and a few short fields", () => {
    assert.deepEqual(
      appLine({
        event: "stream_error",
        data: { name: "TypeError", ms: 12, bytes: false },
      }),
      {
        event: "stream_error",
        data: { name: "TypeError", ms: 12, bytes: false },
      },
    )
    assert.deepEqual(appLine({ event: "boot" }), { event: "boot", data: {} })
  })

  it("refuses a name that is not [a-z0-9_] or is too long, and a data that is not an object", () => {
    for (const event of ["", "Bad", "a-b", "a b", "x".repeat(41), 5, undefined])
      assert.equal(appLine({ event }), undefined, String(event))
    for (const data of ["x", 5, null, [1]])
      assert.equal(appLine({ event: "ok", data }), undefined)
  })

  it("drops odd keys and values instead of rejecting the line", () => {
    const l = appLine({
      event: "ok",
      data: {
        "Bad Key": 1,
        good: 2,
        obj: {},
        arr: [],
        nul: null,
        nan: Number.NaN,
      },
    })
    assert.deepEqual(l?.data, { good: 2 })
  })

  it("drops a value that looks like init data, whatever the key", () => {
    const l = appLine({
      event: "ok",
      data: {
        a: "query_id=AAH&user=%7B%7D&auth_date=1&hash=" + "0".repeat(64),
        b: "x hash=abc",
        c: "plain",
      },
    })
    assert.deepEqual(l?.data, { c: "plain" })
  })

  it("cuts a long text, strips control characters and keeps twelve fields", () => {
    const l = appLine({
      event: "ok",
      data: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [
          "k" + i,
          "a\nb" + "x".repeat(300),
        ]),
      ),
    })
    assert.equal(Object.keys(l?.data ?? {}).length, 12)
    const v = (l?.data.k0 as string) ?? ""
    assert.equal(v.length, 200)
    assert.ok(![...v].some((c) => c.charCodeAt(0) < 32))
  })
})

describe("the line limit", () => {
  it("allows the limit in a window and again after it", () => {
    let t = 0
    const g = new LineGate(3, 1000, () => t)
    assert.deepEqual(
      [g.take(), g.take(), g.take(), g.take()],
      [true, true, true, false],
    )
    t = 999
    assert.equal(g.take(), false)
    t = 1000
    assert.equal(g.take(), true)
  })
})
