/**
 * The public face: a short list of paths. Init data is checked here before
 * anything reaches the link, the body is capped as it arrives, and nothing but
 * a route name, a status and a duration is logged.
 */
import { createHash, timingSafeEqual } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { isIP } from "node:net"

import { checkInitData, fromHeader } from "./shared/initdata.ts"
import type { Config } from "./config.ts"
import { parseBeat, type Deadman } from "./deadman.ts"
import { InFlight, RateLimiter } from "./limits.ts"
import type { Link } from "./link.ts"
import { log } from "./log.ts"
import { OFFLINE_CSP, OFFLINE_HTML } from "./offline.ts"

const BEAT_BODY_MAX = 16 * 1024
const FORWARD_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "last-event-id",
]

type Route = "healthz" | "beat" | "app" | "v1" | "other"

const SECURITY = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
}

const json = (
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
) => {
  res.writeHead(status, {
    "content-type": "application/json",
    ...SECURITY,
    ...extra,
  })
  res.end(JSON.stringify(body))
}

const same = (a: string, b: string) => {
  const h = (s: string) => createHash("sha256").update(s).digest()
  return timingSafeEqual(h(a), h(b))
}

async function readBody(
  req: IncomingMessage,
  cap: number,
): Promise<Buffer | "too_large"> {
  const len = Number(req.headers["content-length"])
  if (Number.isFinite(len) && len > cap) return "too_large"
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req) {
    n += (c as Buffer).length
    if (n > cap) return "too_large"
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks)
}

export type PublicDeps = {
  cfg: Config
  link: Link
  deadman: Deadman
  now?: () => number
}

export function publicHandler(d: PublicDeps) {
  const { cfg, link, deadman } = d
  const now = d.now ?? Date.now
  const limiter = new RateLimiter(cfg.rate.perSecond, cfg.rate.burst, now)
  const beatLimiter = new RateLimiter(cfg.beatPerSecond, cfg.beatPerSecond, now)
  const flight = new InFlight(cfg.maxInFlightPerClient, cfg.maxInFlightTotal)

  const clientOf = (req: IncomingMessage): string => {
    const h = cfg.clientIpHeader?.toLowerCase()
    const raw = h ? req.headers[h] : undefined
    const first = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0].trim()
    if (first && isIP(first)) return first
    return req.socket.remoteAddress ?? "unknown"
  }

  const forward = async (
    req: IncomingMessage,
    res: ServerResponse,
    target: string,
    client: string,
  ) => {
    const slot = flight.enter(client)
    if (slot === "client") return json(res, 429, { error: "too many requests" })
    if (slot === "total") return json(res, 503, { error: "busy" })
    res.on("close", slot)
    const method = req.method as string
    let body: Buffer | undefined
    if (method === "POST") {
      const b = await readBody(req, cfg.maxBodyBytes)
      if (b === "too_large") {
        res.once("finish", () => req.destroy())
        return json(
          res,
          413,
          { error: "body too large" },
          { connection: "close" },
        )
      }
      body = b
    }
    const headers: Record<string, string> = {}
    for (const k of FORWARD_HEADERS) {
      const v = req.headers[k]
      if (typeof v === "string") headers[k] = v
    }
    if (!link.request({ method, path: target, headers, body, client }, res))
      json(res, 503, { error: "the Mac is offline" })
  }

  const beat = async (
    req: IncomingMessage,
    res: ServerResponse,
    client: string,
  ) => {
    if (req.method !== "POST")
      return json(res, 405, { error: "method not allowed" }, { allow: "POST" })
    if (!cfg.heartbeatToken) return json(res, 404, { error: "not found" })
    if (!beatLimiter.take(client))
      return json(res, 429, { error: "too many requests" })
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")
    if (!m || !same(m[1], cfg.heartbeatToken))
      return json(res, 401, { error: "unauthorized" })
    const b = await readBody(req, BEAT_BODY_MAX)
    if (b === "too_large") return json(res, 413, { error: "body too large" })
    let parsed: ReturnType<typeof parseBeat>
    try {
      parsed = parseBeat(JSON.parse(b.toString("utf8")))
    } catch {
      parsed = undefined
    }
    if (!parsed) return json(res, 400, { error: "not a heartbeat" })
    deadman.beat(parsed)
    res.writeHead(204, SECURITY)
    res.end()
  }

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
    setRoute: (r: Route) => void,
  ) => {
    const raw = req.url ?? "/"
    if (!raw.startsWith("/") || raw.startsWith("//"))
      return json(res, 404, { error: "not found" })
    let u: URL
    try {
      u = new URL(raw, "http://relay")
    } catch {
      return json(res, 404, { error: "not found" })
    }
    const p = u.pathname
    const client = clientOf(req)

    if (p === "/healthz" && req.method === "GET") {
      setRoute("healthz")
      res.writeHead(200, { "content-type": "text/plain", ...SECURITY })
      return void res.end("ok")
    }
    if (p === "/beat") {
      setRoute("beat")
      return beat(req, res, client)
    }
    const isApp = p === "/app" || p.startsWith("/app/")
    const isV1 = p === "/v1" || p.startsWith("/v1/")
    if (!isApp && !isV1) return json(res, 404, { error: "not found" })
    setRoute(isApp ? "app" : "v1")
    if (!limiter.take(client))
      return json(res, 429, { error: "too many requests" })
    if (req.method !== "GET" && req.method !== "POST")
      return json(
        res,
        405,
        { error: "method not allowed" },
        { allow: "GET, POST" },
      )

    if (isV1) {
      if (cfg.operatorUserId === undefined)
        return json(res, 503, { error: "the relay has no operator configured" })
      const v = checkInitData(fromHeader(req.headers.authorization), {
        operator: cfg.operatorUserId,
        maxAgeSeconds: cfg.maxAgeSeconds,
        token: cfg.verifyToken,
        now,
      })
      if (!v.ok)
        return json(res, v.status, {
          error: v.status === 403 ? "forbidden" : "unauthorized",
        })
    }
    if (!link.up()) {
      if (isV1) return json(res, 503, { error: "the Mac is offline" })
      res.writeHead(503, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": OFFLINE_CSP,
        ...SECURITY,
      })
      return void res.end(OFFLINE_HTML)
    }
    return forward(req, res, p + u.search, client)
  }

  return (req: IncomingMessage, res: ServerResponse) => {
    const t0 = now()
    let route: Route = "other"
    res.on("close", () =>
      log("request", { route, status: res.statusCode, ms: now() - t0 }),
    )
    handle(req, res, (r) => (route = r)).catch(() => {
      if (!res.headersSent) json(res, 500, { error: "internal error" })
      else res.destroy()
    })
  }
}
