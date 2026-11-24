import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { Rule } from "./config.ts"
import { globToRegExp, Router, runClassifier } from "./routing.ts"

function clock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const router = (rules: Rule[], classify = async () => true) => {
  const c = clock(1_000_000)
  return { c, r: new Router({ away: { minutes: 10 }, rules }, classify, c.now) }
}

describe("globToRegExp", () => {
  it("matches ** across segments and * within one", () => {
    assert.ok(globToRegExp("**/app").test("/srv/src/app"))
    assert.ok(globToRegExp("**/app").test("app"))
    assert.ok(!globToRegExp("**/app").test("/src/app2"))
    assert.ok(globToRegExp("/src/*/app").test("/src/x/app"))
    assert.ok(!globToRegExp("/src/*/app").test("/src/x/y/app"))
    assert.ok(globToRegExp("/src/a.b?").test("/src/a.bc"))
    assert.ok(!globToRegExp("/src/a.b").test("/src/aXb"))
  })
})

const MIN = 60_000

describe("presence rules", () => {
  it("defaults: idle 10, phone 30, grace 60 s, override 2 h, signals off", () => {
    const { c, r } = router([])
    assert.deepEqual(r.state(), { away: false, reason: "input" })
    c.advance(10 * MIN)
    assert.deepEqual(r.state(), { away: true, reason: "idle" })
    assert.equal(r.overrideMs(), 120 * MIN)
  })

  it("a Telegram message means away for N minutes and each later one extends it", () => {
    const { c, r } = router([])
    r.phone()
    let st = r.state()
    assert.equal(st.reason, "phone")
    assert.equal(st.until, c.now() + 30 * MIN)
    c.advance(20 * MIN)
    r.touch(c.now() - 1)
    r.phone()
    st = r.state()
    assert.equal(st.until, c.now() + 30 * MIN)
    c.advance(29 * MIN)
    assert.equal(r.state().reason, "phone")
  })

  it("when the phone window ends it goes back to the input rule", () => {
    const { c, r } = router([])
    r.phone()
    c.advance(30 * MIN - 1000)
    r.touch()
    assert.equal(r.state().reason, "phone")
    c.advance(1000)
    assert.deepEqual(r.state(), { away: false, reason: "input" })
  })

  it("phoneMinutes 0 turns the phone rule off", () => {
    const c = clock(1_000_000)
    const r = new Router(
      { away: { minutes: 10, phoneMinutes: 0 }, rules: [] },
      undefined,
      c.now,
    )
    r.phone()
    assert.equal(r.away(), false)
  })

  it("a glance does not flip it; continuous input for the grace does", () => {
    const { c, r } = router([])
    c.advance(5 * MIN)
    r.phone()
    c.advance(5_000)
    r.touch()
    assert.equal(r.state().reason, "phone", "one keystroke")
    for (let i = 0; i < 7; i++) {
      c.advance(10_000)
      r.touch()
    }
    assert.deepEqual(r.state(), { away: false, reason: "input" })
  })

  it("input with gaps longer than the grace never builds a run", () => {
    const { c, r } = router([])
    c.advance(5 * MIN)
    r.phone()
    for (let i = 0; i < 5; i++) {
      c.advance(90_000)
      r.touch()
      assert.equal(r.state().reason, "phone")
    }
  })

  it("a new phone message restarts the wait", () => {
    const { c, r } = router([])
    r.phone()
    for (let i = 0; i < 7; i++) {
      c.advance(10_000)
      r.touch()
    }
    assert.equal(r.away(), false)
    r.phone()
    assert.equal(r.state().reason, "phone")
  })

  it("/afk and /back win over the phone and expire into the rules", () => {
    const { c, r } = router([])
    r.setAfk("off")
    r.phone()
    assert.deepEqual(r.state(), {
      away: false,
      reason: "manual-present",
      until: c.now() + 120 * MIN,
    })
    c.advance(120 * MIN)
    assert.equal(r.afkMode(), "auto")
    assert.equal(r.state().reason, "idle")
    r.touch()
    r.setAfk("on", c.now() + 5 * MIN)
    assert.equal(r.state().reason, "manual-away")
    assert.equal(r.afkEnds(), c.now() + 5 * MIN)
    c.advance(5 * MIN)
    assert.equal(r.state().reason, "input")
  })

  it("a forced mode without a time gets the default time-box", () => {
    const { c, r } = router([])
    r.setAfk("on")
    assert.equal(r.afkEnds(), c.now() + 2 * 60 * MIN)
    const r2 = new Router(
      { away: { minutes: 10, overrideMinutes: 30 }, rules: [] },
      undefined,
      c.now,
    )
    r2.setAfk("off")
    assert.equal(r2.afkEnds(), c.now() + 30 * MIN)
  })

  it("lock and sleep are signals that are off unless set", () => {
    const c = clock(1_000_000)
    const off = new Router(
      { away: { minutes: 10 }, rules: [] },
      undefined,
      c.now,
    )
    off.setLocked(() => true)
    off.slept()
    assert.equal(off.away(), false)
    const on = new Router(
      { away: { minutes: 10, lock: true, sleep: true }, rules: [] },
      undefined,
      c.now,
    )
    let locked = true
    on.setLocked(() => locked)
    assert.equal(on.state().reason, "locked")
    locked = false
    assert.equal(on.away(), false)
    c.advance(1000)
    on.slept(c.now())
    assert.equal(on.state().reason, "slept")
    c.advance(1000)
    on.touch()
    assert.equal(on.away(), false)
  })

  it("a schedule window forces away or present; the phone beats it, a forced mode beats both", () => {
    const at = Date.UTC(2026, 0, 5, 23, 30)
    const mk = (as: "away" | "present") => {
      const c = clock(at)
      const r = new Router(
        {
          away: {
            minutes: 10,
            schedule: [{ from: 23 * 60, to: 7 * 60, timezone: "UTC", as }],
          },
          rules: [],
        },
        undefined,
        c.now,
      )
      return { c, r }
    }
    const night = mk("away")
    assert.equal(night.r.state().reason, "schedule-away")
    night.r.setAfk("off")
    assert.equal(night.r.state().reason, "manual-present")
    const desk = mk("present")
    desk.c.advance(30 * MIN)
    assert.equal(desk.r.state().reason, "schedule-present")
    desk.r.phone()
    assert.equal(desk.r.state().reason, "phone")
    const outside = mk("away")
    outside.c.advance(8 * 60 * MIN)
    outside.r.touch()
    assert.equal(outside.r.state().reason, "input")
  })

  it("no TUI attached is away, below the schedule and the phone", () => {
    const { r } = router([])
    r.setPresence(() => false)
    assert.deepEqual(r.state(), { away: true, reason: "no-tui" })
  })

  it("explains each state with its end", () => {
    const { c, r } = router([])
    r.phone()
    assert.match(r.why(), /wrote from Telegram, ends in 30 min/)
    r.setAfk("off", c.now() + 5 * MIN)
    assert.match(r.why(), /\/back.*ends in 5 min/)
  })

  it("a session's idle time only lengthens the instance's", async () => {
    const { c, r } = router([])
    r.set("s", undefined, undefined, 60)
    r.set("t", undefined, undefined, 2)
    c.advance(15 * MIN)
    assert.equal(await r.routes({ id: "s" }), false)
    assert.equal(
      await r.routes({ id: "t" }),
      true,
      "shorter than 10 is ignored",
    )
    c.advance(45 * MIN)
    assert.equal(await r.routes({ id: "s" }), true)
  })

  it("a session's idle time does not hold back a phone message", async () => {
    const { r } = router([])
    r.set("s", undefined, undefined, 60)
    r.phone()
    assert.equal(await r.routes({ id: "s" }), true)
  })
})

