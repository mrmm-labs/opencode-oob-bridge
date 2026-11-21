import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { Host } from "../bridge.ts"
import type { Config } from "../config.ts"
import { Actions } from "./actions.ts"
import { EventRing, startApi, type Api } from "./api.ts"
import { TokenStore } from "./auth.ts"
import { ladder, Views, type Sources } from "./views.ts"

const cfg = (over: Partial<Config["chat"]> = {}) =>
  ({
    redact: { mode: "full" },
    core: { port: 0 },
    miniApp: { maxAgeSeconds: 3600 },
    permissions: { remote: "off" },
    chat: { deny: [], models: [], projects: {}, ...over },
  }) as unknown as Config

type Calls = string[]

function host(calls: Calls, over: Partial<Host> = {}): Host {
  return {
    session: async (id: string) => ({
      id,
      agent: "build",
      directory: id === "ses_secret" ? "/work/shop" : "/work/app",
    }),
    root: (id: string) => id,
    busy: () => false,
    interrupt: async () => {
      calls.push("interrupt")
      return true
    },
    prompt: async (_id: string, text: string) =>
      void calls.push("prompt:" + text),
    compact: async () => void calls.push("compact"),
    rename: async () => {},
    switchAgent: async () => {},
    switchModel: async () => {},
    createSession: async () => ({ id: "ses_new" }),
    replyForm: async () => {},
    agents: async () => ["build"],
    models: async () => [],
    ...over,
  } as unknown as Host
}

const actions = (
  calls: Calls,
  deny: (f: { directory?: string } | undefined) => string | undefined = () =>
    undefined,
  h = host(calls),
) =>
  new Actions({
    cfg: cfg(),
    host: h,
    now: Date.now,
    denial: deny,
    setChat: async () => ({ ok: true, text: "chat" }),
    setWatch: async () => ({ ok: true, text: "watch" }),
    resume: async () => ({ ok: true, text: "resumed" }),
    answer: async () => ({ ok: true, text: "answered" }),
  })

describe("actions", () => {
  it("refuses a permission reply with no policy and never calls the host", async () => {
    const calls: Calls = []
    const r = await actions(calls).run("permission", "ses_1", {
      requestID: "p1",
      decision: "once",
    })
    assert.equal(r.ok, false)
    assert.match(r.text, /no policy/)
    assert.deepEqual(calls, [])
  })

  it("refuses a prompt for a denied session", async () => {
    const calls: Calls = []
    const deny = (f?: { directory?: string }) =>
      f?.directory === "/work/shop" ? "directory **/shop" : undefined
    const a = actions(calls, deny)
    const r = await a.run("prompt", "ses_secret", { text: "hi" })
    assert.equal(r.ok, false)
    assert.match(r.text, /chat\.deny/)
    assert.equal((await a.run("prompt", "ses_ok", { text: "hi" })).ok, true)
    assert.deepEqual(calls, ["prompt:hi"])
  })

  it("stops, compacts and refuses unknown names", async () => {
    const calls: Calls = []
    const a = actions(calls)
    assert.equal((await a.run("stop", "ses_1", {})).ok, true)
    assert.equal((await a.run("compact", "ses_1", {})).ok, true)
    assert.equal((await a.run("nope", "ses_1", {})).ok, false)
    assert.deepEqual(calls, ["interrupt", "compact"])
  })

  it("lists what is unavailable and why", () => {
    const list = actions([]).available()
    assert.equal(list.find((x) => x.name === "permission")?.available, false)
    assert.equal(list.find((x) => x.name === "stop")?.available, true)
  })

  it("is the only route from an adapter to the host", async () => {
    const { execFile } = await import("node:child_process")
    const re = String.raw`\bhost\.(interrupt|prompt|compact|rename|switchAgent|switchModel|createSession|replyForm|replyPermission|resume)\(`
    const out = await new Promise<string>((res) =>
      execFile(
        "grep",
        [
          "-rEn",
          re,
          "src",
          "--include=*.ts",
          "--exclude=*.test.ts",
          "--exclude=*.test-util.ts",
        ],
        (_e, s) => res(s),
      ),
    )
    const hits = out
      .split("\n")
      .filter(
        (l) =>
          l &&
          !l.startsWith("src/core/actions.ts") &&
          !l.startsWith("src/server.ts"),
      )
    assert.deepEqual(hits, [])
  })
})

