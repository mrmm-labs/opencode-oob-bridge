import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  configPath,
  dataDir,
  loadConfig,
  parseConfig,
  type Config,
} from "./config.ts"
import { DEFAULT_MEDIA_MIMES } from "./connectors/telegram-media.ts"

/** The options a connector type parsed for one channel. */
const opts = (c: Config, name: string) =>
  c.channels[name].options as Record<string, unknown>

const base = {
  server: "https://ntfy.example/",
  topics: { out: "oc-x-out", in: "oc-x-in" },
}

describe("parseConfig", () => {
  it("fills defaults", () => {
    const c = parseConfig(base) as Config
    assert.equal(opts(c, "ntfy").server, "https://ntfy.example")
    assert.equal(c.away.minutes, 10)
    assert.deepEqual(c.redact, { mode: "full" })
    assert.deepEqual(c.rules, [])
    assert.equal(opts(c, "ntfy").token, undefined)
    assert.equal(opts(c, "ntfy").actionAuth, true)
    assert.equal(c.channels.ntfy.enabled, true)
    assert.equal(c.channels.telegram, undefined)
  })

  it("actionAuth is a boolean", () => {
    assert.equal(
      opts(parseConfig({ ...base, actionAuth: false }) as Config, "ntfy")
        .actionAuth,
      false,
    )
    assert.ok("error" in parseConfig({ ...base, actionAuth: "yes" }))
  })

  it("accepts token from env or command and rules", () => {
    const c = parseConfig({
      ...base,
      token: { command: ["pass", "show", "ntfy"] },
      rules: [
        { agent: "^coordinator$" },
        { directory: "**/app" },
        { command: ["true"] },
      ],
      redact: "head:300",
      permissions: { tier: 3 },
    }) as Config
    assert.deepEqual(opts(c, "ntfy").token, {
      command: ["pass", "show", "ntfy"],
    })
    assert.equal(c.rules.length, 3)
    assert.ok(c.rules[0].agent?.test("coordinator"))
    assert.deepEqual(
      opts(parseConfig({ ...base, token: { env: "T" } }) as Config, "ntfy")
        .token,
      {
        env: "T",
      },
    )
  })

  it("refuses a literal token, tier 2 and bad topics", () => {
    assert.ok("error" in parseConfig({ ...base, token: "tk_abc" }))
    assert.ok("error" in parseConfig({ ...base, permissions: { tier: 2 } }))
    assert.ok(
      "error" in parseConfig({ ...base, topics: { out: "a", in: "a" } }),
    )
    assert.ok(
      "error" in parseConfig({ ...base, topics: { out: "a/b", in: "c" } }),
    )
    assert.ok("error" in parseConfig({ ...base, server: "ntfy.example" }))
    assert.ok("error" in parseConfig({ ...base, rules: [{}] }))
    assert.ok("error" in parseConfig({ ...base, redact: "half" }))
    assert.ok("error" in parseConfig({ ...base, away: { minutes: 0 } }))
  })
})

