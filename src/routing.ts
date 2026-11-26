/** Decides which sessions are mirrored, and optionally through which channel. */
import { execFile } from "node:child_process"

import type { Rule } from "./config.ts"
import { log } from "./logger.ts"
import { isQuiet } from "./quiet.ts"

export type SessionFacts = {
  id: string
  agent?: string
  directory?: string
  /** Chat is on for the session: it routes when away whatever the rules say. */
  chat?: boolean
}

export type Classify = (argv: string[], s: SessionFacts) => Promise<boolean>

/** Glob over `/`-separated paths: `**` any depth, `*` one segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*" && glob[i + 1] === "*") {
      i++
      if (glob[i + 1] === "/") {
        i++
        re += "(?:.*/)?"
      } else re += ".*"
    } else if (c === "*") re += "[^/]*"
    else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`)
}

/** Runs a classifier: exit 0 means the session routes. Async, never through a shell. */
export const runClassifier: Classify = ([cmd, ...args], s) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: 5000,
        env: {
          ...process.env,
          OOB_BRIDGE_SESSION: s.id,
          OOB_BRIDGE_AGENT: s.agent ?? "",
          OOB_BRIDGE_DIRECTORY: s.directory ?? "",
          // Pre-rename names, for classifiers written against 0.x.
          NTFY_BRIDGE_SESSION: s.id,
          NTFY_BRIDGE_AGENT: s.agent ?? "",
          NTFY_BRIDGE_DIRECTORY: s.directory ?? "",
        },
      },
      (err) => {
        if (err && typeof err.code !== "number")
          log("classifier_error", { message: err.message })
        resolve(!err)
      },
    )
  })

const auto = (routes: boolean, reason: string) => ({
  routes,
  mode: "auto" as const,
  reason,
})

/** A window of the day in which the person counts as away or as present, whatever the input. */
export type Window = {
  from: number
  to: number
  timezone?: string
  as: "away" | "present"
}

/**
 * The rules that decide whether the person is away. Each key is optional here: the
 * config parser fills the defaults, and a Router built without them gets the same ones.
 */
export type AwayRules = {
  /** No input in any TUI for this long: away. */
  minutes: number
  /** A message from the paired chat means away for this long; each later one extends it. 0: off. */
  phoneMinutes?: number
  /** Input in a TUI turns away off only after this many seconds of continuous input, so a glance does not. */
  graceSeconds?: number
  /** How long `/afk` and `/back` last when no time is given. */
  overrideMinutes?: number
  /** Away while the screen is locked (the server asks the OS). */
  lock?: boolean
  /** Away after the machine slept, until the next input. */
  sleep?: boolean
  /** Windows that force away or present. The first that holds wins. */
  schedule?: Window[]
}

export const AWAY_DEFAULTS = {
  phoneMinutes: 30,
  graceSeconds: 60,
  overrideMinutes: 120,
  lock: false,
  sleep: false,
  schedule: [] as Window[],
}

export type Reason =
  | "manual-away"
  | "manual-present"
  | "locked"
  | "slept"
  | "phone"
  | "schedule-away"
  | "schedule-present"
  | "idle"
  | "no-tui"
  | "input"

/**
 * Where an input came from. Only `tui` is the person at the Mac; `telegram` and `app` are the person
 * on the phone; `agent` and `rpc` are neither and change nothing.
 */
export type Source = "tui" | "telegram" | "app" | "agent" | "rpc"

/**
 * Whether the person is away, which rule decided it, and when that rule stops holding (epoch ms).
 * `source` and `at` say whose input decided `input` and `phone`; `start` is the grace after the bridge starts.
 */
export type Presence = {
  away: boolean
  reason: Reason
  until?: number
  source?: Source | "start"
  at?: number
}

const mins = (ms: number) => Math.max(1, Math.ceil(ms / 60_000))

/** `30s ago`, `2m ago`, `3h ago`. */
const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  return s < 3600
    ? `${Math.floor(s / 60)}m ago`
    : `${Math.floor(s / 3600)}h ago`
}

/** One line: the state and why. */
export function explain(p: Presence, now: number, idleMinutes: number): string {
  const left =
    p.until === undefined ? "" : `, ends in ${mins(p.until - now)} min`
  switch (p.reason) {
    case "manual-away":
      return `away because you said so (/afk)${left}`
    case "manual-present":
      return `here because you said so (/back)${left}`
    case "locked":
      return "away: the screen is locked"
    case "slept":
      return "away: the machine slept"
    case "phone":
      return `away: phone active${p.at === undefined ? "" : " " + ago(now - p.at)}${left}`
    case "schedule-away":
      return "away: inside an away window of the schedule"
    case "schedule-present":
      return "here: inside a present window of the schedule"
    case "idle":
      return `away: no input for ${idleMinutes} min`
    case "no-tui":
      return "away: no OpenCode window is open"
    case "input":
      return p.source === "start"
        ? `here: bridge started ${ago(now - (p.at ?? now))}`
        : `here: TUI input ${ago(now - (p.at ?? now))}`
  }
}

export class Router {
  private lastInput: number
  /** Start of the run of input that `lastInput` ends: a gap longer than the grace starts a new one. */
  private runStart: number
  /** What `lastInput` is: input in a TUI, or the grace after the bridge started. */
  private inputSource: "tui" | "start" = "start"
  /** When the paired chat last sent something, or the mini-app was used, and which of the two. */
  private phoneAt = 0
  private phoneSource: "telegram" | "app" = "telegram"
  /** The last input that is neither the Mac nor the phone: kept to be shown, it changes nothing. */
  private ignored: { source: "agent" | "rpc"; at: number } | undefined
  private sleptAt = 0
  private afk: "auto" | "on" | "off" = "auto"
  /** When a forced "on" or "off" ends and the mode returns to auto. */
  private afkUntil: number | undefined
  private present: () => boolean = () => true
  private locked: () => boolean = () => false
  private readonly manual = new Map<
    string,
    { on?: boolean; channel?: string; awayMinutes?: number }
  >()
  private readonly classified = new Map<string, Promise<boolean>>()

  private readonly cfg: { away: AwayRules; rules: Rule[] }
  private readonly rules: Required<AwayRules>
  private readonly classify: Classify
  private readonly now: () => number

  constructor(
    cfg: { away: AwayRules; rules: Rule[] },
    classify: Classify = runClassifier,
    now: () => number = Date.now,
  ) {
    this.cfg = cfg
    this.rules = { ...AWAY_DEFAULTS, ...cfg.away }
    this.classify = classify
    this.now = now
    // Starting the TUI counts as input: nothing routes on away until the idle time passes.
    this.lastInput = this.runStart = now()
  }

  /** Records operator input in a TUI; `at` is when it happened, if a TUI reports it later. */
  touch(at?: number): void {
    const t = at ?? this.now()
    if (t - this.lastInput > this.rules.graceSeconds * 1000) this.runStart = t
    if (t >= this.lastInput) this.inputSource = "tui"
    this.lastInput = Math.max(this.lastInput, t)
  }

  /** A message or tap from the paired chat, or the mini-app: away for `phoneMinutes`, until a TUI has had input for the grace. */
  phone(at?: number, source: "telegram" | "app" = "telegram"): void {
    const t = at ?? this.now()
    if (t >= this.phoneAt) this.phoneSource = source
    this.phoneAt = Math.max(this.phoneAt, t)
  }

  /** One input, by where it came from: only a TUI is the person at the Mac. */
  input(source: Source, at?: number): void {
    if (source === "tui") this.touch(at)
    else if (source === "telegram" || source === "app") this.phone(at, source)
    else this.ignored = { source, at: at ?? this.now() }
  }

  /** Whether any TUI is attached. */
  attached(): boolean {
    return this.present()
  }

  /** The latest input that changed nothing (an agent's or an RPC call's), if any. */
  lastIgnored(): { source: "agent" | "rpc"; at: number } | undefined {
    return this.ignored
  }

  /** The machine slept (told by whoever notices a long gap): away until the next input, if `sleep` is on. */
  slept(at?: number): void {
    this.sleptAt = Math.max(this.sleptAt, at ?? this.now())
  }

  /** When the operator last gave input, in epoch ms. */
  lastInputAt(): number {
    return this.lastInput
  }

  /**
   * `on` and `off` force away and present, for `until` (epoch ms; the default time-box when omitted)
   * and then the rules decide again; `auto` is the rules.
   */
  setAfk(mode: "auto" | "on" | "off", until?: number): void {
    this.afk = mode
    this.afkUntil =
      mode === "auto"
        ? undefined
        : (until ?? this.now() + this.rules.overrideMinutes * 60_000)
  }

  /** How long `/afk` and `/back` last when no time is given, in ms. */
  overrideMs(): number {
    return this.rules.overrideMinutes * 60_000
  }

  /** The end of a forced `on` or `off`, while it lasts. */
  afkEnds(): number | undefined {
    return this.afk !== "auto" && this.afkUntil && this.now() < this.afkUntil
      ? this.afkUntil
      : undefined
  }

  afkMode(): "auto" | "on" | "off" {
    return this.afk === "auto" || this.afkEnds() ? this.afk : "auto"
  }

  /** Whether any TUI is attached: with none, the idle rule counts as away. */
  setPresence(fn: () => boolean): void {
    this.present = fn
  }

  /** Whether the screen is locked, when `away.lock` is on. */
  setLocked(fn: () => boolean): void {
    this.locked = fn
  }

  /** The state, the rule that decided it and when it stops holding. In order: a forced mode, the signals, the phone, the schedule, then input. */
  state(): Presence {
    const now = this.now()
    const r = this.rules
    if (this.afk !== "auto") {
      if (this.afkUntil && now < this.afkUntil)
        return {
          away: this.afk === "on",
          reason: this.afk === "on" ? "manual-away" : "manual-present",
          until: this.afkUntil,
        }
      this.setAfk("auto")
    }
    if (r.lock && this.locked()) return { away: true, reason: "locked" }
    if (r.sleep && this.sleptAt > this.lastInput)
      return { away: true, reason: "slept" }
    const phoneUntil = this.phoneAt + r.phoneMinutes * 60_000
    if (r.phoneMinutes > 0 && this.phoneAt > 0 && now < phoneUntil) {
      const stayed =
        this.lastInput > this.phoneAt &&
        this.lastInput - Math.max(this.runStart, this.phoneAt) >=
          r.graceSeconds * 1000
      if (!stayed)
        return {
          away: true,
          reason: "phone",
          until: phoneUntil,
          source: this.phoneSource,
          at: this.phoneAt,
        }
    }
    const w = r.schedule.find((x) => isQuiet({ ...x, breakthrough: [] }, now))
    if (w)
      return {
        away: w.as === "away",
        reason: w.as === "away" ? "schedule-away" : "schedule-present",
      }
    if (!this.present()) return { away: true, reason: "no-tui" }
    return now - this.lastInput >= this.cfg.away.minutes * 60_000
      ? { away: true, reason: "idle" }
      : {
          away: false,
          reason: "input",
          source: this.inputSource,
          at: this.lastInput,
        }
  }

  /** The state in words, for the status and the chat line. */
  why(): string {
    return explain(this.state(), this.now(), this.cfg.away.minutes)
  }

  away(): boolean {
    return this.state().away
  }

  /**
   * `true` routes a top-level session when away whatever the rules say, `false`
   * never routes it, `undefined` is auto. `channel` ("all" or a channel id)
   * overrides the default one. `awayMinutes` can only lengthen the idle time: a
   * session never counts as away sooner than the instance does. No mode sends while present.
   */
  set(
    rootSessionID: string,
    on: boolean | undefined,
    channel?: string,
    awayMinutes?: number,
  ): void {
    if (on === undefined && channel === undefined && awayMinutes === undefined)
      this.manual.delete(rootSessionID)
    else this.manual.set(rootSessionID, { on, channel, awayMinutes })
  }

  mode(rootSessionID: string): "on" | "off" | "auto" {
    const on = this.manual.get(rootSessionID)?.on
    return on === undefined ? "auto" : on ? "on" : "off"
  }

  /** The session's own idle time, if it has one. */
  awayMinutesOf(rootSessionID: string): number | undefined {
    return this.manual.get(rootSessionID)?.awayMinutes
  }

  /** Sessions with a mode, channel or idle time of their own. */
  chosen(): string[] {
    return [...this.manual.keys()]
  }

  /** The channel a session chose, if any. */
  channel(rootSessionID: string): string | undefined {
    return this.manual.get(rootSessionID)?.channel
  }

  async routes(root: SessionFacts): Promise<boolean> {
    return (await this.decide(root)).routes
  }

  /** The routing decision and why: for telemetry and the menu. */
  async decide(
    root: SessionFacts,
  ): Promise<{ routes: boolean; mode: "on" | "off" | "auto"; reason: string }> {
    const m = this.manual.get(root.id)
    const on = m?.on
    if (on === false)
      return { routes: false, mode: "off", reason: "manual-off" }
    const st = this.state()
    let away = st.away
    // A session's own idle time only lengthens the instance's.
    if (
      away &&
      st.reason === "idle" &&
      m?.awayMinutes !== undefined &&
      this.now() - this.lastInput < m.awayMinutes * 60_000
    )
      away = false
    if (!away)
      return {
        routes: false,
        mode: on ? "on" : "auto",
        reason: "present",
      }
    if (on) return { routes: true, mode: "on", reason: "manual-on" }
    if (root.chat) return auto(true, "chat")
    if (this.cfg.rules.length === 0) return auto(true, "away-no-rules")
    for (const rule of this.cfg.rules)
      if (await this.matches(rule, root)) return auto(true, "rule-match")
    return auto(false, "no-rule-match")
  }

  private async matches(rule: Rule, s: SessionFacts): Promise<boolean> {
    if (rule.agent && !rule.agent.test(s.agent ?? "")) return false
    if (rule.directory && !globToRegExp(rule.directory).test(s.directory ?? ""))
      return false
    if (rule.command) {
      const key = `${s.id}\0${rule.command.join("\0")}`
      let p = this.classified.get(key)
      if (!p) this.classified.set(key, (p = this.classify(rule.command, s)))
      if (!(await p)) return false
    }
    return true
  }
}
