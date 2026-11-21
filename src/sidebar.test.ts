import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Bridge, type Host } from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import type { Connector } from "./connectors/types.ts"
import { Control } from "./control.ts"
import { setSidebarMode, type App } from "./menu.ts"
import { PendingStore } from "./pending.ts"
import { Remote, type Transport } from "./remote.ts"
import { Router } from "./routing.ts"
import { SettingsStore } from "./settings.ts"
import {
  applyPick,
  compactParts,
  registerSidebar,
  rowDialog,
  sidebarModel,
  sidebarRows,
  sidebarState,
  type PendingItem,
  type SidebarState,
  type SidebarView,
} from "./sidebar.ts"
import { sleep } from "./util.ts"

const state = (o: Partial<SidebarState> = {}): SidebarState => ({
  mode: "auto",
  channel: "all",
  channels: ["telegram", "ntfy"],
  defaultChannel: "all",
  chat: false,
  chatCapable: true,
  delivery: "queue",
  override: false,
  defaultDelivery: "queue",
  awayMinutes: 10,
  pending: [],
  now: 10 * 60_000,
  bridge: {
    online: true,
    pid: 42,
    startedAt: 0,
    afk: "auto",
    away: false,
    stuck: [],
  },
  ...o,
})

const prompt = (id: string, askedAt = 0): PendingItem => ({
  id,
  kind: "question",
  title: `Pick ${id}`,
  sessionID: `s-${id}`,
  askedAt,
})

const INSTANCE = ["away", "stuck", "bridge"]

const flat = (s: SidebarState) =>
  sidebarRows(s)
    .filter((r) => !INSTANCE.includes(r.id))
    .map((r) => `${r.label}|${r.value}|${r.tone}`)

describe("sidebarRows", () => {
  it("Notify says on, off or when away, and Chat and Replies follow", async () => {
    assert.deepEqual(flat(state()), [
      "Notify|when away|normal",
      "Chat|off|muted",
      "Replies|after turn|normal",
    ])
    assert.deepEqual(
      flat(
        state({
          mode: "on",
          channel: "telegram",
          chat: true,
          delivery: "steer",
        }),
      ),
      ["Notify|on|ok", "Chat|on|ok", "Replies|immediately|normal"],
    )
    assert.equal(sidebarRows(state({ mode: "off" }))[0].tone, "muted")
  })

  it("Waiting shows only when something waits, in the singular too", async () => {
    assert.equal(flat(state()).length, 3)
    assert.deepEqual(flat(state({ pending: [prompt("a")] })).slice(3), [
      "Waiting|1 question|warn",
    ])
    assert.equal(
      sidebarRows(state({ pending: [prompt("a"), prompt("b")] }))[3].value,
      "2 questions",
    )
    const permission = { ...prompt("p"), kind: "permission" as const }
    assert.equal(
      sidebarRows(state({ pending: [permission] }))[3].value,
      "1 request",
    )
  })

  it("shows the instance: who counts as away, suspended sessions, and the bridge", async () => {
    const rows = (b: Partial<SidebarState["bridge"]>) =>
      sidebarRows(state({ bridge: { ...state().bridge, ...b } }))
        .filter((r) => INSTANCE.includes(r.id))
        .map((r) => `${r.label}|${r.value}|${r.tone}`)
    assert.deepEqual(rows({}), [
      "Away|here · auto|normal",
      "Bridge|42 · up 10m|muted",
    ])
    assert.deepEqual(rows({ away: true, afk: "on" }), [
      "Away|away · on|warn",
      "Bridge|42 · up 10m|muted",
    ])
    assert.deepEqual(
      rows({ stuck: [{ id: "s1", title: "Shop", pending: 2, since: 0 }] }),
      [
        "Away|here · auto|normal",
        "Stuck|1 suspended|warn",
        "Bridge|42 · up 10m|muted",
      ],
    )
    assert.deepEqual(rows({ problem: "telegram" }), [
      "Away|here · auto|normal",
      "Bridge|telegram error|warn",
    ])
  })

  it("an offline bridge is the only row, and the compact line says so", async () => {
    const off = state({ bridge: { online: false, stuck: [] } })
    assert.deepEqual(flat(off), [])
    assert.deepEqual(
      sidebarRows(off).map((r) => `${r.label}|${r.value}|${r.tone}`),
      ["Bridge|offline|warn"],
    )
    assert.match(
      compactParts(off)
        .map((p) => p.text)
        .join(""),
      /bridge offline/,
    )
  })

  it("the instance rows open their own dialogs: away mode, suspended sessions, restart", async () => {
    const s = state({
      bridge: {
        ...state().bridge,
        afk: "on",
        stuck: [{ id: "s1", title: "Shop", pending: 2, since: 0 }],
      },
    })
    const away = rowDialog(s, "away")
    assert.equal(away.current, "on")
    assert.deepEqual(
      away.options.map((o) => o.value),
      ["auto", "on", "off"],
    )
    const stuck = rowDialog(s, "stuck")
    assert.deepEqual(
      stuck.options.map((o) => [o.value, o.title, o.description]),
      [["s1", "Shop", "2 waiting, 10 min ago"]],
    )
    assert.deepEqual(
      rowDialog(s, "bridge").options.map((o) => o.value),
      ["restart"],
    )
    assert.deepEqual(
      rowDialog(state({ bridge: { online: false, stuck: [] } }), "bridge")
        .options,
      [],
    )
  })

  it("chat.deny shows denied in the warning tone", async () => {
    const [, chat] = sidebarRows(state({ blocked: "directory **/payroll" }))
    assert.equal(chat.value, "denied")
    assert.equal(chat.tone, "warn")
  })

  it("has no Chat or Replies row when no selected channel can chat", async () => {
    assert.deepEqual(flat(state({ chatCapable: false })), [
      "Notify|when away|normal",
    ])
  })

  it("names the plugin once, in the title, and describes the rest in words", async () => {
    const m = sidebarModel(state({ pending: [prompt("a")] }), "full")
    if (m.mode !== "full") throw new Error("full")
    assert.equal(m.title, "OOB - Remote access")
    assert.ok(!m.rows.some((r) => /oob/i.test(r.label + r.value)))
  })

  it("keeps every row short enough for a narrow sidebar", async () => {
    const s = state({
      mode: "on",
      chat: true,
      delivery: "steer",
      override: true,
      pending: [prompt("a")],
    })
    for (const r of sidebarRows(s))
      assert.ok(r.label.length <= 8 && r.value.length <= 14, r.label)
  })
})

