export function ago(at, now) {
  if (at === undefined) return ""
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 10) return "now"
  if (s < 60) return s + "s ago"
  if (s < 3600) return Math.floor(s / 60) + "m ago"
  if (s < 86_400) return Math.floor(s / 3600) + "h ago"
  return Math.floor(s / 86_400) + "d ago"
}

/** How long since `at`: "3d 4h", "3h 12m", "5m" or "40s"; empty when the start is not known. */
export function uptime(at, now) {
  if (!Number.isFinite(at)) return ""
  const s = Math.max(0, Math.floor((now - at) / 1000))
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return d + "d " + h + "h"
  if (h > 0) return h + "h " + m + "m"
  return m > 0 ? m + "m" : s + "s"
}

/** Whether this page is not the build the bridge serves now: a copy a phone or a CDN kept. */
export const isStale = (page, app) =>
  typeof app === "string" && app !== "" && page !== app

/** The footer of the Info screen: the bridge version that runs, and for how long. */
export const aboutLine = (version, startedAt, now, page) =>
  [
    "opencode-oob-bridge " + (version || "unknown"),
    uptime(startedAt, now) && "up " + uptime(startedAt, now),
    "page " + (page || "unstamped"),
  ]
    .filter(Boolean)
    .join(" · ")

export const hhmm = (at) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

/** What the list shows for a session: a waiting prompt outranks the state. */
export function stateLabel(s) {
  if (s.pending > 0) return { key: "waiting", text: "Waiting on you" }
  return (
    {
      working: { key: "working", text: "Working" },
      idle: { key: "idle", text: "Idle" },
      failed: { key: "failed", text: "Failed" },
      suspended: { key: "suspended", text: "Suspended" },
    }[s.state] ?? { key: "idle", text: s.state }
  )
}

export const nameOf = (s) => s.title || s.id

const ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * What a launch asked for. The bridge sends "s_<session>", "a_<approval>" and "enrol_<code>"; a bare
 * id is a session from a message sent before the prefixes. Anything else asks for nothing.
 */
export function parseStart(raw) {
  if (typeof raw !== "string" || !ID.test(raw)) return undefined
  const enrol = /^enrol_([A-Za-z0-9]{1,16})$/.exec(raw)
  if (enrol) return { kind: "enrol", code: enrol[1] }
  if (raw.startsWith("enrol_")) return undefined
  if (raw === "s_" || raw === "a_") return undefined
  if (raw.startsWith("s_")) return { kind: "session", id: raw.slice(2) }
  if (raw.startsWith("a_")) return { kind: "approval", id: raw.slice(2) }
  return { kind: "session", id: raw }
}

/** A sentence for each reason the bridge gives when it refuses a request; undefined for one it does not know. */
export const refusalText = (reason) =>
  ({
    no_operator:
      "The bridge has no operator configured. Set channels.telegram.operator in its config, or pair the bot again.",
    no_bot_token:
      "The bridge cannot read the bot token, so it cannot check who you are.",
    missing:
      "Open this app from Telegram: the sign-in data is missing, so the bridge cannot tell who you are.",
    malformed:
      "Open this app from Telegram: the sign-in data could not be read.",
    bad_signature:
      "The signature on the sign-in data did not check out: this app was opened for a different bot than the bridge's.",
    too_old:
      "The sign-in data is too old. Close this view and open the app again from Telegram.",
    not_operator:
      "Not authorised. This app is for the person who set up the bot.",
    "too many failures":
      "Too many failed attempts from this address: wait five minutes.",
  })[reason]

/** The connection pill; the banner under it carries the time of the last data. */
export function connection(state) {
  if (state.conn === "live") return { key: "live", text: "Live" }
  return {
    key: "down",
    text: state.conn === "connecting" ? "Connecting…" : "Reconnecting…",
  }
}

export const diffClass = (line) =>
  line.startsWith("+++") ||
  line.startsWith("---") ||
  line.startsWith("diff ") ||
  line.startsWith("index ")
    ? "meta"
    : line.startsWith("@@")
      ? "hunk"
      : line.startsWith("+")
        ? "add"
        : line.startsWith("-")
          ? "del"
          : ""

/** The decisions the app may offer for a permission: none unless the policy and the core both allow replies. */
export function permissionChoices(meta) {
  if (!meta?.actions?.find((a) => a.name === "permission")?.available) return []
  return (
    { once: ["once", "reject"], all: ["once", "always", "reject"] }[
      meta.permissions
    ] ?? []
  )
}
