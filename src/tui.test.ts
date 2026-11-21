import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"

import { fakeNtfy } from "./connectors/fake-ntfy.test-util.ts"
import { fakeServer, type FakeServer } from "./fake-server.test-util.ts"
import { startServer } from "./server.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import type { SidebarView } from "./sidebar.ts"
import { commandIndex } from "./menu.ts"
import plugin, { setup } from "./tui.ts"

type Handler = (e: unknown) => void

// One entry per sub-command, besides /oob itself.
const SUBS = 17

function fakeCtx(
  size?: { width: number; height: number },
  server?: FakeServer,
) {
  const handlers = new Map<string, Handler>()
  const replies: unknown[] = []
  const toasts: string[] = []
  const commands: Array<{
    id?: string
    title?: string
    description?: string
    palette?: boolean
    slash?: { name: string; aliases?: string[]; arguments?: true }
    run: (i?: string) => unknown
  }> = []
  const dialogs: Array<{
    title: string
    message?: string
    placeholder?: string
    value?: string
    options?: Array<{
      title: string
      value: unknown
      description?: string
      footer?: string
      category?: string
    }>
    current?: unknown
    search?: (q: string, o: unknown[]) => Array<{ value: unknown }>
  }> = []
  // What the operator picks, in order; undefined dismisses.
  const picks: unknown[] = []
  let cleared = 0
  const modes: Array<string | undefined> = []
  const claims: Array<{
    prepend?: string
    render: (i: { sessionID: string }) => unknown
  }> = []
  let released = 0
  const navigations: unknown[] = []
  const sessions: Record<string, Record<string, unknown>> = {
    root: {
      id: "root",
      agent: "coordinator",
      location: { directory: "/w/shop" },
      title: "T",
    },
  }
  const ctx = {
    data: {
      on: (type: string, h: Handler) => {
        handlers.set(type, h)
        const off = type.startsWith("rpc.") ? server?.onTui(type, h) : undefined
        return () => {
          off?.()
          handlers.delete(type)
        }
      },
      session: {
        get: (id: string) => sessions[id],
        root: (id: string) => id,
        form: {
          reply: async (input: unknown) => {
            replies.push(input)
          },
        },
      },
    },
    renderer: size,
    client: {
      session: { get: async () => undefined },
      rpc: {
        call: (i: { method: string; input: unknown }) =>
          server ? server.call(i) : Promise.reject(new Error("no server")),
      },
    },
    keymap: {
      layer: (f: () => { mode?: string; commands: typeof commands }) => {
        const l = f()
        modes.push(l.mode)
        commands.push(...l.commands)
      },
    },
    ui: {
      slot: (c: (typeof claims)[number]) => {
        claims.push(c)
        return () => void released++
      },
      router: {
        current: () => ({ type: "session", sessionID: "root" }),
        navigate: (r: unknown) => navigations.push(r),
      },
      toast: { show: (o: { message: string }) => toasts.push(o.message) },
      dialog: {
        select: async (o: (typeof dialogs)[number]) => {
          dialogs.push(o)
          return picks.shift()
        },
        prompt: async (o: (typeof dialogs)[number]) => {
          dialogs.push(o)
          return picks.shift()
        },
        alert: async (o: (typeof dialogs)[number]) => {
          dialogs.push(o)
          await new Promise((r) => setTimeout(r, 30))
        },
        clear: () => cleared++,
      },
    },
  }
  return {
    ctx: ctx as never,
    handlers,
    replies,
    toasts,
    commands,
    modes,
    dialogs,
    picks,
    claims,
    navigations,
    released: () => released,
    cleared: () => cleared,
  }
}

/** Starts the server half in a fake server, as the OpenCode server would load it. */
async function serve(env: Record<string, string>) {
  const server = fakeServer()
  const stop = await withEnv(env, () => startServer(server.ctx))
  return { server, stop }
}

const fire = (server: FakeServer, e: { type: string; data: unknown }) =>
  server.emit(e.type, e.data)

async function withEnv<T>(
  vars: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = Object.fromEntries(
    Object.keys(vars).map((k) => [k, process.env[k]]),
  )
  Object.assign(process.env, vars)
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(prev))
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
  }
}

