import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { linkUrlProblem } from "./hosts.ts"

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
