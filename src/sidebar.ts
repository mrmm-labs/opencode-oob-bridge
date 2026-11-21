/**
 * The OOB block at the top of the session sidebar: what it shows (a pure
 * function of the session's state), the dialog each row opens, what a pick does,
 * and the claim of the sidebar slot. Drawing is passed in as `view`, so this file
 * needs no UI toolkit: `sidebar.tsx` draws.
 */
import type { Plugin } from "@opencode/plugin/tui"

import type { Delivery, SidebarMode } from "./config.ts"
import { applyRouting, runCommand, sidebarMode, type App } from "./menu.ts"
import type { Pending } from "./pending.ts"
import type { Afk } from "./settings.ts"
import type { InstanceView } from "./view.ts"

type Context = Plugin.Context

export type RowId =
  | "notify"
  | "chat"
  | "replies"
  | "waiting"
  | "away"
  | "stuck"
  | "bridge"
export type Tone = "normal" | "muted" | "ok" | "warn"
export type Part = { text: string; tone: Tone }
export type Row = { id: RowId; label: string; value: string; tone: Tone }

export type SidebarModel =
  | { mode: "off" }
  | { mode: "compact"; parts: Part[] }
  | { mode: "full"; title: string; channel: string; rows: Row[] }

export type PendingItem = Pick<
  Pending,
  "id" | "kind" | "title" | "sessionID" | "askedAt"
>

export type SidebarState = {
  mode: "on" | "off" | "auto"
  /** The channel the session mirrors through: its own choice, or the default. */
  channel: string
  /** The session's own choice of channel, if it made one. */
  via?: string
  /** Ids of the channels of the plugin, for the routing choices. */
  channels: string[]
  /** `all`, or a channel, for a session that chose none. */
  defaultChannel: string
  chat: boolean
  /** Why `chat.deny` blocks chat, when it does. */
  blocked?: string
  /** Whether some selected channel can carry a chat at all. */
  chatCapable: boolean
  delivery: Delivery
  /** The session's delivery differs from `chat.delivery`. */
  override: boolean
  defaultDelivery: Delivery
  /** Minutes without input after which `when away` pushes. */
  awayMinutes: number
  pending: PendingItem[]
  now: number
  /** The bridge in the OpenCode server: running or not, and what it says of the instance. */
  bridge: BridgeState
}

export type BridgeState = {
  online: boolean
  pid?: number
  startedAt?: number
  afk?: Afk
  afkUntil?: number
  /** An overnight plan is running. */
  night?: boolean
  away?: boolean
  windows?: number
  /** The first enabled channel that is not connected or last failed. */
  problem?: string
  stuck: Array<{ id: string; title?: string; pending: number; since: number }>
}

export type Outcome = { ok: boolean; text: string }

export type Choice = {
  title: string
  value: string
  description?: string
  disabled?: boolean
}
export type DialogSpec = { title: string; options: Choice[]; current?: string }

export const TITLE = "OOB - Remote access"

export function sidebarState(app: App, root: string): SidebarState {
  const b = app.pilot
  return {
    mode: b.mode(root),
    channel: b.channelOf(root),
    via: b.channel(root),
    channels: b.connectors().map((c) => c.id),
    defaultChannel: b.defaultChannel(),
    chat: b.chatEnabled(root),
    blocked: b.chatBlocked(root),
    chatCapable: b.canChat(root),
    delivery: b.delivery(root),
    override: b.deliveryOverride(root) !== undefined,
    defaultDelivery: b.defaultDelivery(),
    awayMinutes: b.awayMinutes(),
    pending: b.openPromptList(root),
    now: Date.now(),
    bridge: bridgeState(b.instance(), b.status().channels),
  }
}

function bridgeState(
  i: InstanceView | undefined,
  channels: Array<{
    id: string
    enabled: boolean
    connected?: boolean
    lastError?: string
  }>,
): BridgeState {
  if (!i?.online) return { online: false, stuck: [] }
  return {
    problem: channels.find(
      (c) => c.enabled && (c.connected === false || c.lastError),
    )?.id,
    online: true,
    pid: i.owner?.pid,
    startedAt: i.owner?.startedAt,
    afk: i.afk?.mode,
    afkUntil: i.afk?.until,
    night:
      i.night !== undefined && !i.night.ended && i.night.until > Date.now(),
    away: i.afk?.away,
    windows: i.afk?.tuis,
    stuck: i.stuck,
  }
}

