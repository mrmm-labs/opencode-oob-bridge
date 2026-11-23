/**
 * The outbound link: the bridge dials the relay, keeps the connection open and
 * answers request frames. It opens no listening port. A relay that is gone, a
 * secret that is missing and a URL that is not on the tailnet each leave the
 * bridge working and the link down, with the reason in the status.
 */
import { registerSecret } from "../filter.ts"
import { log } from "../logger.ts"
import {
  describe,
  LINK_KEY_HEADER,
  LINK_PATH,
  seal,
  sealUpgrade,
  Verifier,
  type Down,
} from "./frame.ts"
import { linkUrlProblem } from "./hosts.ts"
import { LinkServer, type Handler } from "./serve.ts"

export type LinkState = "off" | "refused" | "down" | "up"
export type LinkStatus = { state: LinkState; since?: number; reason?: string }

type Socket = {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((e: unknown) => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: ((e: { code?: number }) => void) | null
  onerror: ((e: unknown) => void) | null
}
type SocketCtor = new (
  url: string,
  init: { headers: Record<string, string> },
) => Socket

export type LinkOptions = {
  url: string
  /** The shared secret, read when a connection is made. */
  secret: () => Promise<string | undefined>
  /** The pre-shared key for the upgrade header, when the relay asks for one. */
  key?: () => Promise<string | undefined>
  /** Hostnames besides loopback and the tailnet that the URL may use (wss only). */
  allowHosts?: readonly string[]
  handler: Handler
  backoff?: { minMs: number; maxMs: number }
  now?: () => number
  socket?: SocketCtor
}

const OPEN = 1
/** The relay closes a connection with this code when a newer one took its place. */
const REPLACED = 4000
const MISSED_ACKS_BEFORE_RECONNECT = 2

export class LinkClient {
  private readonly o: LinkOptions
  private readonly now: () => number
  private state: LinkStatus
  private socket: Socket | undefined
  private sealing: string | undefined
  private server: LinkServer
  private stopped = false
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly acks = new Map<number, (ok: boolean) => void>()
  private missed = 0

  constructor(o: LinkOptions) {
    this.o = o
    this.now = o.now ?? Date.now
    this.state = { state: "off", reason: "link.url is not set" }
    this.server = new LinkServer(o.handler, (f) => this.send(f))
  }

  status(): LinkStatus {
    return { ...this.state }
  }

  up(): boolean {
    return this.state.state === "up" && this.socket?.readyState === OPEN
  }

  start(): void {
    const why = linkUrlProblem(this.o.url, this.o.allowHosts)
    if (why) {
      this.state = { state: "refused", reason: why }
      log("link_refused", { reason: why })
      return
    }
    this.set("down", "not connected yet")
    void this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.server.closeAll()
    this.settle(false)
    const s = this.socket
    this.socket = undefined
    try {
      s?.close(1000, "stopping")
    } catch {}
    if (this.state.state !== "refused")
      this.state = { state: "off", reason: "stopped" }
  }

  private set(state: LinkState, reason?: string): void {
    if (this.state.state === state && this.state.reason === reason) return
    this.state = { state, since: this.now(), reason }
  }

  private send(f: Parameters<typeof seal>[2]): void {
    const s = this.socket
    if (!s || s.readyState !== OPEN || this.sealing === undefined) return
    try {
      s.send(seal(this.sealing, "up", f, this.now()))
    } catch (err) {
      log("link_send_failed", { message: (err as Error).message })
    }
  }

  /** Sends a heartbeat and waits for the ack with its sequence number. */
  beat(beat: { seq: number }, timeoutMs: number): Promise<boolean> {
    if (!this.up()) return Promise.resolve(false)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.acks.delete(beat.seq)
        if (++this.missed >= MISSED_ACKS_BEFORE_RECONNECT) {
          this.missed = 0
          log("link_reconnect", { reason: "no ack" })
          this.socket?.close(4001, "no ack")
        }
        resolve(false)
      }, timeoutMs)
      this.acks.set(beat.seq, (ok) => {
        clearTimeout(timer)
        this.acks.delete(beat.seq)
        resolve(ok)
      })
      this.send({ t: "beat", beat })
    })
  }

  private settle(ok: boolean): void {
    for (const f of this.acks.values()) f(ok)
  }

  private later(): void {
    if (this.stopped) return
    const { minMs, maxMs } = this.o.backoff ?? { minMs: 1000, maxMs: 60_000 }
    const base = Math.min(maxMs, minMs * 2 ** Math.min(this.attempt, 16))
    this.attempt++
    this.timer = setTimeout(
      () => void this.connect(),
      base / 2 + Math.random() * (base / 2),
    )
    this.timer.unref?.()
  }

  private path(): string {
    try {
      return new URL(this.o.url).pathname || LINK_PATH
    } catch {
      return LINK_PATH
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    let secret: string | undefined
    try {
      secret = await this.o.secret()
    } catch (err) {
      log("link_secret_error", { message: (err as Error).message })
    }
    if (this.stopped) return
    if (!secret) {
      this.set("down", "no secret")
      log("link_waiting", { reason: "no secret" })
      return this.later()
    }
    registerSecret(secret)
    const headers = sealUpgrade(secret, this.now(), this.path())
    if (this.o.key) {
      let key: string | undefined
      try {
        key = await this.o.key()
      } catch (err) {
        log("link_key_error", { message: (err as Error).message })
      }
      if (this.stopped) return
      if (!key) {
        this.set("down", "no key")
        log("link_waiting", { reason: "no key" })
        return this.later()
      }
      registerSecret(key)
      headers[LINK_KEY_HEADER] = key
    }
    const verify = new Verifier(secret, "down", this.now)
    const Ctor =
      this.o.socket ??
      (globalThis as unknown as { WebSocket: SocketCtor }).WebSocket
    let ws: Socket
    try {
      ws = new Ctor(this.o.url, { headers })
    } catch (err) {
      this.set("down", "cannot connect")
      log("link_connect_failed", { message: (err as Error).message })
      return this.later()
    }
    this.socket = ws
    ws.onopen = () => {
      this.sealing = secret
      this.attempt = 0
      this.missed = 0
      this.set("up")
      log("link_up")
    }
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return
      const r = verify.open<Down>(e.data)
      if (!r.ok) return void log("link_frame_refused", { reason: describe(r) })
      const f = r.payload
      if (f.t === "req") this.server.request(f)
      else if (f.t === "close") this.server.close(f.id)
      else if (f.t === "ack") this.acks.get(f.seq)?.(true)
    }
    let over = false
    const gone = (code?: number) => {
      if (over) return
      over = true
      if (this.socket === ws) {
        this.socket = undefined
        this.sealing = undefined
      }
      this.server.closeAll()
      this.settle(false)
      if (this.stopped) return
      if (code === REPLACED) {
        this.set("down", "replaced by another client")
        log("link_replaced", {})
        return
      }
      this.set(
        "down",
        code === undefined
          ? "connection lost"
          : "connection closed (" + code + ")",
      )
      log("link_down", { code })
      this.later()
    }
    ws.onclose = (e) => gone(e.code)
    ws.onerror = () => gone()
  }
}
