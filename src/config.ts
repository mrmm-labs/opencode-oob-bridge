import { readFile } from "node:fs/promises"

import { parseApprovals, type ApprovalsConfig } from "./approvals/config.ts"
import { legacyConfigPath, configPath, legacy } from "./paths.ts"
import { connectorTypes } from "./connectors/index.ts"
import { parseRedact, type Redact } from "./filter.ts"
import { DEFAULT_INTERVAL_S } from "./deadman.ts"
import {
  BREAKTHROUGH,
  parseClock,
  validZone,
  type QuietHours,
} from "./quiet.ts"
import { DEFAULT_EXCLUDE, type DiffTheme } from "./diffimage.ts"
import { WAKE_KINDS, type Brief, type WakeKind } from "./overnight.ts"
import { DEFAULT_MIN_SECONDS } from "./turncard.ts"
import { parseJsonc } from "./jsonc.ts"
import { parseTokenSource, TOKEN_ERROR, type TokenSource } from "./token.ts"
import {
  parseFormats,
  parseProfiles,
  type Formats,
  type Profile,
} from "./messages.ts"
import type { OtelTarget } from "./otel.ts"
import { isArgv, isObject, URL_RE } from "./util.ts"

export type Rule = {
  agent?: RegExp
  directory?: string
  command?: string[]
}

/** One configured connector instance. */
export type ChannelConfig = {
  /** Key in `connectorTypes`. */
  type: string
  enabled: boolean
  /** What the connector type's `parse` made of the instance's config. */
  options: unknown
}

export type Delivery = "queue" | "steer"

/** The OOB block of the session sidebar: all rows, one line, or nothing. */
export type SidebarMode = "full" | "compact" | "off"
export const SIDEBAR_MODES: readonly SidebarMode[] = ["full", "compact", "off"]

export const MIN_STREAM_MS = 800
const DEFAULT_STREAM_MS = 1000
export const DEFAULT_STREAM_BUDGET = 30

/** Chat from a connector into a session. */
export type ChatConfig = {
  /** Sessions where chat stays off even after `/oob chat on`. */
  deny: Array<{ agent?: RegExp; directory?: string }>
  /** `replies`: every final reply of a chat-enabled session is posted; `remote-only`: only the turns started from the connector. */
  mirror: "replies" | "remote-only"
  /** Show a reply being written, in one message edited as it grows. */
  stream: boolean
  /** Shortest time between two edits of a streamed reply, in ms. */
  streamMs: number
  /** Most edits (and sends) a minute while a reply streams. */
  streamBudget: number
  /** How a prompt reaches a session that is working: `queue` waits for the turn to end, `steer` is injected into it. */
  delivery: Delivery
  /** Applied to chat replies instead of `redact`: a reply cut at a prompt's preview length is unreadable. Default `full`. */
  redact: Redact
  /** The folders a session can be started in from a chat, by name. Empty: starting sessions from a chat is off. */
  projects: Record<
    string,
    { directory: string; agent?: string; model?: string }
  >
  /** `provider/model` ids offered by /model. Empty: the models OpenCode lists, a dozen at most. */
  models: string[]
}

export type Config = {
  /** By instance name. */
  channels: Record<string, ChannelConfig>
  /** `all`, or the name of a channel, for a session that chose none. */
  defaultChannel: string
  away: { minutes: number }
  /** The core API listener: off unless `bind` is set. */
  core: { bind?: string; port: number }
  /** The dead-man heartbeat: off unless `url` is set. */
  deadman: { url?: string; token?: TokenSource; intervalSeconds: number }
  link: { url?: string; secret?: TokenSource }
  /** Approvals for local tools over a unix socket: off unless `enabled`. */
  approvals: ApprovalsConfig
  /** The card posted when a turn ends with changes or after a long turn. */
  turnCard: { enabled: boolean; minSeconds: number }
  /** Whether a permission can be answered from a channel: never, Allow once and Deny, or also Always. */
  permissions: { remote: "off" | "once" | "all" }
  diff: { exclude: string[]; theme: DiffTheme }
  overnight: {
    /** Kinds that notify with sound during a plan. */
    wake: WakeKind[]
    maxResumes: number
    defaults: Partial<Brief>
  }
  /** Silent delivery between two clock times: off unless set. */
  quiet?: QuietHours
  /** One summary message a day: off unless set. `at` is minutes after local midnight. */
  digest?: { at: number; empty: boolean }
  rules: Rule[]
  redact: Redact
  chat: ChatConfig
  /** Default for the sidebar block; a choice made in the TUI wins. */
  sidebar: SidebarMode
  messages: Formats
  profiles: Profile[]
  /** Set when `otel.endpoint` is; the environment may still turn telemetry on. */
  otel?: OtelTarget
}

