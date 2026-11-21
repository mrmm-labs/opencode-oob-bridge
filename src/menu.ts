/** What the `/oob` sub-commands do; which ones there are is in `buildCommands`. */
import type { Plugin } from "@opencode/plugin/tui"

import type { Delivery, SidebarMode } from "./config.ts"
import { renderQr } from "./qr.ts"
import type { Afk, SettingsStore } from "./settings.ts"
import type { ChannelView, Outcome, Pilot } from "./view.ts"
import { rowDialog, sidebarState, TITLE } from "./sidebar.ts"
import {
  dispatch,
  helpText,
  sub,
  type Option,
  type SubCommand,
  type Ui,
} from "./subcommands.ts"

type Context = Plugin.Context

export type App = {
  pilot: Pilot
  /** This window's own choices (the sidebar size). */
  settings: Pick<SettingsStore, "sidebar" | "setSidebar">
}

/** Connectors that can bind to a chat. */
const pairable = (app: App) =>
  app.pilot.connectors().filter((c) => c.capabilities.pairing && c.pair)

const find = (app: App, name: string) =>
  app.pilot.connectors().find((c) => c.id.toLowerCase() === name.toLowerCase())

const toast = (
  ctx: Context,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
) => ctx.ui.toast.show({ message, variant })

function sessionRoot(ctx: Context): string | undefined {
  const route = ctx.ui.router.current()
  return route.type === "session"
    ? ctx.data.session.root(route.sessionID) || route.sessionID
    : undefined
}

function setRouting(
  ctx: Context,
  app: App,
  mode: "on" | "off" | "auto",
  channel?: string,
) {
  const root = sessionRoot(ctx)
  if (!root) return toast(ctx, "Open a session first", "warning")
  const ids = app.pilot.connectors().map((c) => c.id)
  if (channel !== undefined && channel !== "all") {
    const c = find(app, channel)
    if (!c)
      return toast(
        ctx,
        `No channel "${channel}" (use ${["all", ...ids].join(", ")})`,
        "warning",
      )
    channel = c.id
  }
  return applyRouting(app, root, mode, channel).then((out) =>
    toast(
      ctx,
      out.ok ? `oob routing: ${describe(app, root)}` : out.text,
      out.ok ? "info" : "warning",
    ),
  )
}

/** Sets the routing of a session and keeps it. */
export function applyRouting(
  app: App,
  root: string,
  mode: "on" | "off" | "auto",
  channel?: string,
): Promise<Outcome> {
  return app.pilot.route(root, mode, channel)
}

/** How big the sidebar block is: the TUI choice, else the config's. */
export function sidebarMode(app: App): SidebarMode {
  return app.settings.sidebar() ?? app.pilot.defaultSidebar()
}

export function setSidebarMode(app: App, mode: SidebarMode): void {
  app.settings.setSidebar(mode)
  app.pilot.notify()
}

async function setDelivery(ctx: Context, app: App, d: Delivery | undefined) {
  const root = sessionRoot(ctx)
  if (!root) return toast(ctx, "Open a session first", "warning")
  const out = await app.pilot.setDelivery(root, d)
  if (!out.ok) return toast(ctx, out.text, "warning")
  toast(ctx, `Delivery for this session: ${app.pilot.delivery(root)}`)
}

async function setChat(ctx: Context, app: App, on: boolean): Promise<void> {
  const root = sessionRoot(ctx)
  if (!root) return toast(ctx, "Open a session first", "warning")
  const out = await app.pilot.setChat(root, on)
  toast(ctx, out.text, out.ok ? "success" : "warning")
}

const describe = (app: App, root: string) => {
  const via = app.pilot.channel(root)
  const base =
    app.pilot.mode(root) === "on" && via
      ? `on via ${via}`
      : app.pilot.mode(root)
  return app.pilot.chatEnabled(root) ? `${base}, chat on` : base
}

const SESSION = "Open a session first"
const needSession = (ctx: Context) => (sessionRoot(ctx) ? undefined : SESSION)

const onOff = (): Option[] => [
  { value: "on", title: "On" },
  { value: "off", title: "Off" },
]

