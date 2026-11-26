import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { Bridge, type BridgeEvent, type Host } from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { renderTurnCard } from "./connectors/telegram-render.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import type { Connector, Push, TurnCard } from "./connectors/types.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"
import {
  delta,
  header,
  lastParagraph,
  plain,
  shouldCard,
  stats,
} from "./turncard.ts"
import { sleep } from "./util.ts"

const CHAT = 4242
const SECRET = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"

type F = { file: string; additions: number; deletions: number; patch: string }
const file = (name: string, a = 1, d = 0): F => ({
  file: name,
  status: "modified",
  additions: a,
  deletions: d,
  patch: "diff --git a/" + name + " b/" + name,
})

async function rig(
  o: {
    turnCard?: unknown
    chat?: Record<string, unknown>
    diff?: () => Promise<F[]>
    stopped?: boolean
    diffCfg?: unknown
  } = {},
) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-card-"))
  const channel = new TelegramConnector({
    token: async () => tg.token,
    chatId: String(CHAT),
    apiBase: tg.url,
    topicsFile: join(dir, "topics.json"),
    offsetFile: join(dir, "offset.json"),
    pollSeconds: 1,
    backoff: { min: 10, max: 40 },
  })
  const cfg = parseConfig({
    channels: { telegram: { token: { env: "X" } } },
    chat: o.chat,
    turnCard: o.turnCard,
    diff: o.diffCfg,
  }) as Config
  const state = { files: [] as F[], prompts: [] as string[], stops: 0 }
  const host: Host = {
    session: async (id) =>
      id === "root"
        ? { id, agent: "coord", directory: "/w/shop", title: "Fix" }
        : undefined,
    root: (id) => (id === "sub" ? "root" : id),
    replyForm: async () => {},
    prompt: async (_id, text) => void state.prompts.push(text),
    interrupt: async () => (state.stops++, o.stopped ?? true),
    busy: () => false,
    diff: o.diff ?? (async () => state.files),
  }
  const router = new Router(cfg, async () => true)
  router.setAfk("on", Infinity)
  router.set("root", true)
  const bridge = new Bridge(
    cfg,
    host,
    [channel],
    new PendingStore(),
    router,
    Date.now,
  )
  bridge.start()
  const ev = (type: string, data: Record<string, unknown> = {}, id = "root") =>
    bridge.onEvent({
      type,
      data: { sessionID: id, ...data },
    } as unknown as BridgeEvent)
  const cards = () =>
    tg
      .of("sendMessage")
      .map((c) => c.body)
      .filter((b) => /Done|Failed/.test(b.text ?? ""))
  return {
    tg,
    bridge,
    state,
    ev,
    cards,
    /** A turn that ends with `files` changed and `text` as the final answer. */
    async turn(change: F[] = [], text = "", ok = true, id = "root") {
      await ev("session.execution.started", {}, id)
      await sleep(20)
      state.files = change
      if (text)
        await ev(
          "session.text.ended",
          { assistantMessageID: "m" + Math.random(), ordinal: 0, text },
          id,
        )
      await ev(
        ok ? "session.execution.succeeded" : "session.execution.failed",
        {},
        id,
      )
    },
    async done() {
      await bridge.stop()
      await tg.close()
    },
  }
}

const keys = (b: { reply_markup?: any }) =>
  (b.reply_markup?.inline_keyboard?.[0] ?? []).map(
    (k: { text: string }) => k.text,
  )

