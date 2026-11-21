/**
 * Choices made in the TUI (channel on/off, what a connector stored when pairing), kept in
 * the data directory and layered over the config file, which is never rewritten.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { SIDEBAR_MODES, type SidebarMode } from "./config.ts"
import type { ConnectorSettings } from "./connectors/types.ts"
import { log } from "./logger.ts"

/** A top-level session's routing choice. */
export type SessionSetting = {
  on?: boolean
  channel?: string
  chat?: boolean
  /** How prompts from a chat reach the session, when it differs from `chat.delivery`. */
  delivery?: "queue" | "steer"
}
export type Afk = "auto" | "on" | "off"
export type Settings = {
  /** The away override chosen with `/oob afk`. */
  afk?: Afk
  /** When a timed `on` ends, in epoch ms. */
  afkUntil?: number
  /** The sidebar block's size, when chosen in the TUI. */
  sidebar?: SidebarMode
  channels?: Record<string, ConnectorSettings>
  sessions?: Record<string, SessionSetting>
}

const MAX_SESSIONS = 200

export class SettingsStore {
  private data: Settings = {}
  private chain: Promise<void> = Promise.resolve()
  private readonly file?: string

  constructor(file?: string) {
    this.file = file
  }

  async load(): Promise<void> {
    if (!this.file) return
    try {
      const v = JSON.parse(await readFile(this.file, "utf8")) as Settings
      if (typeof v === "object" && v !== null && !Array.isArray(v))
        this.data = v
    } catch {}
  }

  channel(id: string): ConnectorSettings {
    return this.data.channels?.[id] ?? {}
  }

  set(id: string, patch: ConnectorSettings): void {
    this.data = {
      ...this.data,
      channels: {
        ...this.data.channels,
        [id]: { ...this.channel(id), ...patch },
      },
    }
    this.save()
  }

  afk(): Afk {
    const v = this.data.afk
    return v === "on" || v === "off" ? v : "auto"
  }

  afkUntil(): number | undefined {
    const v = this.data.afkUntil
    return this.afk() === "on" && typeof v === "number" ? v : undefined
  }

  setAfk(mode: Afk, until?: number): void {
    this.data = {
      ...this.data,
      afk: mode === "auto" ? undefined : mode,
      afkUntil: mode === "on" ? until : undefined,
    }
    this.save()
  }

  sidebar(): SidebarMode | undefined {
    const v = this.data.sidebar
    return SIDEBAR_MODES.includes(v as SidebarMode) ? v : undefined
  }

  setSidebar(mode: SidebarMode | undefined): void {
    this.data = { ...this.data, sidebar: mode }
    this.save()
  }

  sessions(): Record<string, SessionSetting> {
    return this.data.sessions ?? {}
  }

  /** `undefined` forgets the choice (auto). The oldest entries drop past a cap. */
  setSession(rootID: string, value: SessionSetting | undefined): void {
    const { [rootID]: _old, ...rest } = this.sessions()
    const sessions = value ? { ...rest, [rootID]: value } : rest
    const keys = Object.keys(sessions)
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS)))
      delete sessions[k]
    this.data = { ...this.data, sessions }
    this.save()
  }

  private save(): void {
    if (!this.file) return
    const file = this.file
    const body = `${JSON.stringify(this.data, null, 2)}\n`
    this.chain = this.chain
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, body)
      })
      .catch((err) => log("settings_write_error", { message: err.message }))
  }

  flush(): Promise<void> {
    return this.chain
  }
}
