/**
 * The core API: the view-models and the actions over HTTP under /v1, and a live
 * event stream as SSE. Authentication comes first on every request.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"

import type { AppApprovals } from "../approvals/types.ts"
import type { Config } from "../config.ts"
import type { Control } from "../control.ts"
import { redact } from "../filter.ts"
import { log } from "../logger.ts"
import { ACTIONS, type Actions } from "./actions.ts"
import { appLine, LineGate } from "./applog.ts"
import { appStamp, serveApp } from "./app.ts"
import { checkInitData, fromHeader } from "../link/initdata.ts"
import { FailLimiter, type TokenStore } from "./auth.ts"
import type { Views } from "./views.ts"

export const API_VERSION = "v1"
const KEEP_ALIVE_MS = 25_000
const RING = 500
const MAX_BODY = 64 * 1024
const MAX_PAGE = 200

export type CoreEvent = { id: number; type: string; data: unknown }

/** The last 500 events, each with an id a client can resume from. */
export class EventRing {
  private readonly events: CoreEvent[] = []
  private next = 1
  private readonly subs = new Set<(e: CoreEvent) => void>()

  push(type: string, data: unknown): CoreEvent {
    const e = { id: this.next++, type, data }
    this.events.push(e)
    if (this.events.length > RING) this.events.shift()
    for (const s of this.subs) s(e)
    return e
  }

  /** The id of the newest event, 0 when there is none yet. */
  last(): number {
    return this.next - 1
  }

  /** The events after `id`, or `stale` when some of them are no longer kept. */
  since(id: number): CoreEvent[] | "stale" {
    const oldest = this.events[0]?.id ?? this.next
    if (!Number.isInteger(id) || id < oldest - 1 || id >= this.next)
      return "stale"
    return this.events.filter((e) => e.id > id)
  }

  subscribe(fn: (e: CoreEvent) => void): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }
}

export type ApiDeps = {
  views: Views
  actions: Actions
  control: Control
  cfg: Config
  tokens: TokenStore
  ring: EventRing
  version: string
  keepAliveMs?: number
  /** What a request that came through the relay is checked against. */
  /** The digest as text, without marking its period as covered. */
  digest?: () => { enabled: boolean; text: string }
  /** The second factor of approvals: reachable only through the relay, with init data. */
  approvals?: () => AppApprovals | undefined
  edge?: {
    operator(): number | undefined
    botToken(): string | undefined
    maxAgeSeconds?: number
    now?: () => number
  }
}

/** A request that arrived on the relay link, not on a socket of ours. */
export type Edge = { client: string }

export const DEFAULT_INIT_AGE_S = 3600

/** Why a request on the relay link was refused: the app shows a sentence for each. */
export type Refusal =
  | "no_operator"
  | "no_bot_token"
  | "missing"
  | "malformed"
  | "bad_signature"
  | "too_old"
  | "not_operator"

const WHY: Record<string, Refusal> = {
  malformed: "malformed",
  hash: "bad_signature",
  age: "too_old",
  user: "not_operator",
}

const send = (res: ServerResponse, status: number, body?: unknown) => {
  if (body === undefined) {
    res.writeHead(status)
    return res.end()
  }
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  })
  res.end(JSON.stringify(body))
}

async function readBody(
  req: IncomingMessage,
): Promise<Record<string, unknown> | undefined> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) return undefined
    chunks.push(c as Buffer)
  }
  if (size === 0) return {}
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)

const int = (v: string | null, d: number, max = MAX_PAGE) => {
  const n = Number(v)
  return v !== null && Number.isInteger(n) && n >= 0 ? Math.min(n, max) : d
}

