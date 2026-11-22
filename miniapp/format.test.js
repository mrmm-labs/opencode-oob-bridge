import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  aboutLine,
  avatarOf,
  groups,
  isStale,
  matches,
  nameOf,
  short,
  subtitle,
  ago,
  connection,
  diffClass,
  permissionChoices,
  parseStart,
  refusalText,
  stateLabel,
  uptime,
} from "./format.js"

describe("format", () => {
  it("says how long ago", () => {
    assert.equal(ago(1000, 1000), "now")
    assert.equal(ago(0, 30_000), "30s ago")
    assert.equal(ago(0, 5 * 60_000), "5m ago")
    assert.equal(ago(0, 3 * 3600_000), "3h ago")
    assert.equal(ago(0, 2 * 86_400_000), "2d ago")
    assert.equal(ago(undefined, 1), "")
  })

  it("puts a waiting prompt before the state", () => {
    assert.equal(stateLabel({ pending: 1, state: "working" }).key, "waiting")
    assert.equal(
      stateLabel({ pending: 0, state: "suspended" }).text,
      "Suspended",
    )
    assert.equal(stateLabel({ pending: 0, state: "working" }).key, "working")
  })

  it("names the connection state", () => {
    assert.equal(connection({ conn: "live" }).key, "live")
    assert.equal(connection({ conn: "down" }).text, "Reconnecting…")
    assert.equal(connection({ conn: "connecting" }).text, "Connecting…")
  })

  it("classes diff lines", () => {
    assert.equal(diffClass("+x"), "add")
    assert.equal(diffClass("-x"), "del")
    assert.equal(diffClass("+++ b/a"), "meta")
    assert.equal(diffClass("@@ -1 +1 @@"), "hunk")
    assert.equal(diffClass(" ctx"), "")
  })
})

describe("permission gate", () => {
  const meta = (permissions, available = true) => ({
    permissions,
    actions: [{ name: "permission", available }],
  })

  it("offers nothing when the policy is off, or the core says the action is off", () => {
    assert.deepEqual(permissionChoices(meta("off")), [])
    assert.deepEqual(permissionChoices(meta("once", false)), [])
    assert.deepEqual(permissionChoices(undefined), [])
    assert.deepEqual(
      permissionChoices({ permissions: "once", actions: [] }),
      [],
    )
  })

  it("offers Allow once and Deny for once, and also Always for all", () => {
    assert.deepEqual(permissionChoices(meta("once")), ["once", "reject"])
    assert.deepEqual(permissionChoices(meta("all")), [
      "once",
      "always",
      "reject",
    ])
  })
})

describe("refusal sentences", () => {
  it("has one for each reason the bridge gives, and none for an unknown one", () => {
    for (const r of [
      "no_operator",
      "no_bot_token",
      "missing",
      "malformed",
      "bad_signature",
      "too_old",
      "not_operator",
      "too many failures",
    ])
      assert.ok(refusalText(r)?.length > 20, r)
    assert.equal(refusalText("something else"), undefined)
    assert.equal(refusalText(undefined), undefined)
    assert.match(refusalText("no_operator"), /no operator configured/)
    assert.doesNotMatch(refusalText("no_operator"), /expired/)
  })
})

describe("the start parameter", () => {
  it("names a session, an approval or an enrolment by its prefix", () => {
    assert.deepEqual(parseStart("s_ses_1"), { kind: "session", id: "ses_1" })
    assert.deepEqual(parseStart("a_01ARZ"), { kind: "approval", id: "01ARZ" })
    assert.deepEqual(parseStart("enrol_ABCD2345"), {
      kind: "enrol",
      code: "ABCD2345",
    })
  })

  it("takes a bare id as a session, for a message sent before the prefixes", () => {
    assert.deepEqual(parseStart("ses_1"), { kind: "session", id: "ses_1" })
  })

  it("asks for nothing when it is empty, too long, odd, or an enrolment without a usable code", () => {
    for (const bad of [
      "",
      undefined,
      "a/b",
      "x".repeat(65),
      "enrol_",
      "enrol_" + "A".repeat(17),
      "s_",
      "a_",
    ])
      assert.equal(parseStart(bad), undefined, String(bad))
  })
})