function parseQuiet(raw: unknown): QuietHours | undefined | { error: string } {
  if (raw === undefined) return undefined
  if (!isObject(raw)) return { error: "quiet must be an object" }
  const from = parseClock(raw.from)
  const to = parseClock(raw.to)
  if (from === undefined || to === undefined || from === to)
    return {
      error: "quiet.from and quiet.to must be two different HH:MM times",
    }
  const { timezone, breakthrough = [] } = raw
  if (
    timezone !== undefined &&
    (typeof timezone !== "string" || !validZone(timezone))
  )
    return { error: "quiet.timezone must be an IANA time zone" }
  if (
    !Array.isArray(breakthrough) ||
    breakthrough.some((k) => !(BREAKTHROUGH as readonly unknown[]).includes(k))
  )
    return { error: "quiet.breakthrough lists failed, permission or question" }
  return {
    from,
    to,
    timezone,
    breakthrough: breakthrough as QuietHours["breakthrough"],
  }
}

function parseDigest(
  raw: unknown,
  quiet: QuietHours | undefined,
): Config["digest"] | { error: string } {
  if (raw === undefined || raw === false) return undefined
  const o = raw === true ? {} : raw
  if (!isObject(o)) return { error: "digest must be a boolean or an object" }
  const at = o.at === undefined ? quiet?.to : parseClock(o.at)
  if (at === undefined)
    return {
      error: "digest.at must be HH:MM (or set quiet hours to end at that time)",
    }
  if (o.empty !== undefined && typeof o.empty !== "boolean")
    return { error: "digest.empty must be true or false" }
  return { at, empty: o.empty === true }
}

function parsePermissions(
  raw: unknown,
): Config["permissions"] | { error: string } {
  if (raw === undefined) return { remote: "off" }
  if (!isObject(raw)) return { error: "permissions must be an object" }
  const { remote = "off" } = raw
  if (remote !== "off" && remote !== "once" && remote !== "all")
    return { error: "permissions.remote must be off, once or all" }
  return { remote }
}

function parseOvernight(raw: unknown): Config["overnight"] | { error: string } {
  const out: Config["overnight"] = { wake: [], maxResumes: 3, defaults: {} }
  if (raw === undefined) return out
  if (!isObject(raw)) return { error: "overnight must be an object" }
  const { wake = [], maxResumes = 3, defaults = {} } = raw
  if (
    !Array.isArray(wake) ||
    wake.some((k) => !(WAKE_KINDS as readonly unknown[]).includes(k))
  )
    return { error: `overnight.wake holds ${WAKE_KINDS.join(", ")}` }
  if (
    !Number.isInteger(maxResumes) ||
    (maxResumes as number) < 1 ||
    (maxResumes as number) > 20
  )
    return { error: "overnight.maxResumes must be 1 to 20" }
  if (!isObject(defaults))
    return { error: "overnight.defaults must be an object" }
  const d: Partial<Brief> = {}
  const int = (k: string, lo: number, hi: number) => {
    const v = defaults[k]
    if (v === undefined) return true
    if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi)
      return false
    ;(d as Record<string, unknown>)[k] = v
    return true
  }
  if (!int("maxTurns", 1, 1000))
    return { error: "overnight.defaults.maxTurns must be 1 to 1000" }
  if (!int("maxFailures", 1, 20))
    return { error: "overnight.defaults.maxFailures must be 1 to 20" }
  if (!int("answerAfter", 1, 1440))
    return { error: "overnight.defaults.answerAfter must be 1 to 1440" }
  const q = defaults.question
  if (q !== undefined && q !== "park" && q !== "default")
    return { error: "overnight.defaults.question must be park or default" }
  if (q) d.question = q
  if (defaults.scope !== undefined) {
    if (typeof defaults.scope !== "string" || defaults.scope.length > 2000)
      return {
        error:
          "overnight.defaults.scope must be text of at most 2000 characters",
      }
    d.scope = defaults.scope
  }
  return {
    wake: wake as WakeKind[],
    maxResumes: maxResumes as number,
    defaults: d,
  }
}

