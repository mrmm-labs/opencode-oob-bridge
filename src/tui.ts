/**
 * TUI entry: a pilot of the bridge that runs in the OpenCode server (see
 * src/server.ts). It adds the `/oob` command and the sidebar, shows what the
 * server half reports, and sends it commands. It answers the question forms
 * the server cannot, because only a TUI has the form-reply call. Without a
 * config file it returns before making any request.
 */
import type { Plugin } from "@opencode/plugin/tui"
import { join } from "node:path"

import { dataDir, loadConfig } from "./config.ts"
import { log } from "./logger.ts"
import { commandIndex, runCommand, type App } from "./menu.ts"
import { Remote, formRelay, type Transport } from "./remote.ts"
import { RPC_ID } from "./rpc.ts"
import { SettingsStore } from "./settings.ts"
import { slashEntries } from "./subcommands.ts"
import { registerSidebar, type SidebarView } from "./sidebar.ts"

type Context = Plugin.Context

/** The route the TUI is on, as a top-level session. */
function currentRoot(ctx: Context): string | undefined {
  const route = ctx.ui.router.current()
  return route.type === "session"
    ? ctx.data.session.root(route.sessionID) || route.sessionID
    : undefined
}

/**
 * Loads the function that draws the sidebar block. It lives apart (`sidebar.tsx`)
 * because it needs the host's UI toolkit: if that cannot be loaded, the bridge
 * runs without a sidebar block.
 */
export type ViewLoader = () => Promise<SidebarView>

export async function setup(
  ctx: Context,
  loadView?: ViewLoader,
): Promise<(() => Promise<void>) | undefined> {
  // Registered before any await: OpenCode 2.3.2 ignores keymap layers
  // registered after setup has yielded, so /oob never appeared.
  let app: App | undefined
  // A layer defaults to the "base" input mode, which is inactive while the
  // prompt has focus, so slash completion never saw the command.
  ctx.keymap.layer(() => ({
    mode: "global",
    bindings: ["oob-bridge.route"],
    commands: [
      // `/oob-chat` and the like: the host completes only slash names.
      ...slashEntries(commandIndex(ctx), (line) => runCommand(ctx, app, line)),
      {
        id: "oob-bridge.route",
        title: "oob: settings, routing and channels",
        palette: true,
        slash: { name: "oob", aliases: ["ntfy"], arguments: true },
        run: (input) => runCommand(ctx, app, input),
      },
    ],
  }))

  const cfg = await loadConfig()
  if (!cfg) return undefined
  if ("error" in cfg) {
    log("config_error", { message: cfg.error })
    return undefined
  }

  const sidebar = loadView?.()
    .then((view) => registerSidebar(ctx, view))
    .catch((err: Error) => {
      log("sidebar_unavailable", { message: err.message })
      return undefined
    })

  // This window's own choices live apart from the server's settings: two writers would overwrite each other.
  const dir = dataDir()
  const settings = new SettingsStore(join(dir, "tui.json"))
  await settings.load()
  if (!settings.sidebar()) {
    const old = new SettingsStore(join(dir, "settings.json"))
    await old.load()
    const was = old.sidebar()
    if (was) settings.setSidebar(was)
  }

  const call: Transport = async (method, input) =>
    (
      await ctx.client.rpc.call({
        rpcID: RPC_ID,
        method,
        input: input as never,
      })
    ).output
  const remote = new Remote({
    call,
    roots: () => [currentRoot(ctx)].filter((r) => r !== undefined),
  })
  app = { pilot: remote, settings }

  const off = [
    ctx.data.on(
      ("rpc." + RPC_ID + ".form") as never,
      formRelay({
        id: remote.id,
        call,
        reply: (r) => ctx.data.session.form.reply(r as never),
        undo: (r) =>
          ctx.client.session.revert.stage({ ...r, files: true }).then(() => {}),
      }) as never,
    ),
  ]

  void sidebar?.then((s) => s?.attach(app!))
  await remote.start()
  log("tui_attached", { tui: remote.id })
  return async () => {
    for (const f of off) f()
    remote.stop()
    ;(await sidebar)?.dispose()
    await settings.flush()
  }
}

const plugin: Plugin.Definition = { id: "oob-bridge.tui", setup }

export default plugin
