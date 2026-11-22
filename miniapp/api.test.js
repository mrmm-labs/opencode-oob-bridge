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

describe("a WebView without async iteration on a body", () => {
  /** A response whose body has getReader and nothing else, like an older iOS WebView. */
  const readerOnly = (chunks, { error } = {}) => {
    const spy = { cancelled: false }
    const queue = chunks.map((c) => enc.encode(c))
    const body = {
      getReader: () => ({
        read: async () => {
          if (queue.length > 0) return { done: false, value: queue.shift() }
          if (error) throw error
          return { done: true }
        },
        cancel: async () => void (spy.cancelled = true),
      }),
    }
    return { spy, res: { ok: true, status: 200, body } }
  }

  it("yields events and cancels the request when the loop ends", async () => {
    const { spy, res } = readerOnly([
      ": ok\n\n",
      "id: 1\nevent: a\ndata: {}\n\n",
    ])
    assert.equal(res.body[Symbol.asyncIterator], undefined)
    const api = new Api({ initData: "x", fetch: async () => res })
    const got = []
    for await (const e of api.events()) got.push(e.type)
    assert.deepEqual(got, ["open", "beat", "a"])
    assert.equal(spy.cancelled, true)
  })

  it("cancels the request when the reader fails, so none is left open", async () => {
    const { spy, res } = readerOnly([": ok\n\n"], {
      error: new TypeError("terminated"),
    })
    const api = new Api({ initData: "x", fetch: async () => res })
    await assert.rejects(async () => {
      for await (const _ of api.events());
    }, /terminated/)
    assert.equal(spy.cancelled, true)
  })

  it("is live on the first bytes and delivers events through the Stream", async () => {
    const { res } = readerOnly([": ok\n\n", "id: 4\nevent: a\ndata: {}\n\n"])
    const log = []
    const s = new Stream({
      api: new Api({ initData: "x", fetch: async () => res }),
      onState: (st) => log.push(st),
      onEvent: (e) => log.push("event:" + e.id),
      sleep: async () => s.stop(),
    })
    await s.loop()
    assert.deepEqual(log, ["live", "event:4", "down"])
  })
})

describe("Stream attempts", () => {
  const rig = (fetches, extra = {}) => {
    const log = []
    const notes = []
    let n = 0
    const api = new Api({
      initData: "x",
      fetch: async (...a) => fetches[Math.min(n++, fetches.length - 1)](...a),
    })
    const s = new Stream({
      api,
      onState: (st) => log.push(st),
      onEvent: () => {},
      note: (e, d) => notes.push([e, d]),
      sleep: async (ms) => void log.push("sleep:" + ms),
      ...extra,
    })
    return { s, log, notes }
  }

  it("backs off from the first failure: an attempt that opens and then fails is not a good one", async () => {
    const failing = async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            throw new TypeError("terminated")
          },
          cancel: async () => {},
        }),
      },
    })
    const { s, log } = rig([failing])
    let n = 0
    s.sleep = async (ms) => {
      log.push("sleep:" + ms)
      if (++n === 4) s.stop()
    }
    await s.loop()
    assert.deepEqual(
      log.filter((x) => x.startsWith("sleep")),
      ["sleep:1000", "sleep:2000", "sleep:5000", "sleep:10000"],
    )
    assert.ok(!log.includes("live"), "no byte came, so it was never live")
  })

  it("aborts the request of an attempt that ends on its own", async () => {
    const signals = []
    const ends = async (_u, o) => (signals.push(o.signal), sse(": ok\n\n"))
    const { s } = rig([ends])
    s.sleep = async () => s.stop()
    await s.loop()
    assert.equal(signals[0].aborted, true)
  })

  it("drops an attempt whose headers came and whose bytes did not", async () => {
    const mute = async (_u, o) =>
      new Response(
        new ReadableStream({
          start(c) {
            o.signal.addEventListener("abort", () =>
              c.error(new Error("aborted")),
            )
          },
        }),
      )
    const { s, log } = rig([mute], { firstByteMs: 20 })
    s.sleep = async (ms) => {
      log.push("sleep:" + ms)
      s.stop()
    }
    await s.loop()
    assert.deepEqual(log, ["down", "sleep:1000"])
  })

  it("reports each step with the error name, never a credential", async () => {
    const { s, notes } = rig([async () => reply(401, { error: "no_operator" })])
    await s.loop()
    assert.deepEqual(
      notes.map(([e]) => e),
      ["stream_error"],
    )
    assert.equal(notes[0][1].reason, "no_operator")
    assert.equal(notes[0][1].status, 401)
    assert.ok(!JSON.stringify(notes).includes("hash"))
    const ok = rig([async () => sse(": ok\n\n")])
    ok.s.sleep = async () => ok.s.stop()
    await ok.s.loop()
    assert.deepEqual(
      ok.notes.map(([e]) => e),
      ["stream_open", "stream_live", "stream_end"],
    )
  })
})
