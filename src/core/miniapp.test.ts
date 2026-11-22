import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { Host } from "../bridge.ts"
import type { Config } from "../config.ts"
import { signInitData } from "../link/initdata.ts"
import { Actions } from "./actions.ts"
import { appStamp, CSP, TELEGRAM_SDK } from "./app.ts"
import { EventRing, handler, startApi, type ApiDeps } from "./api.ts"
import { TokenStore } from "./auth.ts"
import { Views } from "./views.ts"

const BOT = "123456:test-bot-token"
const OPERATOR = 4242
const NOW = 1_800_000_000_000

const cfg = {
  redact: { mode: "full" },
  core: { port: 0 },
  miniApp: { maxAgeSeconds: 3600 },
  permissions: { remote: "once" },
  chat: {
    deny: [],
    models: [],
    projects: {
      shop: { directory: "/work/private/shop", agent: "build" },
      hidden: { directory: "/work/secret" },
    },
  },
} as unknown as Config

const init = (o: { user?: number; age?: number; token?: string } = {}) =>
  signInitData(o.token ?? BOT, {
    auth_date: String(Math.floor(NOW / 1000) - (o.age ?? 5)),
    query_id: "AAH",
    user: JSON.stringify({ id: o.user ?? OPERATOR, first_name: "A" }),
  })

const host = {
  session: async (id: string) => ({ id, directory: "/work/app" }),
  busy: () => false,
  agents: async () => ["build", "plan"],
  models: async () => [{ ref: "p/m", name: "M", variants: ["fast"] }],
  canReplyForm: () => false,
} as unknown as Host

async function rig(clock = { t: NOW }) {
  const dir = await mkdtemp(join(tmpdir(), "oob-miniapp-"))
  const tokens = new TokenStore(join(dir, "core-token"))
  await tokens.load()
  const token = (await readFile(join(dir, "core-token"), "utf8")).trim()
  const calls: string[] = []
  const control = {
    snapshot: () => ({
      v: 1,
      at: 1,
      owner: { startedAt: 1700000000000, version: "9.9.9" },
      versions: { installed: "1.0.0", tuis: [] },
      afk: {},
      pending: 0,
      channels: [],
      sessions: [],
      stuck: [],
      night: {
        until: NOW + 1000,
        sessions: [
          {
            id: "s",
            title: "key sk-abcdefghijklmnopqrstuvwxyz123456",
            turns: 1,
            tasksDone: 0,
            tasks: 2,
            needs: 0,
          },
        ],
      },
    }),
    night: {
      end: async (by: string) => {
        calls.push("end:" + by)
        return true
      },
    },
  } as never
  const deps: ApiDeps = {
    views: new Views({
      control,
      bridge: { known: () => [], openPromptList: () => [] } as never,
      host,
      cfg,
      sources: { tail: [], diff: [], todos: [] },
    }),
    actions: new Actions({
      cfg,
      host,
      now: () => NOW,
      denial: (f) =>
        f?.directory === "/work/secret" ? "directory" : undefined,
      setChat: async () => ({ ok: true, text: "" }),
      setWatch: async () => ({ ok: true, text: "" }),
      resume: async () => ({ ok: true, text: "" }),
      answer: async () => ({ ok: true, text: "" }),
    }),
    control,
    cfg,
    tokens,
    ring: new EventRing(),
    version: "9.9.9",
    digest: () => ({ enabled: true, text: "Finished (1)" }),
    edge: {
      operator: () => OPERATOR,
      botToken: () => BOT,
      maxAgeSeconds: 3600,
      now: () => clock.t,
    },
  }
  // The relay link runs a request through the handler with the client the relay saw.
  const h = handler(deps)
  const link: Server = createServer((req, res) =>
    h(req, res, { client: "203.0.113.9" }),
  )
  await new Promise<void>((ok) => link.listen(0, "127.0.0.1", ok))
  const direct = await startApi(deps, { host: "127.0.0.1", port: 0 })
  return {
    deps,
    token,
    calls,
    clock,
    url: "http://127.0.0.1:" + (link.address() as { port: number }).port,
    direct: "http://127.0.0.1:" + direct.port,
    async close() {
      link.closeAllConnections()
      link.close()
      await direct.close()
    },
  }
}