const MODE_TONE: Record<SidebarState["mode"], Tone> = {
  on: "ok",
  off: "muted",
  auto: "normal",
}

/** Whether the session's questions and notices are pushed. */
const notifyValue = (s: SidebarState) =>
  s.mode === "auto" ? "when away" : s.mode

const chatValue = (s: SidebarState) =>
  s.blocked ? "denied" : s.chat ? "on" : "off"

const chatTone = (s: SidebarState): Tone =>
  s.blocked ? "warn" : s.chat ? "ok" : "muted"

const repliesValue = (d: Delivery) =>
  d === "steer" ? "immediately" : "after turn"

const waitingValue = (s: SidebarState) => {
  const n = s.pending.length
  const word = s.pending.every((p) => p.kind === "question")
    ? "question"
    : "request"
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

const duration = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60
    ? `${m}m`
    : m < 2880
      ? `${Math.round(m / 60)}h`
      : `${Math.round(m / 1440)}d`
}

const afkValue = (b: BridgeState) =>
  `${b.away ? "away" : "here"} · ${b.afk ?? "auto"}${b.afkUntil ? ` · ${left(b.afkUntil - Date.now())} left` : ""}${b.night ? " · night" : ""}`

const left = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m >= 60
    ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
    : `${m}m`
}

const bridgeValue = (s: SidebarState) =>
  s.bridge.problem
    ? `${s.bridge.problem} error`
    : s.bridge.online
      ? `${s.bridge.pid}${s.bridge.startedAt !== undefined ? ` · up ${duration(s.now - s.bridge.startedAt)}` : ""}`
      : "offline"

/** Notify, then Chat and Replies when a channel can chat, Waiting when something waits, then the bridge itself. */
export function sidebarRows(s: SidebarState): Row[] {
  if (!s.bridge.online)
    return [{ id: "bridge", label: "Bridge", value: "offline", tone: "warn" }]
  const rows: Row[] = [
    {
      id: "notify",
      label: "Notify",
      value: notifyValue(s),
      tone: MODE_TONE[s.mode],
    },
  ]
  if (s.chatCapable)
    rows.push(
      { id: "chat", label: "Chat", value: chatValue(s), tone: chatTone(s) },
      {
        id: "replies",
        label: "Replies",
        value: repliesValue(s.delivery),
        tone: "normal",
      },
    )
  if (s.pending.length > 0)
    rows.push({
      id: "waiting",
      label: "Waiting",
      value: waitingValue(s),
      tone: "warn",
    })
  rows.push({
    id: "away",
    label: "Away",
    value: afkValue(s.bridge),
    tone: s.bridge.away ? "warn" : "normal",
  })
  if (s.bridge.stuck.length > 0)
    rows.push({
      id: "stuck",
      label: "Stuck",
      value: `${s.bridge.stuck.length} suspended`,
      tone: "warn",
    })
  rows.push({
    id: "bridge",
    label: "Bridge",
    value: bridgeValue(s),
    tone: s.bridge.problem ? "warn" : "muted",
  })
  return rows
}

/** The same facts on one line: `OOB - Remote · telegram · notify on · chat on ▾`. */
export function compactParts(s: SidebarState): Part[] {
  const dot: Part = { text: " · ", tone: "muted" }
  const parts: Part[] = [
    { text: "OOB - Remote", tone: "muted" },
    dot,
    s.bridge.online
      ? { text: s.channel, tone: "normal" }
      : { text: "bridge offline", tone: "warn" },
    dot,
    { text: `notify ${notifyValue(s)}`, tone: MODE_TONE[s.mode] },
  ]
  if (s.chatCapable)
    parts.push(dot, { text: `chat ${chatValue(s)}`, tone: chatTone(s) })
  if (s.pending.length > 0)
    parts.push(dot, { text: `${s.pending.length} waiting`, tone: "warn" })
  if (s.bridge.online && s.bridge.away)
    parts.push(dot, { text: "away", tone: "warn" })
  if (s.bridge.stuck.length > 0)
    parts.push(dot, { text: `${s.bridge.stuck.length} stuck`, tone: "warn" })
  parts.push({ text: " ▾", tone: "muted" })
  return parts
}

