import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  brief,
  Overnight,
  OvernightStore,
  PAUSE_MS,
  parseBriefWords,
  parseDuration,
  parseUntil,
  RESUME_GAP_MS,
  type Deps,
} from "./overnight.ts"

const T0 = Date.UTC(2026, 0, 1, 22, 0)
const MIN = 60_000

type Q = ReturnType<Deps["questions"]>[number]

function rig(over: Partial<Deps> = {}, cfg = {}, file?: string) {
  const s = {
    now: T0,
    busy: false,
    waiting: 0,
    denied: false,
    channelUp: true,
    deadman: "ok" as "ok" | "unconfigured" | "unacked",
    inbox: true,
    known: true,
    resumeOk: true,
    questions: [] as Q[],
    permissions: [] as Array<{ id: string; title: string }>,
    sent: [] as string[],
    scopes: [] as string[],
    resumes: 0,
    stops: 0,
    answers: [] as Array<[string, number]>,
    notes: [] as Array<{ kind: string; text: string; loud: boolean }>,
  }
  const d: Deps = {
    now: () => s.now,
    busy: () => s.busy,
    waiting: () => s.waiting,
    denied: () => s.denied,
    resume: async () => {
      s.resumes++
      return { ok: s.resumeOk }
    },
    send: async (_id, text) => void s.sent.push(text),
    scope: async (_id, text) => void s.scopes.push(text),
    stop: async () => {
      s.stops++
      return true
    },
    questions: () => s.questions,
    permissions: () => s.permissions,
    answer: async (id, n) => {
      s.answers.push([id, n])
      return true
    },
    note: async (_id, kind, text, loud) =>
      void s.notes.push({ kind, text, loud }),
    title: () => "api",
    facts: () => ({ known: s.known, channelUp: s.channelUp, inbox: s.inbox }),
    plan: () => ({ channelUp: s.channelUp, deadman: s.deadman }),
    ...over,
  }
  const store = new OvernightStore(file)
  const n = new Overnight(d, store, { wake: [], maxResumes: 3, ...cfg })
  return { s, n, store }
}

async function started(
  b: Partial<ReturnType<typeof brief>> = { tasks: ["one", "two"] },
  over: Partial<Deps> = {},
  cfg = {},
  file?: string,
) {
  const r = rig(over, cfg, file)
  r.n.stage("ses_1", brief(b))
  const out = await r.n.start(T0 + 8 * 60 * MIN, true)
  assert.ok(out.ok, out.text)
  return r
}

describe("overnight: parsing", () => {
  it("reads durations and clock times", () => {
    assert.equal(parseDuration("8h"), 8 * 60 * MIN)
    assert.equal(parseDuration("1h30m"), 90 * MIN)
    assert.equal(parseDuration("90m"), 90 * MIN)
    assert.equal(parseDuration("soon"), undefined)
    assert.equal(parseDuration(""), undefined)
    const noon = new Date(2026, 0, 1, 12, 0).getTime()
    assert.equal(parseUntil("8h", noon), noon + 8 * 60 * MIN)
    assert.equal(
      parseUntil("13:00", noon),
      new Date(2026, 0, 1, 13, 0).getTime(),
    )
    assert.equal(
      parseUntil("07:00", noon),
      new Date(2026, 0, 2, 7, 0).getTime(),
    )
    assert.equal(parseUntil("25:00", noon), undefined)
  })

  it("reads a brief line, keeping quoted spaces", () => {
    const p = parseBriefWords(
      'api task="run the tests" task=fix scope="only src/" turns=5 failures=1 question=default after=10',
    )
    assert.deepEqual(p, {
      session: "api",
      brief: {
        tasks: ["run the tests", "fix"],
        scope: "only src/",
        maxTurns: 5,
        maxFailures: 1,
        question: "default",
        answerAfter: 10,
      },
    })
    assert.ok("error" in parseBriefWords("api turns=0"))
    assert.ok("error" in parseBriefWords("task=x"))
    assert.ok("error" in parseBriefWords("api question=maybe"))
  })
})