describe("TUI entry", () => {
  it("exports an OpenCode 2 TUI plugin", () => {
    assert.equal(plugin.id, "oob-bridge.tui")
    assert.equal(typeof plugin.setup, "function")
  })

  it("AC-14: without config it only registers /ntfy and makes no request", async () => {
    const f = fakeCtx()
    const realFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      throw new Error("no network expected")
    }) as typeof fetch
    try {
      const cleanup = await withEnv(
        { OPENCODE_OOB_BRIDGE_CONFIG: "/nonexistent/oob-bridge.jsonc" },
        () => setup(f.ctx),
      )
      assert.equal(cleanup, undefined)
      await new Promise((r) => setTimeout(r, 50))
    } finally {
      globalThis.fetch = realFetch
    }
    assert.equal(calls, 0)
    assert.equal(f.handlers.size, 0)
    // /ntfy is registered before any await (OpenCode 2.3.2 drops later layers);
    // without config it only explains itself.
    assert.equal(f.commands.length, SUBS + 1)
    // The default "base" mode is inactive while the prompt has focus.
    assert.deepEqual(f.modes, ["global"])
  })

  it("stays inert on an invalid config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ntfyb-tui-"))
    const cfg = join(dir, "c.jsonc")
    await writeFile(cfg, JSON.stringify({ server: "x", token: "literal" }))
    const f = fakeCtx()
    const cleanup = await withEnv({ OPENCODE_OOB_BRIDGE_CONFIG: cfg }, () =>
      setup(f.ctx),
    )
    assert.equal(cleanup, undefined)
    assert.equal(f.handlers.size, 0)
  })

  it("wires events, /ntfy and form replies end to end against a fake ntfy", async () => {
    const n = await fakeNtfy()
    const dir = await mkdtemp(join(tmpdir(), "ntfyb-tui-"))
    const cfg = join(dir, "c.jsonc")
    await writeFile(
      cfg,
      JSON.stringify({
        server: n.url,
        topics: { out: "oc-out", in: "oc-in" },
        token: { env: "NTFYB_T" },
      }),
    )
    const env = {
      OPENCODE_OOB_BRIDGE_CONFIG: cfg,
      OPENCODE_OOB_BRIDGE_DATA: dir,
      NTFYB_T: "tk_test_token_abcdefghijklmnop",
    }
    const { server, stop } = await serve(env)
    const f = fakeCtx(undefined, server)
    const cleanup = await withEnv(env, () => setup(f.ctx))
    assert.ok(cleanup)
    assert.ok(f.handlers.has("rpc.oob-bridge.form"))
    const cmd = f.commands.find((c) => c.slash?.name === "oob")!
    await cmd.run("on")
    assert.equal(f.toasts.at(-1), "oob routing: on")
    await cmd.run("bogus")
    assert.match(f.toasts.at(-1)!, /No sub-command "bogus"/)

    fire(server, {
      type: "form.created",
      data: {
        form: {
          id: "frm_1",
          sessionID: "root",
          metadata: { kind: "question" },
          fields: [
            {
              key: "q0",
              type: "string",
              description: "Go?",
              options: [{ label: "Yes" }, { label: "No" }],
            },
          ],
        },
      },
    })
    const pub = await n.waitFor(() => n.published[0])
    assert.equal(pub.auth, "Bearer tk_test_token_abcdefghijklmnop")
    assert.equal(pub.body.title, "shop · coordinator asks")
    const action = (pub.body.actions as Array<{ body: string }>)[1]

    await n.waitFor(() => n.subscribes.length > 0)
    n.send("r1", action.body)
    await n.waitFor(() => f.replies[0])
    assert.deepEqual(f.replies[0], {
      sessionID: "root",
      formID: "frm_1",
      answer: { q0: "No" },
    })

    await cleanup()
    await stop!()
    assert.equal(f.handlers.size, 0)
    await n.close()
  })
})

async function readJson(file: string, ms = 3000) {
  const end = Date.now() + ms
  for (;;) {
    try {
      return JSON.parse(await readFile(file, "utf8"))
    } catch (err) {
      if (Date.now() > end) throw err
      await new Promise((r) => setTimeout(r, 10))
    }
  }
}