describe("view-models", () => {
  const sources = (over: Partial<Sources> = {}): Sources => ({
    tail: [
      [
        "server",
        async () => [
          {
            role: "user",
            text: "key sk-abcdefghijklmnopqrstuvwxyz123456",
            at: 1,
          },
        ],
      ],
      ["events", undefined],
    ],
    diff: [
      [
        "server",
        async () => [
          {
            file: "a.ts",
            status: "modified",
            additions: 2,
            deletions: 1,
            patch: "+x",
          },
        ],
      ],
    ],
    todos: [["server", undefined]],
    ...over,
  })
  const views = (src: Sources, blocked?: string) => {
    const row = {
      id: "ses_1",
      title: "T",
      mode: "auto" as const,
      chat: false,
      busy: false,
      prompts: [],
      blocked,
    }
    return new Views({
      control: { snapshot: () => ({ sessions: [row], stuck: [] }) } as never,
      bridge: { known: () => [], openPromptList: () => [] } as never,
      host: host([]),
      cfg: cfg(),
      sources: src,
    })
  }

  it("names the source of a field", async () => {
    const d = await views(sources()).detail("ses_1")
    assert.equal(d?.state, "idle")
    assert.ok(d && "value" in d.diff && d.diff.source === "server")
  })

  it("returns unavailable with a reason, not an empty value", async () => {
    const d = await views(
      sources({
        diff: [
          ["server", async () => undefined],
          ["tui", undefined],
        ],
      }),
    ).detail("ses_1")
    assert.ok(d && "unavailable" in d.diff)
    assert.match(
      (d.diff as { unavailable: string }).unavailable,
      /server: no data; tui: not available/,
    )
    assert.ok("unavailable" in d.todos)
  })

  it("falls to the next rung when one throws", async () => {
    const f = await ladder<number, undefined>(
      [
        [
          "a",
          async () => {
            throw new Error("boom")
          },
        ],
        ["b", async () => 7],
      ],
      "x",
      undefined,
    )
    assert.deepEqual(f, { value: 7, source: "b" })
  })

  it("masks a secret in a message", async () => {
    const m = await views(sources()).messages("ses_1")
    assert.ok(m && "value" in m)
    assert.doesNotMatch(m.value[0].text, /sk-abcdefghijklmnop/)
  })

  it("lists a denied session as blocked with no tail", async () => {
    const v = views(sources(), "directory **/shop")
    const d = await v.detail("ses_1")
    assert.equal(d?.blocked, "directory **/shop")
    assert.ok(d && "unavailable" in d.tail)
    assert.ok(d && "unavailable" in d.diff)
  })
})