export function sidebarModel(s: SidebarState, mode: SidebarMode): SidebarModel {
  if (mode === "off") return { mode }
  if (mode === "compact") return { mode, parts: compactParts(s) }
  return { mode, title: TITLE, channel: s.channel, rows: sidebarRows(s) }
}

const age = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 1
    ? "just now"
    : m < 60
      ? `${m} min ago`
      : `${Math.round(m / 60)} h ago`
}

const short = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** Every option of a row, in plain words, with the current one named. */
export function rowDialog(s: SidebarState, row: RowId): DialogSpec {
  if (row === "notify")
    return {
      title: "Notify about this session",
      current: s.mode === "on" && s.via ? `on:${s.via}` : s.mode,
      options: [
        {
          title: "On — push questions and notices now",
          value: "on",
          description: `through ${s.defaultChannel}`,
        },
        ...s.channels.map((id) => ({
          title: `On via ${id} — push now, only through ${id}`,
          value: `on:${id}`,
        })),
        ...(s.channels.length > 1
          ? [
              {
                title: "On via all — push now, through every channel",
                value: "on:all",
              },
            ]
          : []),
        {
          title: `When away — after ${s.awayMinutes} min without input`,
          value: "auto",
          description: "and only for sessions the rules pick",
        },
        { title: "Off — never push this session", value: "off" },
      ],
    }
  if (row === "chat")
    return {
      title: s.blocked
        ? "Chat is blocked for this session"
        : "Write to this session from the channel",
      current: s.chat ? "on" : "off",
      options: [
        {
          title: "On — messages you send in its topic reach the session",
          value: "on",
          disabled: s.blocked !== undefined,
          description: s.blocked
            ? `Blocked by chat.deny in the config (${s.blocked})`
            : undefined,
        },
        { title: "Off — take no messages", value: "off" },
      ],
    }
  if (row === "replies")
    return {
      title: "How your messages arrive",
      current: s.override ? s.delivery : "default",
      options: [
        {
          title: "Immediately — join the running turn",
          value: "steer",
        },
        {
          title: "After turn — wait for the current turn to finish",
          value: "queue",
        },
        {
          title: `Default — follow the config (${repliesValue(s.defaultDelivery)})`,
          value: "default",
        },
      ],
    }
  if (row === "away")
    return {
      title: "When are you away?",
      current: s.bridge.afk ?? "auto",
      options: [
        {
          title: `Auto — away after ${s.awayMinutes} min without input in any window`,
          value: "auto",
        },
        { title: "Away — push as if you were not here", value: "on" },
        { title: "Here — never count as away", value: "off" },
      ],
    }
  if (row === "stuck")
    return {
      title: "Suspended with messages waiting: pick one to resume it",
      options: s.bridge.stuck.map((x) => ({
        title: short(x.title ?? x.id, 60),
        value: x.id,
        description: `${x.pending} waiting, ${age(s.now - x.since)}`,
      })),
    }
  if (row === "bridge")
    return {
      title: s.bridge.online
        ? `The bridge runs in the OpenCode server (pid ${s.bridge.pid})`
        : "The bridge is not running in the OpenCode server",
      options: s.bridge.online
        ? [{ title: "Restart the bridge (not the server)", value: "restart" }]
        : [],
    }
  return {
    title: "Open questions: pick one to go to its session",
    options: s.pending.map((p) => ({
      title: short(`${p.kind}: ${p.title}`, 60),
      value: p.id,
      description: age(s.now - p.askedAt),
    })),
  }
}