/** Every `/oob` sub-command. The typed form, the picker, help and the README read this list. */
export function buildCommands(ctx: Context, app: App): SubCommand[] {
  const root = () => sessionRoot(ctx)!
  const dialog = (row: "chat" | "replies") => () =>
    rowDialog(sidebarState(app, root()), row)
  const channelIds = () => app.pilot.connectors().map((c) => c.id)
  const cmds: SubCommand[] = [
    sub({
      name: "on",
      title: "Notify: on",
      description:
        "Push this session's questions and notices now, through one channel or all.",
      group: "This session",
      unavailable: () => needSession(ctx),
      args: [
        {
          name: "channel",
          kind: "enum",
          title: "Push through which channel?",
          placeholder: "channel|all",
          optional: true,
          noneTitle: "Default channel",
          options: () => [
            ...channelIds().map((id) => ({
              value: id,
              title: id,
              description: `push now, only through ${id}`,
            })),
            ...(channelIds().length > 1
              ? [
                  {
                    value: "all",
                    title: "all",
                    description: "push now, through every channel",
                  },
                ]
              : []),
          ],
          current: () => app.pilot.channel(root()),
        },
      ],
      run: (v) => setRouting(ctx, app, "on", v.channel),
    }),
    sub({
      name: "off",
      title: "Notify: off",
      description: "Never push this session.",
      group: "This session",
      unavailable: () => needSession(ctx),
      run: () => setRouting(ctx, app, "off"),
    }),
    sub({
      name: "auto",
      title: "Notify: when away",
      description:
        "Push this session after the away time without input, if the rules pick it.",
      group: "This session",
      unavailable: () => needSession(ctx),
      run: () => setRouting(ctx, app, "auto"),
    }),
    sub({
      name: "chat",
      title: "Chat",
      description:
        "Let messages in the session's topic reach it, or stop taking them.",
      group: "This session",
      unavailable: () => needSession(ctx),
      args: [
        {
          name: "state",
          kind: "enum",
          title: "Write to this session from the channel",
          placeholder: "on|off",
          options: () => dialog("chat")().options,
          current: () => dialog("chat")().current,
        },
      ],
      run: (v) => setChat(ctx, app, v.state === "on"),
    }),
    sub({
      name: "delivery",
      title: "Replies",
      description:
        "How your messages from a channel reach a busy session: queue, steer, or the config's default.",
      group: "This session",
      unavailable: () => needSession(ctx),
      args: [
        {
          name: "mode",
          kind: "enum",
          title: "How your messages arrive",
          placeholder: "queue|steer|default",
          options: () => dialog("replies")().options,
          current: () => dialog("replies")().current,
        },
      ],
      run: (v) =>
        setDelivery(
          ctx,
          app,
          v.mode === "default" ? undefined : (v.mode as Delivery),
        ),
    }),
    sub({
      name: "channel",
      title: "Switch a channel",
      description:
        "Turn a channel on or off for every session; kept across restarts.",
      group: "Channels",
      args: [
        {
          name: "name",
          kind: "enum",
          title: "Which channel?",
          placeholder: "channel",
          options: () =>
            app.pilot.status().channels.map((c) => ({
              value: c.id,
              title: c.id,
              description: c.enabled ? "on" : "off",
            })),
        },
        {
          name: "state",
          kind: "enum",
          title: "Turn it",
          placeholder: "on|off",
          options: () => onOff(),
          current: (g) =>
            app.pilot.status().channels.find((c) => c.id === g.name)?.enabled
              ? "on"
              : "off",
        },
      ],
      run: async (v) => {
        const out = await app.pilot.setEnabled(v.name!, v.state === "on")
        toast(
          ctx,
          out.ok ? `${v.name}: ${v.state}` : out.text,
          out.ok ? "info" : "warning",
        )
      },
    }),
    sub({
      name: "pair",
      title: "Pair a channel",
      description:
        "Show the code or link that binds a channel to a chat (the name can be left out when only one can pair).",
      group: "Channels",
      unavailable: () =>
        pairable(app).length === 0
          ? "No channel can be paired: add one that supports it to the config file"
          : undefined,
      args: [
        {
          name: "channel",
          kind: "enum",
          title: "Pair which channel?",
          placeholder: "channel",
          options: () =>
            pairable(app).map((c) => ({ value: c.id, title: c.id })),
          default: () =>
            pairable(app).length === 1 ? pairable(app)[0].id : undefined,
        },
      ],
      // The command returns at once; the dialog closes by itself when pairing ends.
      run: async (v) => void (await pair(ctx, app, find(app, v.channel!))),
    }),
    sub({
      name: "test",
      title: "Send test push",
      description: "Push a test message through every enabled channel.",
      group: "Channels",
      run: () => test(ctx, app),
    }),
    sub({
      name: "sidebar",
      title: "Sidebar section",
      description:
        "How big the section in the session sidebar is: full, compact or off.",
      group: "Plugin",
      args: [
        {
          name: "size",
          kind: "enum",
          title: "Sidebar section",
          placeholder: "full|compact|off",
          options: () => [
            {
              value: "full",
              title: "full",
              description: "a row each for notify, chat, replies",
            },
            {
              value: "compact",
              title: "compact",
              description: "one line; click it to open /oob",
            },
            { value: "off", title: "off", description: "no section" },
          ],
          current: () => sidebarMode(app),
        },
      ],
      run: (v) => {
        setSidebarMode(app, v.size as SidebarMode)
        toast(ctx, `Sidebar block: ${v.size}`)
      },
    }),
    sub({
      name: "afk",
      title: "Away: any window",
      description:
        "When you count as away, for the whole OpenCode instance: on, off, or auto after the away time without input in any window.",
      group: "Instance",
      args: [
        {
          name: "state",
          kind: "enum",
          title: "Count me as away",
          placeholder: "on|off|auto",
          options: () => [
            {
              value: "auto",
              title: "Auto",
              description: `after ${app.pilot.awayMinutes()} min without input in any window`,
            },
            { value: "on", title: "On", description: "away now: push" },
            { value: "off", title: "Off", description: "here: never away" },
          ],
          current: () => app.pilot.instance()?.afk?.mode,
        },
      ],
      run: async (v) => {
        const out = await app.pilot.setAfk(v.state as Afk)
        toast(
          ctx,
          out.ok ? `Away: ${v.state}` : out.text,
          out.ok ? "success" : "warning",
        )
      },
    }),
    sub({
      name: "session",
      title: "Another session",
      description:
        "Notify and chat settings of any session of this instance: on, off, auto, chat or chat-off.",
      group: "Instance",
      args: [
        {
          name: "id",
          kind: "enum",
          title: "Which session?",
          placeholder: "session",
          options: () =>
            (app.pilot.instance()?.sessions ?? []).map((s) => ({
              value: s.id,
              title: s.name ?? s.title ?? s.id,
              description: `${s.mode}${s.chat ? ", chat on" : ""}${s.busy ? ", working" : ""}`,
            })),
        },
        {
          name: "action",
          kind: "enum",
          title: "Do what?",
          placeholder: "on|off|auto|chat|chat-off",
          options: () => [
            { value: "on", title: "Notify: on" },
            { value: "off", title: "Notify: off" },
            { value: "auto", title: "Notify: when away" },
            { value: "chat", title: "Chat: on" },
            { value: "chat-off", title: "Chat: off" },
          ],
          current: (g) => {
            const s = app.pilot.instance()?.sessions.find((x) => x.id === g.id)
            return s?.mode
          },
        },
      ],
      run: async (v) => {
        const id = v.id!
        const out =
          v.action === "chat" || v.action === "chat-off"
            ? await app.pilot.setChat(id, v.action === "chat")
            : await app.pilot.route(id, v.action as "on" | "off" | "auto")
        toast(
          ctx,
          out.text || `${v.action}: done`,
          out.ok ? "success" : "warning",
        )
      },
    }),
    sub({
      name: "resume",
      title: "Resume a session",
      description:
        "Wake a session that is suspended with messages waiting in its inbox.",
      group: "Instance",
      unavailable: () =>
        (app.pilot.instance()?.stuck.length ?? 0) === 0
          ? "No session is suspended with messages waiting"
          : undefined,
      args: [
        {
          name: "id",
          kind: "enum",
          title: "Resume which session?",
          placeholder: "session",
          options: () =>
            (app.pilot.instance()?.stuck ?? []).map((s) => ({
              value: s.id,
              title: s.title ?? s.id,
              description: `${s.pending} waiting`,
            })),
        },
      ],
      run: async (v) => {
        const out = await app.pilot.resume(v.id!)
        toast(ctx, out.text || "Resumed", out.ok ? "success" : "warning")
      },
    }),
    sub({
      name: "restart",
      title: "Restart the bridge",
      description:
        "Restart the bridge in the OpenCode server: channels reconnect. The server keeps running.",
      group: "Instance",
      run: async () => {
        const out = await app.pilot.restart()
        toast(ctx, out.text || "Done", out.ok ? "success" : "warning")
      },
    }),
    sub({
      name: "core",
      title: "Core API",
      description:
        "Show the core API (address and token file), or replace its token: the old token is refused at once.",
      group: "Instance",
      args: [
        {
          name: "action",
          kind: "enum",
          title: "Core API",
          placeholder: "status|rotate",
          options: () => [
            {
              value: "status",
              title: "Status",
              description: "address and token file",
            },
            {
              value: "rotate",
              title: "Rotate token",
              description: "show a new token once",
            },
          ],
        },
      ],
      run: async (v) => {
        const out = await app.pilot.core(
          v.action === "rotate" ? "rotate" : "status",
        )
        const d = (out?.data ?? {}) as {
          state?: string
          address?: string
          reason?: string
          tokenFile?: string
          token?: string
        }
        if (!out?.ok) return toast(ctx, out?.text ?? "No answer", "warning")
        await ctx.ui.dialog.alert({
          title: `${TITLE}: core API`,
          message: [
            d.state === "listening"
              ? `Listening on ${d.address}`
              : `Not listening: ${d.reason}`,
            `Token file: ${d.tokenFile}`,
            ...(d.token ? ["", "New token (shown once):", d.token] : []),
          ].join("\n"),
        })
      },
    }),
    sub({
      name: "status",
      title: "Status",
      description:
        "Show the bridge, who counts as away, each channel, the open prompts and this session's settings.",
      group: "Plugin",
      run: () => status(ctx, app),
    }),
  ]
  cmds.push(
    sub({
      name: "help",
      title: "Help",
      description: "List every sub-command with its usage.",
      group: "Plugin",
      run: () =>
        ctx.ui.dialog.alert({
          title: `${TITLE}: commands`,
          message: helpText(cmds),
        }),
    }),
  )
  return cmds
}

