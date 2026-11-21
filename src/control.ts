/**
 * The instance-level controller: one per OpenCode server, next to the bridge.
 * It knows the TUIs that are attached, how the operator is away, which
 * sessions wait on messages they are not working on, and runs the commands a
 * TUI sends. It holds no OpenCode API of its own: the bridge, the router and
 * the settings are handed in.
 */
import { execFile } from "node:child_process"

import type { Bridge, Host } from "./bridge.ts"
import type { CoreHandle } from "./core/index.ts"
import type { Config } from "./config.ts"
import type { Pairing } from "./connectors/types.ts"
import { log } from "./logger.ts"
import type { Owner } from "./lock.ts"
import type { OpResult, SessionRow, Snapshot, StuckRow } from "./rpc.ts"
import type { Router } from "./routing.ts"
import type { Afk, SettingsStore } from "./settings.ts"
import { isObject } from "./util.ts"

/** A TUI that has not reported for this long is gone. */
export const PRESENCE_MS = 45_000
/** A message waits this long before the session is said to be stuck on it. */
export const STUCK_MS = 60_000
/** An alert is sent again after this long, if the session is still stuck. */
export const REALERT_MS = 6 * 3_600_000
export const SCAN_MS = 15_000
export const PROBE_MS = 60_000
const MAX_SESSIONS = 40

/** Sessions the database says are suspended while they hold messages. */
export type Probe = () => Promise<
  Array<{ id: string; pending: number; since: number }>
>

/**
 * Asks OpenCode's session database, read-only, which top-level sessions have
 * `time_suspended` set and messages in their inbox. The plugin API shows
 * neither. Any failure (no sqlite3, a schema that moved) is an empty answer.
 */
export function sqliteProbe(db: string): Probe {
  const sql =
    "select s.id as id, s.time_suspended as since, " +
    "(select count(*) from session_inbox i where i.session_id = s.id) as pending " +
    "from session_v2 s where s.time_suspended is not null and s.parent_id is null"
  return () =>
    new Promise((resolve) => {
      execFile(
        "sqlite3",
        ["-readonly", "-json", db, sql],
        { timeout: 5000, maxBuffer: 1 << 20 },
        (err, stdout) => {
          if (err) return resolve([])
          try {
            const rows = JSON.parse(stdout || "[]") as Array<
              Record<string, unknown>
            >
            resolve(
              rows
                .filter(
                  (r) => typeof r.id === "string" && Number(r.pending) > 0,
                )
                .map((r) => ({
                  id: String(r.id),
                  pending: Number(r.pending),
                  since: Number(r.since) || Date.now(),
                })),
            )
          } catch {
            resolve([])
          }
        },
      )
    })
}

export type ControlOptions = {
  bridge: Bridge
  router: Router
  settings: SettingsStore
  cfg: Config
  host: Host
  owner: Owner
  version: string
  now?: () => number
  /** Restarts the bridge only. */
  restart?: () => Promise<void>
  probe?: Probe
  stuckMs?: number
  scanMs?: number
  probeMs?: number
}

type Waiting = { sessionID: string; type: string; at: number }

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined

export class Control {
  private readonly o: ControlOptions
  private readonly now: () => number
  private readonly tuis = new Map<string, number>()
  private readonly waiting = new Map<string, Waiting>()
  private readonly probed = new Map<
    string,
    { pending: number; since: number }
  >()
  /** The alert sent for each stuck session: for which suspension, how many messages waited, and when. */
  private readonly alerts = new Map<
    string,
    { key: string; pending: number; at: number }
  >()
  private readonly pairings = new Map<string, { p: Pairing; done?: boolean }>()
  private seen = 0
  private lastAt: number | undefined
  private v = 1
  private timers: ReturnType<typeof setInterval>[] = []

  /** The core API, once the server has started it. */
  core: CoreHandle | undefined

  constructor(o: ControlOptions) {
    this.o = o
    this.now = o.now ?? Date.now
    o.router.setAfk(o.settings.afk())
    o.router.setPresence(() => this.attached() > 0)
    o.bridge.onChat((root) => this.saveSession(root))
    o.bridge.onWatch((root) => this.saveSession(root))
    o.bridge.onStuck(() =>
      this.stuck().map((s) => ({
        id: s.id,
        label: s.title ?? s.id,
        pending: s.pending,
      })),
    )
    o.bridge.onWaiting((id) => this.waitingCount(id))
    o.bridge.subscribe(() => this.v++)
  }

