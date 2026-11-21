/**
 * The server half: the bridge runs once, inside the OpenCode server, and sees
 * every session. A TUI only pilots it (src/remote.ts).
 *
 * The server plugin API has no form-reply call, so a question answered from a
 * chat is handed to an attached TUI, which makes the reply.
 */
import { randomUUID } from "node:crypto"
import { access } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Plugin } from "@opencode/plugin"

import {
  Bridge,
  type BridgeEvent,
  type Host,
  type SessionInfo,
} from "./bridge.ts"
import { ApprovalService } from "./approvals/service.ts"
import { KeychainStore } from "./approvals/keystore.ts"
import { connectorTypes } from "./connectors/index.ts"
import type { Connector } from "./connectors/types.ts"
import { dataDir, loadConfig, type Config } from "./config.ts"
import { DigestLog } from "./digest.ts"
import { Control, sqliteProbe } from "./control.ts"
import { Core } from "./core/index.ts"
import { Deadman, selfCheck, urlProblem } from "./deadman.ts"
import { resolveToken } from "./token.ts"
import { acquire, read as readLock, type Lock } from "./lock.ts"
import { log } from "./logger.ts"
import { resolveOtel, Telemetry } from "./otel.ts"
import { PendingStore } from "./pending.ts"
import { definition, type FormRelay } from "./rpc.ts"
import { Router } from "./routing.ts"
import { OvernightStore } from "./overnight.ts"
import { SettingsStore } from "./settings.ts"
import { isObject, sleep } from "./util.ts"
import { RUNNING } from "./version.ts"

type Context = Plugin.Context

export const EVENTS: BridgeEvent["type"][] = [
  "form.created",
  "form.replied",
  "form.cancelled",
  "permission.asked",
  "permission.replied",
  "session.inbox.enqueued",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.renamed",
  "session.model.selected",
  "session.agent.selected",
  "session.text.delta",
  "session.text.ended",
]
/** Read by the controller only: what leaves a session's inbox, and sessions that are gone. */
const WATCH = [
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.deleted",
]

const RESUME_TEXT =
  "Continue from where you left off: messages are waiting in your inbox. This was started from the chat bridge."
const FORM_WAIT_MS = 10_000
const STANDBY_MS = 15_000

type Info = {
  id: string
  parentID?: string
  agent?: string
  title?: string
  location?: { directory?: string }
  model?: { providerID: string; id: string; variant?: string }
  time?: { busy?: number; idle?: number }
}

/** What the server has told us of each session, so the bridge can read it without waiting. */
export class Sessions {
  readonly info = new Map<string, Info>()
  readonly running = new Set<string>()
  private readonly get: (id: string) => Promise<Info | undefined>

  constructor(get: (id: string) => Promise<Info | undefined>) {
    this.get = get
  }

  /** Loads a session and its parents, once. */
  async ensure(id: string | undefined): Promise<void> {
    for (let i = 0; id && i < 8 && !this.info.has(id); i++) {
      const info = await this.get(id)
      if (!info) return
      this.info.set(id, info)
      const { busy, idle } = info.time ?? {}
      if (busy !== undefined && (idle === undefined || busy > idle))
        this.running.add(id)
      id = info.parentID
    }
  }

  root(id: string): string {
    let cur = id
    for (let i = 0; i < 8; i++) {
      const p = this.info.get(cur)?.parentID
      if (!p) break
      cur = p
    }
    return cur
  }

  /** Keeps the cache current from the events that change it. */
  apply(e: { type: string; data?: unknown }): void {
    const d = (isObject(e.data) ? e.data : {}) as Record<string, unknown>
    const id = typeof d.sessionID === "string" ? d.sessionID : undefined
    if (!id) return
    const info = this.info.get(id)
    switch (e.type) {
      case "session.execution.started":
        this.running.add(id)
        break
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        this.running.delete(id)
        break
      case "session.renamed":
        if (info && typeof d.title === "string") info.title = d.title
        break
      case "session.agent.selected":
        if (info && typeof d.agent === "string") info.agent = d.agent
        break
      case "session.model.selected":
        if (info && isObject(d.model)) info.model = d.model as Info["model"]
        break
      case "session.deleted":
        this.info.delete(id)
        this.running.delete(id)
        break
    }
  }
}

