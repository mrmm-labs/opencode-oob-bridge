/**
 * The instance-level controller: one per OpenCode server, next to the bridge.
 * It knows the TUIs that are attached, how the operator is away, which
 * sessions wait on messages they are not working on, and runs the commands a
 * TUI sends. It holds no OpenCode API of its own: the bridge, the router and
 * the settings are handed in.
 */
import { execFile } from "node:child_process"

import { enrolLink } from "./approvals/link.ts"
import type { ApprovalService } from "./approvals/service.ts"
import type { Bridge, Host } from "./bridge.ts"
import type { CoreHandle } from "./core/index.ts"
import type { LinkStatus } from "./link/client.ts"
import type { Config } from "./config.ts"
import type { Pairing } from "./connectors/types.ts"
import { log } from "./logger.ts"
import type { Owner } from "./lock.ts"
import type { Drain, OpResult, SessionRow, Snapshot, StuckRow } from "./rpc.ts"
import type { Router } from "./routing.ts"
import {
  Overnight,
  OvernightStore,
  brief,
  parseDuration,
  parseUntil,
} from "./overnight.ts"
import type { Afk, SettingsStore } from "./settings.ts"
import { traces } from "./trace.ts"
import { formatDuration, isObject } from "./util.ts"
import {
  activeConfigPath,
  mismatches,
  readInstalled,
  chatLines,
  type Installed,
  type VersionReport,
} from "./version.ts"
import { API_VERSION } from "./core/api.ts"

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
    "from session_v2 s where s.time_suspended is not null and s.parent_id is null " +
    // A turn running now is not stuck, whatever time_suspended still says.
    "and not (s.time_busy is not null and (s.time_idle is null or s.time_busy > s.time_idle))"
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
  /** The plan file; a plan lives only in memory without it. */
  overnight?: OvernightStore
  /** Whether the dead-man receiver acknowledged the last heartbeat. */
  deadman?: () => "ok" | "unconfigured" | "unacked"
  /** Reads the version on disk; tests replace it. */
  installed?: () => Promise<Installed>
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
  /** The version each attached TUI says it runs. */
  private readonly tuiVersions = new Map<string, string>()
  private installed: Installed | undefined
  private installedAt = -Infinity
  private readonly waiting = new Map<string, Waiting>()
  private readonly probed = new Map<
    string,
    { pending: number; since: number }
  >()
  /** The alert sent for each stuck session: for which suspension, how many messages waited, and when. */
  /** The overnight plan and its loop. */
  readonly night: Overnight
  /** When the operator started counting as away, and what the bridge had counted then. */
  private awaySince:
    | { at: number; counts: ReturnType<Bridge["counts"]> }
    | undefined
  private back: { id: number; text: string; at: number } | undefined
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
  /** The relay link, when `link.url` is set and the server has started it. */
  link: { status(): LinkStatus } | undefined
  /** The approvals service, once the server has started it. */
  approvals: ApprovalService | undefined

  constructor(o: ControlOptions) {
    this.o = o
    this.now = o.now ?? Date.now
    o.router.setAfk(o.settings.afk(), o.settings.afkUntil())
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
    o.bridge.onVersion(() => this.versionText())
    o.bridge.subscribe(() => this.v++)
    const bridge = o.bridge
    const anyUp = () =>
      bridge.status().channels.some((c) => c.enabled && c.connected)
    this.night = new Overnight(
      {
        now: this.now,
        busy: (id) => o.host.busy(id),
        waiting: (id) => this.waitingCount(id),
        denied: (id) => bridge.chatBlocked(id) !== undefined,
        resume: (id) => bridge.resume(id, "overnight"),
        send: (id, text) => bridge.actions.prompt(id, text, "queue"),
        scope: async (id, text, busy) => {
          if (o.host.synthetic) await o.host.synthetic(id, text, !busy)
          else await bridge.actions.prompt(id, text, "queue")
        },
        stop: (id) => bridge.actions.stop(id),
        questions: (id) =>
          bridge
            .openPromptList(id)
            .filter((p) => p.kind === "question")
            .map((p) => {
              const q = p.questions ?? []
              const one = q.length === 1 ? q[0] : undefined
              const rec = one?.options.findIndex((x) =>
                /\(recommended\)/i.test(x),
              )
              return {
                id: p.id,
                title: p.title,
                askedAt: p.askedAt,
                single: !!one && !one.multiple && one.options.length > 0,
                recommended:
                  rec !== undefined && rec >= 0 ? rec + 1 : undefined,
              }
            }),
        permissions: (id) =>
          bridge
            .openPromptList(id)
            .filter((p) => p.kind === "permission")
            .map((p) => ({ id: p.id, title: p.title })),
        answer: async (pid, choice) =>
          (await bridge.answerFromClient(pid, { choice })).ok,
        note: (id, kind, text, loud) => bridge.nightNote(id, kind, text, loud),
        title: (id) => this.title(id),
        facts: (id) => ({
          known: bridge.known().some((k) => k.id === id),
          channelUp: anyUp(),
          inbox: o.probe !== undefined || this.seen > 0,
        }),
        plan: () => ({
          channelUp: anyUp(),
          deadman: o.deadman?.() ?? "unconfigured",
        }),
      },
      o.overnight ?? new OvernightStore(),
      { wake: o.cfg.overnight.wake, maxResumes: o.cfg.overnight.maxResumes },
    )
    bridge.setNight(this.night.source())
    bridge.onResume((id, outcome) => this.night.resumed(id, outcome))
  }

  /** TUIs that reported within the presence window. */
  attached(): number {
    const cut = this.now() - PRESENCE_MS
    for (const [id, at] of this.tuis)
      if (at < cut) {
        this.tuis.delete(id)
        this.tuiVersions.delete(id)
      }
    return this.tuis.size
  }

  /** The version on disk, read again at most once a minute unless `force` is set. */
  async refreshInstalled(force = false): Promise<Installed | undefined> {
    if (force || this.now() - this.installedAt >= 60_000) {
      this.installedAt = this.now()
      this.installed = await (this.o.installed ?? readInstalled)()
      this.v++
    }
    return this.installed
  }

  private tuiList(): string[] {
    this.attached()
    return [...this.tuiVersions.values()]
  }

  /** What this server half runs and what is installed; the warnings compare the two and the TUIs. */
  async versionReport(force = true): Promise<VersionReport> {
    // The counts are checked against OpenCode now, not as of the last periodic check.
    await this.o.bridge.reconcile().catch(() => 0)
    const inst = await this.refreshInstalled(force)
    const { owner, version } = this.o
    const core = this.core?.status()
    return {
      running: version,
      installed: inst?.version,
      describe: inst?.describe,
      dir: inst?.dir ?? "",
      pid: owner.pid,
      startedAt: owner.startedAt,
      ownerId: owner.id,
      config: await activeConfigPath(),
      core: {
        api: API_VERSION,
        state: core?.state ?? "off",
        address: core?.address,
      },
      tuis: this.tuiList(),
      warnings: mismatches({
        installed: [inst?.version],
        server: version,
        tuis: this.tuiList(),
      }),
      drain: this.drain(),
    }
  }

  /** What is still pending, as counts. */
  drain(): Drain {
    const { questions, permissions, unverified } = this.o.bridge.drain()
    const approvals = this.approvals?.pending() ?? 0
    return {
      open: questions + approvals + permissions,
      questions,
      approvals,
      permissions,
      unverified,
    }
  }

  /** The text of `/version` in a chat. */
  async versionText(): Promise<string> {
    return chatLines(await this.versionReport(), this.now()).join("\n")
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
  heartbeat(tui: string, inputAt?: number, version?: string): void {
    const before = this.attached()
    this.tuis.set(tui, this.now())
    if (typeof version === "string" && version)
      this.tuiVersions.set(tui, version.slice(0, 40))
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
    void this.refreshInstalled(true).catch(() => {})
    tick(
      async () => void (await this.refreshInstalled()),
      this.o.scanMs ?? SCAN_MS,
    )
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
    if (
      (e.type === "session.execution.succeeded" ||
        e.type === "session.execution.failed") &&
      sessionID &&
      this.o.host.root(sessionID) === sessionID
    )
      this.night.turnEnded(sessionID, e.type.endsWith("succeeded"))
    if (
      e.type === "session.inbox.enqueued" &&
      sessionID &&
      isObject(d.item) &&
      d.item.type === "user"
    )
      this.night.prompted(this.o.host.root(sessionID))
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
    this.trackAway()
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
    await this.night.tick()
    if (this.night.pendingReport()) await this.o.bridge.nightDigest()
  }

  /** Notes when the operator starts counting as away, and tells what happened when they are back. */
  private trackAway(): void {
    const away = this.o.router.away()
    const now = this.now()
    if (away && !this.awaySince)
      this.awaySince = { at: now, counts: this.o.bridge.counts() }
    else if (!away && this.awaySince) {
      const { at, counts } = this.awaySince
      this.awaySince = undefined
      if (now - at < 60_000) return
      const c = this.o.bridge.counts()
      const n = (k: keyof typeof c) => c[k] - counts[k]
      const text = [
        `Away ${formatDuration(now - at)}: ${n("pushes")} push${n("pushes") === 1 ? "" : "es"} sent, ${n("answered")} question${n("answered") === 1 ? "" : "s"} answered from a chat, ${n("finished")} finished, ${n("failed")} failed.`,
        this.night.plan ? this.night.status() : "",
      ]
        .filter(Boolean)
        .join("\n")
      this.back = { id: (this.back?.id ?? 0) + 1, text, at: now }
      this.v++
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
    this.trackAway()
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
      versions: { installed: this.installed?.version, tuis: this.tuiList() },
      afk: {
        mode: router.afkMode(),
        away: router.away(),
        minutes: cfg.away.minutes,
        lastInputAt: router.lastInputAt(),
        tuis: this.attached(),
        until: router.afkEnds(),
      },
      night: this.night.view(),
      back:
        this.back && this.now() - this.back.at < 60_000 ? this.back : undefined,
      channels: st.channels.map((c) => ({
        id: c.id,
        enabled: c.enabled,
        pairing: this.cap(c.id, "pairing"),
        inboundPrompt: this.cap(c.id, "inboundPrompt"),
        connected: c.connected,
        lastError: c.lastError,
        warning: c.warning,
        pollOkAt: c.pollOkAt,
        sendOkAt: c.sendOkAt,
        silentMs: c.silentMs,
      })),
      pending: st.pending,
      drain: this.drain(),
      waiting: st.waiting,
      core: this.core && {
        state: this.core.status().state,
        address: this.core.status().address,
        reason: this.core.status().reason,
      },
      link: this.link?.status(),
      trace: traces.statLines(),
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

  /**
   * Approvals commands. Creating, replacing or deleting a key or a caller is
   * done here, from the TUI at the Mac: never from the socket or a chat.
   */
  private async approvalsOp(args: Record<string, unknown>): Promise<OpResult> {
    const svc = this.approvals
    const fail = (text: string) => this.done({ ok: false, text })
    if (!svc) return fail("Approvals are not running here")
    const action = str(args.action) ?? "status"
    if (action === "status")
      return this.done({ ok: true, data: await svc.status() })
    if (!this.o.cfg.approvals.enabled)
      return fail(
        "Set approvals.enabled to true in the config file, then restart the bridge",
      )
    const name = str(args.name)
    switch (action) {
      case "pair-caller": {
        if (!name) return fail("Name the caller")
        const r = await svc.pairCaller(name)
        return this.done({
          ok: true,
          text:
            `Caller ${name} paired: ${r.file}` +
            (r.listed
              ? ""
              : `. It is not under approvals.callers yet, so every request is refused`),
          data: r,
        })
      }
      case "revoke-caller": {
        if (!name) return fail("Name the caller")
        return (await svc.revokeCaller(name))
          ? this.done({ ok: true, text: `Caller ${name} revoked` })
          : fail(`No caller named ${name}`)
      }
      case "totp": {
        const r = await svc.enrollTotp(args.replace === true)
        return r === "exists"
          ? fail(
              "A code seed is enrolled already: choose replace to make a new one",
            )
          : this.done({
              ok: true,
              text: "Seed made: scan it now, it is not shown again",
              data: r,
            })
      }
      case "enroll-biometric":
      case "enroll-passkey": {
        if (!this.o.cfg.miniApp.url)
          return fail(
            "Set miniApp.url first: Face ID and passkeys are asked in the Mini App",
          )
        const kind = action === "enroll-biometric" ? "biometric" : "passkey"
        const r = await svc.openEnrolment(kind)
        return this.done({
          ok: true,
          text: `Enrolment open for 5 minutes: ${r.code}`,
          data: {
            kind,
            ...r,
            link: enrolLink(this.o.cfg.miniApp.link, r.code),
          },
        })
      }
      case "devices":
        return this.done({ ok: true, data: await svc.devices() })
      case "revoke-device": {
        if (!name) return fail("Name the device or credential id")
        return (await svc.revokeDevice(name))
          ? this.done({ ok: true, text: `Revoked ${name}` })
          : fail(`No device or passkey ${name}`)
      }
      case "rotate-key": {
        const hours = Number(args.hours ?? 24)
        if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 30)
          return fail("hours is 0 to 720")
        const r = await svc.rotateKey(hours * 3_600_000)
        return this.done({
          ok: true,
          text: `New signing key ${r.kid}; the old one verifies for ${hours} h`,
          data: r,
        })
      }
      case "unlock": {
        const r = await svc.unlock()
        return this.done({
          ok: r.signing || r.totp,
          text:
            r.signing || r.totp
              ? "Keychain items read"
              : "No keys yet: pair a caller first",
          data: r,
        })
      }
    }
    return fail("Unknown approvals command: " + action)
  }

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
          const span = str(args.for)
          const ms = span ? parseDuration(span) : undefined
          if (span && (mode !== "on" || !ms))
            return fail("A time (8h, 90m) goes with on only")
          const until = ms ? this.now() + ms : undefined
          router.setAfk(mode as Afk, until)
          settings.setAfk(mode as Afk, until)
          bridge.notify()
          return this.done({
            ok: true,
            text: "afk: " + mode + (span ? " for " + span : ""),
          })
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
        case "overnight": {
          const action = str(args.action) ?? "status"
          if (action === "add") {
            if (!root) return fail("add needs a session")
            const d = this.o.cfg.overnight.defaults
            const num = (k: string) =>
              typeof args[k] === "number" ? (args[k] as number) : undefined
            this.night.stage(
              root,
              brief({
                ...d,
                tasks: Array.isArray(args.tasks)
                  ? args.tasks.filter(
                      (t): t is string =>
                        typeof t === "string" && t.trim() !== "",
                    )
                  : [],
                scope: str(args.scope) ?? d.scope ?? "",
                maxTurns: num("maxTurns") ?? d.maxTurns,
                maxFailures: num("maxFailures") ?? d.maxFailures,
                answerAfter: num("answerAfter") ?? d.answerAfter,
                question:
                  args.question === "default" || args.question === "park"
                    ? args.question
                    : d.question,
              }),
            )
            return this.done({
              ok: true,
              text: "Brief saved for " + (this.title(root) ?? root),
            })
          }
          if (action === "clear") {
            this.night.unstage(root)
            return this.done({ ok: true, text: "Staged briefs cleared" })
          }
          if (action === "end") {
            const ended = await this.night.end("tui")
            return this.done({
              ok: ended,
              text: ended
                ? "Plan ended: nothing acts automatically now."
                : "No plan is running.",
            })
          }
          if (action === "start") {
            const until = parseUntil(str(args.until) ?? "", this.now())
            if (!until) return fail("start needs an end time: 07:00 or 8h")
            const out = await this.night.start(until, args.yes === true)
            if (out.ok) {
              router.setAfk("on", until)
              settings.setAfk("on", until)
              bridge.notify()
            }
            return this.done({ ok: out.ok, text: out.text, data: out.checks })
          }
          const checks =
            this.night.staged().length > 0 ? this.night.preflight() : []
          const mark = { ok: "✓", warning: "!", blocker: "✗" }
          return this.done({
            ok: true,
            text: [
              this.night.status(),
              ...checks.map(
                (c) =>
                  mark[c.level] +
                  " " +
                  (c.scope === "plan"
                    ? "plan"
                    : (this.title(c.scope) ?? c.scope)) +
                  ": " +
                  c.text,
              ),
            ].join("\n"),
            data: checks,
          })
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
        case "approvals":
          return await this.approvalsOp(args)
        case "version":
          return this.done({ ok: true, data: await this.versionReport() })
        case "trace":
          return this.done({
            ok: true,
            data: {
              lines: traces.format(
                typeof args.n === "number" ? args.n : Number(args.n) || 5,
              ),
            },
          })
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