function parseDiff(raw: unknown): Config["diff"] | { error: string } {
  if (raw === undefined) return { exclude: DEFAULT_EXCLUDE, theme: "dark" }
  if (!isObject(raw)) return { error: "diff must be an object" }
  const { exclude = DEFAULT_EXCLUDE, theme = "dark" } = raw
  if (
    !Array.isArray(exclude) ||
    exclude.some((g) => typeof g !== "string" || !g || g.length > 200)
  )
    return { error: "diff.exclude must be a list of globs" }
  if (theme !== "dark" && theme !== "light")
    return { error: "diff.theme must be dark or light" }
  return { exclude: exclude as string[], theme }
}

function parseTurnCard(raw: unknown): Config["turnCard"] | { error: string } {
  const on = { enabled: true, minSeconds: DEFAULT_MIN_SECONDS }
  if (raw === undefined || raw === true) return on
  if (raw === false) return { ...on, enabled: false }
  if (!isObject(raw))
    return { error: "turnCard must be a boolean or an object" }
  const { minSeconds = DEFAULT_MIN_SECONDS } = raw
  if (
    typeof minSeconds !== "number" ||
    !Number.isFinite(minSeconds) ||
    minSeconds < 0 ||
    minSeconds > 86_400
  )
    return { error: "turnCard.minSeconds must be 0 to 86400" }
  return { enabled: true, minSeconds }
}

function parseDeadman(raw: unknown): Config["deadman"] | { error: string } {
  if (raw === undefined) return { intervalSeconds: DEFAULT_INTERVAL_S }
  if (!isObject(raw)) return { error: "deadman must be an object" }
  const { url, token, intervalSeconds = DEFAULT_INTERVAL_S } = raw
  if (url !== undefined && (typeof url !== "string" || url.trim() === ""))
    return { error: "deadman.url must be a URL" }
  if (
    typeof intervalSeconds !== "number" ||
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < 1 ||
    intervalSeconds > 3600
  )
    return { error: "deadman.intervalSeconds must be 1 to 3600" }
  const source = token === undefined ? undefined : parseTokenSource(token)
  if (token !== undefined && !source) return { error: "deadman." + TOKEN_ERROR }
  return { url: url?.trim(), token: source, intervalSeconds }
}

function parseLink(raw: unknown): Config["link"] | { error: string } {
  if (raw === undefined) return {}
  if (!isObject(raw)) return { error: "link must be an object" }
  const { url, secret } = raw
  if (url !== undefined && (typeof url !== "string" || url.trim() === ""))
    return { error: "link.url must be a URL" }
  const source = secret === undefined ? undefined : parseTokenSource(secret)
  if (secret !== undefined && !source)
    return {
      error: 'link.secret must be { "env": NAME } or { "command": [...] }',
    }
  return { url: url?.trim(), secret: source }
}

export const DEFAULT_CORE_PORT = 7842

function parseCore(raw: unknown): Config["core"] | { error: string } {
  if (raw === undefined) return { port: DEFAULT_CORE_PORT }
  if (!isObject(raw)) return { error: "core must be an object" }
  const { bind, port = DEFAULT_CORE_PORT } = raw
  if (bind !== undefined && (typeof bind !== "string" || bind.trim() === ""))
    return { error: 'core.bind must be "tailscale", "localhost" or an address' }
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  )
    return { error: "core.port must be a port number" }
  return { bind: bind?.trim(), port }
}