  /** TUIs that reported within the presence window. */
  attached(): number {
    const cut = this.now() - PRESENCE_MS
    for (const [id, at] of this.tuis) if (at < cut) this.tuis.delete(id)
    return this.tuis.size
  }

  /** The attached TUI that reported most recently: the one to hand a form reply to. */
  pickTui(): string | undefined {
    this.attached()
    let best: [string, number] | undefined
    for (const [id, at] of this.tuis)
      if (!best || at >= best[1]) best = [id, at]
    return best?.[0]
  }

  /** A TUI is alive; `inputAt` is when its operator last typed or clicked. */
  heartbeat(tui: string, inputAt?: number): void {
    const before = this.attached()
    this.tuis.set(tui, this.now())
    if (inputAt !== undefined && Number.isFinite(inputAt))
      this.o.router.touch(Math.min(inputAt, this.now()))
    if (before !== this.attached()) this.o.bridge.notify()
  }

  start(): void {
    const tick = (fn: () => Promise<void> | void, ms: number) => {
      const t = setInterval(
        () => void Promise.resolve(fn()).catch(() => {}),
        ms,
      )
      t.unref?.()
      this.timers.push(t)
    }
    tick(() => this.scan(), this.o.scanMs ?? SCAN_MS)
    if (this.o.probe) {
      void this.refreshProbe()
      tick(() => this.refreshProbe(), this.o.probeMs ?? PROBE_MS)
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  /** Every event the server sends, for what the bridge does not track: messages waiting on a session. */
  onEvent(e: { type: string; data?: unknown }): void {
    this.seen++
    this.lastAt = this.now()
    const d = (isObject(e.data) ? e.data : {}) as Record<string, unknown>
    const sessionID = str(d.sessionID)
    if (e.type === "session.inbox.enqueued" && sessionID && str(d.inboxID)) {
      const item = isObject(d.item) ? d.item : {}
      this.waiting.set(String(d.inboxID), {
        sessionID,
        type: str(item.type) ?? "user",
        at: this.now(),
      })
    } else if (
      (e.type === "session.inbox.delivered" ||
        e.type === "session.inbox.cancelled") &&
      str(d.inboxID)
    )
      this.waiting.delete(String(d.inboxID))
    else if (e.type === "session.deleted" && sessionID)
      for (const [k, w] of this.waiting)
        if (w.sessionID === sessionID) this.waiting.delete(k)
  }

  /** Sessions with a message waiting past the grace period and no turn running. */
  stuck(): StuckRow[] {
    const grace = this.o.stuckMs ?? STUCK_MS
    const now = this.now()
    const rows = new Map<string, StuckRow>()
    const by = new Map<string, Array<Waiting & { id: string }>>()
    for (const [id, w] of this.waiting) {
      if (w.type !== "user") continue
      by.set(w.sessionID, [...(by.get(w.sessionID) ?? []), { ...w, id }])
    }
    for (const [sessionID, items] of by) {
      if (this.o.host.root(sessionID) !== sessionID) continue
      if (this.o.host.busy(sessionID)) continue
      const oldest = items.reduce((a, b) => (a.at <= b.at ? a : b))
      if (now - oldest.at < grace) continue
      rows.set(sessionID, {
        id: sessionID,
        title: this.title(sessionID),
        pending: items.length,
        since: oldest.at,
        source: "events",
        alerted: this.isAlerted(
          sessionID,
          sessionID + ":" + oldest.id,
          items.length,
        ),
      })
    }
    for (const [sessionID, p] of this.probed) {
      if (rows.has(sessionID) || this.o.host.busy(sessionID)) continue
      if (now - p.since < grace) continue
      rows.set(sessionID, {
        id: sessionID,
        title: this.title(sessionID),
        pending: p.pending,
        since: p.since,
        source: "db",
        alerted: this.isAlerted(
          sessionID,
          sessionID + ":db:" + p.since,
          p.pending,
        ),
      })
    }
    return [...rows.values()].sort((a, b) => a.since - b.since)
  }

  /** One alert a suspension: another only when more messages wait, or after six hours. */
  private isAlerted(id: string, key: string, pending: number): boolean {
    const a = this.alerts.get(id)
    return (
      a !== undefined &&
      a.key === key &&
      pending <= a.pending &&
      this.now() - a.at < REALERT_MS
    )
  }

  /** How many messages wait on a session. */
  waitingCount(sessionID: string): number {
    let n = 0
    for (const w of this.waiting.values())
      if (w.sessionID === sessionID && w.type === "user") n++
    return n || (this.probed.get(sessionID)?.pending ?? 0)
  }

  /** Tells the channels about each newly stuck session, once; an alert whose session woke by itself is closed. */
  async scan(): Promise<void> {
    const rows = this.stuck()
    for (const [id] of this.alerts)
      if (!rows.some((s) => s.id === id)) {
        this.alerts.delete(id)
        this.v++
        await this.o.bridge.alertGone(id)
      }
    for (const s of rows) {
      if (s.alerted) continue
      const key =
        s.source === "events"
          ? s.id + ":" + this.oldestWaiting(s.id)
          : s.id + ":db:" + s.since
      this.alerts.set(s.id, { key, pending: s.pending, at: this.now() })
      this.v++
      const minutes = Math.max(1, Math.round((this.now() - s.since) / 60_000))
      const sent = await this.o.bridge.stalled(s.id, {
        pending: s.pending,
        minutes,
      })
      log("stuck_session", { source: s.source, pending: s.pending, sent })
    }
  }

  private oldestWaiting(sessionID: string): string {
    let best: [string, Waiting] | undefined
    for (const [id, w] of this.waiting)
      if (
        w.sessionID === sessionID &&
        w.type === "user" &&
        (!best || w.at < best[1].at)
      )
        best = [id, w]
    return best?.[0] ?? ""
  }

  async refreshProbe(): Promise<void> {
    if (!this.o.probe) return
    const rows = await this.o.probe()
    this.probed.clear()
    for (const r of rows) this.probed.set(r.id, r)
    this.v++
    await this.scan()
  }

  private title(id: string): string | undefined {
    return this.o.bridge.known().find((k) => k.id === id)?.state?.title
  }

  /** `roots` are sessions a TUI is looking at: they are described in full even if never shown to a channel. */
  snapshot(roots: string[] = []): Snapshot {
    const { bridge, router, cfg, host } = this.o
    const st = bridge.status()
    const known = bridge.known().slice(0, MAX_SESSIONS)
    const rows = [
      ...known,
      ...roots
        .filter((r) => !known.some((k) => k.id === r))
        .map((id) => ({ id, state: undefined })),
    ]
    const sessions: SessionRow[] = rows.map(({ id, state }) => ({
      id,
      name: state?.name,
      title: state?.title,
      agent: state?.agent,
      project: state?.project,
      mode: router.mode(id),
      channel: router.channel(id),
      chat: bridge.chatEnabled(id),
      delivery: bridge.delivery(id),
      deliveryOverride: bridge.deliveryOverride(id),
      busy: host.busy(id),
      channelOf: bridge.channelOf(id),
      blocked: bridge.chatBlocked(id),
      canChat: bridge.canChat(id),
      prompts: bridge.openPromptList(id).map((p) => ({
        id: p.id,
        sessionID: p.sessionID,
        kind: p.kind,
        title: p.title,
        askedAt: p.askedAt,
      })),
    }))
    return {
      v: this.v,
      at: this.now(),
      owner: { ...this.o.owner, version: this.o.version },
      afk: {
        mode: router.afkMode(),
        away: router.away(),
        minutes: cfg.away.minutes,
        lastInputAt: router.lastInputAt(),
        tuis: this.attached(),
      },
      channels: st.channels.map((c) => ({
        id: c.id,
        enabled: c.enabled,
        pairing: this.cap(c.id, "pairing"),
        inboundPrompt: this.cap(c.id, "inboundPrompt"),
        connected: c.connected,
        lastError: c.lastError,
        warning: c.warning,
      })),
      pending: st.pending,
      core: this.core && {
        state: this.core.status().state,
        address: this.core.status().address,
        reason: this.core.status().reason,
      },
      sessions,
      stuck: this.stuck(),
      events: { seen: this.seen, lastAt: this.lastAt },
      defaultSidebar: bridge.defaultSidebar(),
      defaultChannel: bridge.defaultChannel(),
      defaultDelivery: bridge.defaultDelivery(),
    }
  }

  /** Keeps a session's routing and chat choices across restarts. */
  saveSession(root: string): void {
    const { router, bridge, settings } = this.o
    const mode = router.mode(root)
    const chat = bridge.chatEnabled(root)
    const delivery = bridge.deliveryOverride(root)
    settings.setSession(
      root,
      mode === "auto" && !chat && !delivery
        ? undefined
        : {
            on: mode === "auto" ? undefined : mode === "on",
            channel: router.channel(root),
            chat: chat || undefined,
            delivery,
          },
    )
    this.v++
  }

  /** Sessions a TUI worked on lately: they stay described in full in the snapshots it gets. */
  private roots: string[] = []

  private cap(id: string, k: "pairing" | "inboundPrompt"): boolean {
    return (
      this.o.bridge.connectors().find((c) => c.id === id)?.capabilities[k] ===
      true
    )
  }

  /** `roots`: the sessions a TUI looks at. */
  watch(roots: string[]): void {
    this.roots = roots.slice(0, 4)
  }

  private done(r: Omit<OpResult, "snapshot">): OpResult {
    this.v++
    return { ...r, snapshot: this.snapshot(this.roots) }
  }

  async op(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<OpResult> {
    const { bridge, router, settings } = this.o
    const root = str(args.root)
    if (root && !this.roots.includes(root))
      this.roots = [root, ...this.roots].slice(0, 4)
    const fail = (text: string) => this.done({ ok: false, text })
    try {
      switch (name) {
        case "afk": {
          const mode = args.mode
          if (mode !== "auto" && mode !== "on" && mode !== "off")
            return fail("afk is on, off or auto")
          router.setAfk(mode as Afk)
          settings.setAfk(mode as Afk)
          bridge.notify()
          return this.done({ ok: true, text: "afk: " + mode })
        }
        case "route": {
          const mode = args.mode
          if (!root || (mode !== "on" && mode !== "off" && mode !== "auto"))
            return fail("route needs a session and on, off or auto")
          bridge.setWatch(root, mode, str(args.channel))
          return this.done({ ok: true })
        }
        case "chat": {
          if (!root) return fail("chat needs a session")
          const out = await bridge.setChat(root, args.on === true)
          return this.done({ ok: out.ok, text: out.text })
        }
        case "delivery": {
          if (!root) return fail("delivery needs a session")
          const d = args.delivery
          bridge.setDelivery(
            root,
            d === "queue" || d === "steer" ? d : undefined,
          )
          this.saveSession(root)
          return this.done({ ok: true })
        }
        case "resume": {
          if (!root) return fail("resume needs a session")
          const out = await bridge.resume(root, "sidebar")
          return this.done({ ok: out.ok, text: out.text })
        }
        case "restart": {
          if (!this.o.restart) return fail("This bridge cannot restart itself")
          await this.o.restart()
          return this.done({ ok: true, text: "Bridge restarted" })
        }
        case "enable": {
          const id = str(args.id)
          if (!id || !bridge.setEnabled(id, args.on === true))
            return fail("No such channel")
          settings.set(id, { enabled: args.on === true })
          bridge.notify()
          return this.done({ ok: true })
        }
        case "core": {
          if (!this.core) return fail("The core API is not running here")
          if (args.action === "rotate")
            return this.done({
              ok: true,
              text: "Token replaced: the old one is refused now",
              data: { token: await this.core.rotate(), ...this.core.status() },
            })
          return this.done({ ok: true, data: this.core.status() })
        }
        case "test":
          return this.done({ ok: true, data: await bridge.test() })
        case "pair": {
          const c = bridge.connectors().find((x) => x.id === str(args.id))
          if (!c?.capabilities.pairing || !c.pair)
            return fail((str(args.id) ?? "That channel") + " has no pairing")
          if (!c.enabled) {
            bridge.setEnabled(c.id, true)
            settings.set(c.id, { enabled: true })
          }
          const p = await bridge.pair(c)
          if (!p) return fail(c.id + ": pairing failed, see the log")
          const entry: { p: Pairing; done?: boolean } = { p }
          this.pairings.set(c.id, entry)
          void p.done.then((ok) => (entry.done = ok))
          const { done: _d, ...shown } = p
          return this.done({ ok: true, data: shown })
        }
        case "pairDone": {
          const e = this.pairings.get(str(args.id) ?? "")
          return this.done({ ok: true, data: { done: e?.done } })
        }
      }
    } catch (err) {
      log("op_error", { op: name, message: (err as Error).message })
      return fail((err as Error).message)
    }
    return fail("Unknown command: " + name)
  }
}