describe("parseConfig channels", () => {
  const ntfy = { server: "https://ntfy.example", topics: { out: "a", in: "b" } }

  it("reads channels.ntfy like the top-level form", () => {
    const legacy = parseConfig(ntfy) as Config
    const nested = parseConfig({
      channels: { ntfy: { ...ntfy, enabled: false } },
    }) as Config
    assert.deepEqual(opts(nested, "ntfy"), opts(legacy, "ntfy"))
    assert.equal(nested.channels.ntfy.enabled, false)
  })

  it("accepts telegram alone, with a token source and optional chat id", () => {
    const c = parseConfig({
      channels: {
        telegram: { token: { env: "TG" }, chatId: -100123 },
      },
    }) as Config
    assert.equal(c.channels.ntfy, undefined)
    assert.equal(c.channels.telegram.enabled, true)
    assert.deepEqual(opts(c, "telegram"), {
      token: { env: "TG" },
      chatId: "-100123",
      apiBase: "https://api.telegram.org",
      statusCard: true,
      notify: {},
      icons: {},
      reactions: {},
      media: { maxBytes: 10 * 1024 * 1024, mimes: DEFAULT_MEDIA_MIMES },
    })
    const d = parseConfig({
      channels: {
        telegram: { token: { command: ["pass", "tg"] }, chatId: "42" },
      },
    }) as Config
    assert.equal(opts(d, "telegram").chatId, "42")
  })

  it("reads telegram's statusCard, notify and icons, and refuses bad ones", () => {
    const c = parseConfig({
      channels: {
        telegram: {
          token: { env: "TG" },
          statusCard: false,
          notify: { finished: true },
          icons: { "^coord": "🎯" },
        },
      },
    }) as Config
    assert.deepEqual(opts(c, "telegram"), {
      token: { env: "TG" },
      chatId: undefined,
      apiBase: "https://api.telegram.org",
      statusCard: false,
      notify: { finished: true, failed: undefined },
      icons: { "^coord": "🎯" },
      reactions: {},
      media: { maxBytes: 10 * 1024 * 1024, mimes: DEFAULT_MEDIA_MIMES },
    })
    for (const bad of [
      { statusCard: "yes" },
      { notify: { failed: 1 } },
      { notify: "no" },
      { icons: { a: 3 } },
      { icons: [] },
    ])
      assert.ok(
        "error" in
          (parseConfig({
            channels: { telegram: { token: { env: "TG" }, ...bad } },
          }) as object),
        JSON.stringify(bad),
      )
  })

  it("reads chat.deny, chat.mirror and chat.stream, and refuses bad ones", () => {
    const base = { channels: { telegram: { token: { env: "TG" } } } }
    const d = parseConfig(base) as Config
    assert.deepEqual(d.chat, {
      deny: [],
      mirror: "replies",
      stream: true,
      streamMs: 1000,
      delivery: "queue",
      redact: { mode: "full" },
      projects: {},
      models: [],
    })
    assert.deepEqual(
      (parseConfig({ ...base, redact: "head:300" }) as Config).chat.redact,
      { mode: "full" },
    )
    assert.deepEqual(
      (parseConfig({ ...base, redact: "title" }) as Config).chat.redact,
      { mode: "title" },
    )
    assert.ok("error" in parseConfig({ ...base, chat: { redact: "half" } }))
    const c = parseConfig({
      ...base,
      chat: {
        mirror: "remote-only",
        stream: false,
        deny: [{ directory: "**/payroll" }, { agent: "^ops$" }],
      },
    }) as Config
    assert.equal(c.chat.mirror, "remote-only")
    assert.equal(c.chat.stream, false)
    assert.equal(c.chat.deny[0].directory, "**/payroll")
    assert.ok(c.chat.deny[1].agent!.test("ops"))
    for (const bad of [
      "yes",
      { mirror: "all" },
      { stream: "no" },
      { deny: {} },
      { deny: [{}] },
      { deny: [{ agent: "(" }] },
      { deny: ["x"] },
    ])
      assert.ok(
        "error" in (parseConfig({ ...base, chat: bad }) as object),
        JSON.stringify(bad),
      )
  })

  it("reads sidebar (full by default) and refuses an unknown size", () => {
    const base = { channels: { telegram: { token: { env: "TG" } } } }
    assert.equal((parseConfig(base) as Config).sidebar, "full")
    for (const m of ["full", "compact", "off"])
      assert.equal((parseConfig({ ...base, sidebar: m }) as Config).sidebar, m)
    for (const bad of ["big", true, 1])
      assert.match(
        (parseConfig({ ...base, sidebar: bad }) as { error: string }).error,
        /sidebar must be/,
      )
  })

  it("reads chat.delivery and chat.streamMs (800 at least), and refuses bad ones", () => {
    const base = { channels: { telegram: { token: { env: "TG" } } } }
    const c = parseConfig({
      ...base,
      chat: { delivery: "steer", streamMs: 800 },
    }) as Config
    assert.equal(c.chat.delivery, "steer")
    assert.equal(c.chat.streamMs, 800)
    for (const bad of [
      { delivery: "now" },
      { delivery: true },
      { streamMs: 799 },
      { streamMs: 0 },
      { streamMs: 1000.5 },
      { streamMs: "1000" },
      { streamMs: 61_000 },
    ])
      assert.ok(
        "error" in (parseConfig({ ...base, chat: bad }) as object),
        JSON.stringify(bad),
      )
  })

  it("reads chat.projects and chat.models, and refuses unsafe ones", () => {
    const base = { channels: { telegram: { token: { env: "TG" } } } }
    const c = parseConfig({
      ...base,
      chat: {
        projects: {
          shop: { directory: "/w/shop", agent: "build", model: "a/b-1" },
          docs: { directory: "/w/docs" },
        },
        models: ["a/b-1", "c/d:free"],
      },
    }) as Config
    assert.deepEqual(c.chat.projects.shop, {
      directory: "/w/shop",
      agent: "build",
      model: "a/b-1",
    })
    assert.deepEqual(c.chat.models, ["a/b-1", "c/d:free"])
    for (const bad of [
      { projects: [] },
      { projects: { "bad name": { directory: "/w" } } },
      { projects: { x: {} } },
      { projects: { x: { directory: "relative/dir" } } },
      { projects: { x: { directory: "/w/../etc" } } },
      { projects: { x: { directory: "/w", model: "nomodel" } } },
      { projects: { x: { directory: "/w", agent: "" } } },
      { models: "a/b" },
      { models: ["nomodel"] },
      { models: [1] },
    ])
      assert.ok(
        "error" in (parseConfig({ ...base, chat: bad }) as object),
        JSON.stringify(bad),
      )
  })

  it("runs both channels together", () => {
    const c = parseConfig({
      channels: { ntfy, telegram: { token: { env: "TG" } } },
    }) as Config
    assert.ok(c.channels.ntfy && c.channels.telegram)
    assert.equal(opts(c, "telegram").chatId, undefined)
  })

  it("defaultChannel is all unless set, and must name a configured channel", () => {
    const both = { channels: { ntfy, telegram: { token: { env: "TG" } } } }
    assert.equal((parseConfig(both) as Config).defaultChannel, "all")
    assert.equal(
      (parseConfig({ ...both, defaultChannel: "telegram" }) as Config)
        .defaultChannel,
      "telegram",
    )
    const err = (raw: unknown) => "error" in (parseConfig(raw) as object)
    assert.ok(err({ ...both, defaultChannel: "signal" }))
    assert.ok(err({ ...ntfy, defaultChannel: "telegram" }))
    assert.equal(
      (parseConfig({ ...ntfy, defaultChannel: "ntfy" }) as Config)
        .defaultChannel,
      "ntfy",
    )
  })

  it("type defaults to the name, so one type can have several instances", () => {
    const c = parseConfig({
      channels: {
        ntfy,
        phone: { type: "telegram", token: { env: "A" } },
        tablet: { type: "telegram", token: { env: "B" }, enabled: false },
      },
    }) as Config
    assert.deepEqual(
      Object.entries(c.channels).map(([n, v]) => [n, v.type, v.enabled]),
      [
        ["ntfy", "ntfy", true],
        ["phone", "telegram", true],
        ["tablet", "telegram", false],
      ],
    )
    assert.equal(
      (parseConfig({ channels: { ntfy }, defaultChannel: "ntfy" }) as Config)
        .defaultChannel,
      "ntfy",
    )
    assert.ok(
      "error" in
        (parseConfig({ channels: { x: { type: "signal" } } }) as object),
    )
    assert.ok(
      "error" in
        (parseConfig({ channels: { "a b": { type: "telegram" } } }) as object),
    )
    // A channel can be named "error" without confusing the result.
    assert.ok(
      "channels" in
        (parseConfig({
          channels: { error: { type: "telegram", token: { env: "A" } } },
        }) as object),
    )
  })

  it("refuses a literal telegram token, a bad chat id, mixed forms and no channel", () => {
    const err = (raw: unknown) => "error" in (parseConfig(raw) as object)
    assert.ok(err({ channels: { telegram: { token: "123:abc" } } }))
    assert.ok(err({ channels: { telegram: {} } }))
    assert.ok(
      err({ channels: { telegram: { token: { env: "T" }, chatId: "me" } } }),
    )
    assert.ok(
      err({ channels: { telegram: { token: { env: "T" }, apiBase: "x" } } }),
    )
    assert.ok(err({ ...ntfy, channels: { ntfy } }))
    assert.ok(err({ channels: { signal: {} } }))
    assert.ok(err({}))
    assert.ok(err({ channels: { ntfy: { ...ntfy, token: "tk_x" } } }))
  })
})