const NAME = /^[A-Za-z0-9][-_A-Za-z0-9]{0,23}$/

function parseChannels(
  raw: Record<string, unknown>,
): { channels: Record<string, ChannelConfig> } | { error: string } {
  if (raw.channels !== undefined && !isObject(raw.channels))
    return { error: "channels must be an object" }
  const given = isObject(raw.channels) ? raw.channels : {}
  const entries: Array<[name: string, cfg: unknown, at: string]> =
    Object.entries(given).map(([name, cfg]) => [name, cfg, `channels.${name}.`])

  // The pre-`channels` form: a type's own keys at the top level mean an instance named after the type.
  for (const [type, t] of Object.entries(connectorTypes)) {
    const keys = (t.legacyKeys ?? []).filter((k) => raw[k] !== undefined)
    if (keys.length === 0) continue
    if (given[type] !== undefined)
      return {
        error: `${keys.join(", ")} at the top level is the old form of channels.${type}: use one`,
      }
    entries.push([type, Object.fromEntries(keys.map((k) => [k, raw[k]])), ""])
  }

  const types = Object.keys(connectorTypes).join(", ")
  const out: Record<string, ChannelConfig> = {}
  for (const [name, cfg, at] of entries) {
    if (!NAME.test(name))
      return {
        error: `channels.${name}: use letters, digits, - and _ (24 at most)`,
      }
    if (!isObject(cfg)) return { error: `channels.${name} must be an object` }
    const type = cfg.type ?? name
    if (typeof type !== "string" || !connectorTypes[type])
      return {
        error: `${at || `channels.${name}.`}type ${String(type)} is unknown (use ${types})`,
      }
    const enabled = cfg.enabled ?? true
    if (typeof enabled !== "boolean")
      return { error: `${at}enabled must be true or false` }
    const options = connectorTypes[type].parse(cfg, at)
    if (isObject(options) && typeof options.error === "string")
      return { error: options.error }
    out[name] = { type, enabled, options }
  }
  if (Object.keys(out).length === 0)
    return { error: "configure a channel under channels" }
  return { channels: out }
}

const PROJECT_NAME = /^[A-Za-z0-9][-_.A-Za-z0-9]{0,31}$/
const MODEL_REF = /^[^/\s]+\/\S+$/
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/])/

function parseModels(raw: unknown, at: string): string[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 50)
    return `${at} must be a list of provider/model ids (50 at most)`
  for (const m of raw)
    if (typeof m !== "string" || !MODEL_REF.test(m))
      return `${at}: ${String(m)} is not a provider/model id`
  return raw as string[]
}

/** The allowlist of folders. A folder is only ever one of these: never text from a chat. */
function parseProjects(
  raw: unknown,
): { projects: ChatConfig["projects"] } | { error: string } {
  if (raw === undefined) return { projects: {} }
  if (!isObject(raw)) return { error: "chat.projects must be an object" }
  const projects: ChatConfig["projects"] = {}
  for (const [name, p] of Object.entries(raw)) {
    const at = `chat.projects.${name}`
    if (!PROJECT_NAME.test(name))
      return { error: `${at}: use letters, digits, - _ . (32 at most)` }
    if (!isObject(p)) return { error: `${at} must be an object` }
    if (
      typeof p.directory !== "string" ||
      !ABSOLUTE.test(p.directory) ||
      p.directory.includes("\0") ||
      p.directory.split(/[\\/]/).includes("..")
    )
      return { error: `${at}.directory must be an absolute path without ..` }
    if (p.agent !== undefined && (typeof p.agent !== "string" || !p.agent))
      return { error: `${at}.agent must be an agent name` }
    if (
      p.model !== undefined &&
      (typeof p.model !== "string" || !MODEL_REF.test(p.model))
    )
      return { error: `${at}.model must be a provider/model id` }
    projects[name] = {
      directory: p.directory,
      agent: p.agent as string | undefined,
      model: p.model as string | undefined,
    }
  }
  return { projects }
}

