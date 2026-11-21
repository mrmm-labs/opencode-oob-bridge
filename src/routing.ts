/** Decides which sessions are mirrored, and optionally through which channel. */
import { execFile } from "node:child_process"

import type { Rule } from "./config.ts"
import { log } from "./logger.ts"

export type SessionFacts = { id: string; agent?: string; directory?: string }

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

export class Router {
  private lastInput: number
  private afk: "auto" | "on" | "off" = "auto"
  /** When a forced "on" ends and the mode returns to auto. */
  private afkUntil: number | undefined
  private present: () => boolean = () => true
  private readonly manual = new Map<string, { on: boolean; channel?: string }>()
  private readonly classified = new Map<string, Promise<boolean>>()

  private readonly cfg: { away: { minutes: number }; rules: Rule[] }
  private readonly classify: Classify
  private readonly now: () => number

  constructor(
    cfg: { away: { minutes: number }; rules: Rule[] },
    classify: Classify = runClassifier,
    now: () => number = Date.now,
  ) {
    this.cfg = cfg
    this.classify = classify
    this.now = now
    // Starting the TUI counts as input: nothing routes on away until the idle time passes.
    this.lastInput = now()
  }

  /** Records operator input in a TUI; `at` is when it happened, if a TUI reports it later. */
  touch(at?: number): void {
    this.lastInput = Math.max(this.lastInput, at ?? this.now())
  }

  /** When the operator last gave input, in epoch ms. */
  lastInputAt(): number {
    return this.lastInput
  }

  /** `on` and `off` force away and present; `auto` follows the time since the last input. */
  setAfk(mode: "auto" | "on" | "off", until?: number): void {
    this.afk = mode
    this.afkUntil = mode === "on" ? until : undefined
  }

  /** The end of a timed "on", while it lasts. */
  afkEnds(): number | undefined {
    return this.afk === "on" && this.afkUntil && this.now() < this.afkUntil
      ? this.afkUntil
      : undefined
  }

  afkMode(): "auto" | "on" | "off" {
    return this.afk
  }

  /** Whether any TUI is attached: with none, auto counts as away. */
  setPresence(fn: () => boolean): void {
    this.present = fn
  }

  away(): boolean {
    if (this.afk === "on" && this.afkUntil && this.now() >= this.afkUntil)
      this.setAfk("auto")
    if (this.afk !== "auto") return this.afk === "on"
    if (!this.present()) return true
    return this.now() - this.lastInput >= this.cfg.away.minutes * 60_000
  }

  /**
   * `true` / `false` force routing for a top-level session; `undefined` returns
   * it to auto. `channel` ("all" or a channel id) overrides the default one.
   */
  set(rootSessionID: string, on: boolean | undefined, channel?: string): void {
    if (on === undefined) this.manual.delete(rootSessionID)
    else this.manual.set(rootSessionID, { on, channel })
  }

  mode(rootSessionID: string): "on" | "off" | "auto" {
    const m = this.manual.get(rootSessionID)
    return m === undefined ? "auto" : m.on ? "on" : "off"
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
    if (m !== undefined)
      return {
        routes: m.on,
        mode: m.on ? "on" : "off",
        reason: m.on ? "manual-on" : "manual-off",
      }
    if (!this.away()) return auto(false, "present")
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
