export function ago(at, now) {
  if (at === undefined) return ""
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 10) return "now"
  if (s < 60) return s + "s ago"
  if (s < 3600) return Math.floor(s / 60) + "m ago"
  if (s < 86_400) return Math.floor(s / 3600) + "h ago"
  return Math.floor(s / 86_400) + "d ago"
}

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