const toSession = (i: Info): SessionInfo => ({
  id: i.id,
  parentID: i.parentID,
  agent: i.agent,
  directory: i.location?.directory,
  title: i.title,
  model: i.model?.id,
  modelRef: i.model && {
    providerID: i.model.providerID,
    id: i.model.id,
    variant: i.model.variant,
  },
})

const list = <T>(r: unknown): T[] =>
  Array.isArray(r)
    ? r
    : isObject(r) && Array.isArray(r.data)
      ? (r.data as T[])
      : []

/** Waits for a TUI to make a form reply the server cannot. */
class FormRelays {
  private readonly open = new Map<
    string,
    {
      ok: () => void
      fail: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  ask(
    emit: (r: FormRelay & { to?: string }) => void,
    r: Omit<FormRelay, "token">,
    to?: string,
  ): Promise<void> {
    if (!to)
      return Promise.reject(
        new Error(
          "No OpenCode window is open to deliver this answer. Answer it at the Mac.",
        ),
      )
    const token = randomUUID()
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.open.delete(token)
        fail(
          new Error(
            "No OpenCode window took the answer in time. Answer it at the Mac.",
          ),
        )
      }, FORM_WAIT_MS)
      timer.unref?.()
      this.open.set(token, { ok, fail, timer })
      emit({ ...r, token, to })
    })
  }

  done(token: string, ok: boolean, error?: string): boolean {
    const o = this.open.get(token)
    if (!o) return false
    clearTimeout(o.timer)
    this.open.delete(token)
    if (ok) o.ok()
    else o.fail(new Error(error || "The reply was refused"))
    return true
  }

  clear(): void {
    for (const [t, o] of this.open) {
      clearTimeout(o.timer)
      o.fail(new Error("The bridge restarted"))
      this.open.delete(t)
    }
  }
}