describe("loadConfig", () => {
  it("returns undefined when the file is missing (inert)", async () => {
    assert.equal(await loadConfig("/nonexistent/oob-bridge.jsonc"), undefined)
  })

  it("reads jsonc", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ntfyb-cfg-"))
    const p = join(dir, "c.jsonc")
    await writeFile(p, `// c\n${JSON.stringify(base)}`)
    assert.equal(
      (opts((await loadConfig(p)) as Config, "ntfy").topics as { in: string })
        .in,
      "oc-x-in",
    )
    await writeFile(p, "{ nope")
    assert.ok("error" in ((await loadConfig(p)) as object))
  })

  it("accepts the shipped example", async () => {
    const example = join(import.meta.dirname, "..", "oob-bridge.example.jsonc")
    const c = (await loadConfig(example)) as Config
    assert.equal(
      (opts(c, "ntfy").topics as { out: string }).out,
      "oc-3k9f2x7q-out",
    )
    assert.equal(c.rules.length, 2)
  })

  it("resolves paths from the environment", () => {
    assert.equal(
      configPath({ OPENCODE_OOB_BRIDGE_CONFIG: "/x.jsonc" }),
      "/x.jsonc",
    )
    assert.equal(
      configPath({ XDG_CONFIG_HOME: "/cfg" }),
      "/cfg/opencode/oob-bridge.jsonc",
    )
    assert.equal(dataDir({ XDG_DATA_HOME: "/d" }), "/d/opencode/oob-bridge")
    assert.equal(dataDir({ OPENCODE_OOB_BRIDGE_DATA: "/e" }), "/e")
  })

  it("falls back to the pre-rename names", async () => {
    assert.equal(
      configPath({ OPENCODE_NTFY_BRIDGE_CONFIG: "/o.jsonc" }),
      "/o.jsonc",
    )
    assert.equal(dataDir({ OPENCODE_NTFY_BRIDGE_DATA: "/o" }), "/o")
    const root = await mkdtemp(join(tmpdir(), "oobb-legacy-"))
    await mkdir(join(root, "opencode"))
    await writeFile(
      join(root, "opencode", "ntfy-bridge.jsonc"),
      JSON.stringify({
        server: "https://n.example",
        topics: { out: "a", in: "b" },
      }),
    )
    const keys = ["XDG_CONFIG_HOME", "OPENCODE_OOB_BRIDGE_CONFIG"] as const
    const prev = keys.map((k) => process.env[k])
    process.env.XDG_CONFIG_HOME = root
    delete process.env.OPENCODE_OOB_BRIDGE_CONFIG
    try {
      assert.equal(
        opts((await loadConfig()) as Config, "ntfy").server,
        "https://n.example",
      )
      assert.equal(await loadConfig(join(root, "other.jsonc")), undefined)
    } finally {
      keys.forEach((k, i) =>
        prev[i] === undefined
          ? delete process.env[k]
          : (process.env[k] = prev[i]),
      )
    }
  })
})

