import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  esc,
  fit,
  renderCard,
  renderStatus,
  starred,
} from "./telegram-render.ts"
import type { Card } from "./types.ts"

// Every tag closed, no stray < > or half an entity.
const wellFormed = (html: string) => {
  const stack: string[] = []
  for (const m of html.matchAll(/<(\/?)([a-z]+)>/g)) {
    if (m[1]) assert.equal(stack.pop(), m[2], `unbalanced </${m[2]}>`)
    else stack.push(m[2])
  }
  assert.deepEqual(stack, [])
  const text = html.replace(/<\/?[a-z]+>/g, "").replace(/&(amp|lt|gt);/g, "")
  assert.doesNotMatch(text, /[<>&]/)
}

const question = (
  over: Partial<Extract<Card, { kind: "question" }>> = {},
): Card => ({
  kind: "question",
  agent: "coord",
  project: "shop",
  questions: [
    {
      text: "Go?",
      options: [{ label: "Yes" }, { label: "No", detail: "later" }],
      multiple: false,
      custom: true,
    },
  ],
  ...over,
})

describe("telegram render", () => {
  it("escapes, and cuts text before escaping so an entity is never split", () => {
    assert.equal(esc("a<b>&c"), "a&lt;b&gt;&amp;c")
    for (const max of [5, 6, 9, 20]) {
      const out = fit("<<<<<<<<<<<<<<<<<<<<<<<<<<<<", max)
      assert.ok(out.length <= max, `${max}: ${out}`)
      wellFormed(out)
    }
    assert.equal(fit("short", 50), "short")
  })

  it("turns (Recommended) into a star before the label", () => {
    assert.equal(starred("Ship it (Recommended)"), "★ Ship it")
    assert.equal(starred("(recommended) Ship it"), "★ Ship it")
    assert.equal(starred("Wait"), "Wait")
  })

  it("never exceeds 4096 characters and never cuts a tag", () => {
    const big = "<&>".repeat(3000)
    const cards: Card[] = [
      question({
        questions: [
          {
            text: big,
            options: Array.from({ length: 40 }, (_, i) => ({
              label: `${big.slice(0, 500)} ${i}`,
              detail: big,
            })),
            multiple: false,
            custom: true,
          },
        ],
      }),
      question({
        questions: Array.from({ length: 300 }, () => ({
          header: big.slice(0, 200),
          text: big,
          options: [{ label: "a" }],
          multiple: false,
          custom: false,
        })),
      }),
      { kind: "permission", agent: "a", project: "p", detail: big },
      {
        kind: "closed",
        outcome: "answered",
        answer: big,
        via: "TUI",
        time: "10:00",
        quote: big,
      },
      { kind: "notice", text: big },
    ]
    for (const c of cards) {
      const html = renderCard(c, { footer: big })
      assert.ok(html.length <= 4096, `${c.kind}: ${html.length}`)
      wellFormed(html)
    }
  })

  it("lays out the status card", () => {
    const base = {
      id: "ses_abcdef123456",
      name: "n",
      project: "shop <x>",
      title: "Fix",
      state: "idle" as const,
      at: new Date(2026, 0, 1, 9, 5).getTime(),
    }
    assert.equal(
      renderStatus(base, "🎯"),
      "💤 <b>Idle</b> 09:05\n📌 Fix\n📁 shop &lt;x&gt; 🎯\n🆔 <code>123456</code>\n🕐 09:05",
    )
    assert.match(renderStatus({ ...base, chat: true }), /^💬 on — 💤/)
    const failed = { ...base, state: "failed" as const }
    assert.match(renderStatus(failed), /^❌ <b>Failed<\/b>/)
    assert.match(
      renderStatus({ ...failed, unstarted: true }),
      /^⚪ <b>Did not start<\/b>/,
    )
    assert.match(
      renderStatus({ ...base, state: "failed" }),
      /^❌ <b>Failed<\/b> 09:05/,
    )
  })

  it("the first line of the card, all a pinned bar shows, says how the session is watched and whether chat is on", () => {
    const base = {
      id: "s",
      name: "shop · Fix",
      project: "shop",
      state: "idle" as const,
      at: new Date(2026, 0, 1, 22, 6).getTime(),
    }
    const all = { mode: "on" as const, channel: "all", minutes: 10 }
    const on = { mode: "on" as const, channel: "telegram", minutes: 10 }
    const auto = { mode: "auto" as const, channel: "all", minutes: 15 }
    const off = { mode: "off" as const, channel: "all", minutes: 10 }
    const first = (s: Parameters<typeof renderStatus>[0]) =>
      renderStatus(s, "🍔")
        .split("\n")[0]
        .replace(/<\/?b>/g, "")
    assert.equal(
      first({ ...base, watch: all }),
      "👁 on · 💬 off — 💤 Idle 22:06",
    )
    assert.equal(
      first({ ...base, watch: on }),
      "👁 on·telegram · 💬 off — 💤 Idle 22:06",
    )
    assert.equal(
      first({ ...base, watch: on, chat: true }),
      "👁 on·telegram · 💬 on — 💤 Idle 22:06",
    )
    assert.equal(
      first({ ...base, watch: auto }),
      "⏱ auto · 💬 off — 💤 Idle 22:06",
    )
    assert.equal(
      first({ ...base, watch: auto, chat: true }),
      "⏱ auto · 💬 on — 💤 Idle 22:06",
    )
    assert.equal(
      first({ ...base, watch: off }),
      "🔕 off · 💬 off — 💤 Idle 22:06",
    )
    assert.equal(
      first({ ...base, watch: off, chat: true, state: "working" }),
      "🔕 off · 💬 on — 🟢 Working",
    )
    for (const w of [on, auto, off])
      assert.ok(
        first({ ...base, watch: w, chat: true, state: "failed" }).length <= 40,
        "fits a phone's pinned bar",
      )
    assert.equal(
      first(base),
      "💤 Idle 22:06",
      "no watch state, no chat: state only",
    )
    assert.match(
      renderStatus({ ...base, watch: on }),
      /\n👁 <b>Watched<\/b>: on via telegram\n/,
    )
    assert.match(
      renderStatus({ ...base, watch: auto }),
      /\n⏱ <b>Watched<\/b>: auto, after 15 min away\n/,
    )
    assert.match(
      renderStatus({ ...base, watch: off }),
      /\n🔕 <b>Not watched<\/b>\n/,
    )
  })
})
