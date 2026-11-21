/**
 * Real check of the Keychain store, through the host executable (it has bun:ffi):
 *
 *   BUN_BE_BUN=1 opencode src/real/keychain.real.test-util.ts
 *
 * Creates, reads, replaces and deletes one item of its own, and prints one JSON line.
 * Exits 1 when a step fails. If macOS shows a prompt, stop and report it.
 */
import { KeychainStore } from "../approvals/keystore.ts"

const store = new KeychainStore("opencode-oob-bridge.real-check")
const name = `probe-${process.pid}`
const steps: Array<[string, unknown]> = []
let failed = false
const step = async (label: string, fn: () => Promise<unknown>) => {
  try {
    steps.push([label, await fn()])
  } catch (err) {
    failed = true
    steps.push([label, `FAILED: ${(err as Error).message}`])
  }
}

await step("read before", () => store.get(name))
await step("set", () => store.set(name, "first-value").then(() => "ok"))
await step("read", async () => (await store.get(name)) === "first-value")
await step("replace", () => store.set(name, "second-value").then(() => "ok"))
await step(
  "read after replace",
  async () => (await store.get(name)) === "second-value",
)
await step("delete", () => store.delete(name).then(() => "ok"))
await step("read after delete", () => store.get(name))
console.log(
  JSON.stringify({ exec: process.execPath, bun: process.versions.bun, steps }),
)
process.exit(failed ? 1 : 0)
