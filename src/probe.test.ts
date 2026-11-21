import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { sqliteProbe } from "./control.ts"

const hasSqlite = (() => {
  try {
    execFileSync("sqlite3", ["-version"])
    return true
  } catch {
    return false
  }
})()

describe("the suspended-session probe", { skip: !hasSqlite }, () => {
  it("lists an idle suspended session with messages, never one whose turn is running", async () => {
    const db = join(await mkdtemp(join(tmpdir(), "oobb-probe-")), "o.db")
    const sql = [
      "create table session_v2 (id text, parent_id text, time_suspended integer, time_busy integer, time_idle integer)",
      "create table session_inbox (id text, session_id text)",
      "insert into session_v2 values ('idle', null, 1000, 500, 900)",
      "insert into session_v2 values ('running', null, 2000, 2000, 1500)",
      "insert into session_v2 values ('never', null, 2000, 2000, null)",
      "insert into session_inbox values ('a', 'idle'), ('b', 'running'), ('c', 'never')",
    ].join(";")
    execFileSync("sqlite3", [db, sql])
    assert.deepEqual(await sqliteProbe(db)(), [
      { id: "idle", pending: 1, since: 1000 },
    ])
  })
})
