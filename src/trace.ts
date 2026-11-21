/**
 * One trace for each Telegram update and each message the bridge sends.
 *
 * A trace is a record of steps (poll, queue, route, every Telegram API call) with
 * an outcome. The last ones are kept in memory for `/oob trace` and `/trace`,
 * each is written to the log, counted, and sent as spans when telemetry is on.
 * The trace id of an update goes on to what the bridge sends back for it, so
 * the update, the session's turn and the reply are one trace. Message text is
 * never recorded here.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { randomBytes } from "node:crypto"

import { log } from "./logger.ts"
import { noTelemetry, type Telemetry } from "./otel.ts"

export const LOG_LEVELS = ["warn", "info", "debug"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]
const RANK: Record<LogLevel, number> = { warn: 0, info: 1, debug: 2 }

/** What became of an inbound update. */
export type Class = "delivered" | "refused" | "dropped"

export type Step = { step: string; at: number; ms: number; ok: boolean }

export type Rec = {
  id: string
  spanId: string
  parent?: string
  dir: "in" | "out"
  kind: string
  event: string
  startedAt: number
  update_id?: number
  message_id?: number
  thread?: number
  session?: string
  agent?: string
  state?: string
  outcome: string
  reason?: string
  ms?: number
  steps: Step[]
  done?: boolean
  extra?: Record<string, unknown>
}

const KEEP = 200
const TURNS = 50
const REASON_MAX = 80
const SEND_METHODS = new Set([
  "sendMessage",
  "editMessageText",
  "sendPhoto",
  "sendDocument",
  "sendMediaGroup",
  "sendMessageDraft",
])
const hex = () => randomBytes(16).toString("hex")

export type Stats = {
  inbound: Record<"received" | Class | "retried", number>
  outbound: Record<"sent" | "failed", number>
  queue: number
  pollOkAt?: number
  sendOkAt?: number
  lastError?: { at: number; what: string }
}

const age = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 90
    ? `${s}s ago`
    : s < 5400
      ? `${Math.round(s / 60)}m ago`
      : `${Math.round(s / 3600)}h ago`
}

export class Traces {
  private tel: Telemetry = noTelemetry()
  private level: LogLevel = "info"
  private readonly ring: Rec[] = []
  private readonly store = new AsyncLocalStorage<Rec>()
  private readonly turns = new Map<string, Rec>()
  private readonly n = new Map<string, number>()
  private queue = 0
  private last: { at: number; what: string } | undefined
  private pollOkAt: number | undefined
  private sendOkAt: number | undefined
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** Where spans and metrics go, and how much is logged. */
  attach(tel: Telemetry, level: LogLevel = "info"): void {
    this.tel = tel
    this.level = level
  }

  start(
    dir: Rec["dir"],
    kind: string,
    init: Partial<Rec> & { event: string },
  ): Rec {
    const rec: Rec = {
      id: hex(),
      spanId: randomBytes(8).toString("hex"),
      dir,
      kind,
      startedAt: this.now(),
      outcome: "started",
      steps: [],
      ...init,
    }
    this.ring.push(rec)
    if (this.ring.length > KEEP) this.ring.shift()
    return rec
  }

  run<T>(rec: Rec, fn: () => T): T {
    return this.store.run(rec, fn)
  }

  current(): Rec | undefined {
    return this.store.getStore()
  }

  step(
    step: string,
    o: { ms?: number; ok?: boolean } = {},
    rec: Rec | undefined = this.current(),
  ): void {
    if (!rec) return
    const ms = Math.max(0, Math.round(o.ms ?? 0))
    const s = {
      step,
      at: Math.max(0, this.now() - rec.startedAt - ms),
      ms,
      ok: o.ok ?? true,
    }
    rec.steps.push(s)
    this.emit("debug", "trace_step", { trace_id: rec.id, ...s })
  }

  annotate(
    patch: Partial<
      Pick<Rec, "session" | "agent" | "state" | "outcome" | "reason">
    > & { extra?: Record<string, unknown> },
    rec: Rec | undefined = this.current(),
  ): void {
    if (!rec) return
    const { extra, ...rest } = patch
    for (const [k, v] of Object.entries(rest))
      if (v !== undefined) (rec as Record<string, unknown>)[k] = v
    if (extra) rec.extra = { ...rec.extra, ...extra }
  }