const tma = (s: string) => ({ authorization: "tma " + s })

describe("init data through the relay link", () => {
  it("accepts fresh init data of the operator", async () => {
    const r = await rig()
    try {
      const res = await fetch(r.url + "/v1/meta", { headers: tma(init()) })
      assert.equal(res.status, 200)
    } finally {
      await r.close()
    }
  })

  it("refuses a tampered hash, a stale date and a wrong bot with 401 and a reason", async () => {
    const r = await rig()
    try {
      const bad = [
        [init().replace(/hash=[0-9a-f]{4}/, "hash=0000"), "bad_signature"],
        [init({ age: 7200 }), "too_old"],
        [init({ token: "999:other" }), "bad_signature"],
        ["user=1", "malformed"],
      ]
      for (const [s, reason] of bad) {
        const res = await fetch(r.url + "/v1/meta", { headers: tma(s) })
        assert.equal(res.status, 401)
        assert.deepEqual(await res.json(), { error: reason })
      }
    } finally {
      await r.close()
    }
  })

  it("answers 403 for another user with a valid hash", async () => {
    const r = await rig()
    try {
      const res = await fetch(r.url + "/v1/sessions", {
        headers: tma(init({ user: 7 })),
      })
      assert.equal(res.status, 403)
    } finally {
      await r.close()
    }
  })

  it("refuses the bearer token on the link, and takes it from a direct client", async () => {
    const r = await rig()
    try {
      const h = { authorization: "Bearer " + r.token }
      assert.equal(
        (await fetch(r.url + "/v1/meta", { headers: h })).status,
        401,
      )
      assert.equal(
        (await fetch(r.direct + "/v1/meta", { headers: h })).status,
        200,
      )
      assert.equal(
        (await fetch(r.direct + "/v1/meta", { headers: tma(init()) })).status,
        401,
        "init data is not a credential on a direct socket",
      )
    } finally {
      await r.close()
    }
  })

  it("blocks a client after ten failures in a minute, good credentials included", async () => {
    const r = await rig()
    try {
      for (let i = 0; i < 10; i++)
        assert.equal(
          (await fetch(r.url + "/v1/meta", { headers: tma("junk") })).status,
          401,
        )
      assert.equal(
        (await fetch(r.url + "/v1/meta", { headers: tma(init()) })).status,
        429,
      )
      r.clock.t += 6 * 60_000
      assert.equal(
        (await fetch(r.url + "/v1/meta", { headers: tma(init()) })).status,
        200,
      )
    } finally {
      await r.close()
    }
  })
})

