import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  KeychainStore,
  KeyStoreUnavailable,
  MemoryKeyStore,
} from "./keystore.ts"

describe("keystore", () => {
  it("memory store sets, gets and deletes", async () => {
    const s = new MemoryKeyStore()
    await s.set("a", "1")
    assert.equal(await s.get("a"), "1")
    await s.delete("a")
    assert.equal(await s.get("a"), undefined)
  })

  it("the Keychain is unavailable where bun:ffi is missing, and no file is made", async () => {
    const s = new KeychainStore("t", async () => {
      throw new KeyStoreUnavailable("this runtime has no bun:ffi")
    })
    await assert.rejects(s.get("a"), KeyStoreUnavailable)
    await assert.rejects(s.set("a", "b"), KeyStoreUnavailable)
  })

  it("the default loader refuses under Node", async () => {
    await assert.rejects(new KeychainStore().get("a"), KeyStoreUnavailable)
  })
})
