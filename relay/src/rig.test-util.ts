import type { AddressInfo } from "node:net"
import { createServer, type Server } from "node:http"
import WebSocket from "ws"

import {
  seal,
  sealUpgrade,
  Verifier,
  type Down,
  type Up,
} from "./shared/frame.ts"
import { signInitData } from "./shared/initdata.ts"
import { loadConfig, type Config } from "./config.ts"
import { Deadman, parseBeat, type Beat } from "./deadman.ts"
import { Link, type LinkOptions } from "./link.ts"
import { publicHandler } from "./public.ts"
import { setSink } from "./log.ts"

export const SECRET = "k".repeat(48)
export const TOKEN = "123456:TEST-VERIFY-TOKEN"
export const OPERATOR = 4242
export const BEAT_TOKEN = "b".repeat(48)

export const initData = (
  over: Record<string, string> = {},
  token = TOKEN,
  user = OPERATOR,
) =>
  signInitData(token, {
    auth_date: String(Math.floor(Date.now() / 1000) - 5),
    query_id: "AAH-test",
    user: JSON.stringify({ id: user, first_name: "A" }),
    ...over,
  })

export function config(env: Record<string, string> = {}): Config {
  const r = loadConfig({
    LINK_SECRET: SECRET,
    OPERATOR_USER_ID: String(OPERATOR),
    TELEGRAM_BOT_TOKEN_VERIFY: TOKEN,
    HEARTBEAT_TOKEN: BEAT_TOKEN,
    CLIENT_IP_HEADER: "CF-Connecting-IP",
    ...env,
  })
  if ("error" in r) throw new Error(r.error)
  return r.config
}

const listen = (s: Server) =>
  new Promise<number>((ok) =>
    s.listen(0, "127.0.0.1", () => ok((s.address() as AddressInfo).port)),
  )

/** A bridge that dials in the way the real one does, and keeps every frame it receives. */
export class FakeBridge {
  readonly frames: Down[] = []
  readonly closed: Array<{ code: number }> = []
  private readonly verify: Verifier
  readonly ws: WebSocket

  private constructor(ws: WebSocket, secret: string) {
    this.ws = ws
    this.verify = new Verifier(secret, "down")
    ws.on("message", (d) => {
      const r = this.verify.open<Down>(d.toString())
      if (r.ok) this.frames.push(r.payload)
    })
    ws.on("close", (code) => this.closed.push({ code }))
  }

  static async connect(
    url: string,
    secret = SECRET,
    headers: Record<string, string> = sealUpgrade(secret),
  ): Promise<FakeBridge> {
    const ws = new WebSocket(url, { headers })
    const b = new FakeBridge(ws, secret)
    await new Promise<void>((ok, fail) => {
      ws.once("open", () => ok())
      ws.once("error", fail)
      ws.once("unexpected-response", (_q, res) =>
        fail(new Error("refused " + res.statusCode)),
      )
    })
    return b
  }

  send(f: Up, secret = SECRET): void {
    this.ws.send(seal(secret, "up", f))
  }

  sendRaw(text: string): void {
    this.ws.send(text)
  }

  reqs() {
    return this.frames.filter((f) => f.t === "req")
  }

  async waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
      const v = fn()
      if (v !== undefined && v !== false) return v
      if (Date.now() > end) throw new Error("timed out waiting")
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  close(): void {
    this.ws.close()
  }
}

export async function rig(
  o: {
    env?: Record<string, string>
    link?: Partial<LinkOptions>
  } = {},
) {
  const cfg = config(o.env)
  const beats: Beat[] = []
  const sent: string[] = []
  const lines: string[] = []
  setSink((l) => lines.push(l))
  const deadman = new Deadman({
    now: Date.now,
    send: async (t) => (sent.push(t), true),
    intervalMs: 30_000,
    missed: 3,
    stoppingMs: 300_000,
    reminderMs: 1_800_000,
  })
  const link = new Link({
    secret: cfg.linkSecret,
    key: cfg.linkKey,
    maxSkewMs: cfg.linkMaxSkewSeconds * 1000,
    keepAliveMs: cfg.sseKeepaliveSeconds * 1000,
    requestTimeoutMs: cfg.requestTimeoutSeconds * 1000,
    pingMs: 60_000,
    onBeat: (b) => {
      const p = parseBeat(b)
      if (p) {
        beats.push(p)
        deadman.beat(p)
      }
    },
    ...o.link,
  })
  const pub = createServer(publicHandler({ cfg, link, deadman }))
  const ls = link.server()
  const [pubPort, linkPort] = await Promise.all([listen(pub), listen(ls)])
  const clients: FakeBridge[] = []
  return {
    cfg,
    link,
    deadman,
    beats,
    sent,
    lines,
    url: "http://127.0.0.1:" + pubPort,
    linkUrl: "ws://127.0.0.1:" + linkPort + "/link",
    async bridge(secret = SECRET): Promise<FakeBridge> {
      const b = await FakeBridge.connect(this.linkUrl, secret)
      clients.push(b)
      return b
    },
    async done() {
      for (const c of clients) c.close()
      link.close()
      for (const s of [pub, ls]) {
        s.closeAllConnections()
        await new Promise((r) => s.close(r))
      }
      setSink((l) => void process.stdout.write(l + "\n"))
    },
  }
}

export const auth = (token = initData()) => ({ authorization: "tma " + token })
