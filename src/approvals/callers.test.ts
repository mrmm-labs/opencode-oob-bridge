import assert from "node:assert/strict"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { CallerStore, mac, proof } from "./callers.ts"

const NOW = 1_800_000_000_000

async function setup() {
  const dir = join(await mkdtemp(join(tmpdir(), "oob-callers-")), "callers")
  const store = new CallerStore(dir)
  const f = await store.pair("secrets-tool", [], "/x/approvals.sock", NOW)
  return { dir, store, f }
}

describe("callers", () => {
  it("writes the caller file as 0600 in a 0700 directory", async () => {
    const { dir } = await setup()
    assert.equal((await stat(dir)).mode & 0o777, 0o700)
    assert.equal((await stat(join(dir, "secrets-tool.json"))).mode & 0o777, 0o600)
  })

  it("accepts a good proof and reloads from disk", async () => {
    const { dir, f } = await setup()
    const again = new CallerStore(dir)
    await again.load()
    assert.deepEqual(again.names(), ["secrets-tool"])
    const body = '{"a":1}'
    const h = proof(f, "POST", "/v1/approvals", body, NOW)
    assert.deepEqual(again.verify(h, "POST", "/v1/approvals", body, NOW), {
      ok: true,
      caller: "secrets-tool",
    })
  })

  it("refuses an unknown caller", async () => {
    const { store, f } = await setup()
    const h = proof({ ...f, name: "other" }, "GET", "/v1/status", "", NOW)
    assert.deepEqual(store.verify(h, "GET", "/v1/status", "", NOW), {
      ok: false,
      reason: "unknown",
    })
  })

  it("refuses a bad mac, a changed body, a changed path and a changed method", async () => {
    const { store, f } = await setup()
    const h = proof(f, "POST", "/v1/approvals", "a", NOW)
    const bad = { ...h, "x-caller-mac": mac("00".repeat(32), "POST", "/v1/approvals", h["x-caller-ts"], "a") }
    assert.equal(store.verify(bad, "POST", "/v1/approvals", "a", NOW).ok, false)
    for (const [m, p, b] of [
      ["POST", "/v1/approvals", "b"],
      ["POST", "/v1/other", "a"],
      ["DELETE", "/v1/approvals", "a"],
    ] as const)
      assert.deepEqual(store.verify(h, m, p, b, NOW), { ok: false, reason: "mac" })
  })

  it("refuses a timestamp 90 seconds old and accepts one 30 seconds old", async () => {
    const { store, f } = await setup()
    const old = proof(f, "GET", "/v1/status", "", NOW - 90_000)
    assert.deepEqual(store.verify(old, "GET", "/v1/status", "", NOW), {
      ok: false,
      reason: "skew",
    })
    const ok = proof(f, "GET", "/v1/status", "", NOW - 30_000)
    assert.equal(store.verify(ok, "GET", "/v1/status", "", NOW).ok, true)
  })

  it("refuses a replayed proof", async () => {
    const { store, f } = await setup()
    const h = proof(f, "GET", "/v1/status", "", NOW)
    assert.equal(store.verify(h, "GET", "/v1/status", "", NOW).ok, true)
    assert.deepEqual(store.verify(h, "GET", "/v1/status", "", NOW + 1000), {
      ok: false,
      reason: "replay",
    })
  })

  it("refuses missing headers, a bad name, and a revoked caller", async () => {
    const { dir, store, f } = await setup()
    assert.deepEqual(store.verify({}, "GET", "/", "", NOW), { ok: false, reason: "missing" })
    await assert.rejects(store.pair("../x", [], "s"), /caller name/)
    assert.equal(await store.revoke("secrets-tool"), true)
    const h = proof(f, "GET", "/v1/status", "", NOW)
    assert.equal(store.verify(h, "GET", "/v1/status", "", NOW).ok, false)
    await assert.rejects(readFile(join(dir, "secrets-tool.json")))
  })
})