describe("turn card: when one is posted", () => {
  it("is posted for a turn that changed files, with the counts in the header", async () => {
    const r = await rig()
    await r.bridge.setChat("root", true)
    await r.turn(
      [file("a.ts", 3, 1), file("b.ts", 2, 0), file("c.ts", 1, 1)],
      "Intro.\n\nFixed the parser.",
    )
    const c = await r.tg.waitFor(() => r.cards()[0])
    assert.match(c.text, /<b>✅ Done · 3 files · \+6 −2 · \d+s<\/b>/)
    assert.match(c.text, /<blockquote expandable>Fixed the parser\./)
    assert.match(c.text, /• a\.ts/)
    assert.deepEqual(keys(c), ["Diff", "Continue", "QA", "Update", "Stop"])
    assert.equal(r.cards().length, 1)
    await r.done()
  })

  it("counts only what the turn changed, not what was already modified", async () => {
    const r = await rig()
    r.state.files = [file("old.ts", 40, 4)]
    await r.turn([file("old.ts", 40, 4), file("new.ts", 5, 0)])
    const c = await r.tg.waitFor(() => r.cards()[0])
    assert.match(c.text, /1 file · \+5 −0/)
    assert.doesNotMatch(c.text, /old\.ts/)
    await r.done()
  })

  it("is not posted for a short turn that changed nothing", async () => {
    const r = await rig()
    await r.turn([])
    await sleep(200)
    assert.equal(r.cards().length, 0)
    await r.done()
  })

  it("is posted for a long turn without changes, and leaves the counts out", async () => {
    const r = await rig({ turnCard: { minSeconds: 0 } })
    await r.turn([])
    const c = await r.tg.waitFor(() => r.cards()[0])
    assert.match(c.text, /<b>✅ Done · \d+s<\/b>/)
    await r.done()
  })

  it("is not posted for a subagent's turn", async () => {
    const r = await rig()
    await r.turn([file("a.ts")], "", true, "sub")
    await sleep(200)
    assert.equal(r.cards().length, 0)
    await r.done()
  })

  it("is off with turnCard: false", async () => {
    const r = await rig({ turnCard: false })
    await r.turn([file("a.ts")])
    await sleep(200)
    assert.equal(r.cards().length, 0)
    await r.done()
  })

  it("shows no counts when the changes cannot be read, never invented ones", async () => {
    const r = await rig({
      turnCard: { minSeconds: 0 },
      diff: async () => {
        throw new Error("no git")
      },
    })
    await r.turn([file("a.ts")])
    const c = await r.tg.waitFor(() => r.cards()[0])
    assert.doesNotMatch(c.text, /files?\b|\+\d/)
    await r.done()
  })

  it("marks a failed turn", async () => {
    const r = await rig()
    await r.turn([file("a.ts")], "", false)
    const c = await r.tg.waitFor(() => r.cards()[0])
    assert.match(c.text, /❌ Failed/)
    await r.done()
  })

  it("masks secrets in the summary and file names, and hides both under redact title", async () => {
    const r = await rig()
    await r.bridge.setChat("root", true)
    await r.turn([file("key-" + SECRET + ".txt")], "Rotated " + SECRET)
    const c = await r.tg.waitFor(() => r.cards()[0])
    assert.ok(!c.text.includes(SECRET))
    assert.match(c.text, /redacted/)
    await r.done()
    const h = await rig({ chat: { redact: "title" } })
    await h.bridge.setChat("root", true)
    await h.turn([file("secret.ts")], "Rotated things")
    const d = await h.tg.waitFor(() => h.cards()[0])
    assert.doesNotMatch(d.text, /secret\.ts|Rotated/)
    await h.done()
  })
})