describe("the app files", () => {
  it("serves the page without credentials, with a policy that allows Telegram's script and no other outside one", async () => {
    const r = await rig()
    try {
      const res = await fetch(r.url + "/app/")
      assert.equal(res.status, 200)
      assert.match(res.headers.get("content-type") ?? "", /text\/html/)
      const csp = res.headers.get("content-security-policy") ?? ""
      assert.equal(csp, CSP)
      assert.match(csp, /script-src 'self' https:\/\/telegram\.org(;|$)/)
      assert.doesNotMatch(csp, /https?:\/\/(?!web|webk|webz|telegram\.org)/)
      assert.doesNotMatch(csp, /unsafe|\*/)
      assert.match(csp, /frame-ancestors https:\/\/web\.telegram\.org/)
      assert.equal(res.headers.get("x-content-type-options"), "nosniff")
      assert.equal((await fetch(r.url + "/app/app.js")).status, 200)
      assert.equal((await fetch(r.url + "/app/app.css")).status, 200)
    } finally {
      await r.close()
    }
  })

  it("serves nothing else: no traversal, no unknown name, no other path", async () => {
    const r = await rig()
    try {
      for (const p of [
        "/app/nope.js",
        "/app/..%2fpackage.json",
        "/app/.env",
        "/app/sub/app.js",
        "/app/app.test.js",
      ])
        assert.equal((await fetch(r.url + p)).status, 404, p)
      for (const p of ["/app/../package.json", "/app/%2e%2e/package.json"])
        assert.notEqual((await fetch(r.url + p)).status, 200, p)
      assert.equal((await fetch(r.url + "/admin")).status, 404)
    } finally {
      await r.close()
    }
  })

  it("answers /healthz openly, and /v1 only with credentials", async () => {
    const r = await rig()
    try {
      assert.equal((await fetch(r.url + "/healthz")).status, 200)
      assert.equal((await fetch(r.url + "/v1/sessions")).status, 401)
    } finally {
      await r.close()
    }
  })

  it("never lets the page be kept, and names every file with the build", async () => {
    const r = await rig()
    try {
      const stamp = await appStamp("9.9.9")
      assert.match(stamp, /^9\.9\.9-[0-9a-f]{8}$/)
      const page = await fetch(r.url + "/app/")
      assert.equal(page.headers.get("cache-control"), "no-store")
      const html = await page.text()
      assert.ok(html.includes(`href="app.css?v=${stamp}"`), html)
      assert.ok(html.includes(`src="app.js?v=${stamp}"`), html)
      assert.ok(
        html.includes(`src="${TELEGRAM_SDK}"`),
        "the outside script is left alone",
      )
      const direct = await fetch(r.direct + "/app/", {
        headers: { authorization: "Bearer " + r.token },
      })
      assert.equal(direct.headers.get("cache-control"), "no-store")
      assert.equal(await direct.text(), html, "the same page by both ports")
    } finally {
      await r.close()
    }
  })

  it("keeps a file for good only when it was asked for with the current build, and stamps its imports", async () => {
    const r = await rig()
    try {
      const stamp = await appStamp("9.9.9")
      const kept = await fetch(`${r.url}/app/app.js?v=${stamp}`)
      assert.equal(
        kept.headers.get("cache-control"),
        "public, max-age=31536000, immutable",
      )
      const js = await kept.text()
      assert.match(js, new RegExp(`from "\\./api\\.js\\?v=${stamp}"`))
      assert.doesNotMatch(
        js,
        /from "\.\/[a-z-]+\.js"/,
        "no import without the build",
      )
      for (const url of [
        "/app/app.js",
        "/app/app.js?v=old",
        "/app/app.css",
        "/app/app.css?v=old",
      ]) {
        const res = await fetch(r.url + url)
        assert.equal(res.status, 200, url)
        assert.equal(res.headers.get("cache-control"), "no-store", url)
      }
    } finally {
      await r.close()
    }
  })

  it("gives the build in the meta, and another build for another version", async () => {
    const r = await rig()
    try {
      const meta = await (
        await fetch(r.url + "/v1/meta", { headers: tma(init()) })
      ).json()
      assert.equal(meta.app, await appStamp("9.9.9"))
      assert.notEqual(await appStamp("9.9.8"), meta.app)
      assert.equal((await appStamp("9.9.9")).slice(-8), meta.app.slice(-8))
    } finally {
      await r.close()
    }
  })

  it("loads nothing from another origin", async () => {
    const dir = new URL("../../miniapp/", import.meta.url)
    const { readdir } = await import("node:fs/promises")
    for (const f of await readdir(dir)) {
      if (!/\.(html|js|css)$/.test(f) || /\.test\./.test(f)) continue
      const text = await readFile(new URL(f, dir), "utf8")
      const outside = [
        ...text.matchAll(/(?:src|href)=["'](https?:[^"']*)/g),
      ].map((m) => m[1])
      assert.deepEqual(
        outside,
        f === "index.html" ? [TELEGRAM_SDK] : [],
        "the only outside file is Telegram's script, in the page",
      )
      assert.doesNotMatch(text, /@import|url\(\s*["']?https?:/, f)
      assert.doesNotMatch(text, /import\(?\s*["']https?:/, f)
    }
  })
})

describe("what the app reads", () => {
  const get = async (r: Awaited<ReturnType<typeof rig>>, p: string) =>
    (await fetch(r.url + p, { headers: tma(init()) })).json() as Promise<any>

  it("lists models, agents and projects, never a folder, and leaves out a denied project", async () => {
    const r = await rig()
    try {
      const o = await get(r, "/v1/options")
      assert.deepEqual(o.agents, ["build", "plan"])
      assert.equal(o.models[0].ref, "p/m")
      assert.deepEqual(o.projects, [{ name: "shop", agent: "build" }])
      assert.doesNotMatch(JSON.stringify(o), /\/work/)
    } finally {
      await r.close()
    }
  })

  it("reports the permission policy in meta, and the plan, redacted, in status", async () => {
    const r = await rig()
    try {
      assert.equal((await get(r, "/v1/meta")).permissions, "once")
      const s = await get(r, "/v1/status")
      assert.equal(s.night.sessions[0].tasks, 2)
      assert.doesNotMatch(s.night.sessions[0].title, /sk-abcdefghijklmnop/)
      assert.equal(s.versions.installed, "1.0.0")
      assert.deepEqual(s.owner, { startedAt: 1700000000000, version: "9.9.9" })
    } finally {
      await r.close()
    }
  })

  it("gives the digest text and ends the plan", async () => {
    const r = await rig()
    try {
      assert.deepEqual(await get(r, "/v1/digest"), {
        enabled: true,
        text: "Finished (1)",
      })
      const end = await fetch(r.url + "/v1/overnight/end", {
        method: "POST",
        headers: tma(init()),
      })
      assert.equal(end.status, 200)
      assert.deepEqual(r.calls, ["end:app"])
      assert.equal(
        (await fetch(r.url + "/v1/overnight/end", { method: "POST" })).status,
        401,
      )
      assert.deepEqual(r.calls, ["end:app"])
    } finally {
      await r.close()
    }
  })
})

describe("the app's diagnostic lines", () => {
  const post = (
    r: Awaited<ReturnType<typeof rig>>,
    body: unknown,
    headers = tma(init()),
  ) =>
    fetch(r.url + "/v1/log", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  it("takes a line with credentials, writes it as app_<event> with its data, and nothing else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oob-log-"))
    const file = join(dir, "bridge.log")
    const was = process.env.OPENCODE_OOB_BRIDGE_LOG
    process.env.OPENCODE_OOB_BRIDGE_LOG = file
    const r = await rig()
    try {
      const res = await post(r, {
        event: "stream_error",
        data: {
          name: "TypeError",
          bytes: false,
          leak: "hash=" + "0".repeat(64),
        },
      })
      assert.equal(res.status, 200)
      const text = await waitFor(async () => {
        const s = await readFile(file, "utf8").catch(() => "")
        return s.includes("app_stream_error") ? s : undefined
      })
      const line = JSON.parse(text.trim().split("\n").pop() ?? "{}")
      assert.equal(line.event, "app_stream_error")
      assert.deepEqual(line.data, { name: "TypeError", bytes: false })
      assert.ok(!text.includes("hash="))
    } finally {
      if (was === undefined) delete process.env.OPENCODE_OOB_BRIDGE_LOG
      else process.env.OPENCODE_OOB_BRIDGE_LOG = was
      await r.close()
    }
  })

  it("refuses a line without credentials, and a body that is not a line", async () => {
    const r = await rig()
    try {
      assert.equal((await post(r, { event: "x" }, {})).status, 401)
      assert.equal((await post(r, { event: "Bad Name" })).status, 400)
      assert.equal((await post(r, { nope: 1 })).status, 400)
    } finally {
      await r.close()
    }
  })

  it("answers 429 after thirty lines in a minute", async () => {
    const r = await rig()
    try {
      for (let i = 0; i < 30; i++)
        assert.equal((await post(r, { event: "x" })).status, 200)
      assert.equal((await post(r, { event: "x" })).status, 429)
    } finally {
      await r.close()
    }
  })
})

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  ms = 2000,
): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((ok) => setTimeout(ok, 20))
  }
}
