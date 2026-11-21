/**
 * The link face: one authenticated bridge at a time, dialing in over a
 * WebSocket. Requests go down as frames, responses come back as frames.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, type WebSocket } from "ws"

import {
  describe,
  LINK_KEY_HEADER,
  LINK_PATH,
  MAX_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  seal,
  Verifier,
  type Down,
  type Headers,
  type Up,
} from "./shared/frame.ts"
import { log } from "./log.ts"

/** Headers the relay passes back to the phone. Everything else the bridge says stays here. */
const RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "content-security-policy",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "etag",
  "content-language",
  "content-disposition",
]

export type Forward = {
  method: string
  path: string
  headers: Headers
  body?: Buffer
  client: string
}

type Pending = {
  res: ServerResponse
  started: boolean
  next: number
  idleAt: number
  timeout?: ReturnType<typeof setTimeout>
  keepAlive?: ReturnType<typeof setInterval>
}

export type LinkOptions = {
  secret: string
  /** When set, the upgrade must carry it in X-OOB-Link-Key, checked before the HMAC. */
  key?: string
  maxSkewMs: number
  now?: () => number
  keepAliveMs: number
  requestTimeoutMs: number
  pingMs?: number
  onBeat: (beat: unknown) => void
}

const offline = (res: ServerResponse) => {
  if (res.headersSent) return void res.destroy()
  res.writeHead(503, {
    "content-type": "application/json",
    "cache-control": "no-store",
  })
  res.end('{"error":"the Mac is offline"}')
}

