import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { allowed, resolveListen } from "./net.ts"

const iface = (address: string, internal = false) => ({
  address,
  family: address.includes(":") ? "IPv6" : "IPv4",
  internal,
  netmask: "",
  mac: "",
  cidr: null,
})

describe("core bind rules", () => {
  it("refuses wildcard and public addresses", () => {
    for (const a of [
      "0.0.0.0",
      "::",
      "8.8.8.8",
      "192.168.1.5",
      "100.63.0.1",
      "100.128.0.1",
    ])
      assert.equal(allowed(a).ok, false, a)
  })

  it("accepts loopback and tailnet addresses", () => {
    for (const a of [
      "127.0.0.1",
      "::1",
      "100.64.0.1",
      "100.86.98.84",
      "100.127.255.254",
      "fd7a:115c:a1e0::1",
    ])
      assert.equal(allowed(a).ok, true, a)
  })

  it("resolves the tailscale keyword to the tailnet interface", async () => {
    const r = await resolveListen("tailscale", {
      en0: [iface("192.168.1.9")],
      lo0: [iface("127.0.0.1", true)],
      utun4: [iface("100.86.98.84")],
    })
    assert.deepEqual(r, { ok: true, host: "100.86.98.84" })
  })

  it("has no listener when there is no tailnet interface", async () => {
    const r = await resolveListen("tailscale", { en0: [iface("192.168.1.9")] })
    assert.equal(r.ok, false)
  })

  it("accepts a name only when every address is allowed", async () => {
    const ok = await resolveListen("mac", {}, async () => ["100.64.0.2"])
    assert.equal(ok.ok, true)
    const bad = await resolveListen("mac", {}, async () => [
      "100.64.0.2",
      "1.1.1.1",
    ])
    assert.equal(bad.ok, false)
  })
})
