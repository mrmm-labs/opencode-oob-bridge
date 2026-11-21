/**
 * The endpoint (docs/approvals.md section 4): HTTP/1.1 on a unix socket, never
 * TCP. The directory is 0700 and the socket 0600; a stale socket is replaced.
 */
import { chmod, mkdir, stat, unlink } from "node:fs/promises"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import { connect } from "node:net"
import { dirname } from "node:path"

import { log } from "../logger.ts"
import type { CallerStore } from "./callers.ts"
import type { Approvals, Res } from "./engine.ts"

const MAX_BODY = 64 * 1024
const KEEP_ALIVE_MS = 15_000

export type Endpoint = { path: string; close(): Promise<void> }

const send = (res: ServerResponse, r: Res) => {
  res.writeHead(r.status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  })
  res.end(JSON.stringify(r.body))
}

const error = (
  res: ServerResponse,
  status: number,
  error: string,
  retryable = false,
) => send(res, { status, body: { error, retryable } })

async function body(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) return undefined
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks)
}

function route(o: {
  engine: Approvals
  callers: CallerStore
  now: () => number
  keepAliveMs: number
}) {
  const events = (
    caller: string,
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    const last = Number(req.headers["last-event-id"] ?? 0)
    const ev = o.engine.events(caller, id, Number.isInteger(last) ? last : 0)
    if (!ev) return error(res, 404, "invalid_request")
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    })
    res.write(": ok\n\n")
    let off = () => {}
    const timer = setInterval(
      () => res.write(": keep-alive\n\n"),
      o.keepAliveMs,
    )
    const stop = () => {
      clearInterval(timer)
      off()
    }
    const write = (e: { id: number; type: string; data: unknown }) => {
      res.write(
        `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`,
      )
      if (e.type === "answer") {
        stop()
        res.end()
      }
    }
    off = ev.subscribe(write)
    req.on("close", stop)
    for (const e of ev.replay) {
      write(e)
      if (e.type === "answer") return
    }
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET"
    const target = req.url ?? "/"
    const raw = await body(req)
    if (!raw) return error(res, 413, "invalid_request")
    const auth = o.callers.verify(req.headers, method, target, raw, o.now())
    if (!auth.ok) {
      log("approval_unauthenticated", { reason: auth.reason })
      return error(res, 401, "unauthenticated")
    }
    const url = new URL(target, "http://approvals")
    const p = url.pathname.split("/").filter(Boolean)
    if (p[0] !== "v1") return error(res, 404, "invalid_request")

    if (method === "GET" && p[1] === "status" && p.length === 2)
      return send(res, { status: 200, body: await o.engine.status() })
    if (p[1] !== "approvals") return error(res, 404, "invalid_request")

    if (method === "POST" && p.length === 2) {
      let json: unknown
      try {
        json = JSON.parse(raw.toString("utf8") || "null")
      } catch {
        return error(res, 400, "invalid_request")
      }
      return send(res, await o.engine.create(auth.caller, json))
    }
    const id = p[2]
    if (!id) return error(res, 404, "invalid_request")
    if (method === "GET" && p.length === 4 && p[3] === "events")
      return events(auth.caller, id, req, res)
    if (p.length !== 3) return error(res, 404, "invalid_request")
    if (method === "GET") {
      const wait = Number(url.searchParams.get("wait") ?? 0)
      return send(
        res,
        wait > 0
          ? await o.engine.wait(auth.caller, id, wait)
          : o.engine.get(auth.caller, id),
      )
    }
    if (method === "DELETE")
      return send(res, await o.engine.withdraw(auth.caller, id))
    return error(res, 405, "invalid_request")
  }
}

/** Whether something answers on the socket path. */
const alive = (path: string) =>
  new Promise<boolean>((resolve) => {
    const c = connect(path)
    c.once("connect", () => (c.destroy(), resolve(true)))
    c.once("error", () => resolve(false))
  })

export async function startEndpoint(o: {
  path: string
  engine: Approvals
  callers: CallerStore
  now?: () => number
  keepAliveMs?: number
}): Promise<Endpoint> {
  const dir = dirname(o.path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const present = await stat(o.path).then(
    () => true,
    () => false,
  )
  if (present) {
    if (await alive(o.path))
      throw new Error("another process holds the approvals socket")
    await unlink(o.path)
  }
  const handle = route({
    engine: o.engine,
    callers: o.callers,
    now: o.now ?? Date.now,
    keepAliveMs: o.keepAliveMs ?? KEEP_ALIVE_MS,
  })
  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      log("approvals_http_error", { message: err.message })
      if (!res.headersSent) error(res, 500, "unavailable", true)
      else res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(o.path, () => {
      server.off("error", reject)
      resolve()
    })
  })
  await chmod(o.path, 0o600)
  return {
    path: o.path,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
        void unlink(o.path).catch(() => {})
      }),
  }
}
