import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { parseConfig, type Config } from "../config.ts"
import { linkUrlProblem } from "./hosts.ts"

const ALLOW = ["oob-link.home.example.test"]

describe("link URL host", () => {
  it("accepts loopback, tailnet addresses and *.ts.net names", () => {
    for (const u of [
      "ws://127.0.0.1:8081/link",
      "ws://localhost/link",
      "ws://[::1]:8081/link",
      "ws://100.64.0.1/link",
      "ws://100.127.255.254/link",
      "wss://[fd7a:115c:a1e0::1]/link",
      "wss://relay.tail1234.ts.net/link",
      "wss://RELAY.example-net.TS.NET/link",
    ])
      assert.equal(linkUrlProblem(u), undefined, u)
  })

  it("refuses a public host, a lookalike and another scheme", () => {
    for (const u of [
      "wss://relay.example.com/link",
      "ws://8.8.8.8/link",
      "ws://100.128.0.1/link",
      "ws://100.63.255.1/link",
      "wss://[2001:db8::1]/link",
      "wss://evil-ts.net/link",
      "wss://ts.net/link",
      "wss://relay.ts.net.evil.com/link",
      "https://relay.tail.ts.net/link",
      "not a url",
      "",
    ])
      assert.ok(linkUrlProblem(u), u)
  })
})

describe("link.allowHosts", () => {
  it("accepts a listed host over wss only, whatever the case", () => {
    assert.equal(
      linkUrlProblem("wss://oob-link.home.example.test/link", ALLOW),
      undefined,
    )
    assert.equal(
      linkUrlProblem("wss://OOB-LINK.Home.Example.Test:8443/link", ALLOW),
      undefined,
    )
    assert.match(
      linkUrlProblem("ws://oob-link.home.example.test/link", ALLOW) ?? "",
      /needs wss/,
    )
  })

  it("matches the exact name: no subdomain, parent, suffix or lookalike", () => {
    for (const u of [
      "wss://a.oob-link.home.example.test/link",
      "wss://home.example.test/link",
      "wss://oob-link.home.example.test.evil.com/link",
      "wss://xoob-link.home.example.test/link",
      "wss://other.example.test/link",
    ])
      assert.ok(linkUrlProblem(u, ALLOW), u)
  })

  it("is empty by default, so the host is refused as before", () => {
    assert.match(
      linkUrlProblem("wss://oob-link.home.example.test/link") ?? "",
      /link.allowHosts/,
    )
    assert.ok(linkUrlProblem("wss://oob-link.home.example.test/link", []))
  })

  it("keeps ws for loopback and the tailnet", () => {
    assert.equal(linkUrlProblem("ws://127.0.0.1:8081/link", ALLOW), undefined)
    assert.equal(linkUrlProblem("ws://100.64.0.1/link", ALLOW), undefined)
  })
})

describe("link settings", () => {
  const parse = (link: unknown) =>
    parseConfig({ channels: { telegram: { token: { env: "X" } } }, link })

  it("default to no allowed host and no key", () => {
    const c = parse(undefined) as Config
    assert.deepEqual(c.link, { allowHosts: [] })
    const d = parse({ url: "ws://127.0.0.1:1/link" }) as Config
    assert.deepEqual(d.link.allowHosts, [])
    assert.equal(d.link.key, undefined)
  })

  it("read allowHosts lower-cased and the key as a secret source", () => {
    const c = parse({
      url: "wss://oob-link.home.example.test/link",
      allowHosts: [" OOB-Link.Home.Example.Test "],
      key: { command: ["pass", "show", "oob-link-key"] },
    }) as Config
    assert.deepEqual(c.link.allowHosts, ["oob-link.home.example.test"])
    assert.deepEqual(c.link.key, { command: ["pass", "show", "oob-link-key"] })
  })

  it("refuse wildcards, schemes, ports, paths, addresses and a bad key", () => {
    for (const h of [
      "*.home.example.test",
      "wss://oob-link.home.example.test",
      "oob-link.home.example.test:8443",
      "oob-link.home.example.test/link",
      "192.0.2.10",
      "",
      3,
    ])
      assert.match(
        (parse({ allowHosts: [h] }) as { error: string }).error,
        /link.allowHosts/,
        String(h),
      )
    assert.match(
      (parse({ allowHosts: "x" }) as { error: string }).error,
      /link.allowHosts/,
    )
    assert.match(
      (parse({ key: "plain-text-key" }) as { error: string }).error,
      /link.key/,
    )
  })
})