export function serverHost(
  ctx: Context,
  sessions: Sessions,
  forms: (r: Omit<FormRelay, "token">) => Promise<void>,
  canReplyForm?: () => boolean,
): Host {
  return {
    async session(id) {
      await sessions.ensure(id)
      const i = sessions.info.get(id)
      return i && toSession(i)
    },
    root: (id) => sessions.root(id),
    peek: (id) => {
      const i = sessions.info.get(id)
      return i && { agent: i.agent, directory: i.location?.directory }
    },
    replyForm: (sessionID, formID, answer) =>
      forms({ sessionID, formID, answer }),
    canReplyForm,
    replyPermission: (sessionID, requestID, decision) =>
      ctx.permission.reply({ sessionID, requestID, decision } as never),
    prompt: async (sessionID, text, delivery, files) => {
      await ctx.session.prompt({
        sessionID,
        text,
        delivery,
        files: files?.map((f) => ({
          uri: "data:" + f.mime + ";base64," + f.data,
          source: { type: "inline" as const },
          name: f.name,
        })),
      })
    },
    busy: (id) => sessions.running.has(id),
    createSession: async ({ directory, agent, model }) => {
      const info = await ctx.session.create({
        location: { directory },
        agent,
        model,
      })
      return { id: info.id }
    },
    switchModel: (sessionID, model) =>
      ctx.session.switchModel({ sessionID, model }),
    switchAgent: (sessionID, agent) =>
      ctx.session.switchAgent({ sessionID, agent }),
    interrupt: async (sessionID) =>
      (await ctx.session.interrupt({ sessionID })).interrupted,
    compact: async (sessionID) => {
      await ctx.session.compact({ sessionID })
    },
    rename: (sessionID, title) => ctx.session.update({ sessionID, title }),
    // The one public way to wake a session: a synthetic message that resumes it.
    resume: async (sessionID) => {
      await ctx.session.synthetic({
        sessionID,
        text: RESUME_TEXT,
        description: "Resumed from the chat",
        resume: true,
      })
    },
    synthetic: async (sessionID, text, resume) => {
      await ctx.session.synthetic({
        sessionID,
        text,
        description: "Overnight scope",
        resume,
      })
    },
    undo: async (sessionID) => {
      const last = list<{ id?: string; type?: string }>(
        await ctx.session.context({ sessionID }),
      )
        .filter((m) => m.type === "user")
        .at(-1)
      if (!last?.id) return false
      await forms({
        sessionID,
        formID: "",
        answer: {},
        kind: "undo",
        messageID: last.id,
      })
      return true
    },
    messages: async (sessionID, limit) => {
      type Part = { type?: string; text?: string }
      type Msg = {
        type?: string
        text?: string
        content?: Part[]
        time?: { created?: number }
      }
      return list<Msg>(await ctx.session.context({ sessionID }))
        .flatMap((m) => {
          const at = m.time?.created ?? 0
          if (m.type === "user" || m.type === "synthetic")
            return typeof m.text === "string"
              ? [{ role: m.type, text: m.text, at }]
              : []
          if (m.type !== "assistant") return []
          const text = (m.content ?? [])
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text)
            .join("\n")
          return text ? [{ role: "assistant", text, at }] : []
        })
        .slice(-limit)
    },
    diff: async (directory) =>
      list<{
        file: string
        status: string
        additions: number
        deletions: number
        patch: string
      }>(await ctx.vcs.diff({ location: { directory }, mode: "working" })),
    agents: async () =>
      list<{ name: string; mode: string; hidden?: boolean }>(
        await ctx.agent.list(),
      )
        .filter((a) => a.mode !== "subagent" && !a.hidden)
        .map((a) => a.name),
    models: async () =>
      list<{
        providerID: string
        modelID: string
        name: string
        enabled: boolean
        status: string
        type?: string
        variants: Array<{ id: string }>
      }>(await ctx.model.list())
        .filter(
          (m) =>
            m.enabled &&
            m.status !== "deprecated" &&
            (m.type === undefined || m.type === "chat"),
        )
        .map((m) => ({
          ref: m.providerID + "/" + m.modelID,
          name: m.name,
          variants: m.variants.map((v) => v.id),
        })),
  }
}

type Running = { control: Control; stop(): Promise<void> }

/** The answer the TUI's status call gives: JSON values only. */
const statusSnapshot = (control: Control, roots: string[]) =>
  plain(control.snapshot(roots))

/** Starts the heartbeat when `deadman.url` is set and usable; otherwise says why not and sends nothing. */
async function startDeadman(o: {
  cfg: Config
  dir: string
  version: string
  control: Control
  bridge: Bridge
  rpcRegistered: () => boolean
}): Promise<Deadman | undefined> {
  const d = o.cfg.deadman
  if (!d.url) return undefined
  const why = urlProblem(d.url)
  if (why) {
    log("deadman_refused", { reason: why })
    return undefined
  }
  const token = await resolveToken(d.token).catch((err: Error) => {
    log("deadman_token_error", { message: err.message })
    return undefined
  })
  if (!token) {
    log("deadman_refused", { reason: "no token" })
    return undefined
  }
  const lockFile = join(o.dir, "owner.lock")
  const dm = new Deadman({
    url: d.url,
    token,
    intervalMs: d.intervalSeconds * 1000,
    version: o.version,
    check: () =>
      selfCheck({
        snapshot: () => statusSnapshot(o.control, []),
        rpcRegistered: o.rpcRegistered,
        lockHeld: async () => (await readLock(lockFile))?.pid === process.pid,
        channels: () => o.bridge.status().channels,
      }),
  })
  dm.start()
  return dm
}