describe("sidebarModel", () => {
  it("full has the title, the channel for the right of it, and the rows", async () => {
    const m = sidebarModel(state({ channel: "telegram", mode: "on" }), "full")
    assert.equal(m.mode, "full")
    if (m.mode !== "full") return
    assert.equal(m.title, "OOB - Remote access")
    assert.equal(m.channel, "telegram")
    assert.equal(m.rows.length, 5)
  })

  it("compact is one line: Remote · channel · notify · chat", async () => {
    const text = (s: SidebarState) =>
      compactParts(s)
        .map((p) => p.text)
        .join("")
    assert.equal(
      text(state({ mode: "on", channel: "telegram", chat: true })),
      "OOB - Remote · telegram · notify on · chat on ▾",
    )
    assert.equal(
      text(state()),
      "OOB - Remote · all · notify when away · chat off ▾",
    )
    assert.equal(
      text(state({ chatCapable: false, mode: "off" })),
      "OOB - Remote · all · notify off ▾",
    )
    assert.equal(
      text(state({ pending: [prompt("a"), prompt("b")], blocked: "x" })),
      "OOB - Remote · all · notify when away · chat denied · 2 waiting ▾",
    )
  })

  it("off draws nothing", async () => {
    assert.deepEqual(sidebarModel(state(), "off"), { mode: "off" })
    const warn =
      "⚠ the server runs 0.22.0 but 0.23.0 is installed: restart OpenCode"
    const stale = state({
      bridge: { ...state().bridge, versionWarnings: [warn] },
    })
    const full = sidebarModel(stale, "full")
    assert.equal(full.mode === "full" && full.warning, warn)
    assert.equal(
      sidebarModel(state(), "full").mode === "full" &&
        (sidebarModel(state(), "full") as { warning?: string }).warning,
      undefined,
    )
    const compact = sidebarModel(stale, "compact")
    assert.equal(compact.mode === "compact" && compact.parts[0].tone, "warn")
    assert.match(
      compact.mode === "compact" ? compact.parts[0].text : "",
      /⚠ restart OpenCode/,
    )
  })
})