describe("the version footer", () => {
  const T = Date.UTC(2026, 10, 22, 12, 0, 0)

  it("counts uptime in the two largest units", () => {
    assert.equal(uptime(T - 40_000, T), "40s")
    assert.equal(uptime(T - 5 * 60_000, T), "5m")
    assert.equal(uptime(T - (3 * 3600 + 12 * 60) * 1000, T), "3h 12m")
    assert.equal(uptime(T - (3 * 86_400 + 4 * 3600) * 1000, T), "3d 4h")
    assert.equal(uptime(T + 5000, T), "0s")
    assert.equal(uptime(undefined, T), "")
  })

  it("says the version and the uptime, and only the version when the start is unknown", () => {
    assert.equal(
      aboutLine("0.37.0", T - 90 * 60_000, T, "0.37.0-ab12cd34"),
      "opencode-oob-bridge 0.37.0 · up 1h 30m · page 0.37.0-ab12cd34",
    )
    assert.equal(
      aboutLine("0.37.0", undefined, T, "x"),
      "opencode-oob-bridge 0.37.0 · page x",
    )
    assert.equal(
      aboutLine(undefined, undefined, T, ""),
      "opencode-oob-bridge unknown · page unstamped",
    )
  })

  it("knows a page that is not the build the bridge serves", () => {
    assert.equal(isStale("0.36.0-aaaa1111", "0.37.0-bbbb2222"), true)
    assert.equal(isStale("", "0.37.0-bbbb2222"), true)
    assert.equal(isStale("0.37.0-bbbb2222", "0.37.0-bbbb2222"), false)
    assert.equal(isStale("x", undefined), false)
    assert.equal(isStale("x", ""), false)
  })
})

describe("the session list", () => {
  const s = (o) => ({ id: "ses_abcdef123456", state: "idle", pending: 0, ...o })

  it("names a session by its title, then its project, then its folder, then a short id", () => {
    assert.equal(
      nameOf(s({ title: "Fix login", project: "shop" })),
      "Fix login",
    )
    assert.equal(nameOf(s({ project: "shop", folder: "web" })), "shop")
    assert.equal(nameOf(s({ folder: "web" })), "web")
    assert.equal(nameOf(s({})), "#123456")
  })

  it("puts project, agent and model under the name, without saying the name twice", () => {
    assert.equal(
      subtitle(
        s({ title: "Fix", project: "shop", agent: "build", model: "m1" }),
      ),
      "shop · build · m1",
    )
    assert.equal(subtitle(s({ project: "shop", agent: "build" })), "build")
    assert.equal(subtitle(s({})), "")
  })

  it("gives one letter and colour to a project, the same each time", () => {
    const a = avatarOf(s({ project: "shop" }))
    assert.deepEqual(a, avatarOf(s({ project: "shop", title: "other" })))
    assert.equal(a.letter, "S")
    assert.ok(a.hue >= 0 && a.hue < 360)
    assert.equal(avatarOf(s({ title: "éclair" })).letter, "É")
    assert.equal(avatarOf({ id: "---" }).letter, "?")
    assert.notEqual(
      avatarOf(s({ project: "shop" })).hue,
      avatarOf(s({ project: "api" })).hue,
    )
  })

  it("counts the age in one unit", () => {
    const T = 1_000_000_000
    assert.equal(short(undefined, T), "")
    assert.equal(short(T - 3000, T), "now")
    assert.equal(short(T - 30_000, T), "30s")
    assert.equal(short(T - 120_000, T), "2m")
    assert.equal(short(T - 3 * 3600_000, T), "3h")
    assert.equal(short(T - 5 * 86_400_000, T), "5d")
  })

  it("sorts sessions into waiting, working and idle, and leaves out an empty section", () => {
    const g = groups([
      s({ id: "a", pending: 2 }),
      s({ id: "b", state: "working" }),
      s({ id: "c", state: "suspended" }),
      s({ id: "d" }),
      s({ id: "e", state: "failed" }),
      s({ id: "f", state: "working", stuck: true }),
    ])
    assert.deepEqual(
      g.map((x) => [x.key, x.items.map((i) => i.id)]),
      [
        ["waiting", ["a", "c", "f"]],
        ["working", ["b"]],
        ["idle", ["d", "e"]],
      ],
    )
    assert.deepEqual(
      groups([s({ id: "x" })]).map((x) => x.key),
      ["idle"],
    )
    assert.deepEqual(groups([]), [])
  })

  it("finds a session by every word, in its name, project, agent, model or id", () => {
    const x = s({
      title: "Fix login",
      project: "shop",
      agent: "build",
      model: "claude",
    })
    assert.equal(matches(x, ""), true)
    assert.equal(matches(x, "login shop"), true)
    assert.equal(matches(x, "CLAUDE"), true)
    assert.equal(matches(x, "abcdef"), true)
    assert.equal(matches(x, "login nope"), false)
  })
})
