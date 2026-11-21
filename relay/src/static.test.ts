import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { describe, it } from "node:test"

const here = new URL("./", import.meta.url)
const sources = async () =>
  Promise.all(
    (await readdir(here))
      .filter((f) => f.endsWith(".ts") && !/\.test(-util)?\.ts$/.test(f))
      .map(async (f) => [f, await readFile(new URL(f, here), "utf8")] as const),
  )

describe("relay source guards", () => {
  it("never reads Telegram updates or sets a webhook", async () => {
    for (const [f, text] of await sources())
      assert.doesNotMatch(
        text,
        /getUpdates|setWebhook|deleteWebhook|getWebhookInfo/,
        f,
      )
  })

  it("calls Telegram in one place, and only sendMessage", async () => {
    const hits = (await sources()).filter(([, t]) => /\/bot\$\{/.test(t))
    assert.deepEqual(
      hits.map(([f]) => f),
      ["deadman.ts"],
    )
    const d = hits[0][1]
    assert.equal((d.match(/\/sendMessage/g) ?? []).length, 1)
    assert.doesNotMatch(d, /\/bot\$\{[^}]+\}\/(?!sendMessage)/)
  })

  it("logs only through log(), and never a header, body or URL", async () => {
    for (const [f, text] of await sources()) {
      if (f === "log.ts") continue
      assert.doesNotMatch(text, /console\.|process\.std(out|err)\.write/, f)
      for (const m of text.matchAll(/\blog\("[a-z_]+",\s*\{([^}]*)\}/g))
        assert.doesNotMatch(
          m[1].replace(/[\w.]+ !== undefined/g, "yes"),
          /req\b|headers|url|body|authorization|token|secret/i,
          f + ": " + m[0],
        )
    }
  })

  it("has no synchronous call outside start-up", async () => {
    for (const [f, text] of await sources())
      if (f !== "config.ts") assert.doesNotMatch(text, /\b\w+Sync\s*\(/, f)
  })
})
