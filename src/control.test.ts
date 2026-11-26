import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { Bridge, type Host } from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import { Control, PRESENCE_MS, STUCK_MS, type Probe } from "./control.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"
import { SettingsStore } from "./settings.ts"
import { flushLog } from "./logger.ts"
import { sleep } from "./util.ts"

const CHAT = 4242

async function rig(
  o: {
    resume?: "ok" | "none" | "fail"
    busy?: boolean
    probe?: Probe
    route?: boolean
    version?: string
    installed?: string
  } = {},
) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-control-"))
  const channel = new TelegramConnector({
    token: async () => tg.token,
    chatId: String(CHAT),
    apiBase: tg.url,
    topicsFile: join(dir, "topics.json"),
    offsetFile: join(dir, "offset.json"),
    pollSeconds: 1,
    backoff: { min: 10, max: 40 },
  })
  const cfg = parseConfig({
    channels: { telegram: { token: { env: "X" } } },
  }) as Config
  const clock = { t: 1_000_000 }
  const now = () => clock.t
  const resumed: string[] = []
  const interrupted: string[] = []
  const state = { busy: o.busy ?? false }
  const host: Host = {
    session: async (id) =>
      id === "root"
        ? { id, agent: "coord", directory: "/w/shop", title: "Shop" }
        : undefined,
    root: (id) => (id === "child" ? "root" : id),
    replyForm: async () => {},
    prompt: async () => {},
    busy: () => state.busy,
    interrupt: async (id: string) => {
      interrupted.push(id)
      return true
    },
    ...(o.resume === "none"
      ? {}
      : {
          resume: async (id: string) => {
            if (o.resume === "fail") throw new Error("refused")
            resumed.push(id)
          },
        }),
  }
  const router = new Router(cfg, async () => true, now)
  router.set("root", o.route !== false)
  const store = new PendingStore()
  const bridge = new Bridge(cfg, host, [channel], store, router)
  const settings = new SettingsStore()
  const control = new Control({
    bridge,
    router,
    settings,
    cfg,
    host,
    owner: { pid: 1, startedAt: now(), id: "abc12345" },
    version: o.version ?? "t",
    installed: async () => ({
      version: o.installed ?? o.version ?? "t",
      describe: "v9.9.9-0-gdeadbee",
      dir: "/opt/plugin",
    }),
    now,
    probe: o.probe,
  })
  bridge.start()
  const enqueue = (id: string, sessionID = "root", type = "user") =>
    control.onEvent({
      type: "session.inbox.enqueued",
      data: { sessionID, inboxID: id, item: { type } },
    })
  return {
    tg,
    bridge,
    store,
    control,
    router,
    settings,
    clock,
    state,
    resumed,
    interrupted,
    enqueue,
    sends: () => tg.of("sendMessage").map((c) => c.body),
    async done() {
      control.stop()
      await bridge.stop()
      await tg.close()
    },
  }
}

describe("who counts as away", () => {
  it("with no window attached the operator is away, and the windows decide otherwise", async () => {
    const r = await rig()
    assert.equal(r.control.snapshot().afk.away, true)
    assert.equal(r.control.snapshot().afk.tuis, 0)
    const t0 = r.clock.t
    r.control.heartbeat("a", t0)
    assert.equal(r.control.snapshot().afk.away, false)
    assert.equal(r.control.snapshot().afk.tuis, 1)
    // The window stays attached but its operator stops typing.
    r.clock.t = t0 + cfgMinutes() * 60_000 - 1
    r.control.heartbeat("a", t0)
    assert.equal(r.control.snapshot().afk.away, false)
    r.clock.t += 1
    r.control.heartbeat("a", t0)
    assert.equal(r.control.snapshot().afk.away, true)
    assert.equal(r.control.snapshot().afk.tuis, 1)
    await r.done()
  })

  it("input in any window counts, and a window that stops reporting is gone", async () => {
    const r = await rig()
    const t0 = r.clock.t
    r.control.heartbeat("a", t0)
    r.clock.t += cfgMinutes() * 60_000 + 1
    r.control.heartbeat("a", t0)
    assert.equal(r.control.snapshot().afk.away, true)
    // Another window reports fresh input: present again, for the whole instance.
    r.control.heartbeat("b", r.clock.t)
    assert.equal(r.control.snapshot().afk.away, false)
    assert.equal(r.control.snapshot().afk.tuis, 2)
    r.clock.t += PRESENCE_MS + 1
    assert.equal(r.control.attached(), 0)
    assert.equal(r.control.snapshot().afk.away, true)
    await r.done()
  })

  it("afk on and off override the windows, and are kept", async () => {
    const r = await rig()
    assert.equal(
      (await r.control.op("afk", { mode: "off" })).snapshot.afk.away,
      false,
    )
    assert.equal(r.settings.afk(), "off")
    r.control.heartbeat("a", r.clock.t)
    assert.equal(
      (await r.control.op("afk", { mode: "on" })).snapshot.afk.away,
      true,
    )
    assert.equal(
      (await r.control.op("afk", { mode: "auto" })).snapshot.afk.away,
      false,
    )
    const bad = await r.control.op("afk", { mode: "sometimes" })
    assert.equal(bad.ok, false)
    await r.done()
  })
})

