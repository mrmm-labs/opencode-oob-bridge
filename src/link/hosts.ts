/** Where the bridge may dial the relay: loopback or the tailnet, never a public host. */
import { isIP } from "node:net"

const loopback = (h: string) =>
  h === "localhost" || h === "::1" || /^127(\.\d+){3}$/.test(h)
const tailnet4 = (h: string) => {
  const [a, b] = h.split(".").map(Number)
  return a === 100 && b >= 64 && b <= 127
}
const tailnet6 = (h: string) => h.toLowerCase().startsWith("fd7a:115c:a1e0:")

/** Why a link URL cannot be used, or undefined when it can. */
export function linkUrlProblem(raw: string): string | undefined {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return "not a URL"
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return "must be ws or wss"
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const v = isIP(host)
  const ok =
    loopback(host) ||
    (v === 4 && tailnet4(host)) ||
    (v === 6 && tailnet6(host)) ||
    (v === 0 && host.endsWith(".ts.net") && host.length > ".ts.net".length)
  return ok
    ? undefined
    : "host must be loopback, a tailnet address or a *.ts.net name"
}
