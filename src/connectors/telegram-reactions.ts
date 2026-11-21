/**
 * The reaction a message from Telegram wears as it moves through the bridge:
 * received, queued or sent, replied to, failed, ignored or held. A bot may set
 * one reaction per message, and only from the set Telegram allows bots, so
 * every choice is checked against that set and falls back to 👀.
 */

// The emoji Telegram lets a bot react with (Bot API, ReactionTypeEmoji).
const ALLOWED_LIST = [
  "👍",
  "👎",
  "❤",
  "🔥",
  "🥰",
  "👏",
  "😁",
  "🤔",
  "🤯",
  "😱",
  "🤬",
  "😢",
  "🎉",
  "🤩",
  "🤮",
  "💩",
  "🙏",
  "👌",
  "🕊",
  "🤡",
  "🥱",
  "🥴",
  "😍",
  "🐳",
  "❤‍🔥",
  "🌚",
  "🌭",
  "💯",
  "🤣",
  "⚡",
  "🍌",
  "🏆",
  "💔",
  "🤨",
  "😐",
  "🍓",
  "🍾",
  "💋",
  "🖕",
  "😈",
  "😴",
  "😭",
  "🤓",
  "👻",
  "👨‍💻",
  "👀",
  "🎃",
  "🙈",
  "😇",
  "😨",
  "🤝",
  "✍",
  "🤗",
  "🫡",
  "🎅",
  "🎄",
  "☃",
  "💅",
  "🤪",
  "🗿",
  "🆒",
  "💘",
  "🙉",
  "🦄",
  "😘",
  "💊",
  "🙊",
  "😎",
  "👾",
  "🤷‍♂",
  "🤷",
  "🤷‍♀",
  "😡",
]

/** Telegram writes these without the emoji variation selector; people type them with it. */
export const plain = (e: string) => e.replace(/\uFE0F/g, "")

export const ALLOWED_REACTIONS: ReadonlySet<string> = new Set(
  ALLOWED_LIST.map(plain),
)

export const FALLBACK_REACTION = "👀"

export type Stage =
  | "received"
  | "queued"
  | "sent"
  | "steered"
  | "done"
  | "failed"
  | "ignored"
  | "held"

export type Reactions = Record<Stage, string> & {
  /** Overrides `sent` for an agent: lower-case agent name to its emoji. Empty by default. */
  agents: Record<string, string>
  /** Used when a configured choice is not an emoji Telegram allows. */
  default: string
}

export const DEFAULT_REACTIONS: Reactions = {
  agents: {},
  default: FALLBACK_REACTION,
  received: "👀",
  queued: "✍",
  sent: "⚡",
  steered: "⚡",
  done: "👌",
  failed: "💔",
  ignored: "🙈",
  held: "🤷",
}

/** What the config file may hold under `reactions`; the rest comes from the defaults. */
export type ReactionsConfig = Partial<Record<Stage | "default", string>> & {
  agents?: Record<string, string>
}

const STAGES: Stage[] = [
  "received",
  "queued",
  "sent",
  "steered",
  "done",
  "failed",
  "ignored",
  "held",
]
const KEYS = ["agents", "default", ...STAGES]

export function parseReactions(
  raw: unknown,
  at: string,
): { reactions: ReactionsConfig } | { error: string } {
  if (raw === undefined) return { reactions: {} }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { error: `${at}reactions must be an object` }
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o))
    if (!KEYS.includes(k))
      return {
        error: `${at}reactions.${k} is not a setting (use ${KEYS.join(", ")})`,
      }
  const out: ReactionsConfig = {}
  for (const k of ["default", ...STAGES] as const) {
    const v = o[k]
    if (v === undefined) continue
    if (typeof v !== "string" || !v)
      return { error: `${at}reactions.${k} must be an emoji` }
    out[k] = v
  }
  if (o.agents !== undefined) {
    if (
      typeof o.agents !== "object" ||
      o.agents === null ||
      Array.isArray(o.agents)
    )
      return { error: `${at}reactions.agents must map agent names to emoji` }
    out.agents = {}
    for (const [k, v] of Object.entries(o.agents)) {
      if (typeof v !== "string" || !v)
        return { error: `${at}reactions.agents.${k} must be an emoji` }
      out.agents[k.toLowerCase()] = v
    }
  }
  return { reactions: out }
}

export type Delivered = { agent?: string; how: "sent" | "queued" | "steered" }

/**
 * The emoji of a stage. A choice outside Telegram's set is replaced by the
 * configured default, then by 👀; `bad` is told about each one that was.
 */
export function stageEmoji(
  cfg: ReactionsConfig | undefined,
  stage: Stage,
  bad?: (emoji: string) => void,
  agent?: string,
): string {
  const ok = (e: string | undefined) => {
    if (e === undefined) return undefined
    const p = plain(e)
    if (ALLOWED_REACTIONS.has(p)) return p
    bad?.(e)
    return undefined
  }
  const fallback =
    ok(cfg?.default) ?? ok(DEFAULT_REACTIONS.default) ?? FALLBACK_REACTION
  const own =
    stage === "sent" && agent
      ? ok(cfg?.agents?.[agent.toLowerCase()])
      : undefined
  return own ?? ok(cfg?.[stage] ?? DEFAULT_REACTIONS[stage]) ?? fallback
}

/** The stage a delivered prompt is in. */
export const stageOf = (d: Delivered | undefined): Stage =>
  d?.how === "queued" ? "queued" : d?.how === "steered" ? "steered" : "sent"

export function reactionFor(
  cfg: ReactionsConfig | undefined,
  d: Delivered | undefined,
  bad?: (emoji: string) => void,
): string {
  return stageEmoji(cfg, stageOf(d), bad, d?.agent)
}