function parseChat(raw: unknown): ChatConfig | { error: string } {
  if (raw === undefined)
    return {
      deny: [],
      mirror: "replies",
      stream: true,
      streamMs: DEFAULT_STREAM_MS,
      streamBudget: DEFAULT_STREAM_BUDGET,
      delivery: "queue",
      redact: { mode: "full" },
      projects: {},
      models: [],
    }
  if (!isObject(raw)) return { error: "chat must be an object" }
  const mirror = raw.mirror ?? "replies"
  if (mirror !== "replies" && mirror !== "remote-only")
    return { error: 'chat.mirror must be "replies" or "remote-only"' }
  const stream = raw.stream ?? true
  if (typeof stream !== "boolean")
    return { error: "chat.stream must be true or false" }
  const streamMs = raw.streamMs ?? DEFAULT_STREAM_MS
  if (
    typeof streamMs !== "number" ||
    !Number.isInteger(streamMs) ||
    streamMs < MIN_STREAM_MS ||
    streamMs > 60_000
  )
    return {
      error: `chat.streamMs must be a whole number of ms, ${MIN_STREAM_MS} at least`,
    }
  const streamBudget = raw.streamBudget ?? DEFAULT_STREAM_BUDGET
  if (
    typeof streamBudget !== "number" ||
    !Number.isInteger(streamBudget) ||
    streamBudget < 1 ||
    streamBudget > 600
  )
    return {
      error:
        "chat.streamBudget must be a whole number of edits a minute, 1 to 600",
    }
  const delivery = raw.delivery ?? "queue"
  if (delivery !== "queue" && delivery !== "steer")
    return { error: 'chat.delivery must be "queue" or "steer"' }
  const redact = parseRedact(raw.redact)
  if (!redact)
    return { error: 'chat.redact must be "full", "title" or "head:<n>"' }
  const deny: ChatConfig["deny"] = []
  if (raw.deny !== undefined && !Array.isArray(raw.deny))
    return { error: "chat.deny must be a list" }
  for (const d of (raw.deny as unknown[] | undefined) ?? []) {
    if (!isObject(d)) return { error: "each chat.deny entry must be an object" }
    const rule: ChatConfig["deny"][number] = {}
    try {
      if (typeof d.agent === "string") rule.agent = new RegExp(d.agent)
    } catch {
      return { error: `invalid chat.deny agent pattern ${d.agent}` }
    }
    if (typeof d.directory === "string") rule.directory = d.directory
    if (!rule.agent && !rule.directory)
      return { error: "a chat.deny entry needs agent or directory" }
    deny.push(rule)
  }
  const projects = parseProjects(raw.projects)
  if ("error" in projects) return projects
  const models = parseModels(raw.models, "chat.models")
  if (typeof models === "string") return { error: models }
  return {
    deny,
    mirror,
    stream,
    streamMs,
    streamBudget,
    delivery,
    redact,
    projects: projects.projects,
    models,
  }
}

