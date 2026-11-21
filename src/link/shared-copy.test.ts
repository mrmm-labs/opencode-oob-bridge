import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"

describe("the relay's copies of the shared modules", () => {
  for (const f of ["frame.ts", "initdata.ts"])
    it(
      f + " is the bridge's file: run 'pnpm --dir relay sync' after a change",
      async () => {
        const a = await readFile(new URL("./" + f, import.meta.url), "utf8")
        const b = await readFile(
          new URL("../../relay/src/shared/" + f, import.meta.url),
          "utf8",
        )
        assert.equal(a, b)
      },
    )
})