/** Only names, titles and usage are read from this list: no session or app is needed. */
export const commandIndex = (ctx: Context): SubCommand[] =>
  buildCommands(ctx, undefined as unknown as App)

const uiOf = (ctx: Context): Ui => ({
  select: (o) => ctx.ui.dialog.select(o as never),
  prompt: (o) => ctx.ui.dialog.prompt(o),
  toast: (message, variant = "info") => toast(ctx, message, variant),
})

/** `/oob` with what was typed after it: nothing opens the picker. */
export async function runCommand(
  ctx: Context,
  app: App | undefined,
  input?: string,
): Promise<void> {
  if (!app)
    return toast(
      ctx,
      "oob bridge is not configured or still starting",
      "warning",
    )
  app.pilot.touch()
  await dispatch(uiOf(ctx), TITLE, buildCommands(ctx, app), input)
}

async function test(ctx: Context, app: App): Promise<void> {
  const results = await app.pilot.test()
  if (results.length === 0)
    return toast(ctx, "No channel is enabled", "warning")
  toast(
    ctx,
    `Test push: ${results.map((r) => `${r.id} ${r.ok ? "sent" : "failed"}`).join(", ")}`,
    results.every((r) => r.ok) ? "success" : "error",
  )
}

const ago = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 1
    ? "just now"
    : m < 60
      ? `${m} min ago`
      : `${Math.round(m / 60)} h ago`
}