/** Validates a parsed config file. Returns the config or the first problem. */
export function parseConfig(raw: unknown): Config | { error: string } {
  if (!isObject(raw)) return { error: "config must be an object" }

  const parsed = parseChannels(raw)
  if ("error" in parsed) return parsed
  const configured = parsed.channels

  const defaultChannel = raw.defaultChannel ?? "all"
  if (typeof defaultChannel !== "string")
    return { error: "defaultChannel must be a channel name or all" }
  if (defaultChannel !== "all" && !configured[defaultChannel])
    return {
      error: `defaultChannel is ${defaultChannel}, which is not configured`,
    }

  const away = isObject(raw.away) ? raw.away : {}
  const minutes = away.minutes === undefined ? 10 : away.minutes
  if (typeof minutes !== "number" || !(minutes > 0))
    return { error: "away.minutes must be a positive number" }

  const rules: Rule[] = []
  for (const r of Array.isArray(raw.rules) ? raw.rules : []) {
    if (!isObject(r)) return { error: "each rule must be an object" }
    const rule: Rule = {}
    try {
      if (typeof r.agent === "string") rule.agent = new RegExp(r.agent)
    } catch {
      return { error: `invalid agent pattern ${r.agent}` }
    }
    if (typeof r.directory === "string") rule.directory = r.directory
    if (isArgv(r.command)) rule.command = r.command
    if (!rule.agent && !rule.directory && !rule.command)
      return { error: "a rule needs agent, directory or command" }
    rules.push(rule)
  }

  const sidebar = raw.sidebar ?? "full"
  if (!SIDEBAR_MODES.includes(sidebar as SidebarMode))
    return { error: 'sidebar must be "full", "compact" or "off"' }

  const redact = parseRedact(raw.redact)
  if (!redact) return { error: 'redact must be "full", "title" or "head:<n>"' }

  // Tier 2 (remote permission replies) is not implemented: every permission is push-only.
  const tier = isObject(raw.permissions) ? raw.permissions.tier : undefined
  if (tier !== undefined && tier !== 3)
    return { error: "permissions.tier: only 3 (push only) is supported" }

  let otel: OtelTarget | undefined
  if (raw.otel !== undefined) {
    if (!isObject(raw.otel)) return { error: "otel must be an object" }
    if (raw.otel.endpoint !== undefined) {
      if (
        typeof raw.otel.endpoint !== "string" ||
        !URL_RE.test(raw.otel.endpoint)
      )
        return { error: "otel.endpoint must be an http(s) URL" }
      const h = raw.otel.headers
      if (
        h !== undefined &&
        (!isObject(h) || !Object.values(h).every((v) => typeof v === "string"))
      )
        return { error: "otel.headers must map names to strings" }
      otel = {
        endpoint: raw.otel.endpoint,
        headers: h as Record<string, string> | undefined,
      }
    }
  }

  const core = parseCore(raw.core)
  if ("error" in core) return core
  const deadman = parseDeadman(raw.deadman)
  if ("error" in deadman) return deadman
  const link = parseLink(raw.link)
  if ("error" in link) return link
  const approvals = parseApprovals(raw.approvals)
  if ("error" in approvals) return approvals

  const permissions = parsePermissions(raw.permissions)
  if ("error" in permissions) return permissions
  const diff = parseDiff(raw.diff)
  if ("error" in diff) return diff
  const overnight = parseOvernight(raw.overnight)
  if ("error" in overnight) return overnight
  const turnCard = parseTurnCard(raw.turnCard)
  if ("error" in turnCard) return turnCard

  const quiet = parseQuiet(raw.quiet)
  if (quiet && "error" in quiet) return quiet
  const digest = parseDigest(raw.digest, quiet)
  if (digest && "error" in digest) return digest

  const chat = parseChat(raw.chat)
  if ("error" in chat) return chat
  // "title" hides content, so replies inherit it; a head:<n> preview limit does not.
  if (
    redact.mode === "title" &&
    !(isObject(raw.chat) && raw.chat.redact !== undefined)
  )
    chat.redact = redact

  const messages = parseFormats(raw.messages, "messages")
  if (typeof messages === "string") return { error: messages }
  const profiles = parseProfiles(raw.profiles)
  if (typeof profiles === "string") return { error: profiles }

  return {
    channels: configured,
    defaultChannel,
    sidebar: sidebar as SidebarMode,
    away: { minutes },
    core,
    deadman,
    link,
    approvals,
    turnCard,
    permissions,
    diff,
    overnight,
    quiet,
    digest,
    rules,
    redact,
    chat,
    messages,
    profiles,
    otel,
  }
}

/** Reads the config file. No file means the plugin stays inert. */
export async function loadConfig(
  path = configPath(),
): Promise<Config | { error: string } | undefined> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    // Only the default location falls back; an explicit path never does.
    if (legacy(process.env, "CONFIG") || path !== configPath()) return undefined
    try {
      path = legacyConfigPath()
      text = await readFile(path, "utf8")
    } catch {
      return undefined
    }
  }
  try {
    return parseConfig(parseJsonc(text))
  } catch (err) {
    return { error: `cannot parse ${path}: ${(err as Error).message}` }
  }
}

export { configPath, dataDir, legacyConfigPath, logPath } from "./paths.ts"
