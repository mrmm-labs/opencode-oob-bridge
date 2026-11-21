/**
 * The overnight plan: sessions the bridge keeps moving while the operator is away, within
 * limits set at the Mac. A plan is a file written before every automated action, so a
 * restart neither forgets it nor repeats a task. The bridge never answers a permission.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { log } from "./logger.ts"
import { isObject } from "./util.ts"

export const RESUME_GAP_MS = 5 * 60_000
export const PAUSE_MS = 10 * 60_000
/** A prompt that arrives this soon after the bridge sent one is the bridge's own. */
const OWN_SEND_MS = 5000
export const WAKE_KINDS = [
  "question",
  "permission",
  "failed",
  "resume",
  "stopped",
  "unhealthy",
] as const
export type WakeKind = (typeof WAKE_KINDS)[number]

export type Brief = {
  tasks: string[]
  scope: string
  maxTurns: number
  maxFailures: number
  question: "park" | "default"
  /** Minutes before a question is answered by policy. */
  answerAfter: number
}

export const BRIEF_DEFAULTS: Brief = {
  tasks: [],
  scope: "",
  maxTurns: 20,
  maxFailures: 2,
  question: "park",
  answerAfter: 30,
}

type Task = { text: string; state: "pending" | "sent" | "done" }

export type SessionPlan = {
  id: string
  title?: string
  brief: Brief
  tasks: Task[]
  scopeSent: boolean
  turns: number
  failures: number
  failuresInRow: number
  resumes: number
  lastResumeAt?: number
  noEffectUntil?: number
  answers: number
  parked: string[]
  /** Permissions already reported; they are never answered. */
  reported: string[]
  stopped?: string
  pausedUntil?: number
  lastSendAt?: number
  /** Lines for the morning: what needs the operator. */
  needs: string[]
}

export type Plan = {
  startedAt: number
  until: number
  wake: WakeKind[]
  maxResumes: number
  sessions: Record<string, SessionPlan>
  ended?: { at: number; by: string }
  /** The night section has been put in a digest. */
  reported?: boolean
  unhealthy?: boolean
}

export type Check = {
  scope: "plan" | string
  item: string
  level: "ok" | "warning" | "blocker"
  text: string
}

export type NightView = {
  until: number
  ended?: string
  sessions: Array<{
    id: string
    title?: string
    turns: number
    tasksDone: number
    tasks: number
    stopped?: string
    needs: number
  }>
}

/** What the plan needs from the rest of the bridge. */
export type Deps = {
  now: () => number
  busy(id: string): boolean
  waiting(id: string): number
  denied(id: string): boolean
  resume(id: string): Promise<{ ok: boolean; text?: string }>
  send(id: string, text: string): Promise<void>
  /** The scope, as a message the session reads. */
  scope(id: string, text: string, busy: boolean): Promise<void>
  stop(id: string): Promise<boolean>
  /** Open questions of a session; `recommended` is a 1-based option. */
  questions(id: string): Array<{
    id: string
    title: string
    askedAt: number
    single: boolean
    recommended?: number
  }>
  permissions(id: string): Array<{ id: string; title: string }>
  answer(promptID: string, choice: number): Promise<boolean>
  /** One silent message in the session's topic; with sound when `loud`. */
  note(id: string, kind: WakeKind, text: string, loud: boolean): Promise<void>
  title(id: string): string | undefined
  /** For the preflight. */
  facts(id: string): {
    known: boolean
    channelUp: boolean
    inbox: boolean
  }
  plan(): { channelUp: boolean; deadman: "ok" | "unconfigured" | "unacked" }
}

/** What the bridge needs to know of the plan. */
export type NightSource = {
  /** Until when automation may act; 0 when no plan runs. */
  until(): number
  /** A plan has ended and its night has not been in a digest yet. */
  pending(): boolean
  report(): string[]
  done(): Promise<void>
  status(): string
  end(by: string): Promise<boolean>
}

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

export class OvernightStore {
  private chain: Promise<void> = Promise.resolve()
  private readonly file?: string
  data: Plan | undefined

  constructor(file?: string) {
    this.file = file
  }