function instanceLines(app: App): string[] {
  const i = app.pilot.instance()
  if (!i?.online)
    return [
      "Bridge: not running in the OpenCode server (is the plugin installed for the server, and oob-bridge.jsonc valid?)",
    ]
  const o = i.owner
  const lines = [
    `Bridge: running in the server, pid ${o?.pid}, v${o?.version}, up ${o ? ago(Date.now() - o.startedAt).replace(" ago", "") : "?"}`,
  ]
  if (i.core && i.core.state !== "off")
    lines.push(
      i.core.state === "listening"
        ? `Core API: listening on ${i.core.address}`
        : `Core API: not listening (${i.core.reason})`,
    )
  if (i.afk)
    lines.push(
      `Away: ${i.afk.away ? "away" : "here"} (${i.afk.mode}), ${i.afk.tuis} window${i.afk.tuis === 1 ? "" : "s"}, last input ${ago(Date.now() - i.afk.lastInputAt)}`,
    )
  for (const s of i.stuck)
    lines.push(
      `Suspended: ${s.title ?? s.id} (${s.pending} waiting, ${ago(Date.now() - s.since)})`,
    )
  const watched = i.sessions.filter((s) => s.mode !== "auto" || s.chat)
  if (watched.length > 0)
    lines.push(
      `Sessions: ${watched.map((s) => `${s.name ?? s.title ?? s.id} (${s.mode}${s.chat ? ", chat" : ""})`).join(", ")}`,
    )
  return lines
}