describe("overnight: preflight and start", () => {
  it("refuses on a blocker and says which", async () => {
    const r = rig()
    assert.match(
      (await r.n.start(T0 + MIN, true)).text,
      /no session has a brief/,
    )
    r.n.stage("ses_1", brief())
    r.s.denied = true
    r.s.channelUp = false
    const out = await r.n.start(T0 + 60 * MIN, true)
    assert.equal(out.ok, false)
    assert.match(out.text, /chat.deny/)
    assert.match(out.text, /no channel/)
    assert.equal(r.n.plan, undefined)
  })

  it("needs yes for a warning, and never starts without a TUI call", async () => {
    const r = rig()
    r.s.deadman = "unconfigured"
    r.n.stage("ses_1", brief({ tasks: ["a"] }))
    const no = await r.n.start(T0 + 60 * MIN, false)
    assert.equal(no.ok, false)
    assert.match(no.text, /dead-man/)
    assert.equal(r.n.active(), false)
    assert.ok((await r.n.start(T0 + 60 * MIN, true)).ok)
    assert.equal(r.n.active(), true)
    assert.equal(r.n.until(), T0 + 60 * MIN)
  })

  it("refuses a past end time and a second plan", async () => {
    const r = rig()
    r.n.stage("ses_1", brief())
    assert.match((await r.n.start(T0 - 1, true)).text, /passed/)
    assert.ok((await r.n.start(T0 + MIN, true)).ok)
    r.n.stage("ses_2", brief())
    assert.match((await r.n.start(T0 + 2 * MIN, true)).text, /already running/)
  })

  it("survives a restart without sending a task twice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "night-"))
    const file = join(dir, "overnight.json")
    const a = await started({ tasks: ["one", "two"] }, {}, {}, file)
    await a.n.tick()
    assert.deepEqual(a.s.sent, ["one"])
    const saved = JSON.parse(await readFile(file, "utf8"))
    assert.equal(saved.sessions.ses_1.tasks[0].state, "sent")

    const b = rig({}, {}, file)
    await b.store.load()
    b.s.now = T0 + MIN
    await b.n.tick()
    assert.deepEqual(b.s.sent, [], "the sent task waits for its turn to end")
    b.n.turnEnded("ses_1", true)
    await b.n.tick()
    assert.deepEqual(b.s.sent, ["two"])
  })
})

describe("overnight: the loop", () => {
  it("sends the next task only when the session is idle and the last one ended", async () => {
    const r = await started({ tasks: ["one", "two"] })
    r.s.busy = true
    await r.n.tick()
    assert.deepEqual(r.s.sent, [])
    r.s.busy = false
    await r.n.tick()
    await r.n.tick()
    assert.deepEqual(r.s.sent, ["one"])
    r.n.turnEnded("ses_1", true)
    await r.n.tick()
    assert.deepEqual(r.s.sent, ["one", "two"])
    r.n.turnEnded("ses_1", true)
    await r.n.tick()
    assert.deepEqual(r.s.sent, ["one", "two"])
    assert.equal(r.n.view()!.sessions[0].tasksDone, 2)
  })

  it("delivers the scope once, as an instruction, before any task", async () => {
    const r = await started({ tasks: ["one"], scope: "only src/" })
    await r.n.tick()
    assert.deepEqual(r.s.scopes, ["only src/"])
    assert.deepEqual(r.s.sent, [])
    await r.n.tick()
    assert.deepEqual(r.s.scopes, ["only src/"])
    assert.deepEqual(r.s.sent, ["one"])
  })

  it("resumes a suspended session, at most every 5 minutes and maxResumes times", async () => {
    const r = await started({ tasks: [] })
    r.s.waiting = 2
    await r.n.tick()
    assert.equal(r.s.resumes, 1)
    r.s.now += RESUME_GAP_MS - 1
    await r.n.tick()
    assert.equal(r.s.resumes, 1)
    for (let i = 0; i < 4; i++) {
      r.s.now += RESUME_GAP_MS
      await r.n.tick()
    }
    assert.equal(r.s.resumes, 3)
    assert.ok(r.s.notes.some((n) => /resume limit/.test(n.text)))
  })

  it("trusts the resume outcome: no effect stops the retries and tells the operator", async () => {
    const r = await started({ tasks: [] })
    r.s.waiting = 1
    await r.n.tick()
    r.n.resumed("ses_1", "no_effect")
    await new Promise((x) => setImmediate(x))
    r.s.now += RESUME_GAP_MS - 1
    await r.n.tick()
    assert.equal(r.s.resumes, 1)
    assert.ok(
      r.s.notes.some((n) => n.kind === "resume" && /no effect/.test(n.text)),
    )
  })

  it("tells the operator when the host refuses a resume", async () => {
    const r = await started({ tasks: [] })
    r.s.waiting = 1
    r.s.resumeOk = false
    await r.n.tick()
    assert.ok(r.s.notes.some((n) => /refused/.test(n.text)))
  })

  it("pauses a session for 10 minutes when the operator types, but not for its own send", async () => {
    const r = await started({ tasks: ["one", "two", "three"] })
    await r.n.tick()
    r.n.prompted("ses_1")
    r.n.turnEnded("ses_1", true)
    r.s.now += 6000
    r.n.prompted("ses_1")
    r.s.now += 100
    await r.n.tick()
    assert.deepEqual(r.s.sent, ["one"], "paused: nothing sent")
    r.s.now += PAUSE_MS
    await r.n.tick()
    assert.deepEqual(r.s.sent, ["one", "two"])
  })

  it("does not act for a denied session", async () => {
    const r = await started({ tasks: ["one"] })
    r.s.denied = true
    await r.n.tick()
    assert.deepEqual(r.s.sent, [])
  })
})