const cfgMinutes = () => 10

describe("a session with messages it is not working on", () => {
  it("is told once to the topic, with a Resume button, after the grace period", async () => {
    const r = await rig()
    r.enqueue("i1")
    assert.deepEqual(r.control.stuck(), [])
    r.clock.t += STUCK_MS + 1
    assert.equal(r.control.stuck().length, 1)
    await r.control.scan()
    const sent = await r.tg.waitFor(() =>
      r.sends().find((b) => /has waited 1 min/.test(b.text)),
    )
    assert.deepEqual(sent.reply_markup, {
      inline_keyboard: [[{ text: "▶ Resume", callback_data: "ctl:resume" }]],
    })
    const n = r.sends().length
    await r.control.scan()
    assert.equal(r.sends().length, n)
    assert.equal(r.control.stuck()[0].alerted, true)
    await r.done()
  })

  it("tapping Resume wakes the session and says so", async () => {
    const r = await rig()
    r.enqueue("i1")
    r.clock.t += STUCK_MS + 1
    await r.control.scan()
    await r.tg.waitFor(() =>
      r.sends().find((b) => /Resume wakes it/.test(b.text)),
    )
    r.tg.callback(CHAT, 701, "ctl:resume", 9001)
    const ans = await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.match(ans.body.text, /Waking it/)
    assert.deepEqual(r.resumed, ["root"])
    await r.done()
  })

  it("says to open it at the Mac when the host cannot or will not resume", async () => {
    const refuses = await rig({ resume: "fail" })
    refuses.enqueue("i1")
    assert.match(
      (await refuses.control.op("resume", { root: "root" })).text!,
      /Open it at the Mac/,
    )
    await refuses.done()
    const none = await rig({ resume: "none" })
    none.enqueue("i1")
    none.clock.t += STUCK_MS + 1
    await none.control.scan()
    const note = await none.tg.waitFor(() =>
      none.sends().find((b) => /has waited/.test(b.text)),
    )
    assert.equal(note.reply_markup, undefined)
    const out = await none.control.op("resume", { root: "root" })
    assert.equal(out.ok, false)
    assert.match(out.text!, /Open it at the Mac/)
    await none.done()
  })

  it("is not stuck once the message is delivered, while it works, or when it is a subagent's", async () => {
    const r = await rig()
    r.enqueue("i1")
    r.control.onEvent({
      type: "session.inbox.delivered",
      data: { sessionID: "root", inboxID: "i1" },
    })
    r.clock.t += STUCK_MS + 1
    assert.deepEqual(r.control.stuck(), [])
    r.enqueue("i2")
    r.clock.t += STUCK_MS + 1
    r.state.busy = true
    assert.deepEqual(r.control.stuck(), [])
    r.state.busy = false
    assert.equal(r.control.stuck().length, 1)
    r.control.onEvent({ type: "session.deleted", data: { sessionID: "root" } })
    assert.deepEqual(r.control.stuck(), [])
    r.enqueue("i3", "child")
    r.enqueue("i4", "root", "synthetic")
    assert.deepEqual(r.control.stuck(), [])
    await r.done()
  })

  it("is also found from the database when the events were missed", async () => {
    const r = await rig({
      probe: async () => [
        { id: "root", pending: 3, since: 1_000_000 - 5 * 60_000 },
      ],
    })
    await r.control.refreshProbe()
    const [s] = r.control.stuck()
    assert.equal(s.source, "db")
    assert.equal(s.pending, 3)
    await r.tg.waitFor(() => r.sends().find((b) => /3 messages/.test(b.text)))
    assert.equal(r.control.snapshot().stuck.length, 1)
    await r.done()
  })

  it("a session that is not mirrored is listed but nothing is sent", async () => {
    const r = await rig({ route: false })
    r.enqueue("i1")
    r.clock.t += STUCK_MS + 1
    await r.control.scan()
    assert.equal(r.control.stuck().length, 1)
    assert.deepEqual(r.sends(), [])
    await r.done()
  })
})

