/**
 * OpenTelemetry over OTLP/HTTP JSON, with `fetch` and nothing else.
 *
 * Off unless an endpoint is configured. Attributes carry ids, kinds, counts and
 * timings only: never message text, titles, answers, tokens, chat ids or URLs.
 * Spans and metrics are buffered, the queue is bounded (oldest dropped), a
 * failed export is dropped and logged at most once a minute, and nothing here
 * throws into the plugin.
 */
import { createHash, randomBytes } from "node:crypto"

import { registerSecret } from "./filter.ts"
import { log } from "./logger.ts"
import { URL_RE } from "./util.ts"

export const SERVICE = "opencode/oob-bridge"
export const SCOPE = "opencode-oob-bridge"
const MAX_QUEUE = 2000
const LOG_EVERY_MS = 60_000

export type Attr = string | number | boolean | undefined
export type Labels = Record<string, Attr>

export type OtelTarget = { endpoint: string; headers?: Record<string, string> }

/** Same derivation as the sibling plugins, so spans join the session's trace. */
export const traceIdFor = (session: string | undefined): string =>
  session
    ? createHash("sha256").update(session).digest("hex").slice(0, 32)
    : randomBytes(16).toString("hex")

const newSpanId = () => randomBytes(8).toString("hex")

export type Span = {
  name: string
  traceId: string
  spanId: string
  parentSpanId?: string
  start: number
  end: number
  attrs: Labels
  error?: string
}

const value = (v: Exclude<Attr, undefined>) =>
  typeof v === "string"
    ? { stringValue: v }
    : typeof v === "boolean"
      ? { boolValue: v }
      : Number.isInteger(v)
        ? { intValue: String(v) }
        : { doubleValue: v }

const attributes = (attrs: Labels) =>
  Object.entries(attrs)
    // A null or NaN attribute makes the collector reject the whole batch.
    .filter(
      ([, v]) =>
        v !== undefined &&
        v !== null &&
        v !== "" &&
        (typeof v !== "number" || Number.isFinite(v)),
    )
    .map(([key, v]) => ({ key, value: value(v as Exclude<Attr, undefined>) }))

const resource = {
  attributes: [{ key: "service.name", value: { stringValue: SERVICE } }],
}

/** Unix nanoseconds as a string from fractional milliseconds; a number cannot hold them exactly. */
const nanos = (ms: number): string => {
  let whole = Math.floor(ms)
  let frac = Math.round((ms - whole) * 1e6)
  if (frac >= 1e6) {
    whole += 1
    frac -= 1e6
  }
  return `${whole}${String(frac).padStart(6, "0")}`
}

export function encodeSpans(spans: readonly Span[]): object {
  return {
    resourceSpans: [
      {
        resource,
        scopeSpans: [
          {
            scope: { name: SCOPE },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              parentSpanId: s.parentSpanId,
              name: s.name,
              kind: 1,
              startTimeUnixNano: nanos(s.start),
              // A zero-length span reads as a negative duration in some viewers.
              endTimeUnixNano: nanos(Math.max(s.end, s.start + 0.001)),
              attributes: attributes(s.attrs),
              status: s.error ? { code: 2, message: s.error } : { code: 1 },
            })),
          },
        ],
      },
    ],
  }
}

type Point = { attrs: Labels; value: number }
type HistogramPoint = {
  attrs: Labels
  count: number
  sum: number
  min: number
  max: number
  buckets: number[]
}

const BOUNDS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]
// Answers take seconds to hours: bounds up to a day.
const LATENCY_BOUNDS = [
  500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 300_000, 900_000, 3_600_000,
  21_600_000, 86_400_000,
]
const boundsFor = (name: string) =>
  name.endsWith("latency_ms") ? LATENCY_BOUNDS : BOUNDS

const labelKey = (attrs: Labels) =>
  JSON.stringify(Object.entries(attrs).sort(([a], [b]) => (a < b ? -1 : 1)))

/** Accumulates counters and histograms between flushes (delta temporality) and the latest gauge values. */
export class MetricBuffer {
  private counters = new Map<string, Map<string, Point>>()
  private histograms = new Map<string, Map<string, HistogramPoint>>()
  private gauges = new Map<string, Map<string, Point>>()
  private since = Date.now()