describe("turn card: buttons", () => {
  const tap = (r: Awaited<ReturnType<typeof rig>>, data: string) =>
    r.tg.callback(CHAT, 1, data, 9001)

  it("Diff sends the patch as a document", async () => {
    const r = await rig()
    await r.turn([file("a.ts")])
    await r.tg.waitFor(() => r.cards()[0])
    tap(r, "ctl:diff")
    const d = await r.tg.waitFor(() => r.tg.of("sendDocument")[0])
    assert.match(JSON.stringify(d.body), /diff --git a\/a\.ts/)
    await r.done()
  })

  it("Continue sends continue as a prompt, and is missing when chat is off", async () => {
    const r = await rig()
    await r.bridge.setChat("root", true)
    await r.turn([file("a.ts")])
    await r.tg.waitFor(() => r.cards()[0])
    tap(r, "ctl:continue")
    await r.tg.waitFor(() => r.state.prompts[0])
    assert.deepEqual(r.state.prompts, ["continue"])
    await r.done()
    const off = await rig()
    await off.turn([file("a.ts")])
    const c = await off.tg.waitFor(() => off.cards()[0])
    assert.deepEqual(keys(c), ["Diff", "Stop"])
    await off.done()
  })

  it("Update is on the card, and a tap sends its instruction once", async () => {
    const r = await rig()
    await r.bridge.setChat("root", true)
    await r.turn([file("a.ts")])
    await r.tg.waitFor(() => r.cards()[0])
    tap(r, "ctl:update")
    const a = await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.match(a.body.text, /⏳ Update sent to /)
    assert.equal(r.state.prompts.length, 1)
    assert.match(r.state.prompts[0], /^Give a short progress update now:/)
    await r.done()
  })

  it("QA is on the card next to Continue, and a tap sends the instruction once", async () => {
    const r = await rig()
    await r.bridge.setChat("root", true)
    await r.turn([file("a.ts")])
    const c = await r.tg.waitFor(() => r.cards()[0])
    assert.deepEqual(keys(c), ["Diff", "Continue", "QA", "Update", "Stop"])
    tap(r, "ctl:qa")
    const a = await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.match(a.body.text, /⏳ QA sent to /)
    assert.equal(r.state.prompts.length, 1)
    assert.match(
      r.state.prompts[0],
      /^Run an interactive Q&A on the open decisions now\./,
    )
    assert.doesNotMatch(r.state.prompts[0], /Focus:/)
    await r.done()
  })

  it("a QA or Update tap with chat off, from another chat or from an unknown topic sends nothing", async () => {
    const off = await rig()
    await off.turn([file("a.ts")])
    const c = await off.tg.waitFor(() => off.cards()[0])
    assert.deepEqual(keys(c), ["Diff", "Stop"])
    tap(off, "ctl:qa")
    tap(off, "ctl:update")
    await off.tg.waitFor(
      () =>
        off.tg
          .of("sendMessage")
          .filter((c) => /not delivered: Chat is off/.test(c.body.text))
          .length >= 2 || undefined,
    )
    assert.deepEqual(off.state.prompts, [])
    await off.done()
    const r = await rig()
    await r.bridge.setChat("root", true)
    await r.turn([file("a.ts")])
    await r.tg.waitFor(() => r.cards()[0])
    r.tg.callback(999, 1, "ctl:qa", 9001)
    r.tg.callback(CHAT, 1, "ctl:qa", 7777)
    r.tg.callback(999, 1, "ctl:update", 9001)
    r.tg.callback(CHAT, 1, "ctl:update", 7777)
    const b = await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.match(b.body.text, /Unknown session/)
    await sleep(200)
    assert.deepEqual(r.state.prompts, [])
    await r.done()
  })

  it("Stop interrupts a running turn, or says nothing is running", async () => {
    const r = await rig()
    await r.turn([file("a.ts")])
    await r.tg.waitFor(() => r.cards()[0])
    tap(r, "ctl:stop")
    await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.equal(r.state.stops, 1)
    assert.match(r.tg.of("answerCallbackQuery")[0].body.text, /Stopped/)
    await r.done()
    const idle = await rig({ stopped: false })
    await idle.turn([file("a.ts")])
    await idle.tg.waitFor(() => idle.cards()[0])
    tap(idle, "ctl:stop")
    await idle.tg.waitFor(() => idle.tg.of("answerCallbackQuery")[0])
    assert.match(
      idle.tg.of("answerCallbackQuery")[0].body.text,
      /Nothing is running/,
    )
    await idle.done()
  })

  it("a second card takes the buttons off the first", async () => {
    const r = await rig()
    await r.turn([file("a.ts")])
    const first = await r.tg.waitFor(() => r.cards()[0])
    void first
    const firstId = r.tg.lastMessageId
    await r.turn([file("a.ts"), file("b.ts")])
    await r.tg.waitFor(() => r.cards()[1])
    const e = await r.tg.waitFor(() => r.tg.of("editMessageReplyMarkup")[0])
    assert.equal(e.body.message_id, firstId)
    assert.deepEqual(e.body.reply_markup, { inline_keyboard: [] })
    await r.done()
  })

  it("the buttons go after an hour", async () => {
    const r = await rig()
    ;(r.bridge as unknown as { cardTtlMs: number }).cardTtlMs = 60
    await r.turn([file("a.ts")])
    await r.tg.waitFor(() => r.cards()[0])
    await r.tg.waitFor(() => r.tg.of("editMessageReplyMarkup")[0])
    await r.done()
  })
})