describe("commands from a window", () => {
  it("routes and chats for any session, keeps it, and refuses what it does not know", async () => {
    const r = await rig({ route: false })
    const a = await r.control.op("route", { root: "root", mode: "on" })
    assert.equal(a.ok, true)
    assert.equal(a.snapshot.sessions.find((s) => s.id === "root")?.mode, "on")
    assert.equal(r.settings.sessions().root.on, true)
    assert.equal(
      (await r.control.op("route", { root: "root", mode: "maybe" })).ok,
      false,
    )
    assert.equal((await r.control.op("nope")).ok, false)
    assert.equal((await r.control.op("resume")).ok, false)
    await r.done()
  })
})

describe("resume: the outcome is observed and reported", () => {
  const quick = (r: Awaited<ReturnType<typeof rig>>) => {
    const b = r.bridge as unknown as {
      resumeWatchMs: number
      resumePollMs: number
    }
    b.resumeWatchMs = 400
    b.resumePollMs = 20
  }
  const alerted = async (o: Parameters<typeof rig>[0] = {}) => {
    const r = await rig(o)
    quick(r)
    r.enqueue("i1")
    r.clock.t += STUCK_MS + 1
    await r.control.scan()
    await r.tg.waitFor(() =>
      r.sends().find((b) => /Resume wakes it/.test(b.text)),
    )
    return r
  }
  const tap = (r: Awaited<ReturnType<typeof rig>>) =>
    r.tg.callback(CHAT, 701, "ctl:resume", 9001)
  const edited = (r: Awaited<ReturnType<typeof rig>>, re: RegExp) =>
    r.tg.waitFor(() =>
      r.tg.of("editMessageText").find((c) => re.test(c.body.text)),
    )
  const logged = async <T>(fn: (file: string) => Promise<T>) => {
    const dir = await mkdtemp(join(tmpdir(), "oobb-rlog-"))
    const file = join(dir, "log.jsonl")
    const old = process.env.OPENCODE_OOB_BRIDGE_LOG
    process.env.OPENCODE_OOB_BRIDGE_LOG = file
    try {
      return await fn(file)
    } finally {
      if (old === undefined) delete process.env.OPENCODE_OOB_BRIDGE_LOG
      else process.env.OPENCODE_OOB_BRIDGE_LOG = old
    }
  }
  // The log is written by a queue that can lag under load: wait for the line.
  const resumeLine = async (file: string) => {
    const end = Date.now() + 5000
    for (;;) {
      await flushLog()
      const line = (await readFile(file, "utf8").catch(() => ""))
        .split("\n")
        .find((l) => l.includes('"resume"') && l.includes("outcome"))
      if (line || Date.now() > end) return line
      await sleep(25)
    }
  }

  it("working: the session starts a turn, and the alert says so and loses its button", async () => {
    await logged(async (file) => {
      const r = await alerted()
      tap(r)
      await r.tg.waitFor(() => r.resumed[0])
      r.state.busy = true
      const e = await edited(r, /working again/)
      assert.deepEqual(e.body.reply_markup, { inline_keyboard: [] })
      const line = await resumeLine(file)
      assert.match(line!, /"source":"button"/)
      assert.match(line!, /"outcome":"working"/)
      assert.match(line!, /"session":"root"/)
      await r.done()
    })
  })

  it("drained: the waiting messages were taken", async () => {
    await logged(async (file) => {
      const r = await alerted()
      tap(r)
      await r.tg.waitFor(() => r.resumed[0])
      r.control.onEvent({
        type: "session.inbox.delivered",
        data: { sessionID: "root", inboxID: "i1" },
      })
      await edited(r, /took its waiting messages/)
      assert.match((await resumeLine(file))!, /"outcome":"drained"/)
      await r.done()
    })
  })

  it("no effect: accepted, nothing changed, and the alert says to open it at the Mac", async () => {
    await logged(async (file) => {
      const r = await alerted()
      tap(r)
      const e = await edited(r, /nothing changed/)
      assert.match(e.body.text, /Open the session at the Mac/)
      assert.match((await resumeLine(file))!, /"outcome":"no_effect"/)
      await r.done()
    })
  })

  it("a second tap on a used alert says so and wakes nothing", async () => {
    const r = await alerted()
    tap(r)
    await r.tg.waitFor(() => r.resumed[0])
    tap(r)
    await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[1])
    assert.match(r.tg.of("answerCallbackQuery")[1].body.text, /already used/)
    assert.equal(r.resumed.length, 1)
    await r.done()
  })

  it("the command and the sidebar are logged with their own source", async () => {
    await logged(async (file) => {
      const r = await alerted()
      r.state.busy = true
      await r.control.op("resume", { root: "root" })
      await edited(r, /working again/)
      assert.match((await resumeLine(file))!, /"source":"sidebar"/)
      await r.done()
    })
  })

  it("a refusal is logged and tells the person to open it at the Mac", async () => {
    await logged(async (file) => {
      const r = await rig({ resume: "fail" })
      r.enqueue("i1")
      const out = await r.control.op("resume", { root: "root" })
      assert.match(out.text!, /Open it at the Mac/)
      assert.match((await resumeLine(file))!, /"outcome":"refused"/)
      await r.done()
    })
  })

  it("says there is nothing to wake when nothing waits", async () => {
    const r = await rig()
    const out = await r.control.op("resume", { root: "root" })
    assert.equal(out.ok, false)
    assert.match(out.text!, /nothing to wake/)
    assert.equal(r.resumed.length, 0)
    await r.done()
  })
})