export function handler(d: ApiDeps) {
  const lines = new LineGate(30, 60_000, d.edge?.now)
  const events = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    })
    res.write(": ok\n\n")
    const write = (e: CoreEvent) =>
      res.write(
        `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`,
      )
    const header = req.headers["last-event-id"]
    if (header !== undefined) {
      const missed = d.ring.since(Number(header))
      if (missed === "stale")
        write({ id: d.ring.last(), type: "snapshot", data: d.views.list() })
      else for (const e of missed) write(e)
    }
    const off = d.ring.subscribe(write)
    const timer = setInterval(
      () => res.write(": keep-alive\n\n"),
      d.keepAliveMs ?? KEEP_ALIVE_MS,
    )
    req.on("close", () => {
      clearInterval(timer)
      off()
    })
  }

  const approvalsRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    p: string[],
    edge: boolean,
  ) => {
    if (!edge) return send(res, 403, { error: "init data only" })
    const ap = d.approvals?.()
    if (!ap) return send(res, 503, { error: "approvals are off" })
    const [, , id, b] = p
    const reply = (r: { status: number; body: unknown }) =>
      send(res, r.status, r.body)
    if (req.method === "POST" && id === "enroll" && !b) {
      const body = await readBody(req)
      return body
        ? reply(await ap.enrol(body))
        : send(res, 400, { error: "invalid body" })
    }
    if (!id || !/^[0-9A-Z]{26}$/.test(id))
      return send(res, 404, { error: "not found" })
    if (req.method === "GET" && !b) return reply(await ap.appView(id))
    if (
      req.method === "POST" &&
      (b === "proof" || b === "decision") &&
      p.length === 4
    ) {
      const body = await readBody(req)
      if (!body) return send(res, 400, { error: "invalid body" })
      return reply(
        b === "proof"
          ? await ap.appProof(id, body)
          : await ap.appDecide(id, body),
      )
    }
    return send(res, 404, { error: "not found" })
  }

  const route = async (
    req: IncomingMessage,
    res: ServerResponse,
    edge = false,
  ) => {
    const url = new URL(req.url ?? "/", "http://core")
    const p = url.pathname.split("/").filter(Boolean)
    const get = req.method === "GET"
    const post = req.method === "POST"
    if (!get && !post) return send(res, 405, { error: "method not allowed" })
    if (get && p[0] === "app")
      return serveApp(url.pathname, res, d.version, url.searchParams.get("v"))
    if (p[0] !== "v1") return send(res, 404, { error: "not found" })
    const [, a, id, b, c] = p

    if (post && a === "log" && p.length === 2) {
      const body = await readBody(req)
      if (!body) return send(res, 400, { error: "invalid body" })
      const line = appLine(body)
      if (!line) return send(res, 400, { error: "invalid line" })
      if (!lines.take()) return send(res, 429, { error: "too many lines" })
      log("app_" + line.event, { data: line.data })
      return send(res, 200, { ok: true })
    }

    if (get && a === "meta" && p.length === 2)
      return send(res, 200, {
        api: API_VERSION,
        version: d.version,
        app: await appStamp(d.version),
        actions: d.actions.available(),
        permissions: d.cfg.permissions.remote,
        approvals: d.approvals?.() !== undefined && d.cfg.approvals.enabled,
        fields: d.views.fields(),
      })
    if (get && a === "status" && p.length === 2) {
      const s = d.control.snapshot()
      return send(res, 200, {
        v: s.v,
        at: s.at,
        owner: s.owner,
        versions: s.versions,
        afk: s.afk,
        night: s.night && {
          ...s.night,
          sessions: s.night.sessions.map((x) => ({
            ...x,
            title:
              x.title === undefined ? undefined : redact(x.title, d.cfg.redact),
          })),
        },
        pending: s.pending,
        channels: s.channels.map((ch) => ({
          ...ch,
          lastError: ch.lastError && redact(ch.lastError, d.cfg.redact),
          warning: ch.warning && redact(ch.warning, d.cfg.redact),
        })),
      })
    }
    if (get && a === "events" && p.length === 2) return events(req, res)
    if (get && a === "options" && p.length === 2)
      return send(res, 200, await d.actions.options())
    if (get && a === "digest" && p.length === 2)
      return send(res, 200, d.digest?.() ?? { enabled: false, text: "" })
    if (post && a === "overnight" && id === "end" && p.length === 3) {
      const ended = await d.control.night.end("app")
      return send(res, ended ? 200 : 422, {
        ok: ended,
        text: ended
          ? "The overnight plan is ended: nothing acts automatically now."
          : "There is no overnight plan running.",
      })
    }
    if (a === "approvals") return approvalsRoute(req, res, p, edge)
    if (get && a === "prompts" && id && !b && /^[A-Za-z0-9]{1,16}$/.test(id)) {
      const v = d.views.prompt(id)
      return v ? send(res, 200, v) : send(res, 404, { error: "not found" })
    }
    if (a !== "sessions") return send(res, 404, { error: "not found" })

    if (get && !id)
      return send(
        res,
        200,
        d.views.list(
          int(url.searchParams.get("limit"), 50),
          int(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER),
        ),
      )
    if (post && !id) {
      const body = await readBody(req)
      if (!body) return send(res, 400, { error: "invalid body" })
      const project = str(body.project)
      const text = str(body.text)
      if (!project || !text)
        return send(res, 400, { error: "project and text are needed" })
      const r = await d.actions.create({
        project,
        text,
        agent: str(body.agent),
        model: str(body.model),
      })
      const status = r.ok
        ? 201
        : ((
            { invalid: 400, denied: 403, limited: 429 } as Record<
              string,
              number
            >
          )[r.outcome] ?? 500)
      return send(res, status, { ok: r.ok, text: r.text, id: r.id })
    }
    if (!id) return send(res, 404, { error: "not found" })

    if (get && !b) {
      const v = await d.views.detail(id)
      return v
        ? send(res, 200, v)
        : send(res, 404, { error: "no such session" })
    }
    if (get && b === "messages" && !c) {
      const before = url.searchParams.get("before")
      const m = await d.views.messages(
        id,
        int(url.searchParams.get("limit"), 20),
        before === null ? undefined : Number(before),
      )
      return m
        ? send(res, 200, m)
        : send(res, 404, { error: "no such session" })
    }
    if (get && b === "diff" && !c) {
      const f = await d.views.diff(id)
      if (!f) return send(res, 404, { error: "no such session" })
      if ("blocked" in f)
        return send(res, 403, { error: "blocked by chat.deny" })
      if ("unavailable" in f) return send(res, 200, f)
      if (String(req.headers.accept).includes("text/x-diff")) {
        res.writeHead(200, { "content-type": "text/x-diff; charset=utf-8" })
        return res.end(f.value.map((x) => x.patch).join("\n"))
      }
      return send(res, 200, {
        source: f.source,
        value: {
          files: f.value.map(({ patch: _p, ...rest }) => rest),
          additions: f.value.reduce((n, x) => n + x.additions, 0),
          deletions: f.value.reduce((n, x) => n + x.deletions, 0),
        },
      })
    }
    if (post && b === "actions" && c) {
      if (!(ACTIONS as readonly string[]).includes(c))
        return send(res, 404, { error: "no such action" })
      const body = await readBody(req)
      if (!body) return send(res, 400, { error: "invalid body" })
      const r = await d.actions.run(c, id, body)
      return send(res, r.ok ? 200 : 422, r)
    }
    return send(res, 404, { error: "not found" })
  }

  const fails = new FailLimiter(d.edge?.now)
  const lastRefusal = new Map<string, number>()
  /** One line a minute per reason: the reason, never the credential. */
  const refused = (reason: Refusal, status: number, client: string) => {
    const t = (d.edge?.now ?? Date.now)()
    if (t - (lastRefusal.get(reason) ?? -Infinity) < 60_000) return
    lastRefusal.set(reason, t)
    log("edge_refused", { reason, status, client })
  }
  const done = (req: IncomingMessage, res: ServerResponse, edge = false) =>
    route(req, res, edge).catch(() => {
      if (!res.headersSent) send(res, 500, { error: "internal error" })
      else res.end()
    })

  /** The link counts as an edge: init data only, a short path list, a failed-auth limit. */
  const viaEdge = (req: IncomingMessage, res: ServerResponse, edge: Edge) => {
    const client = edge.client.slice(0, 64) || "unknown"
    if (fails.blocked(client))
      return send(res, 429, { error: "too many failures" })
    const p = new URL(req.url ?? "/", "http://core").pathname
    if (req.method === "GET" && p === "/healthz")
      return send(res, 200, { ok: true })
    if (req.method === "GET" && (p === "/app" || p.startsWith("/app/")))
      return void serveApp(
        p,
        res,
        d.version,
        new URL(req.url ?? "/", "http://core").searchParams.get("v"),
      )
    if (p !== "/v1" && !p.startsWith("/v1/"))
      return send(res, 404, { error: "not found" })
    const operator = d.edge?.operator()
    const token = d.edge?.botToken()
    const raw = fromHeader(req.headers.authorization)
    const refuse = (status: 401 | 403, reason: Refusal) => {
      // A refusal the bridge's own set-up causes is not the client's failure: it does not count towards the block.
      if (reason !== "no_operator" && reason !== "no_bot_token")
        fails.fail(client)
      refused(reason, status, client)
      return send(res, status, { error: reason })
    }
    if (operator === undefined) return refuse(401, "no_operator")
    if (token === undefined) return refuse(401, "no_bot_token")
    if (raw === undefined) return refuse(401, "missing")
    const v = checkInitData(raw, {
      operator,
      token,
      maxAgeSeconds: d.edge?.maxAgeSeconds ?? DEFAULT_INIT_AGE_S,
      now: d.edge?.now,
    })
    if (!v.ok) return refuse(v.status, WHY[v.why] ?? "malformed")
    return done(req, res, true)
  }

  return (req: IncomingMessage, res: ServerResponse, edge?: Edge) => {
    if (edge) return viaEdge(req, res, edge)
    if (!d.tokens.check(req.headers.authorization)) return send(res, 401)
    return done(req, res)
  }
}

export type Api = { port: number; host: string; close(): Promise<void> }

/** Starts the listener on an address `resolveListen` accepted. */
export function startApi(
  d: ApiDeps,
  listen: { host: string; port: number },
): Promise<Api> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(handler(d))
    server.once("error", reject)
    server.listen(listen, () => {
      const addr = server.address()
      resolve({
        host: listen.host,
        port: typeof addr === "object" && addr ? addr.port : listen.port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}