describe("turn card: rendering and the pure parts", () => {
  const card = (n: number, summary = "Fixed it."): TurnCard => ({
    failed: false,
    duration: "3m 12s",
    changes: { files: n, added: 320, removed: 41 },
    summary,
    files: Array.from({ length: n }, (_, i) => "src/f" + i + ".ts"),
  })

  it("the header reads like the spec", () => {
    assert.equal(header(card(14)), "✅ Done · 14 files · +320 −41 · 3m12s")
    assert.equal(header(card(1)).split(" · ")[1], "1 file")
    assert.equal(
      header({ failed: true, files: [], duration: "5s" }),
      "❌ Failed · 5s",
    )
  })

  it("lists up to 15 files then how many more, inside a fold", () => {
    for (const [n, shown, more] of [
      [1, 1, 0],
      [15, 15, 0],
      [40, 15, 25],
    ]) {
      const html = renderTurnCard(card(n))
      assert.match(html, /<blockquote expandable>/)
      assert.equal((html.match(/• /g) ?? []).length, shown)
      assert.equal(/\+25 more/.test(html), more === 25)
      assert.ok(html.length < 4096)
    }
  })

  it("escapes markup in the summary", () => {
    assert.match(renderTurnCard(card(1, "a <b> & c")), /a &lt;b&gt; &amp; c/)
  })

  it("the plain form is the header and at most 300 characters of summary, no files", () => {
    const p = plain(card(3, "x".repeat(500)))
    assert.ok(p.startsWith("✅ Done · 3 files"))
    assert.ok(p.split("\n")[1].length <= 300)
    assert.doesNotMatch(p, /src\/f0/)
  })

  it("a channel without folding gets the plain card through send", async () => {
    const r = await rig()
    const sent: Push[] = []
    const plainCh = {
      id: "plain",
      type: "plain",
      enabled: true,
      capabilities: {
        buttons: false,
        edit: false,
        multiselect: false,
        rich: false,
        threads: true,
        pairing: false,
        inboundPrompt: false,
      },
      start() {},
      hint: () => "",
      async send(p: Push) {
        sent.push(p)
        return "1"
      },
      status: () => ({ state: "ok" }),
    } as unknown as Connector
    const cfg = parseConfig({
      channels: { telegram: { token: { env: "X" } } },
    }) as Config
    const router = new Router(cfg, async () => true)
    router.setAfk("on", Infinity)
    let calls = 0
    const host = {} as unknown as Host
    const b = new Bridge(
      cfg,
      {
        ...host,
        session: async (id: string) => ({ id, agent: "x", directory: "/w" }),
        root: (id: string) => id,
        busy: () => false,
        diff: async () => (calls++ === 0 ? [] : [file("a.ts")]),
      } as unknown as Host,
      [plainCh],
      new PendingStore(),
      router,
      Date.now,
    )
    b.start()
    router.set("root", true)
    const e = (type: string) =>
      b.onEvent({ type, data: { sessionID: "root" } } as unknown as BridgeEvent)
    await e("session.execution.started")
    await sleep(10)
    await e("session.execution.succeeded")
    const card = sent.find((p) => /Done/.test(p.message) && !p.title)
    void card
    assert.ok(
      sent.some((p) => p.message.startsWith("✅ Done")),
      JSON.stringify(sent.map((p) => p.message)),
    )
    await b.stop()
    await r.done()
  })

  it("delta, lastParagraph and shouldCard", () => {
    const before = stats([file("a.ts", 1, 1)])
    assert.deepEqual(delta(before, [file("a.ts", 1, 1), file("b.ts", 2, 0)]), {
      files: ["b.ts"],
      added: 2,
      removed: 0,
    })
    assert.equal(delta(undefined, [file("a.ts")]), undefined)
    assert.equal(lastParagraph("one\n\ntwo\n\n three ", 10), "three")
    assert.equal(lastParagraph("x".repeat(20), 5), "xxxx…")
    assert.equal(shouldCard({ minSeconds: 20, seconds: 5 }), false)
    assert.equal(shouldCard({ minSeconds: 20, seconds: 25 }), true)
    assert.equal(shouldCard({ minSeconds: 20, seconds: 1, changed: 1 }), true)
  })
})