  bump(group: "inbound" | "outbound", outcome: string): void {
    this.n.set(
      `${group}.${outcome}`,
      (this.n.get(`${group}.${outcome}`) ?? 0) + 1,
    )
    this.tel.count(`oob.telegram.${group}`, { outcome })
  }

  setQueue(depth: number): void {
    this.queue = depth
    this.tel.gauge("oob.telegram.queue_depth", {}, depth)
  }

  /** One Telegram API call, from the connector. */
  api(
    method: string,
    o: { ms: number; ok: boolean; code?: number | string; text?: string },
  ): void {
    const poll = method === "getUpdates"
    const at = this.now()
    if (!poll)
      this.tel.record(
        "oob.telegram.api.ms",
        { method, outcome: o.ok ? "ok" : "error" },
        o.ms,
      )
    if (o.ok) {
      if (poll) this.pollOkAt = at
      else this.sendOkAt = at
      this.tel.gauge(
        poll ? "oob.telegram.last_poll_ok" : "oob.telegram.last_send_ok",
        {},
        Math.floor(at / 1000),
      )
    } else {
      const code = String(o.code ?? "network")
      this.tel.count("oob.telegram.api.errors", { method, code })
      this.last = {
        at,
        what: `${method} ${code}${o.text ? ": " + o.text : ""}`.slice(0, 160),
      }
    }
    if (SEND_METHODS.has(method))
      this.bump("outbound", o.ok ? "sent" : "failed")
    if (!poll) this.step(`api:${method}`, { ms: o.ms, ok: o.ok })
  }

  /** Writes the outcome line of a trace; a trace that will be tried again is not finished. */
  line(rec: Rec, extra: Record<string, unknown> = {}): void {
    const bad = ["error", "failed", "dropped"].includes(rec.outcome)
    this.emit(bad ? "warn" : "info", rec.event, {
      trace_id: rec.id,
      update_id: rec.update_id,
      message_id: rec.message_id,
      thread: rec.thread,
      kind: rec.kind,
      outcome: rec.outcome,
      reason: rec.reason,
      session: rec.session,
      agent: rec.agent,
      state: rec.state,
      ...rec.extra,
      ...extra,
      ms: this.now() - rec.startedAt,
      steps:
        RANK[this.level] >= RANK.debug
          ? rec.steps.map((s) => `${s.step}:${s.ms}`).join(" ")
          : undefined,
    })
  }

  finish(
    rec: Rec,
    o: { outcome?: string; reason?: string; cls?: Class; line?: boolean } = {},
  ): void {
    if (rec.done) return
    rec.done = true
    if (o.outcome) rec.outcome = o.outcome
    if (o.reason !== undefined) rec.reason = o.reason.slice(0, REASON_MAX)
    rec.ms = this.now() - rec.startedAt
    if (rec.dir === "in" && o.cls) this.bump("inbound", o.cls)
    const failed = ["error", "failed", "dropped"].includes(rec.outcome)
    if (failed)
      this.last = {
        at: this.now(),
        what: `${rec.kind} ${rec.outcome}${rec.reason ? ": " + rec.reason : ""}`.slice(
          0,
          160,
        ),
      }
    this.span(rec, failed)
    if (o.line !== false) this.line(rec)
  }

  private span(rec: Rec, failed: boolean): void {
    const root = rec.dir === "in" ? "oob.update" : "oob.outbound"
    const base = {
      traceId: rec.id,
      attrs: {
        update_id: rec.update_id,
        message_id: rec.message_id,
        thread: rec.thread,
        "session.id": rec.session,
        agent: rec.agent,
        state: rec.state,
        kind: rec.kind,
        outcome: rec.outcome,
        "connector.type": "telegram",
      },
    }
    this.tel.emit({
      ...base,
      name: root,
      spanId: rec.spanId,
      parentSpanId: rec.parent,
      start: rec.startedAt,
      end: rec.startedAt + (rec.ms ?? 0),
      error: failed ? rec.outcome : undefined,
    })
    for (const s of rec.steps)
      this.tel.emit({
        traceId: rec.id,
        name: `oob.step.${s.step}`,
        spanId: randomBytes(8).toString("hex"),
        parentSpanId: rec.spanId,
        start: rec.startedAt + s.at,
        end: rec.startedAt + s.at + s.ms,
        attrs: { step: s.step, ok: s.ok },
        error: s.ok ? undefined : "failed",
      })
  }

