import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { inline, parse } from "./md.js"

const text = (v) => ({ t: "text", v })

describe("inline", () => {
  it("reads code, bold, italic and a link, and leaves the rest as text", () => {
    assert.deepEqual(inline("a `b` **c** *d* [e](https://x.test/y)"), [
      text("a "),
      { t: "ic", v: "b" },
      text(" "),
      { t: "b", c: [text("c")] },
      text(" "),
      { t: "i", c: [text("d")] },
      text(" "),
      { t: "a", href: "https://x.test/y", c: [text("e")] },
    ])
  })

  it("does not read markup inside code, and links only http and https", () => {
    assert.deepEqual(inline("`**no**`"), [{ t: "ic", v: "**no**" }])
    assert.deepEqual(inline("[x](javascript:alert(1))"), [
      text("[x](javascript:alert(1))"),
    ])
    assert.deepEqual(inline("[x](data:text/html,hi)"), [
      text("[x](data:text/html,hi)"),
    ])
  })

  it("keeps an HTML tag as text", () => {
    assert.deepEqual(inline("<img src=x onerror=alert(1)>"), [
      text("<img src=x onerror=alert(1)>"),
    ])
  })

  it("stays quick on a long run of stars and brackets", () => {
    const t = Date.now()
    inline("*".repeat(20_000) + "[".repeat(20_000) + "`".repeat(20_000))
    assert.ok(Date.now() - t < 500)
  })
})

describe("parse", () => {
  it("makes paragraphs, headings and lists", () => {
    const b = parse("# Title\n\nOne\ntwo\n\n- a\n- b\n\n1. x\n2) y")
    assert.deepEqual(
      b.map((x) => x.t),
      ["h", "p", "ul", "ol"],
    )
    assert.equal(b[0].level, 1)
    assert.equal(b[2].items.length, 2)
    assert.equal(b[3].items.length, 2)
  })

  it("keeps a fenced block as it is, with its language, and closes at the end of the text", () => {
    assert.deepEqual(parse("```ts\nconst a = **1**\n```\nafter"), [
      { t: "pre", lang: "ts", v: "const a = **1**" },
      { t: "p", c: [text("after")] },
    ])
    assert.deepEqual(parse("```\nopen"), [{ t: "pre", lang: "", v: "open" }])
  })

  it("reads a table with its header and rows", () => {
    const [t] = parse("| a | b |\n|---|:-:|\n| 1 | **2** |\n| 3 | 4 |\n\ntext")
    assert.equal(t.t, "table")
    assert.deepEqual(t.head, [[text("a")], [text("b")]])
    assert.equal(t.rows.length, 2)
    assert.deepEqual(t.rows[0][1], [{ t: "b", c: [text("2")] }])
  })

  it("does not take a line with pipes for a table without the separator row", () => {
    assert.deepEqual(
      parse("| a | b |\n| c | d |").map((x) => x.t),
      ["p"],
    )
  })

  it("gives nothing for an empty or missing text", () => {
    assert.deepEqual(parse(""), [])
    assert.deepEqual(parse(undefined), [])
    assert.deepEqual(parse("\n\n"), [])
  })
})
