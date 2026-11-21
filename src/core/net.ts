/** Where the core API may listen: loopback or a Tailscale address, never a wildcard or a public one. */
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { networkInterfaces } from "node:os"

export type Listen = { ok: true; host: string } | { ok: false; reason: string }

type Ifaces = ReturnType<typeof networkInterfaces>

const tailnet4 = (ip: string) => {
  const [a, b] = ip.split(".").map(Number)
  return a === 100 && b >= 64 && b <= 127
}
const tailnet6 = (ip: string) => ip.toLowerCase().startsWith("fd7a:115c:a1e0:")
const loopback = (ip: string) => ip.startsWith("127.") || ip === "::1"

/** Whether an address literal may be listened on. */
export function allowed(ip: string): Listen {
  const v = isIP(ip)
  if (v === 0) return { ok: false, reason: ip + " is not an address" }
  if (ip === "0.0.0.0" || ip === "::")
    return {
      ok: false,
      reason: "a wildcard address would listen on every network",
    }
  if (loopback(ip) || (v === 4 ? tailnet4(ip) : tailnet6(ip)))
    return { ok: true, host: ip }
  return {
    ok: false,
    reason: ip + " is neither loopback nor a Tailscale address",
  }
}

/**
 * `tailscale` is the first local interface address in the Tailscale ranges;
 * `localhost` is 127.0.0.1; an address is checked as it is; a name must resolve
 * only to allowed addresses.
 */
export async function resolveListen(
  bind: string,
  ifaces: Ifaces = networkInterfaces(),
  resolve: (name: string) => Promise<string[]> = async (n) =>
    (await lookup(n, { all: true })).map((a) => a.address),
): Promise<Listen> {
  if (bind === "localhost") return { ok: true, host: "127.0.0.1" }
  if (bind === "tailscale") {
    const all = Object.values(ifaces)
      .flatMap((l) => l ?? [])
      .filter((a) => !a.internal)
      .map((a) => a.address)
    const ip =
      all.find((a) => isIP(a) === 4 && tailnet4(a)) ??
      all.find((a) => isIP(a) === 6 && tailnet6(a))
    return ip
      ? { ok: true, host: ip }
      : { ok: false, reason: "no Tailscale address was found on this machine" }
  }
  if (isIP(bind)) return allowed(bind)
  try {
    const found = await resolve(bind)
    if (found.length === 0)
      return { ok: false, reason: bind + " has no address" }
    for (const a of found) {
      const r = allowed(a)
      if (!r.ok)
        return {
          ok: false,
          reason: bind + " resolves to " + a + ": " + r.reason,
        }
    }
    return { ok: true, host: found[0] }
  } catch {
    return { ok: false, reason: bind + " does not resolve" }
  }
}