  count(name: string, attrs: Labels, by = 1): void {
    const series = this.counters.get(name) ?? new Map<string, Point>()
    this.counters.set(name, series)
    const key = labelKey(attrs)
    const point = series.get(key) ?? { attrs, value: 0 }
    point.value += by
    series.set(key, point)
  }

  gauge(name: string, attrs: Labels, v: number): void {
    const series = this.gauges.get(name) ?? new Map<string, Point>()
    this.gauges.set(name, series)
    series.set(labelKey(attrs), { attrs, value: v })
  }

  record(name: string, attrs: Labels, v: number): void {
    const bounds = boundsFor(name)
    const series =
      this.histograms.get(name) ?? new Map<string, HistogramPoint>()
    this.histograms.set(name, series)
    const key = labelKey(attrs)
    const point = series.get(key) ?? {
      attrs,
      count: 0,
      sum: 0,
      min: v,
      max: v,
      buckets: Array.from({ length: bounds.length + 1 }, () => 0),
    }
    point.count++
    point.sum += v
    point.min = Math.min(point.min, v)
    point.max = Math.max(point.max, v)
    const i = bounds.findIndex((b) => v <= b)
    point.buckets[i < 0 ? bounds.length : i]++
    series.set(key, point)
  }

  /** The OTLP/JSON body for everything since the last drain, or undefined when empty. */
  drain(now = Date.now()): object | undefined {
    const start = nanos(this.since)
    const end = nanos(now)
    const metrics: object[] = []
    for (const [name, series] of this.counters) {
      metrics.push({
        name,
        sum: {
          aggregationTemporality: 1,
          isMonotonic: true,
          dataPoints: [...series.values()].map((p) => ({
            attributes: attributes(p.attrs),
            startTimeUnixNano: start,
            timeUnixNano: end,
            asInt: String(p.value),
          })),
        },
      })
    }
    for (const [name, series] of this.gauges) {
      metrics.push({
        name,
        gauge: {
          dataPoints: [...series.values()].map((p) => ({
            attributes: attributes(p.attrs),
            timeUnixNano: end,
            asInt: String(p.value),
          })),
        },
      })
    }
    for (const [name, series] of this.histograms) {
      metrics.push({
        name,
        unit: "ms",
        histogram: {
          aggregationTemporality: 1,
          dataPoints: [...series.values()].map((p) => ({
            attributes: attributes(p.attrs),
            startTimeUnixNano: start,
            timeUnixNano: end,
            count: String(p.count),
            sum: p.sum,
            min: p.min,
            max: p.max,
            bucketCounts: p.buckets.map(String),
            explicitBounds: boundsFor(name),
          })),
        },
      })
    }
    this.counters.clear()
    this.histograms.clear()
    // A gauge is reported when it changes.
    this.gauges.clear()
    this.since = now
    if (!metrics.length) return undefined
    return {
      resourceMetrics: [
        { resource, scopeMetrics: [{ scope: { name: SCOPE }, metrics }] },
      ],
    }
  }
}

export type Active = {
  /** Span id, to parent other spans; empty when telemetry is off. */
  readonly id: string
  /** Picks the trace when the session is only known at the end. */
  setSession(session: string | undefined): void
  end(attrs?: Labels, error?: string): void
}

const OFF: Active = { id: "", setSession() {}, end() {} }

type Post = (url: string, init: RequestInit) => Promise<Response>

