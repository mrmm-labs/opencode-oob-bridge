import assert from "node:assert/strict"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { safeEqual, TokenStore } from "./auth.ts"

const file = async () =>
  join(await mkdtemp(join(tmpdir(), "oob-core-")), "core-token")

describe("core token", () => {
  it("is created at mode 0600 and is at least 256 bits", async () => {
    const f = await file()
    const t = new TokenStore(f)
    await t.load()
    const text = (await readFile(f, "utf8")).trim()
    assert.ok(Buffer.from(text, "base64url").length >= 32)
    assert.equal((await stat(f)).mode & 0o777, 0o600)
    assert.equal(t.check("Bearer " + text), true)
  })

  it("refuses a missing, wrong or malformed credential", async () => {
    const t = new TokenStore(await file())
    await t.load()
    assert.equal(t.check(undefined), false)
    assert.equal(t.check("Bearer nope"), false)
    assert.equal(t.check("Basic abc"), false)
    assert.equal(t.check("Bearer"), false)
  })

  it("keeps the token across loads and refuses the old one after rotation", async () => {
    const f = await file()
    const a = new TokenStore(f)
    await a.load()
    const old = (await readFile(f, "utf8")).trim()
    const b = new TokenStore(f)
    await b.load()
    assert.equal(b.check("Bearer " + old), true)
    const fresh = await b.rotate()
    assert.notEqual(fresh, old)
    assert.equal(b.check("Bearer " + old), false)
    assert.equal(b.check("Bearer " + fresh), true)
  })

  it("compares in constant time over equal digests", () => {
    assert.equal(safeEqual("a", "a"), true)
    assert.equal(safeEqual("a", "ab"), false)
    assert.equal(safeEqual("", ""), true)
  })
})
