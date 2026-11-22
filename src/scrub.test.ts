import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "node:test"

import { parseConfig } from "./config.ts"
import type { Connector, Push } from "./connectors/types.ts"
import {
  ScrubError,
  WITHHELD,
  parseScrub,
  scrubAll,
  scrubClient,
  withScrub,
  type Scrub,
} from "./scrub.ts"

const SECRET = "Fake-Bridge-Secret-0001"
const POINTER = "{{secret:vault:Infra/example#password}}"

type Mode =
  | "ok"
  | "locked"
  | "hang"
  | "garbage"
  | "wrongid"
  | "close"
  | "notext"

class FakeBroker {
  requests: any[] = []
  connections = 0
  server!: Server
  dir = ""
  path = ""
  mode: Mode
  constructor(mode: Mode = "ok") {
    this.mode = mode
  }
  async start() {
    this.dir = await mkdtemp(join(tmpdir(), "sb-"))
    this.path = join(this.dir, "scrub.sock")
    this.server = createServer((c) => {
      this.connections++
      let buf = ""
      c.setEncoding("utf8")
      c.on("error", () => {})
      c.on("data", (d: string) => {
        buf += d
        const nl = buf.indexOf("\n")
        if (nl < 0) return
        const req = JSON.parse(buf.slice(0, nl))
        this.requests.push(req)
        const ok = {
          v: 1,
          id: req.id,
          ok: true,
          text: String(req.text).replaceAll(SECRET, POINTER),
        }
        const reply: Record<Mode, unknown> = {
          ok,
          locked: { v: 1, id: req.id, ok: false, error: { code: "locked" } },
          hang: undefined,
          garbage: "not json",
          wrongid: { ...ok, id: "other" },
          close: undefined,
          notext: { v: 1, id: req.id, ok: true },
        }
        const r = reply[this.mode]
        if (this.mode === "close") return c.destroy()
        if (r === undefined) return
        c.write((typeof r === "string" ? r : JSON.stringify(r)) + "\n")
      })
    })
    await new Promise<void>((r) => this.server.listen(this.path, r))
    return this
  }
  async stop() {
    this.server?.closeAllConnections?.()
    await new Promise<void>((r) => this.server.close(() => r()))
    await rm(this.dir, { recursive: true, force: true })
  }
}

const running: FakeBroker[] = []
const broker = async (m: Mode = "ok") => {
  const b = await new FakeBroker(m).start()
  running.push(b)
  return b
}
afterEach(async () => {
  while (running.length) await running.pop()!.stop()
})

const target = (b: FakeBroker, timeoutMs = 2000) => ({
  socket: b.path,
  timeoutMs,
})
const kind = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    assert.ok(e instanceof ScrubError, String(e))
    assert.ok(!String((e as Error).message).includes(SECRET))
    return (e as ScrubError).kind
  }
  assert.fail("expected a failure")
}

describe("scrub client", () => {
  it("masks text and speaks protocol v1", async () => {
    const b = await broker()
    const out = await scrubClient(target(b))("pw " + SECRET + " end")
    assert.equal(out, "pw " + POINTER + " end")
    const r = b.requests[0]
    assert.equal(r.v, 1)
    assert.equal(r.op, "scrub")
    assert.equal(r.origin, "outbound")
    assert.equal(r.caller, "oob-bridge")
    assert.match(r.id, /^[0-9a-f-]{36}$/)
  })

  it("names a kind and never carries text when it fails", async () => {
    const cases: Array<[Mode, string]> = [
      ["locked", "refused"],
      ["garbage", "malformed"],
      ["wrongid", "malformed"],
      ["notext", "malformed"],
      ["close", "closed"],
    ]
    for (const [mode, want] of cases) {
      const b = await broker(mode)
      assert.equal(
        await kind(scrubClient(target(b))("x " + SECRET)),
        want,
        mode,
      )
    }
    const hang = await broker("hang")
    assert.equal(await kind(scrubClient(target(hang, 150))("x")), "timeout")
    assert.equal(
      await kind(
        scrubClient({ socket: join(tmpdir(), "no-such.sock"), timeoutMs: 500 })(
          "x",
        ),
      ),
      "unreachable",
    )
    const ok = await broker()
    assert.equal(
      await kind(scrubClient(target(ok))("a".repeat(4 * 1024 * 1024 + 1))),
      "too large",
    )
  })

  it("does not use a reply with another id", async () => {
    const b = await broker("wrongid")
    await assert.rejects(scrubClient(target(b))("x " + SECRET))
  })
})

