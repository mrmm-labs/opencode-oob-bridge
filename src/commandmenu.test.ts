import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildMenu, menuHash, validMenu } from "./commandmenu.ts"

const all = { undo: true, resume: true, digest: true }

describe("the command menu", () => {
  it("starts with the eleven commands of the operator, in order", () => {
    assert.deepEqual(
      buildMenu(all)
        .slice(0, 11)
        .map((c) => c.command),
      [
        "status",
        "stop",
        "model",
        "agent",
        "compact",
        "undo",
        "resume",
        "afk",
        "back",
        "auto",
        "digest",
      ],
    )
  })

  it("leaves out a command whose feature is off, and keeps the always-on ones", () => {
    const names = buildMenu({ undo: false, resume: false, digest: false }).map(
      (c) => c.command,
    )
    for (const n of ["undo", "resume", "digest"])
      assert.ok(!names.includes(n), n)
    for (const n of ["status", "afk", "version", "help", "new"])
      assert.ok(names.includes(n), n)
  })

  it("is valid for Telegram as built", () => {
    assert.deepEqual(validMenu(buildMenu(all)).problems, [])
  })

  it("names the problem of a bad name or description", () => {
    const v = validMenu([
      { command: "Bad", description: "x" },
      { command: "long", description: "x".repeat(257) },
      { command: "empty", description: "" },
      { command: "good_1", description: "ok" },
    ])
    assert.deepEqual(
      v.ok.map((c) => c.command),
      ["good_1"],
    )
    assert.equal(v.problems.length, 3)
  })

  it("hashes the scope and the list", () => {
    const a = buildMenu(all)
    assert.equal(menuHash("s", a), menuHash("s", [...a]))
    assert.notEqual(menuHash("s", a), menuHash("t", a))
    assert.notEqual(menuHash("s", a), menuHash("s", a.slice(1)))
  })
})