describe("rowDialog", () => {
  const titles = (s: SidebarState, row: Parameters<typeof rowDialog>[1]) =>
    rowDialog(s, row).options.map((o) => o.title)

  it("Notify lists on, on per channel, on via all, when away and off", async () => {
    assert.deepEqual(titles(state(), "notify"), [
      "On — push questions and notices now",
      "On via telegram — push now, only through telegram",
      "On via ntfy — push now, only through ntfy",
      "On via all — push now, through every channel",
      "When away — after 10 min without input",
      "Off — never push this session",
    ])
    assert.deepEqual(
      rowDialog(state(), "notify").options.map((o) => o.value),
      ["on", "on:telegram", "on:ntfy", "on:all", "auto", "off"],
    )
  })

  it("Notify with one channel has no via-all", async () => {
    assert.ok(
      !titles(state({ channels: ["telegram"] }), "notify").some((t) =>
        /all/.test(t),
      ),
    )
  })

  it("Notify marks the current choice", async () => {
    assert.equal(rowDialog(state(), "notify").current, "auto")
    assert.equal(rowDialog(state({ mode: "off" }), "notify").current, "off")
    assert.equal(rowDialog(state({ mode: "on" }), "notify").current, "on")
    assert.equal(
      rowDialog(state({ mode: "on", via: "ntfy", channel: "ntfy" }), "notify")
        .current,
      "on:ntfy",
    )
  })

  it("Chat has on and off; denied disables on and says why", async () => {
    const free = rowDialog(state({ chat: true }), "chat")
    assert.deepEqual(
      free.options.map((o) => [o.value, o.disabled]),
      [
        ["on", false],
        ["off", undefined],
      ],
    )
    assert.equal(free.current, "on")
    const denied = rowDialog(state({ blocked: "agent ^coord$" }), "chat")
    assert.equal(denied.options[0].disabled, true)
    assert.match(denied.options[0].description!, /chat\.deny .*agent \^coord\$/)
    assert.match(denied.title, /blocked/)
  })

  it("Replies has immediately, after turn and the config default", async () => {
    assert.deepEqual(titles(state({ defaultDelivery: "steer" }), "replies"), [
      "Immediately — join the running turn",
      "After turn — wait for the current turn to finish",
      "Default — follow the config (immediately)",
    ])
    assert.equal(rowDialog(state(), "replies").current, "default")
    assert.equal(
      rowDialog(state({ override: true, delivery: "steer" }), "replies")
        .current,
      "steer",
    )
  })

  it("Waiting lists the open prompts with their age", async () => {
    const d = rowDialog(
      state({ pending: [prompt("a", 0), prompt("b", 9 * 60_000 + 40_000)] }),
      "waiting",
    )
    assert.deepEqual(
      d.options.map((o) => [o.value, o.description]),
      [
        ["a", "10 min ago"],
        ["b", "just now"],
      ],
    )
    assert.match(d.options[0].title, /^question: Pick a/)
  })
})

async function rig(
  chat: Record<string, unknown> = {},
  o: {
    canChat?: boolean
    sidebar?: string
    version?: string
    installed?: string
    tui?: string
  } = {},
) {
  const cfg = parseConfig({
    channels: { telegram: { token: { env: "X" } } },
    chat,
    sidebar: o.sidebar,
  }) as Config
  const connector = {
    id: "telegram",
    type: "telegram",
    enabled: true,
    capabilities: {
      buttons: true,
      edit: true,
      multiselect: true,
      rich: true,
      threads: true,
      pairing: true,
      inboundPrompt: o.canChat !== false,
    },
    start() {},
    hint: () => "",
    send: async () => undefined,
    status: () => ({}),
  } as unknown as Connector
  const facts = { agent: "coord", directory: "/w/shop" }
  const host = {
    session: async (id: string) => ({ id, ...facts, title: "T" }),
    peek: () => facts,
    root: (id: string) => id,
    replyForm: async () => {},
    prompt: async () => {},
    busy: () => false,
  } as unknown as Host
  const store = new PendingStore()
  const router = new Router(cfg, async () => true)
  const bridge = new Bridge(cfg, host, [connector], store, router)
  const settings = new SettingsStore()
  const control = new Control({
    bridge,
    router,
    settings,
    cfg,
    host,
    owner: { pid: 42, startedAt: Date.now() },
    version: o.version ?? "test",
    installed: async () => ({
      version: o.installed ?? o.version ?? "test",
      dir: "/opt/plugin",
    }),
  })
  const call: Transport = async (method, input) => {
    if (method === "op")
      return control.op(String(input.op), input.args as Record<string, never>)
    control.heartbeat("t", Date.now(), String(input.version))
    return control.snapshot(["root"])
  }
  const remote = new Remote({
    call,
    roots: () => ["root"],
    version: o.tui ?? o.version ?? "test",
    installed: async () => ({
      version: o.installed ?? o.version ?? "test",
      dir: "/opt/plugin",
    }),
  })
  await remote.poll()
  const tui = new SettingsStore()
  const app = { pilot: remote, settings: tui, router, bridge } as App & {
    router: Router
    bridge: Bridge
  }
  return { app, store, bridge, router, settings, tui, remote, control }
}