describe("resume: one alert for each suspension", () => {
  const alerts = (r: Awaited<ReturnType<typeof rig>>) =>
    r.sends().filter((b) => /has waited|have waited/.test(b.text))

  it("stays at one for two hours, grows with the waiting count, and repeats after six hours", async () => {
    const r = await rig()
    r.enqueue("i1")
    r.clock.t += STUCK_MS + 1
    await r.control.scan()
    await r.tg.waitFor(() => alerts(r)[0])
    r.clock.t += 2 * 3_600_000
    await r.control.scan()
    await sleep(80)
    assert.equal(alerts(r).length, 1, "the same suspension")
    r.enqueue("i2")
    await r.control.scan()
    await r.tg.waitFor(() => alerts(r)[1])
    assert.match(alerts(r)[1].text, /2 messages/)
    const gone = await r.tg.waitFor(() => r.tg.of("editMessageReplyMarkup")[0])
    assert.deepEqual(gone.body.reply_markup, { inline_keyboard: [] })
    r.clock.t += 4 * 3_600_000
    await r.control.scan()
    await sleep(80)
    assert.equal(alerts(r).length, 2, "not yet six hours since the last")
    r.clock.t += 2 * 3_600_000
    await r.control.scan()
    await r.tg.waitFor(() => alerts(r)[2])
    await r.done()
  })

  it("an alert whose session woke at the Mac is edited to say so", async () => {
    const r = await rig()
    r.enqueue("i1")
    r.clock.t += STUCK_MS + 1
    await r.control.scan()
    await r.tg.waitFor(() => alerts(r)[0])
    r.state.busy = true
    await r.control.scan()
    const e = await r.tg.waitFor(() =>
      r.tg
        .of("editMessageText")
        .find((c) => /resumed on its own/.test(c.body.text)),
    )
    assert.deepEqual(e.body.reply_markup, { inline_keyboard: [] })
    await r.control.scan()
    assert.equal(
      r.tg.of("editMessageText").filter((c) => /on its own/.test(c.body.text))
        .length,
      1,
    )
    await r.done()
  })
})

