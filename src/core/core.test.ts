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
import { folderOf, ladder, Views, type Sources } from "./views.ts"

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
    agents: async () => [{ id: "build", label: "Build" }],
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

describe("qa and update actions", () => {
  const rig = (o: { chat?: boolean; busy?: boolean; deny?: boolean } = {}) => {
    const sent: Array<{ text: string; delivery: string }> = []
    const h = host([], {
      busy: () => o.busy ?? false,
      prompt: async (_id, text, delivery) => void sent.push({ text, delivery }),
    })
    const a = new Actions({
      cfg: cfg(),
      host: h,
      now: Date.now,
      denial: () => (o.deny ? "directory **/shop" : undefined),
      chatOn: () => o.chat ?? true,
      setChat: async () => ({ ok: true, text: "chat" }),
      setWatch: async () => ({ ok: true, text: "watch" }),
      resume: async () => ({ ok: true, text: "resumed" }),
      answer: async () => ({ ok: true, text: "answered" }),
    })
    return { a, sent }
  }

  it("send the fixed instruction with steer delivery, and say how it went", async () => {
    const idle = rig()
    const out = await idle.a.run("qa", "ses_1", {})
    assert.deepEqual([out.ok, out.text], [true, "→ sent"])
    assert.match(
      idle.sent[0].text,
      /^Run an interactive Q&A on the open decisions now\./,
    )
    assert.equal(idle.sent[0].delivery, "steer")
    const busy = rig({ busy: true })
    const up = await busy.a.run("update", "ses_1", { topic: "the  api\nlayer" })
    assert.equal(up.text, "⚡ steered in")
    assert.match(
      busy.sent[0].text,
      /^Give a short progress update now:.* Focus: the api layer$/,
    )
  })

  it("are refused with chat off or for a denied session, and send nothing", async () => {
    const off = rig({ chat: false })
    const a = await off.a.run("qa", "ses_1", {})
    assert.equal(a.ok, false)
    assert.match(a.text, /Chat is off/)
    const denied = rig({ deny: true })
    const b = await denied.a.run("update", "ses_1", {})
    assert.equal(b.ok, false)
    assert.match(b.text, /chat\.deny/)
    assert.deepEqual([...off.sent, ...denied.sent], [])
  })

  it("are listed among the actions", () => {
    const names = rig()
      .a.available()
      .map((x) => x.name)
    assert.ok(names.includes("qa") && names.includes("update"))
  })
})