describe("scrubAll", () => {
  it("masks many strings in one request and keeps their count", async () => {
    const b = await broker()
    const out = await scrubAll(scrubClient(target(b)), [
      "a " + SECRET,
      "plain",
      SECRET,
    ])
    assert.deepEqual(out, ["a " + POINTER, "plain", POINTER])
    assert.equal(b.requests.length, 1)
    assert.deepEqual(await scrubAll(scrubClient(target(b)), []), [])
    assert.equal(b.requests.length, 1)
  })

  it("refuses text that holds the separator and a reply that changes the shape", async () => {
    const b = await broker()
    assert.equal(
      await kind(scrubAll(scrubClient(target(b)), ["a\u0000b"])),
      "malformed",
    )
    const merge: Scrub = async () => "one string"
    assert.equal(await kind(scrubAll(merge, ["a", "b"])), "malformed")
  })
})

describe("scrub config", () => {
  it("parses and rejects", () => {
    assert.deepEqual(parseScrub({ socket: "/run/s.sock" }), {
      socket: "/run/s.sock",
      timeoutMs: 2000,
    })
    assert.deepEqual(parseScrub({ socket: "/run/s.sock", timeoutMs: 500 }), {
      socket: "/run/s.sock",
      timeoutMs: 500,
    })
    for (const bad of [
      { socket: "relative.sock" },
      { socket: "" },
      {},
      { socket: "/s", timeoutMs: 50 },
      { socket: "/s", timeoutMs: 31000 },
      { socket: "/s", timeoutMs: 1.5 },
      { socket: "/s", extra: 1 },
      "text",
      [],
    ])
      assert.ok("error" in (parseScrub(bad) as object), JSON.stringify(bad))
  })

  it("is off by default and read from the config file", () => {
    const base = {
      server: "https://ntfy.example/",
      topics: { out: "oc-x-out", in: "oc-x-in" },
    }
    const off = parseConfig(base)
    assert.ok(!("error" in off) && off.scrub === undefined)
    const on = parseConfig({ ...base, scrub: { socket: "/run/s.sock" } })
    assert.ok(!("error" in on) && on.scrub?.socket === "/run/s.sock")
    const bad = parseConfig({ ...base, scrub: { socket: "s.sock" } })
    assert.ok("error" in bad && /scrub\.socket/.test(bad.error))
  })
})

class FakeConnector {
  id = "tg"
  type = "fake"
  enabled = true
  capabilities = {
    buttons: true,
    edit: true,
    multiselect: false,
    rich: true,
    threads: true,
    pairing: false,
    inboundPrompt: true,
  }
  sent: Push[] = []
  updated: Array<[string, Push]> = []
  streamed: Array<[string, string]> = []
  replied: Array<[string, string]> = []
  hint() {
    return "reply"
  }
  start() {}
  status() {
    return { connected: this.enabled }
  }
  async send(p: Push) {
    this.sent.push(p)
    return "ref1"
  }
  async update(ref: string, p: Push) {
    this.updated.push([ref, p])
    return true
  }
  stream(s: { name: string }, text: string) {
    this.streamed.push([s.name, text])
  }
  async reply(s: { name: string }, text: string) {
    this.replied.push([s.name, text])
    return { parts: 1, documents: 0 }
  }
}

const logs: Array<[string, Record<string, unknown> | undefined]> = []
const log = (e: string, f?: Record<string, unknown>) => void logs.push([e, f])
const wrap = (fc: FakeConnector, s: Scrub) =>
  withScrub(fc as unknown as Connector, s, log)
const failing: Scrub = async () => {
  throw new ScrubError("unreachable")
}

const richPush = (): Push => ({
  title: "proj · agent asks " + SECRET,
  message: "the key is " + SECRET,
  tags: ["question", SECRET],
  priority: 4,
  session: { id: "ses_1", name: "proj · " + SECRET, project: "proj" },
  prompt: {
    id: "p1",
    questions: [
      {
        header: "h",
        question: "use " + SECRET + "?",
        options: [{ label: SECRET, description: "d" }],
        multiple: false,
      },
    ] as never,
  },
  card: {
    kind: "permission",
    agent: "agent",
    project: "proj",
    detail: "run with " + SECRET,
  },
  stats: { httpStatus: 200 },
})