describe("timed away and the overnight plan", () => {
  const HOUR = 3_600_000

  it("route with root all sets every session at once and keeps the channels", async () => {
    const r = await rig()
    r.router.set("other", false, "telegram")
    const out = await r.control.op("route", { root: "all", mode: "auto" })
    assert.equal(out.ok, true)
    assert.match(out.text!, /2 sessions: auto/)
    assert.equal(r.router.mode("root"), "auto")
    assert.equal(r.router.mode("other"), "auto")
    assert.equal(r.router.channel("other"), "telegram")
    assert.equal(
      (await r.control.op("route", { root: "all", mode: "maybe" })).ok,
      false,
    )
    await r.done()
  })

  it("a forced mode with no time is time-boxed to away.overrideMinutes, and the snapshot says why", async () => {
    const r = await rig()
    r.control.heartbeat("a", r.clock.t)
    const on = await r.control.op("afk", { mode: "on" })
    assert.equal(on.snapshot.afk.away, true)
    assert.equal(on.snapshot.afk.reason, "manual-away")
    assert.equal(on.snapshot.afk.until, r.clock.t + 2 * HOUR)
    assert.match(on.snapshot.afk.why, /because you said so/)
    r.clock.t += 2 * HOUR
    r.control.heartbeat("a", r.clock.t)
    const s = r.control.snapshot()
    assert.equal(s.afk.mode, "auto")
    assert.equal(s.afk.reason, "input")
    await r.done()
  })

  it("afk on <time> ends by itself, is kept, and shows the time left", async () => {
    const r = await rig()
    const on = await r.control.op("afk", { mode: "on", for: "8h" })
    assert.equal(on.snapshot.afk.away, true)
    assert.equal(on.snapshot.afk.until, r.clock.t + 8 * HOUR)
    assert.equal(r.settings.afkUntil(), r.clock.t + 8 * HOUR)
    r.clock.t += 8 * HOUR + 1
    r.control.heartbeat("a", r.clock.t)
    const s = r.control.snapshot()
    assert.equal(s.afk.away, false)
    assert.equal(s.afk.until, undefined)
    assert.equal(
      (await r.control.op("afk", { mode: "auto", for: "8h" })).ok,
      false,
      "a time goes with on or off only",
    )
    const back = await r.control.op("afk", { mode: "off", for: "1h" })
    assert.equal(back.snapshot.afk.reason, "manual-present")
    assert.equal(back.snapshot.afk.until, r.clock.t + HOUR)
    assert.equal(r.settings.afkUntil(), r.clock.t + HOUR)
    assert.equal(
      (await r.control.op("afk", { mode: "on", for: "soon" })).ok,
      false,
    )
    await r.done()
  })

  it("a plan is refused for a session the bridge has not seen, and never from nothing", async () => {
    const r = await rig()
    const out = await r.control.op("overnight", {
      action: "start",
      until: "8h",
      yes: true,
    })
    assert.equal(out.ok, false)
    await r.control.op("overnight", {
      action: "add",
      root: "root",
      tasks: ["a"],
    })
    const refused = await r.control.op("overnight", {
      action: "start",
      until: "8h",
      yes: true,
    })
    assert.equal(refused.ok, false)
    assert.match(refused.text!, /not seen this session|no channel/)
    assert.equal(r.control.night.active(), false)
    await r.done()
  })

  it("starts for a known session, turns away on, sends the task, and ends on request", async () => {
    const r = await rig()
    await r.tg.waitFor(
      () => r.control.snapshot().channels.some((c) => c.connected) || undefined,
    )
    await r.bridge.setChat("root", true)
    await r.control.op("overnight", {
      action: "add",
      root: "root",
      tasks: ["run the tests"],
      maxTurns: 3,
    })
    const started = await r.control.op("overnight", {
      action: "start",
      until: "8h",
      yes: true,
    })
    assert.equal(started.ok, true, started.text)
    const snap = r.control.snapshot()
    assert.equal(snap.afk.away, true)
    assert.equal(snap.afk.until, r.clock.t + 8 * HOUR)
    assert.equal(snap.night!.sessions[0].tasks, 1)
    await r.control.scan()
    assert.equal(r.control.night.plan!.sessions.root.tasks[0].state, "sent")
    r.control.onEvent({
      type: "session.execution.succeeded",
      data: { sessionID: "root" },
    })
    assert.equal(r.control.night.plan!.sessions.root.turns, 1)
    assert.equal((await r.control.op("overnight", { action: "end" })).ok, true)
    assert.equal(r.control.snapshot().night!.ended, "tui")
    await r.control.scan()
    assert.match(
      (
        await r.tg.waitFor(() =>
          r.sends().find((b) => /Night/.test(b.text ?? b.caption ?? "")),
        )
      ).text,
      /Night \(tui\)/,
    )
    await r.done()
  })

  it("tells what happened once the operator is back from a long away", async () => {
    const r = await rig()
    await r.control.op("afk", { mode: "on" })
    r.control.scan()
    r.clock.t += 2 * HOUR
    await r.control.op("afk", { mode: "off" })
    const s = r.control.snapshot()
    assert.match(s.back!.text, /Away 2h/)
    assert.match(s.back!.text, /0 pushes sent/)
    await r.done()
  })
})