describe("telegram reactions and media settings", () => {
  const tg = (extra: Record<string, unknown>) =>
    parseConfig({
      channels: { telegram: { token: { env: "TG" }, ...extra } },
    }) as Config | { error: string }

  it("reads them, and refuses what cannot work", () => {
    const ok = tg({
      reactions: { agents: { Build: "🔥" }, queued: "🙈" },
      media: { maxBytes: 1000, mimes: ["image/*", "application/pdf"] },
    }) as Config
    const t = opts(ok, "telegram")
    assert.deepEqual(t.reactions, { agents: { build: "🔥" }, queued: "🙈" })
    assert.deepEqual(t.media, {
      maxBytes: 1000,
      mimes: ["image/*", "application/pdf"],
    })
    for (const bad of [
      { reactions: [] },
      { reactions: { nope: "x" } },
      { reactions: { agents: { a: 3 } } },
      { media: { maxBytes: 0 } },
      { media: { maxBytes: 21 * 1024 * 1024 } },
      { media: { mimes: ["PDF"] } },
      { media: { other: 1 } },
    ])
      assert.ok("error" in (tg(bad) as object), JSON.stringify(bad))
  })
})

describe("core", () => {
  it("is off unless bind is set", () => {
    const c = parseConfig(base) as Config
    assert.equal(c.core.bind, undefined)
    assert.equal(c.core.port, 7842)
  })

  it("reads bind and port", () => {
    const c = parseConfig({
      ...base,
      core: { bind: "tailscale", port: 9000 },
    }) as Config
    assert.deepEqual(c.core, { bind: "tailscale", port: 9000 })
  })

  it("rejects a bad bind or port", () => {
    for (const core of [
      "x",
      { bind: "" },
      { bind: 1 },
      { port: "80" },
      { port: 70000 },
    ])
      assert.ok(
        "error" in (parseConfig({ ...base, core }) as object),
        JSON.stringify(core),
      )
  })
})

