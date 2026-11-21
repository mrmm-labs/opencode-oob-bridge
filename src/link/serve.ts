/**
 * Answers a request frame by running the core API handler in process. The
 * handler sees an ordinary request and response; only the first is a stand-in
 * made from the frame, and the second turns what it writes into frames.
 */
import { EventEmitter } from "node:events"
import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable } from "node:stream"

import type { Edge } from "../core/api.ts"
import { log } from "../logger.ts"
import { MAX_CHUNK_BYTES, type Down, type Headers, type Up } from "./frame.ts"

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  edge: Edge,
) => void

export const MAX_BODY_BYTES = 256 * 1024
export const MAX_IN_FLIGHT = 16
const REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "last-event-id",
]
const PATH = /^\/(app(\/|$)|v1(\/|$)|healthz$)/

type Req = Extract<Down, { t: "req" }>

class LinkResponse extends EventEmitter {
  statusCode = 200
  headersSent = false
  private n = 0
  private ended = false
  private readonly id: string
  private readonly send: (f: Up) => void
  private readonly finish: () => void

  constructor(id: string, send: (f: Up) => void, finish: () => void) {
    super()
    this.id = id
    this.send = send
    this.finish = finish
  }

  get writableEnded(): boolean {
    return this.ended
  }

  writeHead(status: number, headers: Record<string, unknown> = {}): this {
    if (this.headersSent || this.ended) return this
    this.statusCode = status
    this.headersSent = true
    const h: Headers = {}
    for (const [k, v] of Object.entries(headers))
      if (typeof v === "string" || typeof v === "number")
        h[k.toLowerCase()] = String(v)
    this.send({ t: "res", id: this.id, status, headers: h })
    return this
  }

  flushHeaders(): void {
    this.writeHead(this.statusCode)
  }

  write(chunk: string | Uint8Array): boolean {
    if (this.ended) return false
    if (!this.headersSent) this.writeHead(this.statusCode)
    const b =
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk)
    for (let at = 0; at < b.length; at += MAX_CHUNK_BYTES)
      this.send({
        t: "chunk",
        id: this.id,
        n: this.n++,
        data: b.subarray(at, at + MAX_CHUNK_BYTES).toString("base64"),
      })
    return true
  }

  end(chunk?: string | Uint8Array): this {
    if (this.ended) return this
    if (chunk !== undefined) this.write(chunk)
    if (!this.headersSent) this.writeHead(this.statusCode)
    this.ended = true
    this.send({ t: "end", id: this.id })
    this.finish()
    this.emit("close")
    return this
  }

  /** The relay said the phone left: nothing more is sent. */
  abandon(): void {
    this.ended = true
    this.emit("close")
  }
}

const fail = (
  send: (f: Up) => void,
  id: string,
  status: number,
  error: string,
) => {
  send({
    t: "res",
    id,
    status,
    headers: { "content-type": "application/json" },
  })
  send({
    t: "chunk",
    id,
    n: 0,
    data: Buffer.from(JSON.stringify({ error })).toString("base64"),
  })
  send({ t: "end", id })
}

export class LinkServer {
  private readonly live = new Map<
    string,
    { req: Readable; res: LinkResponse }
  >()
  private readonly handler: Handler
  private readonly send: (f: Up) => void

  constructor(handler: Handler, send: (f: Up) => void) {
    this.handler = handler
    this.send = send
  }

  inFlight(): number {
    return this.live.size
  }

  request(f: Req): void {
    const { id } = f
    if (typeof id !== "string" || id === "" || this.live.has(id)) return
    if (this.live.size >= MAX_IN_FLIGHT) return fail(this.send, id, 503, "busy")
    if (f.method !== "GET" && f.method !== "POST")
      return fail(this.send, id, 405, "method not allowed")
    if (
      typeof f.path !== "string" ||
      !f.path.startsWith("/") ||
      f.path.startsWith("//")
    )
      return fail(this.send, id, 404, "not found")
    let path: string
    try {
      path = new URL(f.path, "http://link").pathname
    } catch {
      return fail(this.send, id, 404, "not found")
    }
    if (!PATH.test(path)) return fail(this.send, id, 404, "not found")
    const body = f.body ? Buffer.from(f.body, "base64") : Buffer.alloc(0)
    if (body.length > MAX_BODY_BYTES)
      return fail(this.send, id, 413, "body too large")

    const headers: Record<string, string> = {}
    for (const k of REQUEST_HEADERS) {
      const v = f.headers?.[k]
      if (typeof v === "string") headers[k] = v
    }
    const client = typeof f.client === "string" ? f.client : "unknown"
    const req = Object.assign(Readable.from(body.length ? [body] : []), {
      method: f.method,
      url: f.path,
      headers,
      socket: { remoteAddress: client },
    })
    const res = new LinkResponse(id, this.send, () => this.live.delete(id))
    this.live.set(id, { req, res })
    try {
      this.handler(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        { client },
      )
    } catch (err) {
      log("link_handler_error", { message: (err as Error).message })
      if (!res.headersSent)
        res.writeHead(500, { "content-type": "application/json" })
      res.end('{"error":"internal error"}')
    }
  }

  /** The relay reports the phone left. */
  close(id: string): void {
    const l = this.live.get(id)
    if (!l) return
    this.live.delete(id)
    l.res.abandon()
    l.req.destroy()
  }

  closeAll(): void {
    for (const id of this.live.keys()) this.close(id)
  }
}