describe("version", () => {
  it("is clean when the disk, the server and the windows run the same version", async () => {
    const r = await rig({ version: "0.23.0" })
    r.control.heartbeat("a", r.clock.t, "0.23.0")
    const rep = await r.control.versionReport()
    assert.equal(rep.running, "0.23.0")
    assert.equal(rep.installed, "0.23.0")
    assert.equal(rep.describe, "v9.9.9-0-gdeadbee")
    assert.equal(rep.ownerId, "abc12345")
    assert.equal(rep.pid, 1)
    assert.deepEqual(rep.tuis, ["0.23.0"])
    assert.equal(rep.core.api, "v1")
    assert.deepEqual(rep.warnings, [])
    assert.match(await r.control.versionText(), /All versions match\./)
    await r.done()
  })

  it("says what is still pending, as counts, only when something is", async () => {
    const r = await rig()
    const none = {
      open: 0,
      questions: 0,
      approvals: 0,
      permissions: 0,
      unverified: 0,
    }
    assert.deepEqual(r.control.snapshot().drain, none)
    assert.deepEqual((await r.control.versionReport()).drain, none)
    assert.doesNotMatch(await r.control.versionText(), /Open:/)

    const entry = (
      id: string,
      kind: "question" | "permission",
      state = "pending",
    ) =>
      ({
        id,
        kind,
        requestID: "r_" + id,
        sessionID: "root",
        rootSessionID: "root",
        title: "secret title",
        askedAt: 1,
        state,
      }) as never
    r.store.put(entry("q1", "question"))
    r.store.put(entry("q2", "question", "answered"))
    r.store.put(entry("p1", "permission"))
    r.control.approvals = { pending: () => 1 } as never
    const open = {
      open: 3,
      questions: 1,
      approvals: 1,
      permissions: 1,
      unverified: 0,
    }
    assert.deepEqual(r.control.snapshot().drain, open)
    const text = await r.control.versionText()
    assert.match(text, /Open: 3 \(questions 1, approvals 1, permissions 1\)/)
    assert.doesNotMatch(text, /secret title|q1|p1/)
    await r.done()
  })

  it("warns to restart when the disk was upgraded and the server still runs the old version", async () => {
    const r = await rig({ version: "0.22.0", installed: "0.23.0" })
    const rep = await r.control.versionReport()
    assert.deepEqual(rep.warnings, [
      "⚠ the server runs 0.22.0 but 0.23.0 is installed: restart OpenCode",
    ])
    const text = await r.control.versionText()
    assert.match(text, /Installed: 0\.23\.0 \(git v9\.9\.9-0-gdeadbee\)/)
    assert.match(text, /Running: 0\.22\.0/)
    assert.match(text, /Up: /)
    assert.doesNotMatch(text, /pid|Config|Owner instance|127\.0\.0\.1/)
    assert.match(
      text,
      /⚠ the server runs 0\.22\.0 but 0\.23\.0 is installed: restart OpenCode/,
    )
    assert.doesNotMatch(text, /All versions match/)
    await r.done()
  })

  it("warns about a window that runs another version, and says so in the snapshot", async () => {
    const r = await rig({ version: "0.23.0" })
    r.control.heartbeat("old", r.clock.t, "0.22.0")
    r.control.heartbeat("new", r.clock.t, "0.23.0")
    const rep = await r.control.versionReport()
    assert.deepEqual(rep.warnings, [
      "⚠ a TUI runs 0.22.0 but 0.23.0 is installed: restart OpenCode",
    ])
    const s = r.control.snapshot()
    assert.deepEqual(s.versions, {
      installed: "0.23.0",
      tuis: ["0.22.0", "0.23.0"],
    })
    assert.equal(s.owner.version, "0.23.0")
    r.clock.t += PRESENCE_MS + 1
    assert.deepEqual((await r.control.versionReport()).tuis, [])
    await r.done()
  })

  it("answers the trace op with lines, and the snapshot carries the counters", async () => {
    const r = await rig()
    const out = await r.control.op("trace", { n: 3 })
    assert.equal(out.ok, true)
    assert.ok(Array.isArray((out.data as { lines: string[] }).lines))
    assert.match(r.control.snapshot([]).trace![0], /^Telegram in: \d+ received/)
    await r.done()
  })

  it("answers the version op with the report, and /version in a chat with the text", async () => {
    const r = await rig({ version: "0.22.0", installed: "0.23.0" })
    const out = await r.control.op("version")
    assert.equal(out.ok, true)
    assert.equal((out.data as { running: string }).running, "0.22.0")
    r.tg.message(CHAT, "/version")
    const sent = await r.tg.waitFor(() =>
      r.sends().find((b) => /Running: /.test(b.text)),
    )
    assert.match(sent.text, /restart OpenCode/)
    await r.done()
  })
})