describe("overnight: questions and permissions", () => {
  const q = (over: Partial<Q> = {}): Q => ({
    id: "q1",
    title: "Which?",
    askedAt: T0,
    single: true,
    recommended: 2,
    ...over,
  })

  it("park leaves the question and says so, without sound by default", async () => {
    const r = await started({ tasks: [], question: "park" })
    r.s.questions = [q()]
    await r.n.tick()
    await r.n.tick()
    assert.deepEqual(r.s.answers, [])
    const n = r.s.notes.filter((x) => x.kind === "question")
    assert.equal(n.length, 1)
    assert.equal(n[0].loud, false)
  })

  it("default answers a single choice with a recommended option, after the wait", async () => {
    const r = await started({ tasks: [], question: "default", answerAfter: 30 })
    r.s.questions = [q()]
    await r.n.tick()
    assert.deepEqual(r.s.answers, [])
    r.s.now += 30 * MIN
    await r.n.tick()
    assert.deepEqual(r.s.answers, [["q1", 2]])
  })

  it("default parks what has no recommended option, or is multi-select", async () => {
    const r = await started({ tasks: [], question: "default", answerAfter: 1 })
    r.s.now += MIN
    r.s.questions = [
      q({ id: "a", title: "A?", recommended: undefined }),
      q({ id: "b", title: "B?", single: false }),
    ]
    await r.n.tick()
    assert.deepEqual(r.s.answers, [])
    assert.equal(r.s.notes.filter((x) => x.kind === "question").length, 2)
  })

  it("never answers a permission: it is reported once", async () => {
    const r = await started({ tasks: [], question: "default", answerAfter: 1 })
    r.s.now += 10 * MIN
    r.s.permissions = [{ id: "p1", title: "run rm" }]
    await r.n.tick()
    await r.n.tick()
    assert.deepEqual(r.s.answers, [])
    assert.equal(r.s.notes.filter((x) => x.kind === "permission").length, 1)
  })

  it("does not answer while the operator has the session paused", async () => {
    const r = await started({ tasks: [], question: "default", answerAfter: 1 })
    await r.n.tick()
    r.n.prompted("ses_1")
    r.s.now += 5 * MIN
    r.s.questions = [q({ askedAt: T0 })]
    await r.n.tick()
    assert.deepEqual(r.s.answers, [])
  })
})

describe("overnight: budgets, escalation and the end", () => {
  it("stops a session at maxTurns and interrupts a running turn", async () => {
    const r = await started({ tasks: ["a", "b", "c"], maxTurns: 2 })
    for (let i = 0; i < 2; i++) {
      await r.n.tick()
      r.n.turnEnded("ses_1", true)
    }
    r.s.busy = true
    await r.n.tick()
    assert.equal(r.n.view()!.sessions[0].stopped, "turns")
    assert.equal(r.s.stops, 1)
    r.s.busy = false
    await r.n.tick()
    assert.equal(r.s.sent.length, 2)
  })

  it("stops after maxFailures failed turns in a row, and a success resets the count", async () => {
    const r = await started({ tasks: ["a", "b", "c", "d"], maxFailures: 2 })
    await r.n.tick()
    r.n.turnEnded("ses_1", false)
    await r.n.tick()
    r.n.turnEnded("ses_1", true)
    await r.n.tick()
    r.n.turnEnded("ses_1", false)
    await r.n.tick()
    assert.equal(r.n.view()!.sessions[0].stopped, undefined)
    r.n.turnEnded("ses_1", false)
    await r.n.tick()
    assert.equal(r.n.view()!.sessions[0].stopped, "failures")
    assert.ok(r.s.notes.some((n) => n.kind === "failed"))
  })

  it("makes a sound only for the kinds in wake", async () => {
    const r = await started(
      { tasks: [], maxTurns: 1 },
      {},
      { wake: ["stopped"] },
    )
    r.s.permissions = [{ id: "p1", title: "x" }]
    await r.n.tick()
    r.n.turnEnded("ses_1", true)
    await r.n.tick()
    const by = (k: string) => r.s.notes.find((n) => n.kind === k)!
    assert.equal(by("stopped").loud, true)
    assert.equal(by("permission").loud, false)
  })

  it("warns once when a channel goes down", async () => {
    const r = await started({ tasks: [] })
    r.s.channelUp = false
    await r.n.tick()
    await r.n.tick()
    assert.equal(r.s.notes.filter((n) => n.kind === "unhealthy").length, 1)
  })

  it("ends from outside and then does nothing, even with work waiting", async () => {
    const r = await started({ tasks: ["a"] })
    assert.equal(await r.n.end("chat"), true)
    assert.equal(await r.n.end("chat"), false)
    r.s.waiting = 3
    await r.n.tick()
    assert.deepEqual(r.s.sent, [])
    assert.equal(r.s.resumes, 0)
    assert.equal(r.n.until(), 0)
    assert.match(r.n.status(), /ended \(chat\)/)
  })

  it("ends by time and reports the night once", async () => {
    const r = await started({ tasks: ["a"] })
    await r.n.tick()
    r.n.turnEnded("ses_1", true)
    r.s.now = T0 + 9 * 60 * MIN
    await r.n.tick()
    assert.equal(r.n.plan!.ended!.by, "time")
    assert.equal(r.n.pendingReport(), true)
    const text = r.n.report().join("\n")
    assert.match(text, /Night \(time\)/)
    assert.match(text, /api: 1 turn, 1\/1 tasks/)
    await r.n.markReported()
    assert.equal(r.n.pendingReport(), false)
  })
})
