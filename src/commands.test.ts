import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { Bridge, type BridgeEvent, type Host } from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import { Telemetry } from "./otel.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"
import { sleep } from "./util.ts"

const CHAT = -1001234567890
const THREAD = 9001
const BOT = "oob_test_bot"

const MODELS = Array.from({ length: 14 }, (_, i) => ({
  ref: `prov/m${i}`,
  name: `Model ${i}`,
  variants: i === 0 ? ["low", "high"] : [],
}))

type Rig = Awaited<ReturnType<typeof rig>>

async function rig(
  o: {
    chat?: Record<string, unknown>
    posts?: string[]
    chatOn?: boolean
    host?: Partial<Host>
    menuStore?: { get(): string | undefined; set(key: string): void }
    stuck?: Array<{ id: string; label: string; pending: number }>
  } = {},
) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-cmd-"))
  const tel = o.posts
    ? new Telemetry(
        { endpoint: "https://otel.example" },
        async (_url, init) => {
          o.posts!.push(String(init.body))
          return new Response("{}", { status: 200 })
        },
        60_000,
      )
    : undefined
  const channel = new TelegramConnector({
    token: async () => tg.token,
    chatId: String(CHAT),
    apiBase: tg.url,
    topicsFile: join(dir, "topics.json"),
    offsetFile: join(dir, "offset.json"),
    pollSeconds: 1,
    backoff: { min: 10, max: 40 },
    tel,
    menuStore: o.menuStore,
  })
  const cfg = parseConfig({
    channels: { telegram: { token: { env: "X" } } },
    chat: {
      projects: {
        shop: { directory: "/w/shop", agent: "build", model: "prov/m1" },
        docs: { directory: "/w/docs" },
        secret: { directory: "/w/payroll" },
      },
      deny: [{ directory: "**/payroll" }],
      ...o.chat,
    },
  }) as Config
  const log = {
    created: [] as Array<Record<string, unknown>>,
    prompts: [] as Array<{ sessionID: string; text: string }>,
    deliveries: [] as string[],
    models: [] as Array<{ sessionID: string; model: unknown }>,
    agents: [] as Array<{ sessionID: string; agent: string }>,
    interrupts: [] as string[],
    compacts: [] as string[],
    renames: [] as Array<{ sessionID: string; title: string }>,
  }
  const state = {
    running: false,
    seq: 0,
    model: "m1",
    variant: undefined as string | undefined,
  }
  const host: Host = {
    session: async (id) =>
      id === "root" || id.startsWith("new_")
        ? {
            id,
            agent: "coord",
            directory: id === "root" ? "/w/shop" : "/w/other",
            title: "Fix",
            model: state.model,
            modelRef: {
              providerID: "prov",
              id: state.model,
              variant: state.variant,
            },
          }
        : undefined,
    root: (id) => id,
    replyForm: async () => {},
    prompt: async (sessionID, text, delivery) => {
      log.deliveries.push(delivery)
      log.prompts.push({ sessionID, text })
    },
    busy: () => state.running,
    createSession: async (c) => {
      log.created.push(c)
      return { id: `new_${++state.seq}` }
    },
    switchModel: async (sessionID, model) => {
      log.models.push({ sessionID, model })
    },
    switchAgent: async (sessionID, agent) => {
      log.agents.push({ sessionID, agent })
    },
    interrupt: async (sessionID) => {
      log.interrupts.push(sessionID)
      return state.running
    },
    compact: async (sessionID) => {
      log.compacts.push(sessionID)
    },
    rename: async (sessionID, title) => {
      log.renames.push({ sessionID, title })
    },
    agents: async () => [
      { id: "build", label: "Build" },
      { id: "plan", label: "Plan" },
    ],
    models: async () => MODELS,
    ...o.host,
  }
  const router = new Router(cfg, async () => true)
  const bridge = new Bridge(
    cfg,
    host,
    [channel],
    new PendingStore(),
    router,
    Date.now,
    tel,
  )
  if (o.stuck) bridge.onStuck(() => o.stuck!)
  bridge.start()
  router.set("root", true)
  await bridge.onEvent({
    type: "session.execution.started",
    data: { sessionID: "root" },
  } as unknown as BridgeEvent)
  await tg.waitFor(() => tg.of("createForumTopic")[0])
  await tg.waitFor(() => tg.of("sendMessage")[0])
  if (o.chatOn !== false) {
    const out = await bridge.setChat("root", true)
    assert.equal(out.ok, true, out.text)
  }
  const texts = () => tg.of("sendMessage").map((c) => c.body.text as string)
  return {
    tg,
    channel,
    router,
    bridge,
    log,
    state,
    tel,
    cfg,
    texts,
    say: (text: string, thread?: number) =>
      tg.message(CHAT, text, undefined, thread),
    /** A message that arrived after n bot messages, as a reply to the last. */
    lastReply: (text: string, thread?: number) =>
      tg.message(CHAT, text, tg.lastMessageId, thread),
    async answered(re: RegExp) {
      return tg.waitFor(() =>
        tg.of("sendMessage").find((c) => re.test(c.body.text)),
      )
    },
    async done() {
      await bridge.stop()
      await tg.close()
    },
  }
}