  /** What the bridge sends for a session's turn joins the trace of the message that started it. */
  follow(session: string, rec: Rec | undefined): void {
    if (!rec) return
    this.turns.delete(session)
    this.turns.set(session, rec)
    while (this.turns.size > TURNS)
      this.turns.delete(this.turns.keys().next().value!)
  }

  turn(session: string): Rec | undefined {
    return this.turns.get(session)
  }

  /** Runs what the bridge sends, as one trace; `result` names its outcome. */
  async out<T>(
    kind: string,
    o: { session?: string; agent?: string },
    fn: () => Promise<T>,
    result: (v: T) => string = () => "sent",
  ): Promise<T> {
    const link = o.session ? this.turns.get(o.session) : undefined
    const rec = this.start("out", kind, {
      event: "outbound",
      id: link?.id,
      parent: link?.spanId,
      session: o.session,
      agent: o.agent ?? link?.agent,
      state: kind,
    })
    try {
      const v = await this.run(rec, fn)
      const outcome = result(v)
      this.finish(rec, { outcome })
      return v
    } catch (err) {
      this.finish(rec, { outcome: "failed", reason: (err as Error).message })
      throw err
    } finally {
      if (o.session && (kind === "finished" || kind === "failed"))
        this.turns.delete(o.session)
    }
  }

  recent(n = 5): Rec[] {
    return this.ring.slice(-Math.max(1, Math.min(n, 20))).reverse()
  }

  stats(): Stats {
    const g = (k: string) => this.n.get(k) ?? 0
    return {
      inbound: {
        received: g("inbound.received"),
        delivered: g("inbound.delivered"),
        refused: g("inbound.refused"),
        dropped: g("inbound.dropped"),
        retried: g("inbound.retried"),
      },
      outbound: { sent: g("outbound.sent"), failed: g("outbound.failed") },
      queue: this.queue,
      pollOkAt: this.pollOkAt,
      sendOkAt: this.sendOkAt,
      lastError: this.last,
    }
  }

  /** The counters and the last error, for a status view. */
  statLines(s: Stats = this.stats(), now = this.now()): string[] {
    const i = s.inbound
    return [
      `Telegram in: ${i.received} received, ${i.delivered} delivered, ${i.refused} refused, ${i.dropped} dropped, ${i.retried} retried · queue ${s.queue}`,
      `Telegram out: ${s.outbound.sent} sent, ${s.outbound.failed} failed`,
      s.lastError
        ? `Last error ${age(now - s.lastError.at)}: ${s.lastError.what}`
        : "Last error: none",
    ]
  }

  /** The last `n` traces, newest first: what came in or went out, the path and the outcome. */
  format(n = 5): string[] {
    const now = this.now()
    const recs = this.recent(n)
    if (!recs.length) return ["No traces yet."]
    return recs.flatMap((r) => {
      const who =
        r.dir === "in"
          ? [
              r.update_id !== undefined ? `u${r.update_id}` : "",
              r.message_id !== undefined ? `m${r.message_id}` : "",
              r.thread !== undefined ? `t${r.thread}` : "",
            ]
          : [r.session ? `s:${r.session.slice(-6)}` : ""]
      const head = [
        age(now - r.startedAt),
        r.dir === "in" ? "←" : "→",
        r.kind,
        ...who,
        r.done ? r.outcome : "in flight",
        r.reason ? `(${r.reason.slice(0, 60)})` : "",
        r.ms !== undefined ? `${r.ms}ms` : "",
        `#${r.id.slice(0, 8)}`,
      ].filter(Boolean)
      const path = r.steps.map((s) => `${s.step} ${s.ms}ms${s.ok ? "" : " ✗"}`)
      return [
        head.join(" "),
        ...(path.length ? [`   ${path.join(" → ")}`] : []),
      ]
    })
  }

  private emit(
    lvl: LogLevel,
    event: string,
    fields: Record<string, unknown>,
  ): void {
    if (RANK[lvl] <= RANK[this.level]) log(event, fields)
  }
}

export const traces = new Traces()
