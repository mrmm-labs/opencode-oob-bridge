/** Starts and stops the core API next to the bridge, and answers the TUI about it. */
import { join } from "node:path"

import type { Bridge, Host } from "../bridge.ts"
import type { Config } from "../config.ts"
import type { Control } from "../control.ts"
import { log } from "../logger.ts"
import { EventRing, handler, startApi, type Api, type ApiDeps } from "./api.ts"
import { TokenStore } from "./auth.ts"
import { resolveListen } from "./net.ts"
import { Views, type Sources } from "./views.ts"

export type CoreStatus = {
  state: "off" | "listening" | "refused"
  address?: string
  reason?: string
  tokenFile: string
}

/** What the controller shows a TUI of the API. */
export type CoreHandle = {
  status(): CoreStatus
  /** Replaces the token and returns the new one. */
  rotate(): Promise<string>
}

export class Core implements CoreHandle {
  readonly ring = new EventRing()
  private readonly tokens: TokenStore
  private readonly o: {
    cfg: Config
    bridge: Bridge
    host: Host
    control: Control
    version: string
    sources: Sources
    /** What a request through the relay is checked against. */
    edge?: ApiDeps["edge"]
  }
  private api: Api | undefined
  private state: Omit<CoreStatus, "tokenFile"> = {
    state: "off",
    reason: "core.bind is not set",
  }
  private readonly tokenFile: string

  constructor(o: Core["o"] & { dir: string }) {
    this.o = o
    this.tokenFile = join(o.dir, "core-token")
    this.tokens = new TokenStore(this.tokenFile)
  }

  status(): CoreStatus {
    return { ...this.state, tokenFile: this.tokenFile }
  }

  async rotate(): Promise<string> {
    return this.tokens.rotate()
  }

  private deps(): ApiDeps {
    return {
      views: new Views({ ...this.o }),
      actions: this.o.bridge.actions,
      control: this.o.control,
      cfg: this.o.cfg,
      tokens: this.tokens,
      ring: this.ring,
      version: this.o.version,
      edge: this.o.edge,
      digest: () => this.o.bridge.digestPreview(),
    }
  }

  private handlerFn: ReturnType<typeof handler> | undefined

  /** The handler the relay link runs requests through; the same code as the socket's. */
  handle(...a: Parameters<ReturnType<typeof handler>>): void {
    this.handlerFn ??= handler(this.deps())
    this.handlerFn(...a)
  }

  async start(): Promise<void> {
    const { cfg } = this.o
    if (!cfg.core.bind) return
    const where = await resolveListen(cfg.core.bind)
    if (!where.ok) {
      this.state = { state: "refused", reason: where.reason }
      log("core_refused", { bind: cfg.core.bind, reason: where.reason })
      return
    }
    try {
      await this.tokens.load()
      this.api = await startApi(this.deps(), {
        host: where.host,
        port: cfg.core.port,
      })
      this.state = {
        state: "listening",
        address: `${where.host}:${this.api.port}`,
      }
      log("core_listening", { address: this.state.address })
    } catch (err) {
      const reason = (err as Error).message
      this.state = { state: "refused", reason }
      log("core_refused", { bind: cfg.core.bind, reason })
    }
  }

  /** An event for the stream: a type and the session it is about, never text. */
  event(type: string, sessionID: string | undefined): void {
    this.ring.push(type, sessionID ? { sessionID } : {})
  }

  async stop(): Promise<void> {
    await this.api?.close()
    this.api = undefined
  }
}