describe("version mismatch in the sidebar and in /oob version", () => {
  it("shows no warning when the disk, the server and the TUI agree", async () => {
    const { app, control } = await rig({}, { version: "0.23.0" })
    await control.refreshInstalled(true)
    await app.pilot.refresh()
    assert.deepEqual(app.pilot.versionWarnings(), [])
    assert.deepEqual(sidebarState(app, "root").bridge.versionWarnings, [])
    const m = sidebarModel(sidebarState(app, "root"), "full")
    assert.equal(m.mode === "full" && m.warning, undefined)
    const lines = (await app.pilot.versionLines())!
    assert.ok(lines.includes("All versions match."), lines.join("\n"))
  })

  it("warns in the header and in /oob version when the server runs an older version than the disk", async () => {
    const { app, control } = await rig(
      {},
      { version: "0.22.0", installed: "0.23.0", tui: "0.23.0" },
    )
    await control.refreshInstalled(true)
    await app.pilot.refresh()
    const want =
      "⚠ the server runs 0.22.0 but 0.23.0 is installed: restart OpenCode"
    assert.deepEqual(app.pilot.versionWarnings(), [want])
    const s = sidebarState(app, "root")
    const m = sidebarModel(s, "full")
    assert.equal(m.mode === "full" && m.warning, want)
    const lines = (await app.pilot.versionLines())!
    assert.ok(lines.includes(want), lines.join("\n"))
    assert.ok(lines.includes("TUI runs: 0.23.0"))
    assert.ok(lines.some((l) => l.startsWith("Server runs: 0.22.0, pid 42")))
  })

  it("warns when this TUI runs an older version than the disk", async () => {
    const { app, control } = await rig(
      {},
      { version: "0.23.0", installed: "0.23.0", tui: "0.22.0" },
    )
    await control.refreshInstalled(true)
    await app.pilot.refresh()
    assert.deepEqual(app.pilot.versionWarnings(), [
      "⚠ a TUI runs 0.22.0 but 0.23.0 is installed: restart OpenCode",
    ])
    // The server learned the TUI's version from its heartbeat, so a chat says so too.
    assert.match(
      await control.versionText(),
      /a TUI runs 0\.22\.0 but 0\.23\.0 is installed/,
    )
  })
})

