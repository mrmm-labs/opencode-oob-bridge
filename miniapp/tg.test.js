import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { contrast, launch, readable, themeVars } from "./tg.js"

const loc = (hash, search = "") => ({ hash, search })

describe("launch parameters", () => {
  it("reads init data, theme and start parameter from the hash", () => {
    const init =
      "query_id=A&user=" + encodeURIComponent('{"id":1}') + "&hash=ab"
    const theme = JSON.stringify({ bg_color: "#112233" })
    const hash =
      "#tgWebAppData=" +
      encodeURIComponent(init) +
      "&tgWebAppThemeParams=" +
      encodeURIComponent(theme) +
      "&tgWebAppStartParam=ses_abc-1"
    const p = launch(loc(hash))
    assert.equal(p.initData, init)
    assert.deepEqual(p.theme, { bg_color: "#112233" })
    assert.equal(p.start, "ses_abc-1")
  })

  it("takes the session from ?s= when the hash has none, and refuses odd characters", () => {
    assert.equal(launch(loc("", "?s=ses_9")).start, "ses_9")
    assert.equal(launch(loc("#tgWebAppStartParam=a/b")).start, "")
    assert.equal(launch(loc("#tgWebAppStartParam=" + "x".repeat(65))).start, "")
  })

  it("survives a missing or broken hash", () => {
    const p = launch(loc("#tgWebAppThemeParams=%7Bnot-json"))
    assert.deepEqual(p, { initData: "", theme: {}, start: "" })
    assert.equal(launch(loc("")).initData, "")
  })
})

describe("theme", () => {
  it("measures contrast like WCAG", () => {
    assert.equal(Math.round(contrast("#000000", "#ffffff")), 21)
    assert.equal(contrast("#777777", "nope"), undefined)
  })

  it("keeps a theme text colour that reads and replaces one that does not", () => {
    assert.equal(readable("#ffffff", "#000000"), "#ffffff")
    assert.equal(readable("#777777", "#808080", "#000000"), "#000000")
    assert.equal(readable("#777777", "#808080"), "#000000")
  })

  it("keeps every pair of the dark theme at 4.5:1", () => {
    const v = themeVars({
      bg_color: "#17212b",
      text_color: "#f5f5f5",
      hint_color: "#708499",
      link_color: "#6ab3f3",
      button_color: "#5288c1",
      button_text_color: "#ffffff",
      secondary_bg_color: "#232e3c",
      destructive_text_color: "#ec3942",
    })
    assert.equal(v["--scheme"], "dark")
    for (const [fg, bg] of [
      ["--text", "--bg"],
      ["--hint", "--bg2"],
      ["--link", "--bg"],
      ["--btn-text", "--btn"],
      ["--danger", "--bg2"],
    ])
      assert.ok(
        contrast(v[fg], v[bg]) >= 4.5,
        fg + " on " + bg + " " + contrast(v[fg], v[bg]),
      )
  })

  it("sets nothing for a theme it cannot read, so the stylesheet defaults stay", () => {
    assert.deepEqual(themeVars({}), {})
    assert.deepEqual(themeVars({ bg_color: "red", text_color: "blue" }), {})
  })
})