describe("agent ids", () => {
  const projects = {
    shop: { directory: "/w/shop", agent: "Build" },
    docs: { directory: "/w/docs" },
  }
  const rig = (over: Partial<Host> = {}) => {
    const created: unknown[] = []
    const switched: string[] = []
    const noted: string[] = []
    const h = host([], {
      createSession: async (c) => {
        created.push(c)
        return { id: "ses_new" }
      },
      switchAgent: async (_id, agent) => void switched.push(agent),
      agents: async () => [
        { id: "build", label: "Build" },
        { id: "plan", label: "Plan" },
      ],
      ...over,
    })
    const a = new Actions({
      cfg: cfg({ projects } as never),
      host: h,
      now: Date.now,
      denial: () => undefined,
      created: (id) => void noted.push(id),
      setChat: async () => ({ ok: true, text: "chat" }),
      setWatch: async () => ({ ok: true, text: "watch" }),
      resume: async () => ({ ok: true, text: "resumed" }),
      answer: async () => ({ ok: true, text: "answered" }),
    })
    return { a, created, switched, noted }
  }

  it("creates with the id, or the label in any case, and sends the id", async () => {
    const r = rig()
    for (const agent of ["build", "Build", "BUILD"])
      assert.equal(
        (await r.a.create({ project: "docs", agent, text: "go" })).ok,
        true,
      )
    assert.deepEqual(
      r.created.map((c) => (c as { agent: string }).agent),
      ["build", "build", "build"],
    )
    assert.deepEqual(r.noted, ["ses_new", "ses_new", "ses_new"])
  })

  it("resolves the agent of a project's config too", async () => {
    const r = rig()
    assert.equal((await r.a.create({ project: "shop", text: "go" })).ok, true)
    assert.equal((r.created[0] as { agent: string }).agent, "build")
  })

  it("refuses an unknown agent before any session exists", async () => {
    const r = rig()
    const out = await r.a.create({ project: "docs", agent: "nope", text: "go" })
    assert.equal(out.ok, false)
    assert.equal(out.outcome, "invalid")
    assert.match(out.text, /agent is not available/)
    assert.deepEqual(r.created, [])
    assert.deepEqual(r.noted, [])
  })

  it("passes the value through when OpenCode lists no agents", async () => {
    const r = rig({ agents: async () => [] })
    assert.equal(
      (await r.a.create({ project: "docs", agent: "Build", text: "go" })).ok,
      true,
    )
    assert.equal((r.created[0] as { agent: string }).agent, "Build")
  })

  it("switches by id and by label, and sends the id", async () => {
    const r = rig()
    assert.equal((await r.a.run("agent", "ses_1", { agent: "plan" })).ok, true)
    const out = await r.a.run("agent", "ses_1", { agent: "Build" })
    assert.equal(out.text, "Agent: Build")
    assert.deepEqual(r.switched, ["plan", "build"])
  })

  it("refuses to switch to an unknown agent", async () => {
    const r = rig()
    const out = await r.a.run("agent", "ses_1", { agent: "nope" })
    assert.equal(out.ok, false)
    assert.deepEqual(r.switched, [])
  })

  it("offers each agent as an id and a label", async () => {
    const o = await rig().a.options()
    assert.deepEqual(o.agents[0], { id: "build", label: "Build" })
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

  it("fills a missing title from what the host knows, and gives only the last part of the directory", () => {
    const row = {
      id: "ses_1",
      mode: "auto" as const,
      chat: false,
      busy: false,
      prompts: [],
    }
    const v = (peek: unknown, title?: string) =>
      new Views({
        control: {
          snapshot: () => ({ sessions: [{ ...row, title }], stuck: [] }),
        } as never,
        bridge: { known: () => [], openPromptList: () => [] } as never,
        host: { ...host([]), peek } as never,
        cfg: cfg(),
        sources: sources(),
      })
    const known = () => ({
      title: "Fix login",
      directory: "/work/private/shop/",
    })
    const a = v(known).list().sessions[0]
    assert.equal(a.title, "Fix login")
    assert.equal(a.folder, "shop")
    assert.doesNotMatch(JSON.stringify(a), /private/)
    assert.equal(v(known, "Own title").list().sessions[0].title, "Own title")
    const none = v(() => undefined).list().sessions[0]
    assert.equal(none.title, undefined)
    assert.equal(none.folder, undefined)
    assert.equal(v(undefined).list().sessions[0].title, undefined)
  })

  it("names the folder whichever way the path is written", () => {
    assert.equal(folderOf("/a/b/shop"), "shop")
    assert.equal(folderOf("C:\\work\\shop\\"), "shop")
    assert.equal(folderOf("/"), undefined)
    assert.equal(folderOf(undefined), undefined)
    assert.equal(folderOf("/x/" + "y".repeat(80))?.length, 60)
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
      drain: {
        open: 2,
        questions: 1,
        approvals: 1,
        permissions: 0,
        unverified: 0,
      },
      channels: [],
      sessions: [row],
      stuck: [],
    }
    const control = { snapshot: () => snap } as never
    const views = new Views({
      control,
      bridge: {
        known: () => [],
        openPromptList: () => [],
        promptEntry: (id: string) =>
          id === "p5gf"
            ? {
                id,
                kind: "question",
                state: "pending",
                rootSessionID: "ses_1",
                title: "ask",
                askedAt: 1,
                questions: [
                  {
                    key: "q0",
                    header: "h",
                    text: "t",
                    options: ["a", "b"],
                    multiple: false,
                    custom: true,
                  },
                ],
              }
            : undefined,
      } as never,
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

  it("takes qa and update on the action endpoint with the token, and not without it", async () => {
    const r = await rig()
    try {
      const url = r.url + "/v1/sessions/ses_1/actions/"
      const bare = await fetch(url + "qa", { method: "POST", body: "{}" })
      assert.equal(bare.status, 401)
      assert.deepEqual(r.calls, [])
      const qa = await fetch(url + "qa", {
        method: "POST",
        headers: r.h,
        body: "{}",
      })
      assert.equal(qa.status, 200)
      const up = await fetch(url + "update", {
        method: "POST",
        headers: r.h,
        body: JSON.stringify({ topic: "the api" }),
      })
      assert.equal(up.status, 200)
      assert.equal(r.calls.length, 2)
      assert.match(r.calls[0], /^prompt:Run an interactive Q&A/)
      assert.match(
        r.calls[1],
        /^prompt:Give a short progress update now:.* Focus: the api$/,
      )
    } finally {
      await r.api.close()
    }
  })

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

  it("serves a question by its short id, in any state, and 404s an unknown one", async () => {
    const r = await rig()
    try {
      const ok = await fetch(r.url + "/v1/prompts/p5gf", { headers: r.h })
      assert.equal(ok.status, 200)
      const v = (await ok.json()) as {
        state: string
        session: string
        items: Array<{ options: string[] }>
      }
      assert.equal(v.state, "pending")
      assert.equal(v.session, "ses_1")
      assert.deepEqual(v.items[0].options, ["a", "b"])
      assert.equal(
        (await fetch(r.url + "/v1/prompts/zz99", { headers: r.h })).status,
        404,
      )
      assert.equal(
        (await fetch(r.url + "/v1/prompts/p5gf", { headers: {} })).status,
        401,
      )
    } finally {
      await r.api.close()
    }
  })

  it("serves the drain counts in the status", async () => {
    const r = await rig()
    try {
      const s = (await (
        await fetch(r.url + "/v1/status", { headers: r.h })
      ).json()) as { drain: unknown }
      assert.deepEqual(s.drain, {
        open: 2,
        questions: 1,
        approvals: 1,
        permissions: 0,
        unverified: 0,
      })
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