async function boot(
  ctx: Context,
  cfg: Config,
  lock: Extract<Lock, { held: true }>,
  forms: FormRelays,
  emit: (r: FormRelay & { to?: string }) => void,
  restart: () => Promise<void>,
  dir: string,
  rpcRegistered: () => boolean,
  instances = 1,
): Promise<Running> {
  const tel = new Telemetry(resolveOtel(cfg.otel))
  const settings = new SettingsStore(join(dir, "settings.json"))
  await settings.load()
  const nightStore = new OvernightStore(join(dir, "overnight.json"))
  await nightStore.load()
  let deadmanRef: Deadman | undefined
  const connectors: Connector[] = Object.entries(cfg.channels).map(
    ([name, c]) => {
      const connector = connectorTypes[c.type].create(
        {
          name,
          dir,
          tel,
          settings: {
            get: () => settings.channel(name),
            set: (patch) => settings.set(name, patch),
          },
        },
        c.options,
      )
      connector.enabled = settings.channel(name).enabled ?? c.enabled
      return connector
    },
  )
  const store = new PendingStore(join(dir, "pending.jsonl"))
  await store.load()
  const router = new Router(cfg)
  for (const [id, v] of Object.entries(settings.sessions()))
    router.set(id, v.on, v.channel)

  const sessions = new Sessions(async (id) => {
    try {
      return (await ctx.session.get({ sessionID: id })) as unknown as Info
    } catch {
      return undefined
    }
  })
  let control!: Control
  const host = serverHost(
    ctx,
    sessions,
    (r) => forms.ask(emit, r, control.pickTui()),
    () => control.pickTui() !== undefined,
  )
  const digest = new DigestLog(join(dir, "digest.jsonl"))
  await digest.load()
  const bridge = new Bridge(
    cfg,
    host,
    connectors,
    store,
    router,
    Date.now,
    tel,
    digest,
  )
  const db = join(dirname(dir), "opencode.db")
  const probe = await access(db).then(
    () => sqliteProbe(db),
    () => undefined,
  )
  control = new Control({
    bridge,
    router,
    settings,
    cfg,
    host,
    owner: lock.owner,
    version: RUNNING,
    restart,
    probe,
    overnight: nightStore,
    deadman: () =>
      !cfg.deadman.url
        ? "unconfigured"
        : deadmanRef?.acknowledged()
          ? "ok"
          : "unacked",
  })
  const core = new Core({
    cfg,
    dir,
    bridge,
    host,
    control,
    version: RUNNING,
    sources: {
      tail: [
        ["server", host.messages && ((id, n) => host.messages!(id, n))],
        ["events", undefined],
      ],
      diff: [
        [
          "server",
          async (_id, d) => (d && host.diff ? host.diff(d) : undefined),
        ],
        ["tui", undefined],
      ],
      todos: [["server", undefined]],
    },
  })
  control.core = core
  await core.start()
  const approvals = new ApprovalService({
    cfg: () => cfg.approvals,
    dir,
    keys: new KeychainStore(),
    connectors: () => bridge.connectors(),
    away: () => router.away(),
  })
  bridge.setPermissionGate((o) => approvals.gate(o))
  control.approvals = approvals
  await approvals.start()
  const deadman = await startDeadman({
    cfg,
    dir,
    version: RUNNING,
    control,
    bridge,
    rpcRegistered,
  })
  deadmanRef = deadman
  for (const [id, v] of Object.entries(settings.sessions())) {
    if (v.chat) bridge.restoreChat(id)
    if (v.delivery === "queue" || v.delivery === "steer")
      bridge.restoreDelivery(id, v.delivery)
  }

  const ac = new AbortController()
  const feed = async () => {
    while (!ac.signal.aborted) {
      try {
        for await (const e of ctx.event.subscribe({
          types: [...EVENTS, ...WATCH] as never,
          signal: ac.signal,
        })) {
          const ev = e as unknown as { type: string; data?: unknown }
          control.onEvent(ev)
          const d = (isObject(ev.data) ? ev.data : {}) as Record<
            string,
            unknown
          >
          const form = isObject(d.form) ? d.form : {}
          const id =
            (typeof d.sessionID === "string" && d.sessionID) ||
            (typeof form.sessionID === "string" && form.sessionID) ||
            undefined
          await sessions.ensure(id || undefined)
          sessions.apply(ev)
          core.event(ev.type, id ? sessions.root(id) : undefined)
          if ((EVENTS as string[]).includes(ev.type))
            void bridge.onEvent(ev as unknown as BridgeEvent)
        }
      } catch (err) {
        if (!ac.signal.aborted)
          log("event_stream_error", { message: (err as Error).message })
      }
      await sleep(2000, ac.signal)
    }
  }
  void feed()
  bridge.start()
  control.start()
  log("server_started", {
    otel: tel.enabled(),
    channels: connectors.map((c) => c.id),
    rules: cfg.rules.length,
    probe: probe !== undefined,
    instances,
    directory: (ctx.location as { directory?: string } | undefined)?.directory,
  })
  return {
    control,
    async stop() {
      await deadman?.stop()
      ac.abort()
      await approvals.stop()
      await core.stop()
      control.stop()
      forms.clear()
      await bridge.stop()
      await settings.flush()
      await tel.dispose()
    },
  }
}