describe("deadman", () => {
  it("is off unless a url is set", () => {
    const c = parseConfig(base) as Config
    assert.equal(c.deadman.url, undefined)
    assert.equal(c.deadman.intervalSeconds, 30)
  })

  it("reads url, token source and interval", () => {
    const c = parseConfig({
      ...base,
      deadman: {
        url: "https://relay.example/beat",
        token: { env: "T" },
        intervalSeconds: 10,
      },
    }) as Config
    assert.deepEqual(c.deadman, {
      url: "https://relay.example/beat",
      token: { env: "T" },
      intervalSeconds: 10,
    })
  })

  it("refuses a literal token and bad values", () => {
    for (const deadman of [
      "x",
      { url: "" },
      { url: 3 },
      { token: "literal" },
      { intervalSeconds: 0 },
      { intervalSeconds: 7200 },
    ])
      assert.ok(
        "error" in (parseConfig({ ...base, deadman }) as object),
        JSON.stringify(deadman),
      )
  })
})

describe("turnCard", () => {
  const base = { channels: { telegram: { token: { env: "X" } } } }
  it("is on with 20 seconds by default, off with false, and takes minSeconds", () => {
    const c = (turnCard?: unknown) =>
      (parseConfig({ ...base, turnCard }) as Config).turnCard
    assert.deepEqual(c(), { enabled: true, minSeconds: 20 })
    assert.equal(c(false).enabled, false)
    assert.deepEqual(c({ minSeconds: 0 }), { enabled: true, minSeconds: 0 })
  })
  it("refuses a value that is not a boolean or a sensible object", () => {
    for (const turnCard of ["yes", { minSeconds: -1 }, { minSeconds: "5" }])
      assert.ok(
        "error" in (parseConfig({ ...base, turnCard }) as object),
        JSON.stringify(turnCard),
      )
  })
})

describe("quiet and digest", () => {
  const base = { channels: { telegram: { token: { env: "X" } } } }
  const c = (extra: Record<string, unknown>) =>
    parseConfig({ ...base, ...extra }) as Config & { error?: string }

  it("are off by default", () => {
    assert.equal(c({}).quiet, undefined)
    assert.equal(c({}).digest, undefined)
  })

  it("parses the window, the zone and the break-through list", () => {
    const q = c({
      quiet: {
        from: "23:00",
        to: "07:30",
        timezone: "Europe/Paris",
        breakthrough: ["failed"],
      },
    }).quiet
    assert.deepEqual(q, {
      from: 1380,
      to: 450,
      timezone: "Europe/Paris",
      breakthrough: ["failed"],
    })
  })

  it("the digest time defaults to the end of quiet hours", () => {
    const k = c({ quiet: { from: "23:00", to: "07:00" }, digest: true })
    assert.deepEqual(k.digest, { at: 420, empty: false })
    assert.deepEqual(c({ digest: { at: "08:15", empty: true } }).digest, {
      at: 495,
      empty: true,
    })
  })

  it("refuses what cannot work", () => {
    for (const extra of [
      { quiet: { from: "23:00", to: "23:00" } },
      { quiet: { from: "25:00", to: "07:00" } },
      { quiet: { from: "23:00", to: "07:00", timezone: "Mars/Base" } },
      { quiet: { from: "23:00", to: "07:00", breakthrough: ["finished"] } },
      { digest: true },
      { digest: { at: "soon" } },
      { digest: { at: "07:00", empty: "yes" } },
    ])
      assert.ok("error" in c(extra), JSON.stringify(extra))
  })
})