describe("sidebarState and applyPick", () => {
  const go = (ok = true) => {
    const seen: string[] = []
    return { seen, fn: (id: string) => (seen.push(id), ok) }
  }

  it("reads the state of a session from the bridge", async () => {
    const { app } = await rig()
    const s = sidebarState(app, "root")
    assert.equal(s.mode, "auto")
    assert.equal(s.channel, "all")
    assert.deepEqual(s.channels, ["telegram"])
    assert.equal(s.defaultChannel, "all")
    assert.equal(s.awayMinutes, 10)
    assert.deepEqual(s.pending, [])
  })

  it("a Notify pick sets the routing and keeps it", async () => {
    const { app, settings } = await rig()
    assert.match(
      (await applyPick(app, "root", "notify", "on:telegram", go().fn)).text,
      /Notify on via telegram/,
    )
    assert.equal(app.router.mode("root"), "on")
    assert.equal(app.router.channel("root"), "telegram")
    assert.equal(settings.sessions().root.on, true)
    assert.equal(
      (await applyPick(app, "root", "notify", "off", go().fn)).text,
      "Notify off",
    )
    assert.equal(app.router.mode("root"), "off")
    assert.equal(
      (await applyPick(app, "root", "notify", "auto", go().fn)).text,
      "Notify when away",
    )
    assert.equal(settings.sessions().root, undefined)
    assert.equal(
      (await applyPick(app, "root", "notify", "on", go().fn)).ok,
      true,
    )
    assert.equal(
      (await applyPick(app, "root", "notify", "on:all", go().fn)).ok,
      true,
    )
  })

  it("a Notify pick of something unknown changes nothing", async () => {
    const { app } = await rig()
    assert.equal(
      (await applyPick(app, "root", "notify", "bogus", go().fn)).ok,
      false,
    )
    const out = await applyPick(app, "root", "notify", "on:nope", go().fn)
    assert.equal(out.ok, false)
    assert.equal(app.router.mode("root"), "auto")
  })

  it("a Chat pick turns it on and off", async () => {
    const { app } = await rig()
    assert.equal((await applyPick(app, "root", "chat", "on", go().fn)).ok, true)
    assert.equal(sidebarState(app, "root").chat, true)
    assert.equal(
      (await applyPick(app, "root", "chat", "off", go().fn)).ok,
      true,
    )
    assert.equal(app.bridge.chatEnabled("root"), false)
  })

  it("chat.deny is shown, explained in the dialog, and refused on a pick", async () => {
    const { app } = await rig({ deny: [{ directory: "**/shop" }] })
    const s = sidebarState(app, "root")
    assert.equal(s.blocked, "directory **/shop")
    assert.equal(sidebarRows(s)[1].value, "denied")
    assert.equal(rowDialog(s, "chat").options[0].disabled, true)
    const out = await applyPick(app, "root", "chat", "on", go().fn)
    assert.equal(out.ok, false)
    assert.match(out.text, /chat\.deny .*directory \*\*\/shop/)
    assert.equal(app.bridge.chatEnabled("root"), false)
  })

  it("a Replies pick sets the session's delivery, and default clears it", async () => {
    const { app, settings } = await rig()
    assert.equal(
      (await applyPick(app, "root", "replies", "steer", go().fn)).text,
      "Replies: immediately",
    )
    assert.equal(settings.sessions().root.delivery, "steer")
    assert.equal(sidebarState(app, "root").override, true)
    await applyPick(app, "root", "replies", "default", go().fn)
    assert.equal(app.bridge.deliveryOverride("root"), undefined)
    assert.equal(settings.sessions().root, undefined)
    assert.equal(
      (await applyPick(app, "root", "replies", "x", go().fn)).ok,
      false,
    )
  })

  it("open prompts are listed oldest first, and a Waiting pick goes to its session", async () => {
    const { app, store } = await rig()
    const base = {
      kind: "question" as const,
      requestID: "r",
      title: "t",
      rootSessionID: "root",
      state: "pending" as const,
    }
    store.put({ ...base, id: "b", sessionID: "child", askedAt: 2 })
    store.put({ ...base, id: "a", sessionID: "root", askedAt: 1 })
    store.put({
      ...base,
      id: "c",
      sessionID: "root",
      askedAt: 3,
      state: "answered" as never,
    })
    store.put({
      ...base,
      id: "x",
      sessionID: "x",
      askedAt: 1,
      rootSessionID: "other",
    })
    await app.pilot.refresh()
    const s = sidebarState(app, "root")
    assert.deepEqual(
      s.pending.map((p) => p.id),
      ["a", "b"],
    )
    const g = go()
    assert.equal((await applyPick(app, "root", "waiting", "b", g.fn)).ok, true)
    assert.deepEqual(g.seen, ["child"])
    assert.equal(
      (await applyPick(app, "root", "waiting", "b", go(false).fn)).ok,
      false,
    )
    assert.match(
      (await applyPick(app, "root", "waiting", "gone", g.fn)).text,
      /no longer open/,
    )
  })
})