async function status(ctx: Context, app: App): Promise<void> {
  await app.pilot.refresh()
  const st = app.pilot.status()
  const root = sessionRoot(ctx)
  const lines = instanceLines(app)
  lines.push("")
  lines.push(
    ...st.channels.map((c) => {
      const state = !c.enabled
        ? "off"
        : c.connected === undefined
          ? "on"
          : c.connected
            ? "on, connected"
            : "on, not connected"
      return [
        `${c.id}: ${state}${c.lastError ? ` (last error: ${c.lastError})` : ""}`,
        ...(c.warning ? [`  ⚠ ${c.warning}`] : []),
      ].join("\n")
    }),
  )
  lines.push(`Open prompts: ${st.pending}`)
  if (root) lines.push(`This session: ${describe(app, root)}`)
  await ctx.ui.dialog.alert({
    title: `${TITLE} status`,
    message: lines.join("\n"),
  })
}

/** Resolves to a promise that settles when the pairing dialog closes. */
async function pair(
  ctx: Context,
  app: App,
  c: ChannelView | undefined,
): Promise<Promise<void> | undefined> {
  if (!c?.capabilities.pairing || !c.pair)
    return void toast(
      ctx,
      c
        ? `${c.id} has no pairing`
        : "No channel can be paired: add one that supports it to the config file",
      "warning",
    )
  const p = await app.pilot.pair(c.id)
  if (!p)
    return void toast(ctx, `${c.id}: pairing failed, see the log`, "error")
  const lines = [`Pair ${c.id} with OpenCode.`]
  if (p.hint) lines.push(p.hint)
  if (p.link) {
    const qr = renderQr(p.link)
    const w = terminal(ctx)
    // Dialog padding, title and the lines below the code.
    if (!w || (w.cols >= qr.width + 10 && w.rows >= qr.height + 14))
      lines.push("", "Scan with your phone camera:", ...qr.lines)
    lines.push("", "Or open this link:", p.link)
  }
  for (const l of p.links ?? []) lines.push("", `${l.label}:`, l.url)
  const minutes = Math.max(1, Math.round((p.expiresAt - Date.now()) / 60_000))
  lines.push(
    "",
    `Or send this code: ${p.code}`,
    `It works once and expires in ${minutes} minutes.`,
  )
  let open = true
  const closed = ctx.ui.dialog
    .alert({ title: `Pair ${c.id}`, message: lines.join("\n") })
    .then(() => {
      open = false
    })
  void p.done.then((ok) => {
    if (open) ctx.ui.dialog.clear()
    if (ok) toast(ctx, `${c.id} paired`, "success")
    else toast(ctx, "Pairing code expired", "warning")
  })
  return closed
}

/** Terminal size when the renderer reports it. */
function terminal(ctx: Context): { cols: number; rows: number } | undefined {
  const r = (ctx.renderer ?? {}) as unknown as Record<string, unknown>
  const cols = Number(r.width ?? r.terminalWidth ?? process.stdout.columns)
  const rows = Number(r.height ?? r.terminalHeight ?? process.stdout.rows)
  return cols > 0 && rows > 0 ? { cols, rows } : undefined
}
