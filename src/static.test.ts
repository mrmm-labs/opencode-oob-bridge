// Source-level guards for the safety criteria that a unit test cannot observe.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, it } from "node:test"

const dir = import.meta.dirname

async function sources(): Promise<Array<[string, string]>> {
  const files = (await readdir(dir)).filter(
    (f) => f.endsWith(".ts") && !f.includes(".test"),
  )
  return Promise.all(
    files.map(
      async (f) =>
        [f, await readFile(join(dir, f), "utf8")] as [string, string],
    ),
  )
}

describe("source guards", () => {
  it("AC-11: no synchronous child process, file or sqlite call", async () => {
    for (const [f, text] of await sources()) {
      assert.doesNotMatch(text, /\b\w+Sync\s*\(/, `${f} uses a *Sync call`)
      assert.doesNotMatch(text, /bun:sqlite|node:sqlite|better-sqlite/, f)
      assert.doesNotMatch(text, /from "node:fs"/, `${f} imports sync fs`)
    }
  })

  it("AC-10: only the host adapter replies to a permission, and only when a policy allows it", async () => {
    for (const [f, text] of await sources()) {
      if (f === "server.ts") continue
      assert.doesNotMatch(text, /permission\s*\.\s*reply|\/permission\//, f)
    }
  })
})
