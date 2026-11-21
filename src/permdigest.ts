/** The text of the digest that stands for the permissions waiting in a session. */

const MAX_GROUPS = 8

export type Waiting = { agent?: string; action?: string }

/** "investigator · shell ×58, general · webfetch ×2": the most frequent first. */
export function breakdown(items: Waiting[]): string {
  const groups = new Map<string, number>()
  for (const i of items) {
    const key = `${i.agent ?? "agent"} · ${i.action ?? "permission"}`
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  const sorted = [...groups].sort((a, b) => b[1] - a[1])
  const shown = sorted.slice(0, MAX_GROUPS).map(([k, n]) => `${k} ×${n}`)
  if (sorted.length > MAX_GROUPS)
    shown.push(`+${sorted.length - MAX_GROUPS} more`)
  return shown.join(", ")
}

export function permissionDigest(items: Waiting[]): {
  title: string
  message: string
} {
  const n = items.length
  if (n === 0) return { title: "✅ none waiting", message: "" }
  return {
    title: `🔐 ${n} permission${n === 1 ? "" : "s"} waiting at the Mac`,
    message: breakdown(items),
  }
}
