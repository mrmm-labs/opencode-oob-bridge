import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  ago,
  connection,
  diffClass,
  permissionChoices,
  refusalText,
  stateLabel,
} from "./format.js"

describe("format", () => {
  it("says how long ago", () => {
    assert.equal(ago(1000, 1000), "now")
    assert.equal(ago(0, 30_000), "30s ago")
    assert.equal(ago(0, 5 * 60_000), "5m ago")
    assert.equal(ago(0, 3 * 3600_000), "3h ago")
    assert.equal(ago(0, 2 * 86_400_000), "2d ago")
    assert.equal(ago(undefined, 1), "")
  })

  it("puts a waiting prompt before the state", () => {
    assert.equal(stateLabel({ pending: 1, state: "working" }).key, "waiting")
    assert.equal(
      stateLabel({ pending: 0, state: "suspended" }).text,
      "Suspended",
    )
    assert.equal(stateLabel({ pending: 0, state: "working" }).key, "working")
  })

  it("names the connection state", () => {
    assert.equal(connection({ conn: "live" }).key, "live")
    assert.equal(connection({ conn: "down" }).text, "Reconnecting…")
    assert.equal(connection({ conn: "connecting" }).text, "Connecting…")
  })

  it("classes diff lines", () => {
    assert.equal(diffClass("+x"), "add")
    assert.equal(diffClass("-x"), "del")
    assert.equal(diffClass("+++ b/a"), "meta")
    assert.equal(diffClass("@@ -1 +1 @@"), "hunk")
    assert.equal(diffClass(" ctx"), "")
  })
})

describe("permission gate", () => {
  const meta = (permissions, available = true) => ({
    permissions,
    actions: [{ name: "permission", available }],
  })

  it("offers nothing when the policy is off, or the core says the action is off", () => {
    assert.deepEqual(permissionChoices(meta("off")), [])
    assert.deepEqual(permissionChoices(meta("once", false)), [])
    assert.deepEqual(permissionChoices(undefined), [])
    assert.deepEqual(
      permissionChoices({ permissions: "once", actions: [] }),
      [],
    )
  })

  it("offers Allow once and Deny for once, and also Always for all", () => {
    assert.deepEqual(permissionChoices(meta("once")), ["once", "reject"])
    assert.deepEqual(permissionChoices(meta("all")), [
      "once",
      "always",
      "reject",
    ])
  })
})

describe("refusal sentences", () => {
  it("has one for each reason the bridge gives, and none for an unknown one", () => {
    for (const r of [
      "no_operator",
      "no_bot_token",
      "missing",
      "malformed",
      "bad_signature",
      "too_old",
      "not_operator",
      "too many failures",
    ])
      assert.ok(refusalText(r)?.length > 20, r)
    assert.equal(refusalText("something else"), undefined)
    assert.equal(refusalText(undefined), undefined)
    assert.match(refusalText("no_operator"), /no operator configured/)
    assert.doesNotMatch(refusalText("no_operator"), /expired/)
  })
})