describe("http api", () => {
  async function rig(keepAliveMs?: number) {
    const dir = await mkdtemp(join(tmpdir(), "oob-core-api-"))
    const tokens = new TokenStore(join(dir, "core-token"))
    await tokens.load()
    const token = (await readFile(join(dir, "core-token"), "utf8")).trim()
    const ring = new EventRing()
    const calls: Calls = []
    const a = actions(calls)
    const row = {
      id: "ses_1",
      mode: "auto" as const,
      chat: false,
      busy: false,
      prompts: [],
    }
    const snap = {
      v: 1,
      at: 1,
      owner: {},
      afk: {},
      pending: 0,
      channels: [],
      sessions: [row],
      stuck: [],
    }
    const control = { snapshot: () => snap } as never
    const views = new Views({
      control,
      bridge: { known: () => [], openPromptList: () => [] } as never,
      host: host(calls),
      cfg: cfg(),
      sources: { tail: [], diff: [], todos: [] },
    })
    const api: Api = await startApi(
      {
        views,
        actions: a,
        control,
        cfg: cfg(),
        tokens,
        ring,
        version: "9.9.9",
        keepAliveMs,
      },
      { host: "127.0.0.1", port: 0 },
    )
    const url = `http://127.0.0.1:${api.port}`
    const h = { authorization: "Bearer " + token }
    return { api, url, h, token, tokens, ring, calls, dir }
  }

  it("answers 401 with no detail without a valid token", async () => {
    const r = await rig()
    try {
      for (const headers of [{}, { authorization: "Bearer wrong" }]) {
        const res = await fetch(r.url + "/v1/meta", { headers })
        assert.equal(res.status, 401)
        assert.equal(await res.text(), "")
      }
      assert.equal((await fetch(r.url + "/nothing")).status, 401)
    } finally {
      await r.api.close()
    }
  })

  it("serves meta, sessions and actions", async () => {
    const r = await rig()
    try {
      const meta = (await (
        await fetch(r.url + "/v1/meta", { headers: r.h })
      ).json()) as { api: string; version: string; actions: unknown[] }
      assert.equal(meta.api, "v1")
      assert.equal(meta.version, "9.9.9")
      assert.ok(meta.actions.length > 5)
      const list = (await (
        await fetch(r.url + "/v1/sessions", { headers: r.h })
      ).json()) as { sessions: Array<{ id: string }>; total: number }
      assert.equal(list.total, 1)
      assert.equal(list.sessions[0].id, "ses_1")
      assert.equal(
        (await fetch(r.url + "/v1/sessions/ses_1", { headers: r.h })).status,
        200,
      )
      const stop = await fetch(r.url + "/v1/sessions/ses_1/actions/stop", {
        method: "POST",
        headers: r.h,
        body: "{}",
      })
      assert.equal(stop.status, 200)
      const perm = await fetch(
        r.url + "/v1/sessions/ses_1/actions/permission",
        { method: "POST", headers: r.h, body: "{}" },
      )
      assert.equal(perm.status, 422)
      assert.equal(
        (
          await fetch(r.url + "/v1/sessions/ses_1/actions/zzz", {
            method: "POST",
            headers: r.h,
            body: "{}",
          })
        ).status,
        404,
      )
      assert.equal(
        (
          await fetch(r.url + "/v1/sessions/ses_1/actions/stop", {
            method: "POST",
            headers: r.h,
            body: "[",
          })
        ).status,
        400,
      )
      assert.deepEqual(r.calls, ["interrupt"])
    } finally {
      await r.api.close()
    }
  })

  it("refuses the old token at once after rotation", async () => {
    const r = await rig()
    try {
      await r.tokens.rotate()
      assert.equal(
        (await fetch(r.url + "/v1/meta", { headers: r.h })).status,
        401,
      )
    } finally {
      await r.api.close()
    }
  })

  async function read(
    url: string,
    headers: Record<string, string>,
    want: number,
    ms = 3000,
  ) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), ms)
    const res = await fetch(url, { headers, signal: ac.signal })
    const dec = new TextDecoder()
    let text = ""
    try {
      for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
        text += dec.decode(c)
        if ((text.match(/\n\n/g) ?? []).length >= want) break
      }
    } catch {
      /* aborted */
    }
    clearTimeout(timer)
    ac.abort()
    return text
  }

  it("resumes the stream from Last-Event-ID", async () => {
    const r = await rig()
    try {
      for (const t of ["a", "b", "c"]) r.ring.push(t, { n: t })
      const text = await read(
        r.url + "/v1/events",
        { ...r.h, "last-event-id": "1" },
        3,
      )
      assert.match(text, /id: 2\nevent: b/)
      assert.match(text, /id: 3\nevent: c/)
      assert.doesNotMatch(text, /event: a/)
    } finally {
      await r.api.close()
    }
  })

  it("sends a snapshot when the id is older than the kept events", async () => {
    const r = await rig()
    try {
      for (let i = 0; i < 510; i++) r.ring.push("e", {})
      const text = await read(
        r.url + "/v1/events",
        { ...r.h, "last-event-id": "3" },
        2,
      )
      assert.match(text, /event: snapshot/)
      assert.match(text, /"sessions"/)
    } finally {
      await r.api.close()
    }
  })

  it("sends a keep-alive comment", async () => {
    const r = await rig(30)
    try {
      const text = await read(r.url + "/v1/events", r.h, 3)
      assert.match(text, /: keep-alive/)
    } finally {
      await r.api.close()
    }
  })

  it("keeps the ring to 500 events", () => {
    const ring = new EventRing()
    for (let i = 0; i < 600; i++) ring.push("e", i)
    assert.equal(ring.since(ring.last() - 1).length, 1)
    assert.equal(ring.since(50), "stale")
    assert.equal(ring.since(ring.last() + 5), "stale")
  })

  it("leaves no token in the data directory listing besides the token file", async () => {
    const r = await rig()
    try {
      assert.deepEqual(await readdir(r.dir), ["core-token"])
    } finally {
      await r.api.close()
    }
  })
})
