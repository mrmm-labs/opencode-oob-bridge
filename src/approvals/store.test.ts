import assert from "node:assert/strict"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { KEEP_MS, RecordStore, type Rec } from "./store.ts"

const rec = (key: string, createdAt: number, over: Partial<Rec> = {}): Rec =>
  ({
    caller: "tool",
    request: { id: "id-" + key, idempotency_key: key },
    requestHash: "h",
    bodyHash: "b",
    scopeHash: "s",
    level: 1,
    state: "pending",
    createdAt,
    expiresAt: createdAt + 1000,
    ...over,
  }) as unknown as Rec

describe("approvals record store", () => {
  it("keeps records across a restart, with the last write of each id winning", async () => {
    const file = join(
      await mkdtemp(join(tmpdir(), "oobb-store-")),
      "a",
      "r.jsonl",
    )
    const a = new RecordStore(file)
    const now = Date.now()
    a.put(rec("k1", now))
    a.put(rec("k1", now, { state: "approved", reasonCode: undefined }))
    await a.flush()
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    const b = new RecordStore(file)
    await b.load(now)
    assert.equal(b.get("tool", "k1")?.state, "approved")
    assert.equal(b.byId("id-k1")?.state, "approved")
    assert.equal(b.all().length, 1)
  })

  it("drops what is older than 24 hours and a broken line, and rewrites the file", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "oobb-store-")), "r.jsonl")
    const now = Date.now()
    await writeFile(
      file,
      [
        JSON.stringify(rec("old", now - KEEP_MS - 1)),
        "{broken",
        JSON.stringify(rec("new", now - 1000)),
      ].join("\n") + "\n",
    )
    const s = new RecordStore(file)
    await s.load(now)
    assert.equal(s.get("tool", "old"), undefined)
    assert.ok(s.get("tool", "new"))
    const lines = (await readFile(file, "utf8")).trim().split("\n")
    assert.equal(lines.length, 1)
  })

  it("scopes a key to its caller", async () => {
    const s = new RecordStore()
    s.put(rec("k", Date.now()))
    assert.ok(s.get("tool", "k"))
    assert.equal(s.get("other", "k"), undefined)
  })
})