describe("withScrub", () => {
  it("masks every text of a push in one round trip and keeps ids and transport facts", async () => {
    const b = await broker()
    const fc = new FakeConnector()
    const ch = wrap(fc, scrubClient(target(b)))
    const push = richPush()
    assert.equal(await ch.send(push), "ref1")
    assert.equal(b.connections, 1)
    const got = fc.sent[0]
    assert.ok(
      !JSON.stringify(got).includes(SECRET),
      "a value reached the connector",
    )
    assert.equal(got.title, "proj · agent asks " + POINTER)
    assert.equal(got.message, "the key is " + POINTER)
    assert.deepEqual(got.tags, ["question", POINTER])
    assert.equal(got.priority, 4)
    assert.equal(got.session?.id, "ses_1")
    assert.equal(got.session?.name, "proj · " + POINTER)
    assert.equal(got.prompt?.id, "p1")
    assert.equal((got.card as { detail: string }).detail, "run with " + POINTER)
    assert.equal((got.card as { kind: string }).kind, "permission")
    assert.deepEqual(got.stats, { httpStatus: 200 })
    assert.ok(
      push.message.includes(SECRET),
      "the caller's push must not be modified",
    )
  })

  it("rewrites edits the same way", async () => {
    const b = await broker()
    const fc = new FakeConnector()
    assert.equal(
      await wrap(fc, scrubClient(target(b))).update!("ref9", richPush()),
      true,
    )
    assert.equal(fc.updated[0][0], "ref9")
    assert.ok(!JSON.stringify(fc.updated[0][1]).includes(SECRET))
  })

  it("falls back to the title when the scrubber fails, and drops everything else", async () => {
    const fc = new FakeConnector()
    await wrap(fc, failing).send(richPush())
    const got = fc.sent[0]
    assert.equal(
      got.title,
      "proj · agent asks " + SECRET,
      "the title is kept as given",
    )
    assert.equal(got.message, WITHHELD)
    assert.equal(got.tags, undefined)
    assert.equal(got.card, undefined)
    assert.equal(got.prompt, undefined)
    assert.deepEqual(got.session, { id: "ses_1", name: "session" })
    assert.equal(got.priority, 4)
    assert.ok(!JSON.stringify(got).replace(got.title!, "").includes(SECRET))
    assert.ok(
      logs.some(
        ([e, f]) =>
          e === "scrub_failed" && f?.op === "send" && f.kind === "unreachable",
      ),
    )
    assert.ok(!JSON.stringify(logs).includes(SECRET))
  })

  it("fails closed against a locked broker", async () => {
    const b = await broker("locked")
    const fc = new FakeConnector()
    await wrap(fc, scrubClient(target(b))).send({
      title: "t",
      message: "m " + SECRET,
    })
    assert.equal(fc.sent[0].message, WITHHELD)
    assert.ok(!JSON.stringify(fc.sent[0]).includes(SECRET))
  })

  it("drops streamed updates and replies it cannot mask", async () => {
    const fc = new FakeConnector()
    const ch = wrap(fc, failing)
    ch.stream!({ id: "s", name: "n" }, "text " + SECRET)
    assert.equal(
      await ch.reply!({ id: "s", name: "n" }, "text " + SECRET),
      undefined,
    )
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(fc.streamed, [])
    assert.deepEqual(fc.replied, [])
  })

  it("masks streamed updates in order and replies", async () => {
    const b = await broker()
    const fc = new FakeConnector()
    const ch = wrap(fc, scrubClient(target(b)))
    for (const t of ["one " + SECRET, "two", "three " + SECRET])
      ch.stream!({ id: "s", name: "n " + SECRET }, t)
    assert.deepEqual(
      await ch.reply!({ id: "s", name: "n" }, "done " + SECRET),
      { parts: 1, documents: 0 },
    )
    for (let i = 0; i < 50 && fc.streamed.length < 3; i++)
      await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(fc.streamed, [
      ["n " + POINTER, "one " + POINTER],
      ["n " + POINTER, "two"],
      ["n " + POINTER, "three " + POINTER],
    ])
    assert.deepEqual(fc.replied, [["n", "done " + POINTER]])
  })

  it("leaves the rest of the connector alone", async () => {
    const fc = new FakeConnector()
    const ch = wrap(fc, failing)
    assert.equal(ch.id, "tg")
    assert.equal(ch.capabilities.edit, true)
    assert.equal(ch.hint("p", []), "reply")
    ch.enabled = false
    assert.equal(fc.enabled, false, "writes must reach the connector")
    assert.deepEqual(
      ch.status(),
      { connected: false },
      "methods keep the connector as this",
    )
    const bare = {
      ...new FakeConnector(),
      send: async () => undefined,
    } as unknown as Connector
    const w2 = withScrub(bare, failing, log)
    assert.equal(w2.update, undefined)
    assert.equal(w2.stream, undefined)
    assert.equal(w2.reply, undefined)
  })
})