/**
 * The host accepts only JSON values in an RPC answer or event: an object key
 * holding `undefined` is refused as `rpc.invalid_output`. A round trip drops those keys.
 */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T

/** Logs what a handler throws before the host turns it into `rpc.internal`. */
const guard =
  <A, R>(method: string, fn: (input: A) => Promise<R>) =>
  async (input: A): Promise<R> => {
    try {
      return plain(await fn(input))
    } catch (err) {
      log("rpc_error", { method, message: (err as Error).message })
      throw err
    }
  }

type Registration = {
  dispose(): Promise<void>
  events: { emit: (...a: never[]) => Promise<void> }
}

/** One plugin instance: OpenCode sets the plugin up once per location of the server, all in one process. */
type Member = { ctx: Context; reg?: Registration }

type Held = Extract<Lock, { held: true }>

/**
 * What every instance in this process shares. The RPC registry of the host is
 * per location, so each instance registers it; one of them, the owner, runs
 * the bridge, and every instance answers through it. The file lock only keeps
 * a second process out.
 */
class Hub {
  readonly members = new Set<Member>()
  readonly forms = new FormRelays()
  cfg: Config | undefined
  /** Read once, when the first instance joins: a retry later must not look elsewhere. */
  private dir = ""
  private lock: Held | undefined
  private running: Running | undefined
  private owner: Member | undefined
  private foreign: number | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private chain: Promise<unknown> = Promise.resolve()

  private readonly standbyMs: number

