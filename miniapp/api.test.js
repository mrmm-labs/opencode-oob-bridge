import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Api, ApiError, parseBlock, Stream } from "./api.js"

const reply = (status, body) =>
  new Response(
    body === undefined
      ? ""
      : typeof body === "string"
        ? body
        : JSON.stringify(body),
    { status },
  )

const enc = new TextEncoder()
const sse = (...chunks) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const x of chunks) c.enqueue(enc.encode(x))
        c.close()
      },
    }),
  )

describe("requests", () => {
  it("sends init data as the tma scheme and nothing else", async () => {
    let seen
    const api = new Api({
      initData: "a=b&hash=c",
      fetch: async (u, o) => ((seen = { u, o }), reply(200, {})),
    })
    await api.meta()
    assert.equal(seen.u, "/v1/meta")
    assert.equal(seen.o.headers.authorization, "tma a=b&hash=c")
    assert.deepEqual(Object.keys(seen.o.headers), ["authorization"])
  })

  it("names what went wrong by status, and a dead network as offline", async () => {
    for (const [status, kind] of [
      [401, "expired"],
      [403, "forbidden"],
      [429, "limited"],
      [503, "offline"],
      [500, "error"],
    ]) {
      const api = new Api({
        initData: "x",
        fetch: async () => reply(status, { error: "x" }),
      })
      await assert.rejects(
        api.meta(),
        (e) => e instanceof ApiError && e.kind === kind,
      )
    }
    const dead = new Api({
      initData: "x",
      fetch: async () => {
        throw new TypeError("fail")
      },
    })
    await assert.rejects(dead.meta(), (e) => e.kind === "offline")
  })

  it("returns the core's own refusal text instead of throwing", async () => {
    const api = new Api({
      initData: "x",
      fetch: async () =>
        reply(422, { ok: false, text: "Blocked by chat.deny." }),
    })
    assert.deepEqual(await api.action("s", "stop"), {
      ok: false,
      text: "Blocked by chat.deny.",
    })
    const created = new Api({
      initData: "x",
      fetch: async () => reply(429, { ok: false, text: "At most 5." }),
    })
    assert.equal((await created.create({})).text, "At most 5.")
  })

  it("encodes a session id in the path and posts JSON", async () => {
    let seen
    const api = new Api({
      initData: "x",
      fetch: async (u, o) => ((seen = { u, o }), reply(200, { ok: true })),
    })
    await api.action("a/b", "prompt", { text: "hi" })
    assert.equal(seen.u, "/v1/sessions/a%2Fb/actions/prompt")
    assert.equal(seen.o.headers["content-type"], "application/json")
    assert.equal(seen.o.body, '{"text":"hi"}')
  })
})

describe("event stream parsing", () => {
  it("reads id, event and data, and treats a comment as a heartbeat", () => {
    assert.deepEqual(parseBlock('id: 3\nevent: x\ndata: {"a":1}'), {
      type: "x",
      id: 3,
      data: { a: 1 },
    })
    assert.deepEqual(parseBlock(": keep-alive"), { type: "beat" })
  })

  it("yields events split across chunks", async () => {
    const api = new Api({
      initData: "x",
      fetch: async () =>
        sse(": ok\n\nid: 1\neve", "nt: a\ndata: {}\n\n", ": keep-alive\n\n"),
    })
    const got = []
    for await (const e of api.events()) got.push(e.type)
    assert.deepEqual(got, ["open", "beat", "a", "beat"])
  })

  it("sends Last-Event-ID on a resume", async () => {
    let h
    const api = new Api({
      initData: "x",
      fetch: async (_u, o) => ((h = o.headers), sse()),
    })
    for await (const _ of api.events(7));
    assert.equal(h["last-event-id"], "7")
  })
})

describe("Stream", () => {
  const rig = (fetches, extra = {}) => {
    const log = []
    let n = 0
    const api = new Api({
      initData: "x",
      fetch: async (...a) => fetches[Math.min(n++, fetches.length - 1)](...a),
    })
    const s = new Stream({
      api,
      onState: (st, why) => log.push(why ? st + ":" + why : st),
      onEvent: (e) => log.push("event:" + e.type + ":" + e.id),
      sleep: async (ms) => void log.push("sleep:" + ms),
      ...extra,
    })
    return { s, log, api }
  }

  it("goes live, reconnects with the last id, and backs off while down", async () => {
    const heard = []
    const { s, log } = rig([
      async () => sse("id: 4\nevent: a\ndata: {}\n\n"),
      async (_u, o) => (
        heard.push(o.headers["last-event-id"]),
        sse("id: 5\nevent: b\ndata: {}\n\n")
      ),
      async () => {
        throw new TypeError("down")
      },
    ])
    let sleeps = 0
    s.sleep = async (ms) => {
      log.push("sleep:" + ms)
      if (++sleeps === 3) s.stop()
    }
    await s.loop()
    assert.deepEqual(log.slice(0, 8), [
      "live",
      "event:a:4",
      "down",
      "sleep:1000",
      "live",
      "event:b:5",
      "down",
      "sleep:1000",
    ])
    assert.deepEqual(heard, ["4"])
    assert.ok(log.includes("sleep:2000") || log.includes("sleep:1000"))
  })

  it("treats silence as a drop", async () => {
    const hang = async (_u, o) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(": ok\n\n"))
            o.signal.addEventListener("abort", () =>
              c.error(new Error("aborted")),
            )
          },
        }),
      )
    const { s, log } = rig([hang], { silenceMs: 20 })
    s.sleep = async (ms) => {
      log.push("sleep:" + ms)
      s.stop()
    }
    await s.loop()
    assert.deepEqual(log, ["live", "down", "sleep:1000"])
  })

  it("stops for good when the view has expired", async () => {
    const { s, log } = rig([async () => reply(401)])
    await s.loop()
    assert.deepEqual(log, ["down:expired"])
  })
})
