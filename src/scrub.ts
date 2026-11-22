/**
 * Masks outbound connector text through a local secret broker's scrub socket.
 *
 * Protocol v1: one JSON request per line, one JSON reply per line. The bridge asks for
 * `scrub` and uses only the text that comes back. Any failure is an error that names a
 * kind and carries no text, and the decorator then falls back to the title.
 */
import { randomUUID } from "node:crypto"
import { createConnection } from "node:net"
import { isAbsolute } from "node:path"

import type { Connector, Push } from "./connectors/types.ts"

export type ScrubTarget = { socket: string; timeoutMs: number }
export type Scrub = (text: string) => Promise<string>
type Log = (event: string, fields?: Record<string, unknown>) => void

export class ScrubError extends Error {
  readonly kind: string
  constructor(kind: string) {
    super(kind)
    this.kind = kind
  }
}

const MAX_TEXT = 4 * 1024 * 1024
const MAX_REPLY = 8 * 1024 * 1024
const SEP = "\u0000"

export const WITHHELD = "Details withheld: the secret scrubber is unavailable."

export function parseScrub(raw: unknown): ScrubTarget | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { error: "scrub must be an object" }
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o))
    if (k !== "socket" && k !== "timeoutMs")
      return { error: "scrub." + k + " is not a known key" }
  if (typeof o.socket !== "string" || !isAbsolute(o.socket))
    return { error: "scrub.socket must be an absolute path" }
  const t = o.timeoutMs ?? 2000
  if (typeof t !== "number" || !Number.isInteger(t) || t < 100 || t > 30000)
    return { error: "scrub.timeoutMs must be an integer from 100 to 30000" }
  return { socket: o.socket, timeoutMs: t }
}

export const scrubClient =
  (t: ScrubTarget): Scrub =>
  (text) =>
    new Promise<string>((resolve, reject) => {
      if (Buffer.byteLength(text) > MAX_TEXT)
        return reject(new ScrubError("too large"))
      const id = randomUUID()
      const sock = createConnection(t.socket)
      sock.setEncoding("utf8")
      let buf = ""
      let done = false
      const finish = (err?: ScrubError, out?: string) => {
        if (done) return
        done = true
        clearTimeout(timer)
        sock.destroy()
        if (err) reject(err)
        else resolve(out as string)
      }
      const timer = setTimeout(
        () => finish(new ScrubError("timeout")),
        t.timeoutMs,
      )
      sock.on("connect", () =>
        sock.write(
          JSON.stringify({
            v: 1,
            id,
            op: "scrub",
            text,
            origin: "outbound",
            caller: "oob-bridge",
          }) + "\n",
        ),
      )
      sock.on("data", (chunk: string) => {
        buf += chunk
        if (buf.length > MAX_REPLY) return finish(new ScrubError("malformed"))
        const nl = buf.indexOf("\n")
        if (nl < 0) return
        let r: any
        try {
          r = JSON.parse(buf.slice(0, nl))
        } catch {
          return finish(new ScrubError("malformed"))
        }
        if (r?.v !== 1 || r.id !== id)
          return finish(new ScrubError("malformed"))
        if (r.ok !== true || typeof r.text !== "string")
          return finish(
            new ScrubError(r.ok === false ? "refused" : "malformed"),
          )
        finish(undefined, r.text)
      })
      sock.on("error", () => finish(new ScrubError("unreachable")))
      sock.on("close", () => finish(new ScrubError("closed")))
    })

/** Masks several strings with one request. The result has as many strings as the input. */
export async function scrubAll(
  scrub: Scrub,
  strings: string[],
): Promise<string[]> {
  if (strings.length === 0) return []
  if (strings.some((s) => s.includes(SEP))) throw new ScrubError("malformed")
  const out = (await scrub(strings.join(SEP))).split(SEP)
  if (out.length !== strings.length) throw new ScrubError("malformed")
  return out
}

type Slot = { get: () => string; set: (v: string) => void }
const SKIP = new Set(["stats", "id", "priority", "kind", "multiple", "custom"])

function slots(v: unknown, out: Slot[]): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => {
      if (typeof x === "string")
        out.push({ get: () => x, set: (s) => void (v[i] = s) })
      else slots(x, out)
    })
  } else if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>
    for (const [k, x] of Object.entries(o)) {
      if (SKIP.has(k)) continue
      if (typeof x === "string")
        out.push({ get: () => x, set: (s) => void (o[k] = s) })
      else slots(x, out)
    }
  }
}

async function scrubPush(push: Push, scrub: Scrub): Promise<Push> {
  const { stats, ...rest } = push
  const copy = structuredClone(rest) as Push
  const all: Slot[] = []
  slots(copy, all)
  const masked = await scrubAll(
    scrub,
    all.map((s) => s.get()),
  )
  all.forEach((s, i) => s.set(masked[i]))
  return { ...copy, stats }
}

/** What goes out when the scrubber cannot answer: the title and a fixed notice. */
function titleOnly(push: Push): Push {
  return {
    title: push.title,
    message: WITHHELD,
    priority: push.priority,
    session: push.session && { id: push.session.id, name: "session" },
    stats: push.stats,
  }
}

type Session = NonNullable<Push["session"]>

/**
 * Wraps a connector so its outbound text is masked first. Everything else (capabilities,
 * enabled, status, inbound) is the connector's own.
 */
export function withScrub(ch: Connector, scrub: Scrub, log: Log): Connector {
  const failed = (op: string, err: unknown) =>
    log("scrub_failed", {
      channel: ch.id,
      op,
      kind: err instanceof ScrubError ? err.kind : "error",
    })

  const safePush = async (op: string, push: Push): Promise<Push> => {
    try {
      return await scrubPush(push, scrub)
    } catch (err) {
      failed(op, err)
      return titleOnly(push)
    }
  }

  let chain: Promise<void> = Promise.resolve()
  const wrapped: Record<string, unknown> = {
    send: async (push: Push) => ch.send(await safePush("send", push)),
    update:
      ch.update &&
      (async (ref: string, push: Push) =>
        ch.update!(ref, await safePush("update", push))),
    stream:
      ch.stream &&
      ((session: Session, text: string, gapMs?: number) => {
        chain = chain.then(async () => {
          try {
            const [t, name] = await scrubAll(scrub, [text, session.name])
            ch.stream!({ ...session, name }, t, gapMs)
          } catch (err) {
            failed("stream", err)
          }
        })
      }),
    reply:
      ch.reply &&
      (async (session: Session, text: string) => {
        try {
          const [t, name] = await scrubAll(scrub, [text, session.name])
          return await ch.reply!({ ...session, name }, t)
        } catch (err) {
          failed("reply", err)
          return undefined
        }
      }),
  }
  return new Proxy(ch, {
    get(target, prop) {
      if (typeof prop === "string" && wrapped[prop]) return wrapped[prop]
      const v = Reflect.get(target, prop, target)
      return typeof v === "function" ? v.bind(target) : v
    },
  })
}