/** Resolves the export target: the config's endpoint, else `OTEL_EXPORTER_OTLP_ENDPOINT`; undefined means off. */
export function resolveOtel(
  cfg: OtelTarget | undefined,
  env: NodeJS.ProcessEnv = process.env,
): OtelTarget | undefined {
  if (cfg) return cfg
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  if (!endpoint || !URL_RE.test(endpoint)) return undefined
  const headers: Record<string, string> = {}
  for (const pair of (env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
    const i = pair.indexOf("=")
    if (i > 0)
      headers[pair.slice(0, i).trim()] = decodeURIComponent(
        pair.slice(i + 1).trim(),
      )
  }
  return { endpoint, headers }
}

/**
 * Buffers spans and metrics and posts them every few seconds. A failed post is
 * dropped, never retried.
 */
export class Telemetry {
  readonly metrics = new MetricBuffer()
  private queue: Span[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastLog = 0
  private readonly onExit = () => void this.flush()
  private readonly target: OtelTarget | undefined
  private readonly post: Post
  private readonly everyMs: number
  private readonly now: () => number

  constructor(
    target: OtelTarget | undefined,
    post: Post = (url, init) => globalThis.fetch(url, init),
    everyMs = 2000,
    now: () => number = Date.now,
  ) {
    this.target = target
    this.post = post
    this.everyMs = everyMs
    this.now = now
    for (const v of Object.values(target?.headers ?? {})) registerSecret(v)
    // A short run exits before the timer fires; send what is left.
    if (target) process.once?.("beforeExit", this.onExit)
  }

  enabled(): boolean {
    return this.target !== undefined
  }

  private arm(): void {
    if (this.timer) return
    this.timer = setTimeout(() => void this.flush(), this.everyMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  /** Starts a span. `session` is the top-level session, which picks the trace. */
  begin(
    name: string,
    o: { session?: string; parent?: string; attrs?: Labels } = {},
  ): Active {
    if (!this.target) return OFF
    const start = this.now()
    let session = o.session
    const spanId = newSpanId()
    let done = false
    return {
      id: spanId,
      setSession: (s) => (session = s),
      end: (attrs, error) => {
        if (done) return
        done = true
        if (this.queue.length >= MAX_QUEUE) this.queue.shift()
        this.queue.push({
          name,
          traceId: traceIdFor(session),
          spanId,
          parentSpanId: o.parent || undefined,
          start,
          end: this.now(),
          attrs: { "session.id": session, ...o.attrs, ...attrs },
          error,
        })
        this.arm()
      },
    }
  }

  /** A span measured by the caller, on a trace id of its own. */
  emit(s: {
    name: string
    traceId: string
    spanId: string
    parentSpanId?: string
    start: number
    end: number
    attrs: Labels
    error?: string
  }): void {
    if (!this.target) return
    if (this.queue.length >= MAX_QUEUE) this.queue.shift()
    this.queue.push(s)
    this.arm()
  }

  /** Runs `fn` inside a span; the span's outcome is `ok` or the error. */
  async trace<T>(
    name: string,
    o: Parameters<Telemetry["begin"]>[1],
    fn: (span: Active) => Promise<T>,
  ): Promise<T> {
    const span = this.begin(name, o)
    try {
      const out = await fn(span)
      span.end()
      return out
    } catch (err) {
      span.end({ ok: false }, (err as Error).name)
      throw err
    }
  }

  count(name: string, attrs: Labels = {}, by = 1): void {
    if (!this.target) return
    this.metrics.count(name, attrs, by)
    this.arm()
  }

  gauge(name: string, attrs: Labels, v: number): void {
    if (!this.target) return
    this.metrics.gauge(name, attrs, v)
    this.arm()
  }

  record(name: string, attrs: Labels, v: number): void {
    if (!this.target) return
    this.metrics.record(name, attrs, v)
    this.arm()
  }

  private failed(what: string): void {
    const t = this.now()
    if (t - this.lastLog < LOG_EVERY_MS) return
    this.lastLog = t
    log("otel_export_failed", { what })
  }

  async flush(): Promise<void> {
    this.timer = undefined
    const t = this.target
    const spans = this.queue.splice(0)
    const metrics = this.metrics.drain()
    if (!t) return
    const base = t.endpoint.replace(/\/+$/, "")
    const send = async (path: string, body: object) => {
      try {
        const res = await this.post(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...t.headers },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) this.failed(`${path} HTTP ${res.status}`)
        await res.body?.cancel()
      } catch (err) {
        // A missing collector must never slow or break a session.
        this.failed(`${path} ${(err as Error).name}`)
      }
    }
    await Promise.all([
      spans.length ? send("/v1/traces", encodeSpans(spans)) : undefined,
      metrics ? send("/v1/metrics", metrics) : undefined,
    ])
  }

  async dispose(): Promise<void> {
    process.off?.("beforeExit", this.onExit)
    await this.flush()
  }
}

/** A telemetry that is off: every call does nothing. */
export const noTelemetry = () => new Telemetry(undefined)