/** What a pick does. `go` moves the TUI to a session and says whether it could. */
export async function applyPick(
  app: App,
  root: string,
  row: RowId,
  value: string,
  go: (sessionID: string) => boolean,
): Promise<Outcome> {
  const b = app.pilot
  if (row === "notify") {
    const [mode, channel] = value.split(":") as [string, string | undefined]
    if (mode !== "on" && mode !== "off" && mode !== "auto")
      return { ok: false, text: "Unknown choice." }
    if (
      channel !== undefined &&
      channel !== "all" &&
      !b.connectors().some((c) => c.id === channel)
    )
      return { ok: false, text: `No channel "${channel}".` }
    const out = await applyRouting(app, root, mode, channel)
    if (!out.ok) return out
    return {
      ok: true,
      text:
        mode === "on"
          ? `Notify on via ${b.channelOf(root)}`
          : mode === "auto"
            ? "Notify when away"
            : "Notify off",
    }
  }
  if (row === "chat") {
    if (value !== "on" && value !== "off")
      return { ok: false, text: "Unknown choice." }
    return b.setChat(root, value === "on")
  }
  if (row === "replies") {
    if (value !== "queue" && value !== "steer" && value !== "default")
      return { ok: false, text: "Unknown choice." }
    const out = await b.setDelivery(
      root,
      value === "default" ? undefined : value,
    )
    if (!out.ok) return out
    return { ok: true, text: `Replies: ${repliesValue(b.delivery(root))}` }
  }
  if (row === "away") {
    if (value !== "auto" && value !== "on" && value !== "off")
      return { ok: false, text: "Unknown choice." }
    return b.setAfk(value)
  }
  if (row === "stuck") return b.resume(value)
  if (row === "bridge")
    return value === "restart"
      ? b.restart()
      : { ok: false, text: "Unknown choice." }
  const p = b.openPromptList(root).find((x) => x.id === value)
  if (!p) return { ok: false, text: "That prompt is no longer open." }
  return go(p.sessionID)
    ? { ok: true, text: "Opened the session." }
    : { ok: false, text: "That session cannot be opened from here." }
}

/** What a drawing function is given for one sidebar. */
export type SidebarView = (p: {
  /** Re-read on every change. */
  model: () => SidebarModel
  /** Calls `fn` on every change; returns the way to stop. */
  subscribe: (fn: () => void) => () => void
  /** A row was clicked: opens its dialog. */
  open: (row: RowId) => void
  /** The compact line was clicked: opens `/oob`. */
  openMenu: () => void
  colors: () => Record<Tone, unknown>
}) => unknown

// V2 theme leaves are a colour or a { base, ... } state set.
const leaf = (v: unknown) =>
  v && typeof v === "object" && "base" in v ? (v as { base: unknown }).base : v

export function toneColors(ctx: Context): Record<Tone, unknown> {
  // `theme` is optional in the plugin typings, so it is read loosely.
  const t = (ctx as unknown as { theme?: Record<string, any> }).theme
  return {
    normal: leaf(t?.text?.base),
    muted: leaf(t?.text?.muted),
    ok: leaf(t?.text?.feedback?.success),
    warn: leaf(t?.text?.feedback?.warning),
  }
}

/**
 * Claims the top of the session sidebar. Safe to call before the bridge exists:
 * the block stays empty until `attach`.
 */
export function registerSidebar(
  ctx: Context,
  view: SidebarView,
): { attach(app: App): void; dispose(): void } {
  let app: App | undefined
  let off: (() => void) | undefined
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((fn) => fn())
  const rootOf = (id: string) => ctx.data.session.root(id) || id
  const toast = (out: Outcome) =>
    ctx.ui.toast.show({
      message: out.text,
      variant: out.ok ? "success" : "warning",
    })
  const failed = () =>
    ctx.ui.toast.show({
      message: "That did not work: see the log.",
      variant: "error",
    })
  const go = (id: string) => {
    if (!ctx.data.session.get(id)) return false
    ctx.ui.router.navigate({ type: "session", sessionID: id })
    return true
  }

  const release = ctx.ui.slot({
    // First in the sidebar: before the sections other plugins append.
    prepend: "sidebar.content",
    render: (input) =>
      view({
        model: () => {
          const root = rootOf(input.sessionID)
          return app && root
            ? sidebarModel(sidebarState(app, root), sidebarMode(app))
            : { mode: "off" }
        },
        subscribe: (fn) => {
          listeners.add(fn)
          return () => void listeners.delete(fn)
        },
        open: (row) => {
          const a = app
          if (!a) return
          const root = rootOf(input.sessionID)
          const spec = rowDialog(sidebarState(a, root), row)
          if (spec.options.length === 0) return
          void ctx.ui.dialog
            .select<string>({
              title: spec.title,
              current: spec.current,
              options: spec.options,
            })
            .then((value) =>
              value === undefined
                ? undefined
                : applyPick(a, root, row, value, go).then(toast),
            )
            .catch(failed)
        },
        openMenu: () => {
          const a = app
          if (a) void runCommand(ctx, a).catch(failed)
        },
        colors: () => toneColors(ctx),
      }) as never,
  })

  return {
    attach(next) {
      off?.()
      app = next
      off = next.pilot.subscribe(emit)
      emit()
    },
    dispose() {
      off?.()
      listeners.clear()
      release()
    },
  }
}