describe("turn card: the Diff button draws images", () => {
  const tap = (r: Awaited<ReturnType<typeof rig>>, data: string) =>
    r.tg.callback(CHAT, 1, data, 9001)
  const hunk = (n: number, name = "a.ts"): F => ({
    file: name,
    status: "modified",
    additions: n,
    deletions: 0,
    patch: [
      "diff --git a/" + name + " b/" + name,
      `@@ -1,${n} +1,${n} @@`,
      ...Array.from({ length: n }, (_, i) => "+line " + i),
    ].join("\n"),
  })
  const diffed = async (files: F[], o: Parameters<typeof rig>[0] = {}) => {
    const r = await rig(o)
    await r.turn(files)
    await r.tg.waitFor(() => r.cards()[0])
    tap(r, "ctl:diff")
    return r
  }

  it("a small diff is one photo and the patch document", async () => {
    const r = await diffed([hunk(5)])
    const p = await r.tg.waitFor(() => r.tg.of("sendPhoto")[0])
    assert.match(p.body.fields.caption, /1 file \+5 -0/)
    const d = await r.tg.waitFor(() => r.tg.of("sendDocument")[0])
    assert.match(d.body.fields.document, /\+line 4/)
    assert.equal(d.body.fields.caption, "📄 Patch")
    assert.equal(r.tg.of("sendMediaGroup").length, 0)
    await r.done()
  })

  it("a large diff is an album of three, and the caption says the rest is in the patch", async () => {
    const r = await diffed([hunk(500)])
    const g = await r.tg.waitFor(() => r.tg.of("sendMediaGroup")[0])
    const media = JSON.parse(g.body.fields.media)
    assert.equal(media.length, 3)
    assert.deepEqual(
      media.map((m: { media: string }) => m.media),
      ["attach://p0", "attach://p1", "attach://p2"],
    )
    assert.match(media[0].caption, /more lines are only in the patch/)
    const d = await r.tg.waitFor(() => r.tg.of("sendDocument")[0])
    assert.match(d.body.fields.document, /\+line 499/)
    await r.done()
  })

  it("a hidden file is named, not drawn, and not in the patch", async () => {
    const r = await diffed([hunk(2, ".env.local"), hunk(2, "b.ts")])
    const d = await r.tg.waitFor(() => r.tg.of("sendDocument")[0])
    assert.doesNotMatch(d.body.fields.document, /env\.local/)
    assert.match(d.body.fields.document, /b\.ts/)
    await r.done()
  })

  it("diff.exclude replaces the default globs", async () => {
    const r = await diffed([hunk(2, ".env.local"), hunk(2, "b.ts")], {
      diffCfg: { exclude: ["**/b.ts"] },
    })
    const d = await r.tg.waitFor(() => r.tg.of("sendDocument")[0])
    assert.match(d.body.fields.document, /env\.local/)
    assert.doesNotMatch(d.body.fields.document, /\+\+\+ b|a\/b\.ts/)
    await r.done()
  })

  it("when drawing fails the patch and the file list are sent", async () => {
    const r = await rig()
    ;(r.bridge as unknown as { drawer: () => Promise<never> }).drawer =
      async () => {
        throw new Error("encoder broke")
      }
    await r.turn([hunk(3, "a.ts"), hunk(3, "b.ts")])
    await r.tg.waitFor(() => r.cards()[0])
    tap(r, "ctl:diff")
    const d = await r.tg.waitFor(() => r.tg.of("sendDocument")[0])
    assert.match(d.body.fields.caption, /images unavailable: a\.ts, b\.ts/)
    assert.match(d.body.fields.document, /\+line 2/)
    assert.equal(
      r.tg.of("sendPhoto").length + r.tg.of("sendMediaGroup").length,
      0,
    )
    await r.done()
  })

  it("a denied session gets no diff and is told why", async () => {
    const r = await rig({ chat: { deny: [{ directory: "**/shop" }] } })
    await r.turn([hunk(2)])
    await r.tg.waitFor(() => r.cards()[0])
    tap(r, "ctl:diff")
    const t = await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.match(t.body.text, /chat\.deny/)
    assert.equal(r.tg.of("sendDocument").length, 0)
    await r.done()
  })

  it("diff.theme must be dark or light", () => {
    const c = (diff: unknown) =>
      parseConfig({ channels: { telegram: { token: { env: "X" } } }, diff })
    assert.equal((c({ theme: "light" }) as Config).diff.theme, "light")
    assert.ok("error" in (c({ theme: "blue" }) as object))
    assert.ok("error" in (c({ exclude: [1] }) as object))
    assert.deepEqual((c(undefined) as Config).diff.exclude, [
      "**/.env*",
      "**/*.pem",
      "**/*secret*",
      "**/id_*",
    ])
  })
})