const buttons = (call: { body: any }): string[] =>
  (call.body.reply_markup.inline_keyboard as any[][]).flat().map((b) => b.text)

const lastMenu = (r: Rig) =>
  r.tg
    .of("sendMessage")
    .filter((c) => c.body.reply_markup?.inline_keyboard?.length)
    .at(-1)!

const tap = (r: Rig, text: string, thread?: number) => {
  const m = lastMenu(r)
  const b = (m.body.reply_markup.inline_keyboard as any[][])
    .flat()
    .find((x) => x.text.endsWith(text))
  assert.ok(b, `no button ${text} in ${buttons(m)}`)
  r.tg.callback(CHAT, 1, b.callback_data, thread)
}

describe("commands: registration and parsing", () => {
  it("registers the commands for the paired chat only", async () => {
    const r = await rig()
    const c = await r.tg.waitFor(() => r.tg.of("setMyCommands")[0])
    assert.deepEqual(c.body.scope, { type: "chat", chat_id: String(CHAT) })
    const names = c.body.commands.map((x: { command: string }) => x.command)
    for (const n of [
      "new",
      "sessions",
      "projects",
      "model",
      "agent",
      "variant",
      "status",
      "stop",
      "steer",
      "compact",
      "rename",
      "chat",
      "help",
    ])
      assert.ok(names.includes(n), n)
    for (const x of c.body.commands) {
      assert.match(x.command, /^[a-z_]+$/)
      assert.ok(x.description.length <= 256)
    }
    await r.done()
  })

  it("takes /cmd@thisbot, and leaves /cmd@otherbot to the other bot", async () => {
    const r = await rig()
    r.say(`/help@${BOT}`)
    await r.answered(/In General or a private chat/)
    const before = r.tg.of("sendMessage").length
    r.say("/help@some_other_bot")
    await sleep(200)
    assert.equal(r.tg.of("sendMessage").length, before)
    await r.done()
  })

  it("answers /help by scope", async () => {
    const r = await rig()
    r.say("/help", THREAD)
    await r.answered(/In this session's topic/)
    await r.done()
  })

  it("is case-insensitive and knows /effort as /variant", async () => {
    const r = await rig()
    r.say("/EFFORT", THREAD)
    await r.answered(/has no variants/)
    await r.done()
  })

  it("says so for an unknown command, and a path is still a prompt", async () => {
    const r = await rig()
    r.say("/frobnicate now", THREAD)
    await r.answered(/Unknown command/)
    assert.deepEqual(r.log.prompts, [])
    r.say("/etc/hosts looks odd, why?", THREAD)
    await r.tg.waitFor(() => r.log.prompts[0])
    assert.equal(r.log.prompts[0].text, "/etc/hosts looks odd, why?")
    await r.done()
  })

  it("ignores commands from another chat", async () => {
    const r = await rig()
    r.tg.message(999, "/help")
    await sleep(200)
    assert.equal(r.texts().filter((t) => /In General/.test(t)).length, 0)
    await r.done()
  })
})

describe("commands: scope", () => {
  it("a session command in General gets a hint and does nothing", async () => {
    const r = await rig()
    r.say("/stop")
    const h = await r.answered(/acts on a session/)
    assert.equal(h.body.message_thread_id, undefined)
    assert.deepEqual(r.log.interrupts, [])
    r.say("/model")
    await r.answered(/\/model acts on a session/)
    await r.done()
  })

  it("a General command in a session's topic gets a hint", async () => {
    const r = await rig()
    r.say("/new shop hello", THREAD)
    await r.answered(/works in the General topic/)
    r.say("/sessions", THREAD)
    await r.answered(/\/sessions works in the General topic/)
    assert.deepEqual(r.log.created, [])
    await r.done()
  })

  it("session commands need chat on for the session", async () => {
    const r = await rig({ chatOn: false })
    r.say("/stop", THREAD)
    await r.answered(/Chat is off for this session/)
    assert.deepEqual(r.log.interrupts, [])
    r.say("/model", THREAD)
    await sleep(100)
    assert.equal(
      r.tg
        .of("sendMessage")
        .filter((c) => c.body.reply_markup?.inline_keyboard?.length).length,
      0,
    )
    await r.done()
  })

  it("session commands are refused by chat.deny", async () => {
    const r = await rig({
      chat: { deny: [{ agent: "^coord$" }] },
      chatOn: false,
    })
    r.bridge.restoreChat("root")
    r.say("/stop", THREAD)
    await r.answered(/blocked for this session by chat\.deny/)
    assert.deepEqual(r.log.interrupts, [])
    await r.done()
  })
})

describe("commands: in a session topic", () => {
  it("/stop interrupts the turn, and says when nothing runs", async () => {
    const r = await rig()
    r.say("/stop", THREAD)
    await r.answered(/Nothing is running/)
    r.state.running = true
    r.say("/stop", THREAD)
    await r.answered(/Stopped the running turn/)
    assert.deepEqual(r.log.interrupts, ["root", "root"])
    await r.done()
  })

  it("/steer injects into a running turn, and needs text", async () => {
    const r = await rig()
    r.state.running = true
    r.say("/steer use the other table", THREAD)
    await r.answered(/⚡ steered in/)
    assert.deepEqual(r.log.prompts, [
      { sessionID: "root", text: "use the other table" },
    ])
    assert.deepEqual(r.log.deliveries, ["steer"])
    r.state.running = false
    r.say("/steer and now this", THREAD)
    await r.answered(/→ sent/)
    r.say("/steer", THREAD)
    await r.answered(/Usage: \/steer/)
    assert.equal(r.log.prompts.length, 2)
    await r.done()
  })

  it("/steer is refused where chat is off", async () => {
    const r = await rig({ chatOn: false })
    r.say("/steer hi", THREAD)
    await r.answered(/Chat is off for this session/)
    assert.deepEqual(r.log.prompts, [])
    await r.done()
  })

  it("/compact and /rename act on the session", async () => {
    const r = await rig()
    r.say("/compact", THREAD)
    await r.answered(/Compacting/)
    assert.deepEqual(r.log.compacts, ["root"])
    r.say("/rename Ship it <now>", THREAD)
    await r.answered(/Renamed/)
    assert.deepEqual(r.log.renames, [
      { sessionID: "root", title: "Ship it <now>" },
    ])
    r.say("/rename", THREAD)
    await r.answered(/Usage: \/rename/)
    r.say(`/rename ${"x".repeat(101)}`, THREAD)
    await sleep(100)
    assert.equal(r.log.renames.length, 1)
    await r.done()
  })

  it("/chat off turns chat off; /chat on is for the TUI", async () => {
    const r = await rig()
    r.say("/chat on", THREAD)
    await r.answered(/switched on in the TUI/)
    assert.equal(r.bridge.chatEnabled("root"), true)
    r.say("/chat off", THREAD)
    await r.answered(/Chat is off for this session/)
    assert.equal(r.bridge.chatEnabled("root"), false)
    await r.done()
  })

  it("/status redraws the card and pins it again", async () => {
    const r = await rig()
    r.say("/status", THREAD)
    await r.answered(/Status card refreshed/)
    const pins = r.tg.of("pinChatMessage")
    assert.ok(pins.length >= 2, "pinned at creation and again")
    assert.ok(
      r.tg.of("editMessageText").some((c) => /Working|Idle/.test(c.body.text)),
    )
    await r.done()
  })

  it("/model offers the models, marks the current one, and applies the pick to the session", async () => {
    const r = await rig()
    r.say("/model", THREAD)
    const m = await r.answered(/Model for the next prompts/)
    assert.equal(m.body.message_thread_id, THREAD)
    const labels = buttons(m)
    assert.ok(labels.includes("✓ Model 1"))
    assert.equal(labels.filter((l) => l.startsWith("✓")).length, 1)
    tap(r, "Model 3", THREAD)
    await r.answered(/Model: Model 3\. It applies to the next prompts/)
    assert.deepEqual(r.log.models, [
      {
        sessionID: "root",
        model: { providerID: "prov", id: "m3", variant: undefined },
      },
    ])
    // The menu is spent.
    r.tg.callback(
      CHAT,
      1,
      lastMenu(r).body.reply_markup.inline_keyboard[0][0].callback_data,
      THREAD,
    )
    await r.tg.waitFor(() =>
      r.tg
        .of("answerCallbackQuery")
        .find((c) => /expired/.test(c.body.text ?? "")),
    )
    assert.equal(r.log.models.length, 1)
    await r.done()
  })

  it("/model <ref> applies an allowed model directly and refuses any other", async () => {
    const r = await rig()
    r.say("/model prov/m5", THREAD)
    await r.answered(/Model: Model 5/)
    assert.equal(r.log.models.length, 1)
    r.say("/model evil/free-for-all", THREAD)
    await r.answered(/Not an allowed model/)
    assert.equal(
      r.log.models.length,
      1,
      "a typed id outside the list is never used",
    )
    await r.done()
  })

  it("/model lists at most 12, six to a page, with page buttons", async () => {
    const r = await rig()
    r.say("/model", THREAD)
    const m = await r.answered(/Model for the next prompts/)
    const rows = m.body.reply_markup.inline_keyboard as any[][]
    assert.equal(rows.length, 7, "six models and a page row")
    assert.deepEqual(
      rows.at(-1).map((b) => b.text),
      ["1/2", "Next ›"],
    )
    r.tg.callback(CHAT, 1, rows.at(-1)[1].callback_data, THREAD)
    const e = await r.tg.waitFor(() =>
      r.tg
        .of("editMessageReplyMarkup")
        .find((c) => c.body.reply_markup.inline_keyboard.length > 0),
    )
    const page2 = e.body.reply_markup.inline_keyboard as any[][]
    assert.deepEqual(
      page2.slice(0, -1).map((x) => x[0].text),
      ["Model 6", "Model 7", "Model 8", "Model 9", "Model 10", "Model 11"],
    )
    assert.deepEqual(
      page2.at(-1).map((b) => b.text),
      ["‹ Prev", "2/2"],
    )
    // Model 12 and 13 are past the cap.
    assert.ok(!JSON.stringify(page2).includes("Model 12"))
    // A page that does not exist is refused.
    r.tg.callback(
      CHAT,
      1,
      `m:${rows.at(-1)[1].callback_data.split(":")[1]}:p9`,
      THREAD,
    )
    await r.tg.waitFor(() =>
      r.tg
        .of("answerCallbackQuery")
        .find((c) => c.body.text === "Unknown button."),
    )
    await r.done()
  })

  it("chat.models is the allowlist: only those, and only if OpenCode lists them", async () => {
    const r = await rig({
      chat: { models: ["prov/m2", "prov/m7", "other/gone"] },
    })
    r.say("/model", THREAD)
    const m = await r.answered(/Model for the next prompts/)
    assert.deepEqual(buttons(m), ["Model 2", "Model 7"])
    r.say("/model prov/m3", THREAD)
    await r.answered(/Not an allowed model/)
    assert.equal(r.log.models.length, 0)
    await r.done()
  })

  it("a forged tap on a model that was not offered applies nothing", async () => {
    const r = await rig()
    r.say("/model", THREAD)
    const m = await r.answered(/Model for the next prompts/)
    const id =
      m.body.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1]
    r.tg.callback(CHAT, 1, `m:${id}:99`, THREAD)
    await r.tg.waitFor(() =>
      r.tg
        .of("answerCallbackQuery")
        .find((c) => c.body.text === "Unknown button."),
    )
    assert.deepEqual(r.log.models, [])
    await r.done()
  })

  it("/agent offers the primary agents and switches the session's agent", async () => {
    const r = await rig()
    r.say("/agent", THREAD)
    const m = await r.answered(/Agent for this session/)
    assert.deepEqual(buttons(m), ["Build", "Plan"])
    tap(r, "Plan", THREAD)
    await r.answered(/Agent: plan/)
    assert.deepEqual(r.log.agents, [{ sessionID: "root", agent: "plan" }])
    r.say("/agent Build", THREAD)
    await r.answered(/Agent: build/)
    assert.deepEqual(r.log.agents[1], { sessionID: "root", agent: "build" })
    r.say("/agent nope", THREAD)
    await r.answered(/Not an agent I can use/)
    assert.equal(r.log.agents.length, 2)
    await r.done()
  })

  it("/variant lists the variants of the current model, with default, and applies the pick", async () => {
    const r = await rig()
    r.say("/variant", THREAD)
    await r.answered(/has no variants/)
    r.state.model = "m0"
    r.state.variant = "low"
    r.say("/variant", THREAD)
    const m = await r.answered(/Variant of Model 0/)
    assert.deepEqual(buttons(m), ["default", "✓ low", "high"])
    tap(r, "high", THREAD)
    await r.answered(/Model: Model 0 \(high\)/)
    assert.deepEqual(r.log.models, [
      {
        sessionID: "root",
        model: { providerID: "prov", id: "m0", variant: "high" },
      },
    ])
    r.say("/variant default", THREAD)
    await r.answered(/Model: Model 0\. It applies/)
    assert.equal(
      (r.log.models[1].model as { variant?: string }).variant,
      undefined,
    )
    r.say("/effort turbo", THREAD)
    await r.answered(/Not a variant of Model 0/)
    assert.equal(r.log.models.length, 2)
    await r.done()
  })
})