export class Link {
  private ws: WebSocket | undefined
  private sinceAt: number | undefined
  private readonly pending = new Map<string, Pending>()
  private readonly verifier: Verifier
  private readonly refusals: Record<string, number> = {}
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    clientTracking: false,
  })
  private readonly o: LinkOptions
  private readonly now: () => number

  constructor(o: LinkOptions) {
    this.o = o
    this.now = o.now ?? Date.now
    this.verifier = new Verifier(o.secret, "up", this.now, o.maxSkewMs)
  }

  up(): boolean {
    return this.ws?.readyState === 1
  }

  since(): number | undefined {
    return this.up() ? this.sinceAt : undefined
  }

  refused(): Record<string, number> {
    return { ...this.refusals }
  }

  private keyOk(headers: IncomingMessage["headers"]): boolean {
    const got = headers[LINK_KEY_HEADER.toLowerCase()]
    if (typeof got !== "string") return false
    const digest = (s: string) => createHash("sha256").update(s).digest()
    return timingSafeEqual(digest(got), digest(this.o.key!))
  }

  private keyLoggedAt = 0
  private keySuppressed = 0

  /** One line a minute at most: a scan of the link port must not fill the log. */
  private keyLog(): void {
    const at = this.now()
    if (at - this.keyLoggedAt < 60_000) return void this.keySuppressed++
    log("link_refused", {
      what: "upgrade",
      reason: "key",
      suppressed: this.keySuppressed,
    })
    this.keyLoggedAt = at
    this.keySuppressed = 0
  }

  private refuse(what: string, reason: string): void {
    this.refusals[reason] = (this.refusals[reason] ?? 0) + 1
    log("link_refused", { what, reason })
  }

  /** The HTTP server for the link port: it answers the upgrade on /link and nothing else. */
  server(): Server {
    const s = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("not found")
    })
    s.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head))
    return s
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const deny = (code: number, text: string) => {
      socket.write(
        `HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      )
      socket.destroy()
    }
    if ((req.url ?? "").split("?")[0] !== LINK_PATH)
      return deny(404, "Not Found")
    if (this.o.key !== undefined && !this.keyOk(req.headers)) {
      this.refusals.key = (this.refusals.key ?? 0) + 1
      this.keyLog()
      return deny(401, "Unauthorized")
    }
    const r = this.verifier.openUpgrade(req.headers)
    if (!r.ok) {
      this.refuse("upgrade", describe(r))
      return deny(401, "Unauthorized")
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.adopt(ws))
  }

  private adopt(ws: WebSocket): void {
    const old = this.ws
    this.ws = ws
    this.sinceAt = this.now()
    if (old) {
      old.close(4000, "replaced")
      this.failPending()
    }
    log("link_up", { replaced: old !== undefined })
    let alive = true
    const ping = setInterval(() => {
      if (!alive) return void ws.terminate()
      alive = false
      ws.ping()
    }, this.o.pingMs ?? 20_000)
    ping.unref?.()
    ws.on("pong", () => (alive = true))
    ws.on("message", (data, binary) => {
      alive = true
      if (binary) return this.refuse("frame", "binary")
      this.frame(data.toString("utf8"))
    })
    const gone = () => {
      clearInterval(ping)
      if (this.ws !== ws) return
      this.ws = undefined
      this.failPending()
      log("link_down")
    }
    ws.on("close", gone)
    ws.on("error", gone)
  }

  private frame(text: string): void {
    const r = this.verifier.open<Up>(text)
    if (!r.ok) return this.refuse("frame", describe(r))
    const f = r.payload
    switch (f.t) {
      case "res":
        return this.onRes(f)
      case "chunk":
        return this.onChunk(f)
      case "end":
        return this.onEnd(f.id)
      case "beat": {
        this.o.onBeat(f.beat)
        const seq = (f.beat as { seq?: unknown } | null)?.seq
        this.send({ t: "ack", seq: typeof seq === "number" ? seq : 0 })
        return
      }
      default:
        this.refuse("frame", "type")
    }
  }

  private onRes(f: Extract<Up, { t: "res" }>): void {
    const p = this.pending.get(f.id)
    if (!p || p.started) return
    if (!Number.isInteger(f.status) || f.status < 200 || f.status > 599)
      return this.abort(f.id, p)
    const headers: Record<string, string> = {}
    for (const k of RESPONSE_HEADERS) {
      const v = f.headers?.[k]
      if (typeof v === "string" && !/[\r\n]/.test(v)) headers[k] = v
    }
    headers["x-content-type-options"] ??= "nosniff"
    headers["cache-control"] ??= "no-store"
    headers["strict-transport-security"] = "max-age=63072000; includeSubDomains"
    if (p.timeout) clearTimeout(p.timeout)
    p.timeout = undefined
    p.started = true
    p.idleAt = this.now()
    p.res.writeHead(f.status, headers)
    p.res.flushHeaders()
    if ((headers["content-type"] ?? "").startsWith("text/event-stream")) {
      p.keepAlive = setInterval(
        () => {
          if (this.now() - p.idleAt >= this.o.keepAliveMs) {
            p.res.write(": keep-alive\n\n")
            p.idleAt = this.now()
          }
        },
        Math.max(10, Math.floor(this.o.keepAliveMs / 2)),
      )
      p.keepAlive.unref?.()
    }
  }

  private onChunk(f: Extract<Up, { t: "chunk" }>): void {
    const p = this.pending.get(f.id)
    if (!p?.started) return
    if (f.n !== p.next || typeof f.data !== "string") return this.abort(f.id, p)
    const buf = Buffer.from(f.data, "base64")
    if (buf.length > MAX_CHUNK_BYTES) return this.abort(f.id, p)
    p.next++
    p.idleAt = this.now()
    p.res.write(buf)
  }

  private onEnd(id: string): void {
    const p = this.pending.get(id)
    if (!p) return
    this.release(id, p)
    if (p.started) p.res.end()
    else offline(p.res)
  }

  private abort(id: string, p: Pending): void {
    this.release(id, p)
    this.send({ t: "close", id })
    if (p.started) p.res.destroy()
    else {
      p.res.writeHead(502, { "content-type": "application/json" })
      p.res.end('{"error":"bad gateway"}')
    }
  }

  private release(id: string, p: Pending): void {
    this.pending.delete(id)
    if (p.timeout) clearTimeout(p.timeout)
    if (p.keepAlive) clearInterval(p.keepAlive)
  }

  private failPending(): void {
    for (const [id, p] of this.pending) {
      this.release(id, p)
      offline(p.res)
    }
  }

  private send(f: Down): void {
    if (!this.up()) return
    this.ws?.send(seal(this.o.secret, "down", f, this.now()), () => {})
  }

  /** Sends a request down the link. False when no bridge is connected. */
  request(r: Forward, res: ServerResponse): boolean {
    if (!this.up()) return false
    const id = randomBytes(9).toString("hex")
    const p: Pending = { res, started: false, next: 0, idleAt: this.now() }
    p.timeout = setTimeout(() => {
      if (!this.pending.has(id)) return
      this.release(id, p)
      this.send({ t: "close", id })
      res.writeHead(504, { "content-type": "application/json" })
      res.end('{"error":"the Mac did not answer"}')
    }, this.o.requestTimeoutMs)
    p.timeout.unref?.()
    this.pending.set(id, p)
    res.on("close", () => {
      if (!this.pending.has(id)) return
      this.release(id, p)
      this.send({ t: "close", id })
    })
    this.send({
      t: "req",
      id,
      method: r.method,
      path: r.path,
      headers: r.headers,
      body: r.body?.length ? r.body.toString("base64") : undefined,
      client: r.client,
    })
    return true
  }

  inFlight(): number {
    return this.pending.size
  }

  close(): void {
    this.failPending()
    this.ws?.close(1001, "going away")
    this.ws = undefined
    this.wss.close()
  }
}