function fakeCtx() {
  const claims: Array<{
    prepend?: string
    append?: string
    render: (i: { sessionID: string }) => unknown
  }> = []
  const toasts: Array<{ message: string; variant?: string }> = []
  const dialogs: Array<{
    title: string
    current?: string
    options: Array<{ title: string; value: string; disabled?: boolean }>
  }> = []
  const picks: Array<string | undefined> = []
  const navigations: unknown[] = []
  let released = 0
  const ctx = {
    data: {
      session: {
        root: (id: string) => (id === "child" ? "root" : id),
        get: (id: string) => (id === "gone" ? undefined : { id }),
      },
    },
    ui: {
      slot: (c: (typeof claims)[number]) => {
        claims.push(c)
        return () => void released++
      },
      toast: {
        show: (o: { message: string; variant?: string }) => toasts.push(o),
      },
      dialog: {
        select: async (o: (typeof dialogs)[number]) => {
          dialogs.push(o)
          return picks.shift()
        },
        alert: async () => {},
      },
      router: {
        current: () => ({ type: "session", sessionID: "root" }),
        navigate: (r: unknown) => navigations.push(r),
      },
    },
    theme: {
      text: {
        base: "#ffffff",
        muted: { base: "#888888", hover: "#aaaaaa" },
        feedback: { success: "#00ff00", warning: "#ffaa00" },
      },
    },
  }
  return {
    ctx: ctx as never,
    claims,
    toasts,
    dialogs,
    picks,
    navigations,
    released: () => released,
  }
}

const rowsOf = (v: Parameters<SidebarView>[0]) => {
  const m = v.model()
  return m.mode === "full"
    ? m.rows
        .filter((r) => !INSTANCE.includes(r.id))
        .map((r) => `${r.label}: ${r.value}`)
    : []
}

