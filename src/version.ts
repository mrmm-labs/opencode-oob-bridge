/**
 * Which plugin version is loaded where. `RUNNING` is read once, when this module
 * is loaded, so it is the code in memory: an upgrade on disk does not change it.
 * `readInstalled` reads the disk now. When the two differ, the host has to be
 * restarted.
 */
import { execFile } from "node:child_process"
import { access, readFile, realpath } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { configPath, legacy, legacyConfigPath } from "./paths.ts"
import type { Drain } from "./rpc.ts"

/** The install directory: the package root, one level above src/ and dist/. */
export const INSTALL_DIR = fileURLToPath(new URL("..", import.meta.url))

const versionOf = (text: string): string => {
  try {
    const v = (JSON.parse(text) as { version?: unknown }).version
    return typeof v === "string" && v ? v : "unknown"
  } catch {
    return "unknown"
  }
}

async function loadRunning(): Promise<string> {
  try {
    return versionOf(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    )
  } catch {
    return "unknown"
  }
}

/** The version this process loaded: read once, as the module loads, and never again. */
export const RUNNING: string = await loadRunning()

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

export type Installed = {
  version: string
  /** `git describe` of the install directory, when it is a checkout of its own. */
  describe?: string
  dir: string
}

const git = (dir: string, args: string[]) =>
  new Promise<string | undefined>((resolve) => {
    execFile("git", ["-C", dir, ...args], { timeout: 2000 }, (err, stdout) =>
      resolve(err ? undefined : stdout.trim() || undefined),
    )
  })

/** A directory inside someone else's repository (dotfiles, say) is not a checkout of the plugin. */
async function describeOf(dir: string): Promise<string | undefined> {
  const top = await git(dir, ["rev-parse", "--show-toplevel"])
  if (!top) return undefined
  const [a, b] = await Promise.all([
    realpath(top).catch(() => top),
    realpath(dir).catch(() => dir),
  ])
  if (a !== b) return undefined
  return git(dir, ["describe", "--tags", "--always", "--dirty"])
}

/** The package.json on disk now, and the git state of its directory. Never throws. */
export async function readInstalled(dir = INSTALL_DIR): Promise<Installed> {
  let version = "unknown"
  try {
    version = versionOf(await readFile(`${dir}/package.json`, "utf8"))
  } catch {}
  return { version, describe: await describeOf(dir), dir }
}

/** The config file this process reads: the default, the legacy name when only that exists, or the one named by the environment. */
export async function activeConfigPath(env = process.env): Promise<string> {
  const main = configPath(env)
  if (legacy(env, "CONFIG") || (await exists(main))) return main
  const old = legacyConfigPath(env)
  return (await exists(old)) ? old : main
}

export type Seen = {
  /** The versions on disk, one per install directory looked at. */
  installed: Array<string | undefined>
  /** What the server half runs. */
  server?: string
  /** What each attached TUI runs. */
  tuis: string[]
}

const unique = (xs: Array<string | undefined>) => [
  ...new Set(xs.filter((x): x is string => !!x && x !== "unknown")),
]

/**
 * One line for each place where two versions differ. The version on disk is the
 * reference: whatever runs something else is stale and needs the host restarted.
 * With no version on disk, the running parts are compared with each other.
 */
export function mismatches(s: Seen): string[] {
  const out: string[] = []
  const disk = unique(s.installed)
  if (disk.length > 1)
    out.push(
      `⚠ the install directories hold different versions (${disk.join(", ")})`,
    )
  const ref = disk[0]
  const parts: Array<[string, string]> = []
  if (s.server && s.server !== "unknown") parts.push(["the server", s.server])
  for (const t of unique(s.tuis)) parts.push(["a TUI", t])
  if (ref) {
    for (const [who, v] of parts)
      if (v !== ref)
        out.push(`⚠ ${who} runs ${v} but ${ref} is installed: restart OpenCode`)
  } else if (new Set(parts.map(([, v]) => v)).size > 1) {
    out.push(
      `⚠ the server and the TUI run different versions (${parts.map(([w, v]) => `${w} ${v}`).join(", ")}): restart OpenCode`,
    )
  }
  return out
}

/** What the server half reports about itself, for `/oob version` and `/version`. */
export type VersionReport = {
  running: string
  installed?: string
  describe?: string
  dir: string
  pid: number
  startedAt: number
  ownerId?: string
  config: string
  core: { api: string; state: string; address?: string }
  /** The version each attached TUI reported. */
  tuis: string[]
  warnings: string[]
  /** What is still pending, for a restart to wait on. */
  drain?: Drain
}

const drainLines = (d?: Drain): string[] =>
  d && (d.open > 0 || d.unverified > 0)
    ? [
        `Open: ${d.open} (questions ${d.questions}, approvals ${d.approvals}, permissions ${d.permissions})${d.unverified > 0 ? `, ${d.unverified} not confirmed by OpenCode` : ""}`,
      ]
    : []

const when = (ms: number) =>
  new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC"

/** How long, as "3d 4h", "3h 12m", "5m" or "40s". */
export function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return m > 0 ? `${m}m` : `${s}s`
}

/**
 * What `/version` says in a chat: versions and uptime. A chat is not a private place, so it holds no
 * path, pid, instance id or address; `/oob version` in the TUI has those.
 */
export function chatLines(r: VersionReport, now: number): string[] {
  const tuis = [...new Set(r.tuis)]
  return [
    `Running: ${r.running}`,
    `Installed: ${r.installed ?? "unknown"}${r.describe ? ` (git ${r.describe})` : ""}`,
    `TUI runs: ${tuis.length ? tuis.join(", ") : "no TUI attached"}`,
    `Up: ${span(now - r.startedAt)}`,
    ...drainLines(r.drain),
    ...(r.warnings.length ? r.warnings : ["All versions match."]),
  ]
}

/** The report as lines of text. `tui` is the half that is asking, when it is a TUI. */
export function reportLines(
  r: VersionReport,
  tui?: { running: string; installed?: Installed },
): string[] {
  const here = tui?.installed
  const lines = [
    `Installed: ${r.installed ?? "unknown"}${r.describe ? ` (git ${r.describe})` : ""}`,
  ]
  if (here && (here.version !== r.installed || here.dir !== r.dir))
    lines.push(
      `Installed for this TUI: ${here.version}${here.describe ? ` (git ${here.describe})` : ""}`,
    )
  lines.push(
    `Server runs: ${r.running}, pid ${r.pid}, started ${when(r.startedAt)}`,
    `Owner instance: ${r.ownerId ?? "unknown"}`,
  )
  if (tui) lines.push(`TUI runs: ${tui.running}`)
  else
    lines.push(
      `TUI runs: ${r.tuis.length ? [...new Set(r.tuis)].join(", ") : "no TUI attached"}`,
    )
  lines.push(
    `Config: ${r.config}`,
    `Core API: ${r.core.api}, ${r.core.state === "listening" ? `listening on ${r.core.address}` : r.core.state}`,
    ...drainLines(r.drain),
  )
  const warn = tui
    ? mismatches({
        installed: [r.installed, here?.version],
        server: r.running,
        tuis: [tui.running],
      })
    : r.warnings
  lines.push(...(warn.length ? warn : ["All versions match."]))
  return lines
}