  constructor(standbyMs = STANDBY_MS) {
    this.standbyMs = standbyMs
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => {})
    return next
  }

  /** Asks the instances' locations to relay a form reply: only the window it names acts. */
  readonly emit = (r: FormRelay & { to?: string }): void => {
    for (const m of this.members)
      void (
        m.reg?.events.emit as unknown as
          | ((n: string, d: unknown) => Promise<void>)
          | undefined
      )?.("form", plain(r)).catch((err: Error) =>
        log("form_relay_error", { message: err.message }),
      )
  }

  /** The controller, or why there is none. */
  control(): Control {
    if (this.running) return this.running.control
    throw new Error(
      this.foreign && this.foreign > 0
        ? "The bridge runs in another OpenCode process (pid " +
            this.foreign +
            ")"
        : "The bridge is starting",
    )
  }

  async join(ctx: Context, cfg: Config): Promise<() => Promise<void>> {
    this.cfg = cfg
    this.dir ||= dataDir()
    const member: Member = { ctx }
    this.members.add(member)
    const ctl = () => this.control()
    member.reg = (await ctx.rpc.register(definition, {
      status: guard("status", async (input: unknown) => {
        const i = (isObject(input) ? input : {}) as {
          tui?: string
          inputAt?: number
          roots?: unknown
          version?: unknown
        }
        const roots = Array.isArray(i.roots)
          ? i.roots.filter((r): r is string => typeof r === "string")
          : []
        ctl().heartbeat(
          String(i.tui ?? "tui"),
          i.inputAt,
          typeof i.version === "string" ? i.version : undefined,
        )
        ctl().watch(roots)
        return statusSnapshot(ctl(), roots) as never
      }),
      op: guard("op", async (input: unknown) => {
        const i = (isObject(input) ? input : {}) as {
          op?: string
          args?: Record<string, unknown>
        }
        return (await ctl().op(String(i.op ?? ""), i.args)) as never
      }),
      formDone: guard("formDone", async (input: unknown) => {
        const i = (isObject(input) ? input : {}) as {
          token?: string
          ok?: boolean
          error?: string
        }
        return {
          ok: this.forms.done(String(i.token ?? ""), i.ok === true, i.error),
        } as never
      }),
    } as never)) as unknown as Registration
    await this.serial(() => this.elect())
    return () => this.leave(member)
  }

  private async elect(): Promise<void> {
    const owner = [...this.members][0]
    if (this.running || !owner || !this.cfg) return
    if (!this.lock) {
      const l = await acquire(join(this.dir, "owner.lock"))
      if (!l.held) {
        if (this.foreign !== l.owner?.pid)
          log("server_standby", { owner: l.owner?.pid })
        this.foreign = l.owner?.pid ?? -1
        this.timer ??= setInterval(() => {
          void this.serial(() => this.elect())
        }, this.standbyMs)
        this.timer.unref?.()
        return
      }
      this.lock = l
    }
    this.foreign = undefined
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.owner = owner
    this.running = await boot(
      owner.ctx,
      this.cfg,
      this.lock,
      this.forms,
      this.emit,
      () => this.restart(),
      this.dir,
      () => [...this.members].some((m) => m.reg !== undefined),
      this.members.size,
    )
  }

  /** Restarts the bridge only: the instances and the RPC stay. */
  private restart(): Promise<void> {
    return this.serial(async () => {
      await this.running?.stop()
      this.running = undefined
      this.owner = undefined
      await this.elect()
    })
  }

  private leave(member: Member): Promise<void> {
    return this.serial(async () => {
      if (!this.members.delete(member)) return
      await member.reg?.dispose().catch(() => {})
      if (this.owner === member) {
        await this.running?.stop()
        this.running = undefined
        this.owner = undefined
      }
      if (this.members.size > 0) return this.elect()
      if (this.timer) clearInterval(this.timer)
      this.timer = undefined
      this.foreign = undefined
      this.dir = ""
      await this.lock?.release()
      this.lock = undefined
    })
  }
}

const HUB = Symbol.for("oob-bridge.hub.1")

/** Joins this instance to the bridge of the process, starting it if no instance has. */
export async function startServer(
  ctx: Context,
  o: { standbyMs?: number } = {},
): Promise<(() => Promise<void>) | undefined> {
  const cfg = await loadConfig()
  if (!cfg) return undefined
  if ("error" in cfg) {
    log("config_error", { message: cfg.error })
    return undefined
  }
  // On globalThis so a second copy of this module still finds the same hub.
  const g = globalThis as unknown as { [HUB]?: Hub }
  const hub = (g[HUB] ??= new Hub(o.standbyMs))
  const leave = await hub.join(ctx, cfg)
  return async () => {
    await leave()
    if (hub.members.size === 0 && g[HUB] === hub) delete g[HUB]
  }
}
