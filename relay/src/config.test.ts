import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { loadConfig } from "./config.ts"

const base = { LINK_SECRET: "s".repeat(32) }
const ok = (env: Record<string, string>) => {
  const r = loadConfig(env, () => "")
  if ("error" in r) assert.fail(r.error)
  return r
}
const bad = (env: Record<string, string>) => {
  const r = loadConfig(env, () => "")
  assert.ok("error" in r, "an error")
  return (r as { error: string }).error
}

describe("relay config", () => {
  it("needs a link secret of 32 characters", () => {
    assert.match(bad({}), /LINK_SECRET is required/)
    assert.match(bad({ LINK_SECRET: "short" }), /at least 32/)
  })

  it("has the documented defaults", () => {
    const { config: c } = ok(base)
    assert.deepEqual(
      [
        c.port,
        c.linkPort,
        c.metricsPort,
        c.maxAgeSeconds,
        c.maxBodyBytes,
        c.sseKeepaliveSeconds,
        c.linkMaxSkewSeconds,
      ],
      [8080, 8081, 9090, 3600, 262_144, 25, 60],
    )
    assert.deepEqual(c.rate, { perSecond: 20, burst: 40 })
    assert.equal(c.maxInFlightPerClient, 20)
    assert.equal(c.maxInFlightTotal, 16)
    assert.deepEqual(c.deadman, {
      intervalSeconds: 30,
      missedBeats: 3,
      stoppingGraceSeconds: 300,
      reminderSeconds: 1800,
    })
    assert.equal(c.alert.apiBase, "https://api.telegram.org")
    assert.equal(c.bind, "0.0.0.0")
  })

  it("warns about what is off, without refusing to start", () => {
    const { warnings } = ok(base)
    const all = warnings.join("\n")
    for (const w of [
      "OPERATOR_USER_ID",
      "TELEGRAM_BOT_TOKEN_VERIFY",
      "TELEGRAM_BOT_TOKEN or",
      "HEARTBEAT_TOKEN",
    ])
      assert.ok(all.includes(w), w)
  })

  it("treats a placeholder operator id as unset", () => {
    const { config, warnings } = ok({ ...base, OPERATOR_USER_ID: "CHANGE_ME" })
    assert.equal(config.operatorUserId, undefined)
    assert.ok(warnings.some((w) => /not a Telegram user id/.test(w)))
    assert.equal(
      ok({ ...base, OPERATOR_USER_ID: "4242" }).config.operatorUserId,
      4242,
    )
  })

  it("refuses numbers out of range and a body cap above 256 KiB", () => {
    assert.match(bad({ ...base, PORT: "0" }), /PORT must be/)
    assert.match(bad({ ...base, MAX_BODY_BYTES: "300000" }), /MAX_BODY_BYTES/)
    assert.match(bad({ ...base, MISSED_BEATS: "x" }), /MISSED_BEATS/)
    assert.match(
      bad({ ...base, LINK_MAX_SKEW_SECONDS: "61" }),
      /LINK_MAX_SKEW_SECONDS/,
    )
  })

  it("reads a secret from NAME_FILE, and refuses a file it cannot read", () => {
    const r = loadConfig(
      { LINK_SECRET_FILE: "/run/secrets/link" },
      () => "f".repeat(40) + "\n",
    )
    assert.ok(!("error" in r) && r.config.linkSecret === "f".repeat(40))
    const e = loadConfig({ LINK_SECRET_FILE: "/nope" }, () => {
      throw new Error("ENOENT")
    })
    assert.ok("error" in e && /LINK_SECRET_FILE cannot be read/.test(e.error))
  })

  it("checks the header name, the heartbeat token length and the API base", () => {
    assert.match(
      bad({ ...base, CLIENT_IP_HEADER: "bad header" }),
      /CLIENT_IP_HEADER/,
    )
    assert.match(bad({ ...base, HEARTBEAT_TOKEN: "short" }), /HEARTBEAT_TOKEN/)
    assert.match(
      bad({ ...base, TELEGRAM_API_BASE: "ftp://x" }),
      /TELEGRAM_API_BASE/,
    )
  })

  it("never puts a secret in an error", () => {
    const e = bad({
      LINK_SECRET: "short-secret-value",
      HEARTBEAT_TOKEN: "tiny-token-value",
    })
    assert.ok(
      !e.includes("short-secret-value") && !e.includes("tiny-token-value"),
    )
  })
})
