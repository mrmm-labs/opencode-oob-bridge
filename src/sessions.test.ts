import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Sessions, toSession } from "./server.ts"

const time = { created: 1, updated: 2, busy: 3, idle: 4 }

describe("the viewed signal of a session", () => {
  it("is false until a viewer marks an idle transition viewed", () => {
    assert.equal(toSession({ id: "a", time }).viewed, false)
    assert.equal(
      toSession({ id: "a", time: { ...time, viewed: 4 } }).viewed,
      true,
    )
  })

  it("is unset when the host sends no time", () => {
    assert.equal(toSession({ id: "a" }).viewed, undefined)
  })

  it("follows the session.viewed event, which is read by the cache only", async () => {
    const s = new Sessions(async (id) => ({ id, time }))
    await s.ensure("a")
    assert.equal(toSession(s.info.get("a")!).viewed, false)
    s.apply({ type: "session.viewed", data: { sessionID: "a", idle: 4 } })
    assert.equal(toSession(s.info.get("a")!).viewed, true)
    assert.equal(s.info.get("a")!.time?.busy, 3, "the rest of the time stays")
    s.apply({ type: "session.viewed", data: { sessionID: "other", idle: 4 } })
    assert.equal(s.info.has("other"), false)
  })

  it("keeps a child's root: only a session with no parent is a root", async () => {
    const s = new Sessions(async (id) =>
      id === "kid" ? { id, parentID: "a", time } : { id, time },
    )
    await s.ensure("kid")
    assert.equal(s.root("kid"), "a")
    assert.equal(s.root("a"), "a")
  })
})