describe("commands: in General", () => {
  it("/projects lists the allowlist", async () => {
    const r = await rig()
    r.say("/projects")
    const m = await r.answered(/• shop/)
    assert.match(m.body.text, /• shop \(shop · build · prov\/m1\)/)
    assert.match(m.body.text, /• docs \(docs\)/)
    await r.done()
  })

  it("/new <project> <prompt> starts a session in the listed folder, routed here with chat on", async () => {
    const r = await rig()
    r.say("/new shop add a health check")
    const m = await r.answered(/🆕 Started shop · build/)
    assert.deepEqual(r.log.created, [
      {
        directory: "/w/shop",
        agent: "build",
        model: { providerID: "prov", id: "m1" },
      },
    ])
    assert.deepEqual(r.log.prompts, [
      { sessionID: "new_1", text: "add a health check" },
    ])
    assert.equal(r.bridge.chatEnabled("new_1"), true)
    assert.match(
      m.body.text,
      /<a href="https:\/\/t\.me\/c\/1234567890\/\d+">topic<\/a>/,
    )
    await r.tg.waitFor(() => r.tg.of("createForumTopic")[1])
    await r.done()
  })

  it("never takes a folder typed in the chat", async () => {
    const r = await rig()
    for (const t of [
      "/new /etc do it",
      "/new ../shop x",
      "/new /w/shop x",
      "/new constructor x",
      "/new __proto__ x",
    ]) {
      r.say(t)
      await r.answered(/No project/)
    }
    assert.deepEqual(r.log.created, [])
    await r.done()
  })

  it("respects chat.deny for the project", async () => {
    const r = await rig()
    r.say("/new secret read the payroll")
    await r.answered(/blocked by chat\.deny/)
    assert.deepEqual(r.log.created, [])
    await r.done()
  })

  it("is off without a chat.projects allowlist", async () => {
    const r = await rig({ chat: { projects: {} } })
    r.say("/new shop x")
    await r.answered(/Starting sessions from a chat is off/)
    assert.deepEqual(r.log.created, [])
    await r.done()
  })

  it("at most 5 new sessions an hour", async () => {
    const r = await rig()
    for (let i = 1; i <= 5; i++) {
      r.say(`/new docs task ${i}`)
      await r.tg.waitFor(() => r.log.created.length >= i || undefined)
      await r.tg.waitFor(
        () =>
          r.texts().filter((t) => /Started/.test(t)).length >= i || undefined,
      )
    }
    r.say("/new docs one too many")
    await r.answered(/At most 5 new sessions an hour/)
    assert.equal(r.log.created.length, 5)
    await r.done()
  })

  it("a project's own model comes from the config, not from the chat.models list", async () => {
    const r = await rig({ chat: { models: ["prov/m2"] } })
    // shop's own model is prov/m1, not in chat.models: it comes from the config.
    r.say("/new shop go")
    await r.answered(/Started shop/)
    assert.deepEqual(r.log.created[0].model, { providerID: "prov", id: "m1" })
    await r.done()
  })

  it("a session that fails right after it was started is marked in its topic", async () => {
    const r = await rig()
    r.say("/new shop add a health check")
    await r.answered(/🆕 Started shop/)
    await r.bridge.onEvent({
      type: "session.execution.failed",
      data: { sessionID: "new_1" },
    } as unknown as BridgeEvent)
    const e = await r.tg.waitFor(() =>
      r.tg
        .of("editForumTopic")
        .find((c) => (c.body.name ?? "").startsWith("⚪ ")),
    )
    await r.done()
  })

  it("/new with no arguments walks project, agent, model, then asks for the prompt", async () => {
    const r = await rig()
    r.say("/new")
    await r.answered(/Start a session in which project/)
    tap(r, "docs")
    await r.answered(/Agent for docs/)
    assert.deepEqual(buttons(lastMenu(r)), [
      "default (OpenCode's own)",
      "Build",
      "Plan",
    ])
    tap(r, "Plan")
    await r.answered(/Model for docs/)
    assert.equal(buttons(lastMenu(r))[0], "default (OpenCode's own)")
    tap(r, "Model 4")
    const ask = await r.answered(
      /Reply to this message with the prompt for docs/,
    )
    assert.equal(ask.body.reply_markup.force_reply, true)
    r.lastReply("write the changelog")
    await r.answered(/🆕 Started docs · plan/)
    assert.deepEqual(r.log.created, [
      {
        directory: "/w/docs",
        agent: "plan",
        model: { providerID: "prov", id: "m4" },
      },
    ])
    assert.equal(r.log.prompts[0].text, "write the changelog")
    await r.done()
  })

  it("/new <project> with no prompt starts at the agent step, with default choices", async () => {
    const r = await rig()
    r.say("/new shop")
    await r.answered(/Agent for shop/)
    assert.equal(buttons(lastMenu(r))[0], "default (build)")
    tap(r, "default (build)")
    await r.answered(/Model for shop/)
    tap(r, "default (prov/m1)")
    await r.answered(/Reply to this message with the prompt for shop/)
    r.lastReply("hello there")
    await r.answered(/Started shop · build/)
    assert.deepEqual(r.log.created[0], {
      directory: "/w/shop",
      agent: "build",
      model: { providerID: "prov", id: "m1" },
    })
    await r.done()
  })

  it("/sessions lists the mirrored sessions with links, and says when there are none", async () => {
    const r = await rig()
    r.say("/sessions")
    const m = await r.answered(/shop · Fix/)
    assert.match(
      m.body.text,
      /<a href="https:\/\/t\.me\/c\/1234567890\/9001">topic<\/a>/,
    )
    await r.done()
  })
})