  async load(): Promise<void> {
    if (!this.file) return
    try {
      const v = JSON.parse(await readFile(this.file, "utf8")) as Plan
      if (isObject(v) && isObject(v.sessions)) this.data = v
    } catch {}
  }

  /** Resolves when the plan is on disk. */
  save(): Promise<void> {
    if (!this.file) return Promise.resolve()
    const file = this.file
    const body = JSON.stringify(this.data ?? null, null, 2) + "\n"
    this.chain = this.chain
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file + ".tmp", body)
        await rename(file + ".tmp", file)
      })
      .catch((err) => log("overnight_write_error", { message: err.message }))
    return this.chain
  }
}

export function parseDuration(s: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/i.exec(s.trim())
  if (!m || (!m[1] && !m[2])) return undefined
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000
}

/** `8h` or `07:00` (the next one, local time) as an instant. */
export function parseUntil(s: string, now: number): number | undefined {
  const d = parseDuration(s)
  if (d) return now + d
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim())
  if (!m) return undefined
  const t = new Date(now)
  t.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (t.getTime() <= now) t.setDate(t.getDate() + 1)
  return t.getTime()
}

/** Words of a line, with "double" or 'single' quotes keeping spaces: task="run the tests". */
export function words(s: string): string[] {
  return (s.match(/(?:[^\s"'=]+=)?(?:"[^"]*"|'[^']*'|[^\s"']+)/g) ?? []).map(
    (w) =>
      w
        .replace(/^([^\s"'=]+=)["'](.*)["']$/, "$1$2")
        .replace(/^["'](.*)["']$/, "$1"),
  )
}

/** `<session> task=... scope=... turns=20 failures=2 question=default after=30`. */
export function parseBriefWords(
  line: string,
):
  | { session: string; brief: Partial<Brief> & { tasks: string[] } }
  | { error: string } {
  const ws = words(line)
  const session = ws.find((w) => !w.includes("="))
  if (!session) return { error: "Name the session first." }
  const out: Partial<Brief> & { tasks: string[] } = { tasks: [] }
  for (const w of ws) {
    const i = w.indexOf("=")
    if (i < 0) continue
    const k = w.slice(0, i)
    const v = w.slice(i + 1)
    const n = /^\d+$/.test(v) ? Number(v) : NaN
    if (k === "task" && v) out.tasks.push(v)
    else if (k === "scope") out.scope = v
    else if (k === "turns" && n >= 1) out.maxTurns = n
    else if (k === "failures" && n >= 1) out.maxFailures = n
    else if (k === "after" && n >= 1) out.answerAfter = n
    else if (k === "question" && (v === "park" || v === "default"))
      out.question = v
    else
      return {
        error: `Cannot read "${w}". Use task=, scope=, turns=, failures=, question=park|default, after=.`,
      }
  }
  return { session, brief: out }
}

export function brief(partial: Partial<Brief> = {}): Brief {
  return { ...BRIEF_DEFAULTS, ...partial, tasks: partial.tasks ?? [] }
}

export class Overnight {
  private readonly d: Deps
  private readonly store: OvernightStore
  private readonly cfg: {
    wake: WakeKind[]
    maxResumes: number
  }
  /** Briefs being prepared at the Mac; a plan is made from them. */
  private readonly draft = new Map<string, Brief>()

  constructor(
    d: Deps,
    store: OvernightStore,
    cfg: { wake: WakeKind[]; maxResumes: number },
  ) {
    this.d = d
    this.store = store
    this.cfg = cfg
  }

  get plan(): Plan | undefined {
    return this.store.data ?? undefined
  }

  /** A plan that has not ended and whose time has not passed. */
  active(): boolean {
    const p = this.plan
    return !!p && !p.ended && this.d.now() < p.until
  }

  /** Until when automation may act, or 0. */
  until(): number {
    return this.active() ? this.plan!.until : 0
  }

  stage(id: string, b: Brief): void {
    this.draft.set(id, b)
  }

  unstage(id?: string): void {
    if (id) this.draft.delete(id)
    else this.draft.clear()
  }

  staged(): Array<[string, Brief]> {
    return [...this.draft]
  }

  /** The checklist for the staged sessions and the plan. */
  preflight(): Check[] {
    const out: Check[] = []
    const plan = this.d.plan()
    out.push({
      scope: "plan",
      item: "channel",
      level: plan.channelUp ? "ok" : "blocker",
      text: plan.channelUp
        ? "a channel is connected"
        : "no channel is connected",
    })
    out.push({
      scope: "plan",
      item: "deadman",
      level: plan.deadman === "ok" ? "ok" : "warning",
      text:
        plan.deadman === "ok"
          ? "the dead-man heartbeat is acknowledged"
          : plan.deadman === "unconfigured"
            ? "the dead-man heartbeat is not configured: nothing tells you if this Mac sleeps"
            : "the dead-man heartbeat was not acknowledged",
    })
    out.push({
      scope: "plan",
      item: "digest",
      level: "ok",
      text: "quiet hours and the digest are on for the night",
    })
    if (this.draft.size === 0)
      out.push({
        scope: "plan",
        item: "sessions",
        level: "blocker",
        text: "no session has a brief",
      })
    for (const id of this.draft.keys()) {
      const f = this.d.facts(id)
      const add = (item: string, level: Check["level"], text: string) =>
        out.push({ scope: id, item, level, text })
      add(
        "state",
        f.known ? "ok" : "blocker",
        f.known
          ? "state known, topic present"
          : "the bridge has not seen this session",
      )
      add(
        "deny",
        this.d.denied(id) ? "blocker" : "ok",
        this.d.denied(id) ? "blocked by chat.deny" : "not denied by chat.deny",
      )
      add(
        "channel",
        f.channelUp ? "ok" : "blocker",
        f.channelUp ? "its channel is healthy" : "its channel is not connected",
      )
      add(
        "inbox",
        f.inbox ? "ok" : "warning",
        f.inbox
          ? "inbox readable"
          : "the inbox cannot be read here: a suspended session may not be noticed",
      )
    }
    return out
  }

  /** Starts a plan from the staged briefs. A blocker refuses it; warnings need `yes`. */
  async start(
    until: number,
    yes: boolean,
  ): Promise<{ ok: boolean; text: string; checks: Check[] }> {
    const checks = this.preflight()
    const blockers = checks.filter((c) => c.level === "blocker")
    if (blockers.length)
      return {
        ok: false,
        text: "Refused: " + blockers.map((c) => c.text).join("; "),
        checks,
      }
    const warnings = checks.filter((c) => c.level === "warning")
    if (warnings.length && !yes)
      return {
        ok: false,
        text:
          "Warnings: " +
          warnings.map((c) => c.text).join("; ") +
          ". Add yes to start anyway.",
        checks,
      }
    if (until <= this.d.now())
      return { ok: false, text: "The end time has passed.", checks }
    if (this.active())
      return { ok: false, text: "A plan is already running.", checks }
    const sessions: Record<string, SessionPlan> = {}
    for (const [id, b] of this.draft)
      sessions[id] = {
        id,
        title: this.d.title(id),
        brief: b,
        tasks: b.tasks.map((text) => ({ text, state: "pending" })),
        scopeSent: false,
        turns: 0,
        failures: 0,
        failuresInRow: 0,
        resumes: 0,
        answers: 0,
        parked: [],
        reported: [],
        needs: [],
      }
    this.store.data = {
      startedAt: this.d.now(),
      until,
      wake: this.cfg.wake,
      maxResumes: this.cfg.maxResumes,
      sessions,
    }
    this.draft.clear()
    await this.store.save()
    log("overnight_action", {
      action: "start",
      reason: "operator",
      sessions: Object.keys(sessions).length,
    })
    return {
      ok: true,
      text:
        "Overnight plan started for " +
        Object.keys(sessions).length +
        " session(s). Scope is an instruction only: permissions still wait for you.",
      checks,
    }
  }

  /** Ends the plan; automation stops at once. */
  async end(by: string): Promise<boolean> {
    const p = this.plan
    if (!p || p.ended) return false
    p.ended = { at: this.d.now(), by }
    await this.store.save()
    log("overnight_action", { action: "end", reason: by })
    return true
  }

  private async commit(): Promise<void> {
    await this.store.save()
  }

  private act(s: SessionPlan, action: string, reason: string) {
    log("overnight_action", { session: s.id, action, reason })
  }

  private async raise(s: SessionPlan, kind: WakeKind, text: string) {
    if (s.needs.includes(text)) return
    s.needs.push(text)
    await this.commit()
    await this.d.note(s.id, kind, text, this.cfg.wake.includes(kind))
  }

  /** A turn of a session ended. */
  turnEnded(id: string, ok: boolean): void {
    const s = this.plan?.sessions[id]
    if (!s || !this.active()) return
    s.turns++
    if (ok) s.failuresInRow = 0
    else {
      s.failures++
      s.failuresInRow++
    }
    const t = s.tasks.find((x) => x.state === "sent")
    if (t) t.state = "done"
    void this.commit()
  }

  /** A prompt reached the session: the operator's, unless the bridge just sent one. */
  prompted(id: string): void {
    const s = this.plan?.sessions[id]
    if (!s || !this.active()) return
    if (s.lastSendAt && this.d.now() - s.lastSendAt < OWN_SEND_MS) return
    s.pausedUntil = this.d.now() + PAUSE_MS
    this.act(s, "pause", "the operator typed a prompt")
    void this.commit()
  }

  /** What a resume reported. */
  resumed(id: string, outcome: string): void {
    const s = this.plan?.sessions[id]
    if (!s || !this.active() || outcome !== "no_effect") return
    s.noEffectUntil = this.d.now() + RESUME_GAP_MS
    void this.raise(
      s,
      "resume",
      "a resume had no effect: open the session at the Mac",
    )
  }

  /** One pass over the plan, from the scan loop. */
  async tick(): Promise<void> {
    const p = this.plan
    if (!p || p.ended) return
    const now = this.d.now()
    if (now >= p.until) {
      p.ended = { at: now, by: "time" }
      await this.commit()
      log("overnight_action", { action: "end", reason: "time" })
      return
    }
    for (const s of Object.values(p.sessions)) {
      if (this.plan?.ended) return
      if (!p.unhealthy && !this.d.plan().channelUp) {
        p.unhealthy = true
        await this.raise(
          s,
          "unhealthy",
          "a channel is down: pushes may not reach you",
        )
      }
      try {
        await this.session(p, s)
      } catch (err) {
        log("overnight_error", {
          session: s.id,
          message: (err as Error).message,
        })
      }
    }
  }

  private async stop(s: SessionPlan, reason: string) {
    s.stopped = reason
    await this.commit()
    this.act(s, "stop", reason)
    if (this.d.busy(s.id)) await this.d.stop(s.id)
    await this.raise(
      s,
      reason === "failures" ? "failed" : "stopped",
      "stopped: " + reason,
    )
  }

  private async session(p: Plan, s: SessionPlan) {
    if (s.stopped || this.d.denied(s.id)) return
    const now = this.d.now()
    const busy = this.d.busy(s.id)
    if (s.turns >= s.brief.maxTurns) return this.stop(s, "turns")
    if (s.failuresInRow >= s.brief.maxFailures) return this.stop(s, "failures")

    for (const perm of this.d.permissions(s.id))
      if (!s.reported.includes(perm.id)) {
        s.reported.push(perm.id)
        await this.raise(s, "permission", "permission waiting: " + perm.title)
      }
    await this.questions(s, now)

    if ((s.pausedUntil ?? 0) > now) return
    if (!s.scopeSent && s.brief.scope) {
      s.scopeSent = true
      await this.commit()
      this.act(s, "scope", "delivered as an instruction")
      await this.d.scope(s.id, s.brief.scope, busy)
      return
    }
    if (!busy && this.d.waiting(s.id) > 0) {
      if ((s.noEffectUntil ?? 0) > now) return
      if (s.lastResumeAt && now - s.lastResumeAt < RESUME_GAP_MS) return
      if (s.resumes >= p.maxResumes)
        return this.raise(
          s,
          "resume",
          "resume limit reached: open the session at the Mac",
        )
      s.resumes++
      s.lastResumeAt = now
      await this.commit()
      this.act(s, "resume", "messages waiting")
      const out = await this.d.resume(s.id)
      if (!out.ok)
        await this.raise(
          s,
          "resume",
          "the host refused a resume: open the session at the Mac",
        )
      return
    }
    if (!busy && !s.tasks.some((t) => t.state === "sent")) {
      const next = s.tasks.find((t) => t.state === "pending")
      if (next) {
        next.state = "sent"
        s.lastSendAt = now
        await this.commit()
        this.act(s, "task", next.text.slice(0, 60))
        await this.d.send(s.id, next.text)
      }
    }
  }

  private async questions(s: SessionPlan, now: number) {
    if ((s.pausedUntil ?? 0) > now) return
    for (const q of this.d.questions(s.id)) {
      if (s.parked.includes(q.id)) continue
      const wait = s.brief.answerAfter * 60_000
      if (s.brief.question === "default" && now - q.askedAt < wait) continue
      if (s.brief.question === "default" && q.single && q.recommended) {
        this.act(s, "answer", "recommended option " + q.recommended)
        if (await this.d.answer(q.id, q.recommended)) {
          s.answers++
          await this.commit()
          continue
        }
      }
      s.parked.push(q.id)
      await this.raise(s, "question", "question parked: " + q.title)
    }
  }

  view(): NightView | undefined {
    const p = this.plan
    if (!p) return undefined
    return {
      until: p.until,
      ended: p.ended?.by,
      sessions: Object.values(p.sessions).map((s) => ({
        id: s.id,
        title: s.title,
        turns: s.turns,
        tasksDone: s.tasks.filter((t) => t.state === "done").length,
        tasks: s.tasks.length,
        stopped: s.stopped,
        needs: s.needs.length,
      })),
    }
  }

  /** The night section of the digest: once a plan has ended, until a digest has carried it. */
  pendingReport(): boolean {
    const p = this.plan
    return !!p && !!p.ended && !p.reported
  }

  report(): string[] {
    const p = this.plan
    if (!p) return []
    return [
      "🌙 Night" + (p.ended ? " (" + p.ended.by + ")" : ""),
      ...Object.values(p.sessions).flatMap((s) => [
        "• " +
          (s.title ?? s.id) +
          ": " +
          [
            s.turns + " turn" + (s.turns === 1 ? "" : "s"),
            s.tasks.filter((t) => t.state === "done").length +
              "/" +
              s.tasks.length +
              " tasks",
            s.resumes + " resume" + (s.resumes === 1 ? "" : "s"),
            s.answers + " answered by policy",
            s.parked.length + " parked",
            s.failures + " failed",
            s.stopped ? "stopped: " + s.stopped : "not stopped",
          ].join(", "),
        ...s.needs.map((n) => "   ⚠ " + n),
      ]),
    ]
  }

  /** The plan as the bridge sees it. */
  source(): NightSource {
    return {
      until: () => this.until(),
      pending: () => this.pendingReport(),
      report: () => this.report(),
      done: () => this.markReported(),
      status: () => this.status(),
      end: (by) => this.end(by),
    }
  }

  /** In words, for a chat and the TUI. */
  status(): string {
    const p = this.plan
    if (!p) return "Overnight: not planned"
    const head = p.ended
      ? `Overnight: ended (${p.ended.by})`
      : `Overnight: running until ${hhmm(p.until)}`
    return [
      head,
      ...Object.values(p.sessions).map(
        (s) =>
          `• ${s.title ?? s.id}: ${s.tasks.filter((t) => t.state === "done").length}/${s.tasks.length} tasks, ${s.turns} turns${s.stopped ? `, stopped: ${s.stopped}` : ""}${s.needs.length ? `, ${s.needs.length} need you` : ""}`,
      ),
    ].join("\n")
  }

  async markReported(): Promise<void> {
    if (!this.plan) return
    this.plan.reported = true
    await this.store.save()
  }
}