describe("Router", () => {
  it("routes nothing until the operator is away, then everything without rules", async () => {
    const { c, r } = router([])
    assert.equal(await r.routes({ id: "s" }), false)
    c.advance(10 * 60_000)
    assert.equal(r.away(), true)
    assert.equal(await r.routes({ id: "s" }), true)
    r.touch()
    assert.equal(await r.routes({ id: "s" }), false)
  })

  it("manual off beats away, manual on never sends while present", async () => {
    const { c, r } = router([])
    r.set("s", true)
    assert.equal(r.mode("s"), "on")
    assert.equal(await r.routes({ id: "s" }), false, "on while present")
    assert.equal((await r.decide({ id: "s" })).reason, "present")
    c.advance(11 * 60_000)
    assert.equal(await r.routes({ id: "s" }), true)
    r.set("s", false)
    assert.equal(await r.routes({ id: "s" }), false)
    r.set("s", undefined)
    assert.equal(r.mode("s"), "auto")
    assert.equal(await r.routes({ id: "s" }), true)
  })

  it("on skips the rules when away; chat does too", async () => {
    const { c, r } = router([{ agent: /^nope$/ }])
    c.advance(11 * 60_000)
    assert.equal(await r.routes({ id: "s", agent: "x" }), false)
    assert.equal(await r.routes({ id: "s", agent: "x", chat: true }), true)
    r.set("s", true)
    assert.equal(await r.routes({ id: "s", agent: "x" }), true)
  })

  it("a channel alone keeps the mode on auto", () => {
    const { r } = router([])
    r.set("s", undefined, "telegram")
    assert.equal(r.mode("s"), "auto")
    assert.equal(r.channel("s"), "telegram")
    assert.deepEqual(r.chosen(), ["s"])
  })

  it("applies agent, directory and command rules when away", async () => {
    const calls: string[] = []
    const { c, r } = router(
      [{ agent: /^coordinator$/ }, { directory: "**/app" }, { command: ["x"] }],
      async (_argv, s) => {
        calls.push(s.id)
        return s.id === "cmd"
      },
    )
    c.advance(10 * 60_000)
    assert.equal(await r.routes({ id: "a", agent: "coordinator" }), true)
    assert.equal(await r.routes({ id: "d", directory: "/w/app" }), true)
    assert.equal(await r.routes({ id: "cmd" }), true)
    assert.equal(
      await r.routes({ id: "no", agent: "build", directory: "/w/x" }),
      false,
    )
    await r.routes({ id: "no" })
    assert.deepEqual(
      calls.filter((x) => x === "no").length,
      1,
      "classifier cached",
    )
  })

  it("runs a classifier command asynchronously by exit code", async () => {
    assert.equal(await runClassifier(["true"], { id: "s" }), true)
    assert.equal(await runClassifier(["false"], { id: "s" }), false)
    assert.equal(
      await runClassifier(
        ["sh", "-c", 'test "$OOB_BRIDGE_AGENT" = coordinator'],
        {
          id: "s",
          agent: "coordinator",
        },
      ),
      true,
    )
    assert.equal(await runClassifier(["/nonexistent/cmd"], { id: "s" }), false)
  })
})