describe("commands: telemetry records names and outcomes, never arguments", () => {
  it("emits oob.command and oob.session.create without the text", async () => {
    const posts: string[] = []
    const r = await rig({ posts })
    r.say("/rename top secret title", THREAD)
    await r.answered(/Renamed/)
    r.say("/new docs rotate the payroll keys")
    await r.answered(/Started docs/)
    r.say("/bogus", THREAD)
    await r.answered(/Unknown command/)
    await sleep(100)
    await r.tel!.flush()
    const dump = posts.join("\n")
    assert.match(dump, /oob\.command/)
    assert.match(dump, /oob\.session\.create/)
    assert.match(dump, /"stringValue":"rename"/)
    assert.match(dump, /"stringValue":"new"/)
    assert.match(dump, /"stringValue":"unknown"/)
    for (const bad of ["top secret", "payroll", "rotate", "bogus", "/w/docs"])
      assert.ok(!dump.includes(bad), `exported ${bad}`)
    await r.done()
  })
})

describe("commands: the menu and /undo /resume /afk /digest", () => {
  const names = (c: { body: any }) =>
    c.body.commands.map((x: { command: string }) => x.command) as string[]
  const withUndo = {
    undo: async () => true,
    resume: async () => {},
  }

  it("lists the operator's commands first, and leaves out what is off", async () => {
    const r = await rig({ host: withUndo })
    const c = await r.tg.waitFor(() => r.tg.of("setMyCommands")[0])
    assert.deepEqual(names(c).slice(0, 10), [
      "status",
      "stop",
      "model",
      "agent",
      "compact",
      "undo",
      "resume",
      "afk",
      "night",
      "new",
    ])
    assert.ok(!names(c).includes("digest"), "the digest is off")
    await r.done()
    const off = await rig()
    const d = await off.tg.waitFor(() => off.tg.of("setMyCommands")[0])
    assert.ok(!names(d).includes("undo"))
    assert.ok(!names(d).includes("resume"))
    assert.ok(names(d).includes("afk"))
    await off.done()
  })

  it("does not register again when the list is the stored one", async () => {
    const store = new Map<string, string>()
    const menuStore = {
      get: () => store.get("k"),
      set: (v: string) => void store.set("k", v),
    }
    const a = await rig({ menuStore })
    await a.tg.waitFor(() => a.tg.of("setMyCommands")[0])
    await sleep(50)
    assert.equal(store.size, 1)
    await a.done()
    const b = await rig({ menuStore })
    await sleep(400)
    assert.equal(b.tg.of("setMyCommands").length, 0)
    await b.done()
  })

  it("drops a command Telegram would refuse and registers the rest", async () => {
    const r = await rig()
    await r.tg.waitFor(() => r.tg.of("setMyCommands")[0])
    r.channel.menu([
      { command: "fine", description: "ok" },
      { command: "long", description: "x".repeat(300) },
      { command: "Bad-Name", description: "no" },
    ])
    const c = await r.tg.waitFor(() => r.tg.of("setMyCommands")[1])
    assert.deepEqual(names(c), ["fine"])
    await r.done()
  })

  it("registers all private chats for a private pairing", async () => {
    const r = await rig()
    const tg = await fakeTelegram()
    const dir = await mkdtemp(join(tmpdir(), "oobb-menu-"))
    const ch = new TelegramConnector({
      token: async () => tg.token,
      chatId: "4242",
      apiBase: tg.url,
      topicsFile: join(dir, "t.json"),
      offsetFile: join(dir, "o.json"),
      pollSeconds: 1,
      backoff: { min: 10, max: 40 },
    })
    const ac = new AbortController()
    ch.start(async () => undefined, ac.signal)
    const c = await tg.waitFor(() => tg.of("setMyCommands")[0])
    assert.deepEqual(c.body.scope, { type: "all_private_chats" })
    ac.abort()
    await tg.close()
    await r.done()
  })

  it("/undo asks, then reverts on Undo", async () => {
    const calls: string[] = []
    const r = await rig({
      host: { undo: async (id) => (calls.push(id), true) },
    })
    r.say("/undo", THREAD)
    await r.answered(/Revert the last turn/)
    assert.deepEqual(buttons(lastMenu(r)), ["Undo", "Cancel"])
    assert.deepEqual(calls, [])
    tap(r, "Undo", THREAD)
    await r.answered(/Reverted the last turn/)
    assert.deepEqual(calls, ["root"])
    await r.done()
  })

  it("/undo does nothing on Cancel, and not while a turn runs", async () => {
    const calls: string[] = []
    const r = await rig({
      host: { undo: async (id) => (calls.push(id), true) },
    })
    r.say("/undo", THREAD)
    await r.answered(/Revert the last turn/)
    tap(r, "Cancel", THREAD)
    await sleep(150)
    assert.deepEqual(calls, [])
    r.state.running = true
    r.say("/undo", THREAD)
    await r.answered(/Stop the running turn first/)
    await r.done()
  })

  it("/undo says to do it at the Mac when no window can take it", async () => {
    const r = await rig({
      host: {
        undo: async () => {
          throw new Error("No OpenCode window is open")
        },
      },
    })
    r.say("/undo", THREAD)
    await r.answered(/Revert the last turn/)
    tap(r, "Undo", THREAD)
    await r.answered(/needs an OpenCode window open at the Mac/)
    await r.done()
  })

  it("/undo in General is a scope hint", async () => {
    const r = await rig({ host: withUndo })
    r.say("/undo")
    await r.answered(/acts on a session/)
    await r.done()
  })

  it("/resume in a topic wakes that session", async () => {
    const woken: string[] = []
    const r = await rig({ host: { resume: async (id) => void woken.push(id) } })
    r.say("/resume", THREAD)
    await r.answered(/Waking it/)
    assert.deepEqual(woken, ["root"])
    await r.done()
  })

  it("/resume in General lists stuck sessions, or says none", async () => {
    const woken: string[] = []
    const none = await rig({ host: { resume: async () => {} } })
    none.say("/resume")
    await none.answered(/Nothing is stuck/)
    await none.done()
    const r = await rig({
      host: { resume: async (id) => void woken.push(id) },
      stuck: [{ id: "root", label: "shop", pending: 2 }],
    })
    r.say("/resume")
    await r.answered(/Wake which session/)
    assert.deepEqual(buttons(lastMenu(r)), ["shop (2 waiting)"])
    tap(r, "shop (2 waiting)")
    await r.answered(/Waking it/)
    assert.deepEqual(woken, ["root"])
    await r.done()
  })

  it("/afk shows the state and changes nothing", async () => {
    const r = await rig()
    const before = r.router.afkMode()
    r.say("/afk on")
    const m = await r.answered(/Away mode:/)
    assert.match(m.body.text, /changed at the Mac/)
    assert.equal(r.router.afkMode(), before)
    await r.done()
  })

  it("/night shows the plan and ends it, and cannot start one", async () => {
    const r = await rig()
    r.say("/night")
    await r.answered(/not planned/)
    r.say("/night end")
    await r.answered(/no overnight plan running/i)
    await r.done()
  })

  it("/digest says it is not enabled", async () => {
    const r = await rig()
    r.say("/digest")
    await r.answered(/digest is not enabled/)
    await r.done()
  })
})