describe("the interrupt op", () => {
  it("interrupts a working session without asking, and refuses an idle one", async () => {
    const r = await rig({ busy: true })
    const out = await r.control.op("interrupt", { session: "root" })
    assert.equal(out.ok, true)
    assert.match(out.text ?? "", /Interrupted/)
    assert.deepEqual(r.interrupted, ["root"])
    r.state.busy = false
    const idle = await r.control.op("interrupt", { session: "root" })
    assert.equal(idle.ok, false)
    assert.match(idle.text ?? "", /nothing to interrupt/)
    assert.deepEqual(r.interrupted, ["root"])
    await r.done()
  })
})

describe("presence by source through the control", () => {
  it("a TUI that is attached with no input is not input; a time of 0 is none", async () => {
    const r = await rig()
    const start = r.router.lastInputAt()
    r.clock.t += 30 * MIN_MS
    r.control.heartbeat("tui1")
    r.control.heartbeat("tui1", undefined)
    r.control.heartbeat("tui1", 0)
    assert.equal(r.router.lastInputAt(), start)
    r.control.heartbeat("tui1", r.clock.t - 1000)
    assert.equal(r.router.lastInputAt(), r.clock.t - 1000)
    assert.equal(r.router.state().source, "tui")
    await r.done()
  })

  it("the app is the phone: away, with the source in afk.why; rpc changes nothing", async () => {
    const r = await rig()
    r.control.heartbeat("tui1", r.clock.t)
    r.control.activity("rpc")
    assert.equal(r.router.state().away, false)
    r.control.activity("app")
    const out = await r.control.op("afk", { mode: "auto" })
    assert.equal(out.snapshot.afk.away, true)
    assert.match(out.snapshot.afk.why, /^away: phone active/)
    await r.done()
  })
})

const MIN_MS = 60_000
