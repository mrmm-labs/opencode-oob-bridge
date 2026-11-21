import assert from "node:assert/strict"
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { acquire } from "./lock.ts"

const dir = async () =>
  join(await mkdtemp(join(tmpdir(), "oobb-lock-")), "owner.lock")

describe("owner lock", () => {
  it("the first loader owns it; a second in the same process does not, and says who does", async () => {
    const f = await dir()
    const a = await acquire(f, { beatMs: 1e9 })
    assert.equal(a.held, true)
    const b = await acquire(f, { beatMs: 1e9 })
    assert.equal(b.held, false)
    assert.equal(b.owner?.pid, process.pid)
    assert.equal(JSON.parse(await readFile(f, "utf8")).pid, process.pid)
    assert.match(a.held ? (a.owner.id ?? "") : "", /^[0-9a-f]{8}$/)
    assert.equal(
      b.owner?.id,
      a.held ? a.owner.id : undefined,
      "the loser is told the owner's id",
    )
    if (a.held) await a.release()
    const c = await acquire(f, { beatMs: 1e9 })
    assert.equal(c.held, true, "free again after release")
    if (c.held) await c.release()
  })

  it("takes over a lock whose process is gone", async () => {
    const f = await dir()
    await writeFile(f, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: 1 }))
    const a = await acquire(f, { beatMs: 1e9 })
    assert.equal(a.held, true)
    if (a.held) await a.release()
  })

  it("takes over a lock nobody refreshes, even if its pid is alive; leaves a fresh one", async () => {
    const f = await dir()
    await writeFile(f, JSON.stringify({ pid: process.ppid, startedAt: 1 }))
    const fresh = await acquire(f, { beatMs: 1e9 })
    assert.equal(fresh.held, false, "a live holder that is refreshing")
    const old = new Date(Date.now() - 120_000)
    await utimes(f, old, old)
    const a = await acquire(f, { beatMs: 1e9, staleMs: 30_000 })
    assert.equal(a.held, true)
    if (a.held) await a.release()
  })

  it("a lock that is not valid JSON counts as stale", async () => {
    const f = await dir()
    await writeFile(f, "not json")
    const a = await acquire(f, { beatMs: 1e9 })
    assert.equal(a.held, true)
    if (a.held) await a.release()
  })
})
