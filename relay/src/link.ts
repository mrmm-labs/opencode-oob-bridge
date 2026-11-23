/**
 * The link face: one authenticated bridge at a time, dialing in over a
 * WebSocket. Requests go down as frames, responses come back as frames.
 * Other local clients may hold named channels on /link/<name>, one connection
 * each, with their own secret; they never touch the bridge's connection.
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
  BRIDGE_CHANNEL,
  channelOf,
  describe,
  LINK_KEY_HEADER,
  MAX_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  NonceCache,
  seal,
  Verifier,
  type ChannelFrame,
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
  /** Named channels by name, each with its own secret and optional key. */
  channels?: Record<string, { secret: string; key?: string }>
  /** The one consumer of verified channel frames. With none, a channel frame is refused. */
  onChannel?: (channel: string, frame: ChannelFrame) => void
  /** A channel whose send buffer is above this is closed with 1013. */
  channelBufferBytes?: number
}

const CHANNEL_BUFFER_BYTES = MAX_FRAME_BYTES

const offline = (res: ServerResponse) => {
  if (res.headersSent) return void res.destroy()
  res.writeHead(503, {
    "content-type": "application/json",
    "cache-control": "no-store",
  })
  res.end('{"error":"the Mac is offline"}')
}

export class Link {
  /** One socket per channel; the bridge's is under BRIDGE_CHANNEL. */
  private readonly socks = new Map<string, WebSocket>()
  private sinceAt: number | undefined
  private readonly pending = new Map<string, Pending>()
  private readonly verifiers = new Map<string, Verifier>()
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
    const nonces = new NonceCache(this.now)
    const secrets: Record<string, string> = { [BRIDGE_CHANNEL]: o.secret }
    for (const [name, c] of Object.entries(o.channels ?? {}))
      secrets[name] = c.secret
    for (const [name, secret] of Object.entries(secrets))
      this.verifiers.set(
        name,
        new Verifier(secret, "up", this.now, o.maxSkewMs, nonces),
      )
  }

  private get ws(): WebSocket | undefined {
    return this.socks.get(BRIDGE_CHANNEL)
  }

  up(): boolean {
    return this.ws?.readyState === 1
  }

  channelUp(ch: string): boolean {
    return ch !== BRIDGE_CHANNEL && this.socks.get(ch)?.readyState === 1
  }

  /** Each configured channel and whether a client is connected on it. */
  channelStates(): Record<string, boolean> {
    return Object.fromEntries(
      Object.keys(this.o.channels ?? {}).map((n) => [n, this.channelUp(n)]),
    )
  }

  since(): number | undefined {
    return this.up() ? this.sinceAt : undefined
  }

  refused(): Record<string, number> {
    return { ...this.refusals }
  }

  private keyOk(headers: IncomingMessage["headers"], key: string): boolean {
    const got = headers[LINK_KEY_HEADER.toLowerCase()]
    if (typeof got !== "string") return false
    const digest = (s: string) => createHash("sha256").update(s).digest()
    return timingSafeEqual(digest(got), digest(key))
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

  private refuse(what: string, reason: string, channel?: string): void {
    this.refusals[reason] = (this.refusals[reason] ?? 0) + 1
    log("link_refused", { what, reason, channel })
  }

  /** The HTTP server for the link port: it answers the upgrade on /link and /link/<channel> and nothing else. */
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
    const path = (req.url ?? "").split("?")[0]
    const ch = channelOf(path)
    const verifier = ch === undefined ? undefined : this.verifiers.get(ch)
    if (ch === undefined || verifier === undefined)
      return deny(404, "Not Found")
    const key = ch === BRIDGE_CHANNEL ? this.o.key : this.o.channels?.[ch]?.key
    if (key !== undefined && !this.keyOk(req.headers, key)) {
      this.refusals.key = (this.refusals.key ?? 0) + 1
      this.keyLog()
      return deny(401, "Unauthorized")
    }
    const r = verifier.openUpgrade(req.headers, path)
    if (!r.ok) {
      this.refuse(
        "upgrade",
        describe(r),
        ch === BRIDGE_CHANNEL ? undefined : ch,
      )
      return deny(401, "Unauthorized")
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.adopt(ws, ch))
  }

  private adopt(ws: WebSocket, ch: string): void {
    const bridge = ch === BRIDGE_CHANNEL
    const old = this.socks.get(ch)
    this.socks.set(ch, ws)
    if (bridge) this.sinceAt = this.now()
    if (old) {
      old.close(4000, "replaced")
      if (bridge) this.failPending()
    }
    log("link_up", {
      replaced: old !== undefined,
      channel: bridge ? undefined : ch,
    })
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
      this.frame(data.toString("utf8"), ch)
    })
    const gone = () => {
      clearInterval(ping)
      if (this.socks.get(ch) !== ws) return
      this.socks.delete(ch)
      if (bridge) this.failPending()
      log("link_down", { channel: bridge ? undefined : ch })
    }
    ws.on("close", gone)
    ws.on("error", gone)
  }

  private frame(text: string, ch: string): void {
    const r = this.verifiers.get(ch)!.open<Up>(text)
    if (!r.ok) return this.refuse("frame", describe(r), ch)
    if (ch !== BRIDGE_CHANNEL)
      return this.channelFrame(ch, r.payload as unknown as ChannelFrame)
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

  /** The label inside the signed body must be the channel the socket was upgraded for. */
  private channelFrame(ch: string, f: ChannelFrame): void {
    if (typeof f.t !== "string" || f.ch !== ch)
      return this.refuse("frame", "channel", ch)
    if (!this.o.onChannel) return this.refuse("frame", "unrouted", ch)
    try {
      this.o.onChannel(ch, f)
    } catch (err) {
      log("channel_consumer_error", { channel: ch, error: (err as Error).name })
    }
  }

  /**
   * Sends a frame down a channel, labelled and sealed with the channel's secret.
   * False when nobody is connected there, or when the client is too slow: its
   * buffer is past the limit and the channel is closed with 1013.
   */
  sendTo(ch: string, f: { t: string; [k: string]: unknown }): boolean {
    const s = this.socks.get(ch)
    const secret = this.o.channels?.[ch]?.secret
    if (secret === undefined || s?.readyState !== 1) return false
    if (
      s.bufferedAmount > (this.o.channelBufferBytes ?? CHANNEL_BUFFER_BYTES)
    ) {
      this.refuse("send", "backpressure", ch)
      s.close(1013, "slow consumer")
      return false
    }
    s.send(seal(secret, "down", { ...f, ch }, this.now()), () => {})
    return true
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
    for (const s of this.socks.values()) s.close(1001, "going away")
    this.socks.clear()
    this.wss.close()
  }
}