describe("/oob menu and channels", () => {
  // Tokens resolve lazily, after setup has returned.
  before(() => void (process.env.OOBB_TG = "123456:TESTTOKEN"))
  after(() => void delete process.env.OOBB_TG)

  async function started(
    channels: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    size?: { width: number; height: number },
    dir?: string,
    loadView?: () => Promise<SidebarView>,
  ) {
    dir ??= await mkdtemp(join(tmpdir(), "oobb-menu-"))
    const cfg = join(dir, "c.jsonc")
    await writeFile(cfg, JSON.stringify({ channels, ...extra }))
    const env = {
      OPENCODE_OOB_BRIDGE_CONFIG: cfg,
      OPENCODE_OOB_BRIDGE_DATA: dir,
    }
    const { server, stop } = await serve(env)
    const f = fakeCtx(size, server)
    const tui = await withEnv(env, () => setup(f.ctx, loadView))
    assert.ok(tui)
    const cmd = f.commands.find((c) => c.slash?.name === "oob")!
    const cleanup = async () => {
      await tui()
      await stop!()
    }
    return { f, dir, cmd, cleanup, server }
  }

  it("registers /oob (alias ntfy, in the palette) and one /oob-<sub> per sub-command, synchronously", async () => {
    const f = fakeCtx()
    void setup(f.ctx)
    const main = f.commands.filter((c) => c.slash?.name === "oob")
    assert.equal(main.length, 1)
    assert.equal(main[0].palette, true)
    assert.deepEqual(main[0].slash?.aliases, ["ntfy"])
    assert.equal(main[0].slash?.arguments, true)
    assert.equal(f.commands.length, SUBS + 1)
    assert.deepEqual(f.modes, ["global"])
  })

  it("the /oob-<sub> entries match the registry 1:1, with unique names and ids", async () => {
    const f = fakeCtx()
    void setup(f.ctx)
    const reg = commandIndex(f.ctx)
    const subs = f.commands.filter((c) => c.slash?.name !== "oob")
    assert.deepEqual(
      subs.map((c) => c.slash!.name),
      reg.map((c) => `oob-${c.name}`),
    )
    assert.deepEqual(
      subs.map((c) => c.slash!.name),
      [
        "oob-on",
        "oob-off",
        "oob-auto",
        "oob-chat",
        "oob-delivery",
        "oob-channel",
        "oob-pair",
        "oob-test",
        "oob-sidebar",
        "oob-afk",
        "oob-overnight",
        "oob-session",
        "oob-resume",
        "oob-restart",
        "oob-core",
        "oob-status",
        "oob-help",
      ],
    )
    for (const [i, c] of subs.entries()) {
      assert.equal(c.slash!.arguments, true)
      assert.equal(c.slash!.aliases, undefined)
      assert.equal(c.palette, undefined)
      assert.equal(c.title, `oob: ${reg[i].title}`)
      assert.ok(c.description!.includes(reg[i].description))
      assert.ok(c.description!.includes(reg[i].usage))
    }
    const all = f.commands.map((c) => c.slash!.name)
    assert.equal(new Set(all).size, all.length)
    const ids = f.commands.map((c) => c.id)
    assert.equal(new Set(ids).size, ids.length)
  })

  it("/oob-<sub> <rest> runs exactly like /oob <sub> <rest>", async () => {
    const tg = await fakeTelegram()
    const { f, cleanup } = await started({
      telegram: { token: { env: "OOBB_TG" }, chatId: 7, apiBase: tg.url },
    })
    const by = (n: string) => f.commands.find((c) => c.slash?.name === n)!
    await by("oob-delivery").run("steer")
    assert.match(f.toasts.at(-1)!, /Delivery for this session: steer/)
    await by("oob-chat").run("on")
    assert.match(f.toasts.at(-1)!, /Chat is on/)
    await by("oob-off").run()
    assert.equal(f.toasts.at(-1), "oob routing: off, chat on")
    // Nothing typed after the name: the argument is asked for, as in /oob chat.
    f.picks.push("off")
    await by("oob-chat").run()
    assert.equal(
      f.dialogs.at(-1)!.title,
      "Write to this session from the channel",
    )
    assert.match(f.toasts.at(-1)!, /Chat is off/)
    // A wrong value is named, as in the typed form.
    await by("oob-delivery").run("fast")
    assert.match(f.toasts.at(-1)!, /"fast" is not a mode/)
    await cleanup()
    await tg.close()
  })

  it("/oob alone opens a searchable picker of every sub-command, then walks the arguments", async () => {
    const n = await fakeNtfy()
    const { f, cmd, cleanup } = await started({
      ntfy: { server: n.url, topics: { out: "o", in: "i" } },
      telegram: { token: { env: "OOBB_TG" } },
    })
    await cmd.run()
    const m = f.dialogs[0]
    assert.equal(m.title, "OOB - Remote access")
    assert.deepEqual(
      m.options!.map((o) => o.value),
      [
        "on",
        "off",
        "auto",
        "chat",
        "delivery",
        "channel",
        "pair",
        "test",
        "sidebar",
        "afk",
        "overnight",
        "session",
        "resume",
        "restart",
        "core",
        "status",
        "help",
      ],
    )
    const delivery = m.options!.find((o) => o.value === "delivery")!
    assert.equal(delivery.footer, "/oob delivery <queue|steer|default>")
    assert.equal(delivery.category, "This session")
    assert.ok(delivery.description)
    assert.deepEqual(
      m.search!("statu", m.options!).map((o) => o.value),
      ["status"],
    )

    // Pick "delivery", then a value: the same list as the sidebar's dropdown.
    f.picks.push("delivery", "steer")
    await cmd.run()
    const list = f.dialogs.find((d) => d.title === "How your messages arrive")!
    assert.equal(list.current, "default")
    assert.deepEqual(
      list.options!.map((o) => o.value),
      ["steer", "queue", "default"],
    )
    assert.match(f.toasts.at(-1)!, /Delivery for this session: steer/)

    // Esc at the picker, and Esc at an argument: nothing happens.
    const toasts = f.toasts.length
    await cmd.run()
    f.picks.push("chat", undefined)
    await cmd.run()
    assert.equal(f.toasts.length, toasts)

    f.picks.push("off")
    await cmd.run()
    assert.equal(f.toasts.at(-1), "oob routing: off")
    await cmd.run("auto")
    assert.equal(f.toasts.at(-1), "oob routing: auto")
    await cleanup()
    await n.close()
  })

  it("a prefix that fits two sub-commands opens the picker with just those; one runs at once", async () => {
    const n = await fakeNtfy()
    const { f, cmd, cleanup } = await started({
      ntfy: { server: n.url, topics: { out: "o", in: "i" } },
    })
    f.picks.push("off")
    await cmd.run("o")
    assert.deepEqual(
      f.dialogs[0].options!.map((o) => o.value),
      ["on", "off", "overnight"],
    )
    assert.equal(f.toasts.at(-1), "oob routing: off")
    await cmd.run("au")
    assert.equal(f.toasts.at(-1), "oob routing: auto")
    assert.equal(f.dialogs.length, 1)
    await cleanup()
    await n.close()
  })

  it("/oob help lists every sub-command with its usage", async () => {
    const { f, cmd, cleanup } = await started({
      telegram: { token: { env: "OOBB_TG" } },
    })
    await cmd.run("help")
    const d = f.dialogs.at(-1)!
    assert.equal(d.title, "OOB - Remote access: commands")
    for (const u of [
      "/oob on [<channel|all>]",
      "/oob chat <on|off>",
      "/oob delivery <queue|steer|default>",
      "/oob sidebar <full|compact|off>",
      "/oob channel <channel> <on|off>",
      "/oob status",
    ])
      assert.ok(d.message!.includes(u), u)
    await cleanup()
  })

  it("switches a channel off, persists it, and stops its subscription", async () => {
    const n = await fakeNtfy()
    const { f, dir, cmd, cleanup } = await started({
      ntfy: { server: n.url, topics: { out: "o", in: "i" } },
    })
    await n.waitFor(() => n.subscribes.length > 0)
    f.picks.push("channel", "ntfy", "off")
    await cmd.run()
    assert.equal(f.dialogs.at(-1)!.current, "on")
    assert.equal(f.toasts.at(-1), "ntfy: off")
    const saved = await readJson(join(dir, "settings.json"))
    assert.equal(saved.channels.ntfy.enabled, false)
    await cleanup()
    await n.close()

    // The next start honours it: no subscription, nothing sent.
    const n2 = await fakeNtfy()
    await writeFile(
      join(dir, "c.jsonc"),
      JSON.stringify({
        channels: { ntfy: { server: n2.url, topics: { out: "o", in: "i" } } },
      }),
    )
    const env2 = {
      OPENCODE_OOB_BRIDGE_CONFIG: join(dir, "c.jsonc"),
      OPENCODE_OOB_BRIDGE_DATA: dir,
    }
    const s2 = await serve(env2)
    const f2 = fakeCtx(undefined, s2.server)
    const tui2 = await withEnv(env2, () => setup(f2.ctx))
    const cleanup2 = async () => {
      await tui2!()
      await s2.stop!()
    }
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(n2.subscribes.length, 0)
    await f2.commands.find((c) => c.slash?.name === "oob")!.run("test")
    assert.equal(f2.toasts.at(-1), "No channel is enabled")
    await cleanup2()
    await n2.close()
  })

  it("sends a test push to every enabled channel and shows status", async () => {
    const n = await fakeNtfy()
    const tg = await fakeTelegram()
    const { f, cmd, cleanup } = await started({
      ntfy: { server: n.url, topics: { out: "o", in: "i" } },
      telegram: {
        token: { env: "OOBB_TG" },
        chatId: 7,
        apiBase: tg.url,
      },
    })
    await cmd.run("test")
    assert.equal(f.toasts.at(-1), "Test push: ntfy sent, telegram sent")
    assert.equal(n.published.length, 1)
    assert.match(tg.of("sendMessage")[0].body.text, /Test push/)

    await cmd.run("status")
    const msg = f.dialogs.at(-1)!.message!
    assert.match(msg, /^ntfy: on/m)
    assert.match(msg, /^telegram: on/m)
    assert.match(msg, /Open prompts: 0/)
    await cleanup()
    await n.close()
    await tg.close()
  })

  it("the pairing dialog also offers the add-to-a-group link", async () => {
    const tg = await fakeTelegram()
    const { f, cmd, cleanup } = await started({
      telegram: { token: { env: "OOBB_TG" }, apiBase: tg.url },
    })
    await cmd.run("pair telegram")
    const msg = f.dialogs.at(-1)!.message!
    const code = /send this code: ([A-Z2-9]{6})/.exec(msg)![1]
    assert.match(
      msg,
      new RegExp(
        `add it to a group[^\\n]*:\\nhttps://t.me/oob_test_bot\\?startgroup=${code}`,
      ),
    )
    await cleanup()
    await tg.close()
  })

  it("Status shows that topics cannot be created for lack of the admin right", async () => {
    const tg = await fakeTelegram()
    tg.forum = true
    tg.fail("createForumTopic", 400, {
      description: "Bad Request: not enough rights to create a topic",
    })
    const dir = await mkdtemp(join(tmpdir(), "oobb-menu-"))
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ sessions: { root: { on: true } } }),
    )
    const { f, cmd, cleanup, server } = await started(
      { telegram: { token: { env: "OOBB_TG" }, chatId: 7, apiBase: tg.url } },
      {},
      undefined,
      dir,
    )
    fire(server, {
      type: "session.execution.started",
      data: { sessionID: "root" },
    })
    await tg.waitFor(() =>
      tg.of("sendMessage").find((c) => /Manage Topics/.test(c.body.text)),
    )
    await cmd.run("status")
    assert.match(
      f.dialogs.at(-1)!.message!,
      /^telegram: on[^\n]*\n {2}⚠ topics: the bot needs the Manage Topics admin right/m,
    )
    await cleanup()
    await tg.close()
  })

  it("/oob chat on turns chat on for the session, keeps it across a restart, and the picker shows it", async () => {
    const tg = await fakeTelegram()
    const { f, dir, cmd, cleanup } = await started({
      telegram: { token: { env: "OOBB_TG" }, chatId: 7, apiBase: tg.url },
    })
    await cmd.run("chat on")
    assert.match(f.toasts.at(-1)!, /Chat is on for this session/)
    await cleanup()
    const saved = await readJson(join(dir, "settings.json"))
    assert.equal(saved.sessions.root.chat, true)
    assert.equal(saved.sessions.root.on, true)

    const again = await started(
      { telegram: { token: { env: "OOBB_TG" }, chatId: 7, apiBase: tg.url } },
      {},
      undefined,
      dir,
    )
    again.f.picks.push("off")
    await again.cmd.run("chat")
    const ask = again.f.dialogs.find(
      (d) => d.title === "Write to this session from the channel",
    )!
    assert.equal(ask.current, "on")
    assert.match(again.f.toasts.at(-1)!, /Chat is off/)
    await again.cleanup()
    const off = await readJson(join(dir, "settings.json"))
    assert.equal(off.sessions.root.chat, undefined)
    await tg.close()
  })

  it("claims the sidebar once the view loads, shows the session's state, and releases it on cleanup", async () => {
    const tg = await fakeTelegram()
    const seen: Array<Parameters<SidebarView>[0]> = []
    const { f, cmd, cleanup } = await started(
      { telegram: { token: { env: "OOBB_TG" }, chatId: 7, apiBase: tg.url } },
      {},
      undefined,
      undefined,
      async () => (p) => {
        seen.push(p)
        return "block"
      },
    )
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(f.claims.length, 1)
    assert.equal(f.claims[0].prepend, "sidebar.content")
    assert.equal(f.claims[0].render({ sessionID: "root" }), "block")
    const rows = () => {
      const m = seen[0].model()
      return m.mode === "full"
        ? m.rows.map((r) => `${r.label}: ${r.value}`)
        : []
    }
    assert.deepEqual(rows().slice(0, 3), [
      "Notify: when away",
      "Chat: off",
      "Replies: after turn",
    ])
    assert.deepEqual(
      rows()
        .slice(3)
        .map((r) => r.split(":")[0]),
      ["Away", "Bridge"],
    )
    // A change made from the command shows without a new render.
    let changes = 0
    seen[0].subscribe(() => changes++)
    await cmd.run("chat on")
    assert.ok(changes >= 1)
    assert.equal(rows()[1], "Chat: on")
    // A click opens the row's dialog; the pick does what the command does.
    f.picks.push("steer")
    seen[0].open("replies")
    await new Promise((r) => setTimeout(r, 30))
    assert.match(f.toasts.at(-1)!, /Replies: immediately/)
    assert.equal(rows()[2], "Replies: immediately")
    // The sidebar size is a setting: compact and off change the model.
    await cmd.run("sidebar compact")
    assert.equal(seen[0].model().mode, "compact")
    await cmd.run("sidebar off")
    assert.equal(seen[0].model().mode, "off")
    await cleanup()
    assert.equal(f.released(), 1)
    await tg.close()
  })

  it("runs without a sidebar block when the view cannot be loaded", async () => {
    const { f, cmd, cleanup } = await started(
      { telegram: { token: { env: "OOBB_TG" } } },
      {},
      undefined,
      undefined,
      async () => {
        throw new Error("cannot resolve solid-js")
      },
    )
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(f.claims.length, 0)
    await cmd.run("off")
    assert.match(f.toasts.at(-1)!, /oob routing: off/)
    await cleanup()
    assert.equal(f.released(), 0)
  })

  it("makes no sidebar claim without a view loader, nor without a config", async () => {
    const a = await started({ telegram: { token: { env: "OOBB_TG" } } })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(a.f.claims.length, 0)
    await a.cleanup()
    const f = fakeCtx()
    let loaded = 0
    await withEnv(
      { OPENCODE_OOB_BRIDGE_CONFIG: "/nonexistent/oob-bridge.jsonc" },
      () =>
        setup(f.ctx, async () => {
          loaded++
          return () => 0
        }),
    )
    assert.equal(loaded, 0)
    assert.equal(f.claims.length, 0)
  })

  it("/oob delivery sets the session's delivery, keeps it across a restart, and default clears it", async () => {
    const tg = await fakeTelegram()
    const ch = {
      telegram: { token: { env: "OOBB_TG" }, chatId: 7, apiBase: tg.url },
    }
    const { f, dir, cmd, cleanup } = await started(ch)
    await cmd.run("delivery steer")
    assert.match(f.toasts.at(-1)!, /Delivery for this session: steer/)
    await cleanup()
    assert.equal(
      (await readJson(join(dir, "settings.json"))).sessions.root.delivery,
      "steer",
    )
    const again = await started(ch, {}, undefined, dir, async () => (p) => p)
    await again.cmd.run("delivery default")
    assert.match(again.f.toasts.at(-1)!, /Delivery for this session: queue/)
    await again.cleanup()
    assert.equal(
      (await readJson(join(dir, "settings.json"))).sessions.root,
      undefined,
    )
    await tg.close()
  })

  it("/oob chat on says why when the config denies the session", async () => {
    const tg = await fakeTelegram()
    const { f, cmd, cleanup } = await started(
      { telegram: { token: { env: "OOBB_TG" }, chatId: 7, apiBase: tg.url } },
      { chat: { deny: [{ directory: "**/shop" }] } },
    )
    await cmd.run("chat on")
    assert.match(f.toasts.at(-1)!, /blocked .* chat\.deny/)
    await cleanup()
    await tg.close()
  })

  it("pairs Telegram from a one-time code and stores the chat in the settings", async () => {
    const tg = await fakeTelegram()
    const { f, dir, cmd, cleanup } = await started({
      telegram: { token: { env: "OOBB_TG" }, apiBase: tg.url },
    })
    await cmd.run("pair telegram")
    const dlg = f.dialogs.at(-1)!
    const code = /send this code: ([A-Z2-9]{6})/.exec(dlg.message!)![1]
    assert.match(
      dlg.message!,
      new RegExp(`https://t.me/oob_test_bot\\?start=${code}`),
    )
    // The QR of that link is in the dialog, and it fits.
    assert.match(dlg.message!, /Scan with your phone camera/)
    assert.match(dlg.message!, /█/)
    tg.message(555, code)
    await tg.waitFor(() => f.toasts.includes("telegram paired") || undefined)
    const saved = await readJson(join(dir, "settings.json"))
    assert.equal(saved.channels.telegram.chatId, "555")
    // Never written to the user's config file.
    assert.doesNotMatch(await readFile(join(dir, "c.jsonc"), "utf8"), /chatId/)

    await cmd.run("test")
    assert.equal(tg.of("sendMessage").at(-1)!.body.chat_id, "555")
    await cleanup()
    await tg.close()
  })

  it("pairs through the deep link: /start <code> is the pairing message", async () => {
    const tg = await fakeTelegram()
    const { f, dir, cmd, cleanup } = await started({
      telegram: { token: { env: "OOBB_TG" }, apiBase: tg.url },
    })
    await cmd.run("pair telegram")
    const code = /this code: ([A-Z2-9]{6})/.exec(f.dialogs.at(-1)!.message!)![1]
    tg.message(556, `/start ${code}`)
    await tg.waitFor(() => f.toasts.includes("telegram paired") || undefined)
    assert.equal(
      (await readJson(join(dir, "settings.json"))).channels.telegram.chatId,
      "556",
    )
    await cleanup()
    await tg.close()
  })

  it("falls back to link and code when the terminal is too small for the QR", async () => {
    const tg = await fakeTelegram()
    const small = await started(
      { telegram: { token: { env: "OOBB_TG" }, apiBase: tg.url } },
      {},
      { width: 50, height: 20 },
    )
    await small.cmd.run("pair telegram")
    const msg = small.f.dialogs.at(-1)!.message!
    assert.doesNotMatch(msg, /Scan with your phone camera|█/)
    assert.match(msg, /https:\/\/t\.me\/oob_test_bot\?start=/)
    assert.match(msg, /this code: [A-Z2-9]{6}/)
    await small.cleanup()

    const big = await started(
      { telegram: { token: { env: "OOBB_TG" }, apiBase: tg.url } },
      {},
      { width: 120, height: 50 },
    )
    await big.cmd.run("pair telegram")
    assert.match(big.f.dialogs.at(-1)!.message!, /Scan with your phone camera/)
    await big.cleanup()
    await tg.close()
  })

  it("chooses a channel per session, persists it and restores it after a restart", async () => {
    const n = await fakeNtfy()
    const tg = await fakeTelegram()
    const channels = {
      ntfy: { server: n.url, topics: { out: "o", in: "i" } },
      telegram: { token: { env: "OOBB_TG" }, chatId: 7, apiBase: tg.url },
    }
    const { f, dir, cmd, cleanup, server } = await started(channels)
    await cmd.run("on telegram")
    assert.equal(f.toasts.at(-1), "oob routing: on via telegram")
    await cmd.run("on bogus")
    assert.match(
      f.toasts.at(-1)!,
      /"bogus" is not a channel\. Use: ntfy, telegram, all/,
    )
    await cmd.run("on telegram extra")
    assert.match(f.toasts.at(-1)!, /Usage/)

    // The session now asks: only Telegram hears it.
    fire(server, {
      type: "form.created",
      data: {
        form: {
          id: "frm_1",
          sessionID: "root",
          metadata: { kind: "question" },
          fields: [
            {
              key: "q0",
              type: "string",
              options: [{ label: "A" }, { label: "B" }],
            },
          ],
        },
      },
    })
    await tg.waitFor(() => tg.of("sendMessage")[0])
    assert.equal(n.published.length, 0)

    const saved = await readJson(join(dir, "settings.json"))
    assert.deepEqual(saved.sessions, {
      root: { on: true, channel: "telegram" },
    })
    await cleanup()

    const again = await started(channels, {}, undefined, dir)
    // Esc at the channel list changes nothing.
    again.f.picks.push("on", undefined)
    await again.cmd.run()
    const r = again.f.dialogs.find(
      (d) => d.title === "Push through which channel?",
    )!
    assert.equal(r.current, "telegram")
    assert.deepEqual(
      r.options!.map((o) => o.value),
      ["", "ntfy", "telegram", "all"],
    )
    assert.equal(again.f.toasts.length, 0)
    await again.cmd.run("auto")
    assert.equal(again.f.toasts.at(-1), "oob routing: auto")
    await again.cleanup()
    assert.deepEqual((await readJson(join(dir, "settings.json"))).sessions, {})
    await n.close()
    await tg.close()
  })

  it("channel <name> <state> works typed, and the picker marks the current state", async () => {
    const n = await fakeNtfy()
    const tg = await fakeTelegram()
    const { f, dir, cmd, cleanup } = await started({
      ntfy: { server: n.url, topics: { out: "o", in: "i" } },
      telegram: { token: { env: "OOBB_TG" }, chatId: 7, apiBase: tg.url },
    })
    await cmd.run("channel ntfy off")
    assert.equal(f.toasts.at(-1), "ntfy: off")
    // Only the state is missing: just that is asked, with the current one marked.
    f.picks.push("on")
    await cmd.run("channel ntfy")
    const ask = f.dialogs.at(-1)!
    assert.equal(ask.title, "Turn it")
    assert.equal(ask.current, "off")
    assert.equal(f.toasts.at(-1), "ntfy: on")
    await cmd.run("channel telegram off")
    await cleanup()
    const saved = await readJson(join(dir, "settings.json"))
    assert.equal(saved.channels.ntfy.enabled, true)
    assert.equal(saved.channels.telegram.enabled, false)
    await n.close()
    await tg.close()
  })

  it("pairing: the name is optional with one pairable channel, and the command does not wait for the dialog", async () => {
    const tg = await fakeTelegram()
    const { f, cmd, cleanup } = await started({
      telegram: { token: { env: "OOBB_TG" }, apiBase: tg.url },
    })
    f.picks.push("pair")
    await cmd.run()
    assert.deepEqual(
      f.dialogs.map((d) => d.title),
      ["OOB - Remote access", "Pair telegram"],
    )
    const before = f.dialogs.length
    await cmd.run("pair")
    assert.equal(f.dialogs.length, before + 1)
    await cmd.run("pair telegram")
    assert.equal(f.dialogs.length, before + 2)
    await cleanup()
    await tg.close()
  })

  it("explains itself when Telegram is not configured", async () => {
    const n = await fakeNtfy()
    const { f, cmd, cleanup } = await started({
      ntfy: { server: n.url, topics: { out: "o", in: "i" } },
    })
    await cmd.run("pair telegram")
    assert.match(f.toasts.at(-1)!, /No channel can be paired/)
    await cmd.run("status now")
    assert.equal(f.toasts.at(-1), "Usage: /oob status")
    await cleanup()
    await n.close()
  })
})