describe("registerSidebar with a fake slot registry", () => {
  const capture = () => {
    const seen: Array<Parameters<SidebarView>[0]> = []
    const view: SidebarView = (p) => {
      seen.push(p)
      return { drawn: true }
    }
    return { seen, view }
  }

  it("claims the START of sidebar.content, so it renders first, and draws what the view returns", async () => {
    const f = fakeCtx()
    const { view } = capture()
    registerSidebar(f.ctx, view)
    assert.equal(f.claims.length, 1)
    assert.equal(f.claims[0].prepend, "sidebar.content")
    assert.equal(f.claims[0].append, undefined)
    assert.deepEqual(f.claims[0].render({ sessionID: "root" }), { drawn: true })
  })

  it("is empty until attached, then follows the session in view (a child shows its root)", async () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    const sb = registerSidebar(f.ctx, view)
    f.claims[0].render({ sessionID: "child" })
    assert.deepEqual(seen[0].model(), { mode: "off" })
    sb.attach((await rig({})).app)
    assert.deepEqual(rowsOf(seen[0]), [
      "Notify: when away",
      "Chat: off",
      "Replies: after turn",
    ])
  })

  it("follows the sidebar setting: config default, then the TUI choice", async () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    const sb = registerSidebar(f.ctx, view)
    const r = await rig({}, { sidebar: "compact" })
    sb.attach(r.app)
    f.claims[0].render({ sessionID: "root" })
    assert.equal(seen[0].model().mode, "compact")
    setSidebarMode(r.app, "off")
    assert.equal(seen[0].model().mode, "off")
    assert.equal(r.tui.sidebar(), "off")
  })

  it("tells the view when something changed, and stops after it unsubscribes", async () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    const sb = registerSidebar(f.ctx, view)
    const r = await rig()
    sb.attach(r.app)
    f.claims[0].render({ sessionID: "root" })
    let n = 0
    const off = seen[0].subscribe(() => n++)
    await r.bridge.setChat("root", true)
    await r.remote.poll()
    assert.ok(n >= 1, "chat toggle")
    const after = n
    r.store.put({
      id: "a",
      kind: "question",
      requestID: "r",
      title: "t",
      askedAt: 1,
      sessionID: "root",
      rootSessionID: "root",
      state: "pending",
    })
    await r.remote.poll()
    assert.ok(n > after, "a new prompt")
    assert.deepEqual(rowsOf(seen[0]), [
      "Notify: on",
      "Chat: on",
      "Replies: after turn",
      "Waiting: 1 question",
    ])
    const stop = n
    off()
    r.bridge.setDelivery("root", "steer")
    await r.remote.poll()
    assert.equal(n, stop)
    assert.equal(rowsOf(seen[0])[2], "Replies: immediately")
  })

  it("a click opens the row's dialog with the current choice, and a pick applies and toasts", async () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    const sb = registerSidebar(f.ctx, view)
    const r = await rig()
    sb.attach(r.app)
    f.claims[0].render({ sessionID: "child" })
    f.picks.push("on:telegram")
    seen[0].open("notify")
    await sleep(20)
    assert.equal(f.dialogs[0].title, "Notify about this session")
    assert.equal(f.dialogs[0].current, "auto")
    assert.equal(r.router.mode("root"), "on")
    assert.deepEqual(f.toasts.at(-1), {
      message: "Notify on via telegram",
      variant: "success",
    })
    assert.equal(rowsOf(seen[0])[0], "Notify: on")
  })

  it("a dismissed dialog changes nothing, and chat.deny shows its reason and refuses", async () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    const sb = registerSidebar(f.ctx, view)
    const r = await rig({ deny: [{ agent: "^coord$" }] })
    sb.attach(r.app)
    f.claims[0].render({ sessionID: "root" })
    f.picks.push(undefined)
    seen[0].open("notify")
    await sleep(20)
    assert.equal(r.router.mode("root"), "auto")
    assert.deepEqual(f.toasts, [])
    f.picks.push("on")
    seen[0].open("chat")
    await sleep(20)
    assert.equal(f.dialogs[1].options[0].disabled, true)
    assert.equal(f.toasts.at(-1)!.variant, "warning")
    assert.match(f.toasts.at(-1)!.message, /agent \^coord\$/)
  })

  it("a Waiting pick jumps to the session, and says so when it cannot", async () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    const sb = registerSidebar(f.ctx, view)
    const r = await rig()
    sb.attach(r.app)
    f.claims[0].render({ sessionID: "root" })
    const put = (id: string, sessionID: string) =>
      r.store.put({
        id,
        kind: "question",
        requestID: id,
        title: "t",
        askedAt: 1,
        sessionID,
        rootSessionID: "root",
        state: "pending",
      })
    put("a", "child")
    await r.remote.poll()
    f.picks.push("a")
    seen[0].open("waiting")
    await sleep(20)
    assert.deepEqual(f.navigations, [{ type: "session", sessionID: "child" }])
    put("b", "gone")
    await r.remote.poll()
    f.picks.push("b")
    seen[0].open("waiting")
    await sleep(20)
    assert.equal(f.navigations.length, 1)
    assert.equal(f.toasts.at(-1)!.variant, "warning")
  })

  it("a row with no options (nothing waits) opens no dialog; compact opens /oob", async () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    const sb = registerSidebar(f.ctx, view)
    sb.attach((await rig()).app)
    f.claims[0].render({ sessionID: "root" })
    seen[0].open("waiting")
    await sleep(20)
    assert.equal(f.dialogs.length, 0)
    f.picks.push(undefined)
    seen[0].openMenu()
    await sleep(20)
    assert.equal(f.dialogs[0].title, "OOB - Remote access")
  })

  it("a click before the bridge exists does nothing", async () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    registerSidebar(f.ctx, view)
    f.claims[0].render({ sessionID: "root" })
    seen[0].open("notify")
    seen[0].openMenu()
    await sleep(20)
    assert.deepEqual(f.toasts, [])
    assert.equal(f.dialogs.length, 0)
  })

  it("hands the view the theme's colours, reading { base } state sets", async () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    registerSidebar(f.ctx, view)
    f.claims[0].render({ sessionID: "root" })
    assert.deepEqual(seen[0].colors(), {
      normal: "#ffffff",
      muted: "#888888",
      ok: "#00ff00",
      warn: "#ffaa00",
    })
  })

  it("dispose releases the claim and stops the updates", async () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    const sb = registerSidebar(f.ctx, view)
    const r = await rig()
    sb.attach(r.app)
    f.claims[0].render({ sessionID: "root" })
    let n = 0
    seen[0].subscribe(() => n++)
    sb.dispose()
    assert.equal(f.released(), 1)
    r.bridge.setDelivery("root", "steer")
    assert.equal(n, 0)
  })

  it("no Chat or Replies row for a session whose channel cannot chat", async () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    const sb = registerSidebar(f.ctx, view)
    sb.attach((await rig({}, { canChat: false })).app)
    f.claims[0].render({ sessionID: "root" })
    assert.deepEqual(rowsOf(seen[0]), ["Notify: when away"])
  })
})
