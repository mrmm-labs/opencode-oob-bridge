import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { biometricProof as bridgeProof } from "../src/approvals/factors.ts"
import {
  b64,
  biometricProof,
  createDevice,
  orderFactors,
  parseToken,
  passkeySupported,
  unb64,
  versionAtLeast,
} from "./factors.js"
import { setReporter } from "./tg.js"

describe("factor order", () => {
  it("keeps the bridge's order and drops what the device cannot do", () => {
    const all = ["biometric", "passkey", "totp"]
    assert.deepEqual(orderFactors(all, { biometric: true, passkey: true }), all)
    assert.deepEqual(orderFactors(all, { biometric: false, passkey: true }), [
      "passkey",
      "totp",
    ])
    assert.deepEqual(orderFactors(all, {}), ["totp"])
    assert.deepEqual(orderFactors(["totp", "biometric"], { biometric: true }), [
      "totp",
      "biometric",
    ])
  })

  it("never adds the code when the bridge did not offer it", () => {
    assert.deepEqual(orderFactors(["biometric"], {}), [])
    assert.deepEqual(orderFactors(undefined, {}), [])
  })
})

describe("the Face ID proof", () => {
  it("equals what the bridge computes", async () => {
    const secret = Buffer.from("device-secret-0123456789abcdef!!")
    const mine = await biometricProof(
      secret.toString("base64url"),
      "reqhash",
      "chal",
    )
    assert.equal(mine, bridgeProof(secret, "reqhash", "chal"))
    assert.notEqual(mine, bridgeProof(secret, "reqhash", "other"))
    assert.notEqual(mine, bridgeProof(secret, "other", "chal"))
  })

  it("splits the stored token at the first dot, and refuses a malformed one", () => {
    assert.deepEqual(parseToken("dAbc.sec.ret"), {
      device: "dAbc",
      secret: "sec.ret",
    })
    for (const bad of [undefined, "", "nodot", ".x", "x."])
      assert.equal(parseToken(bad), undefined)
  })

  it("round-trips base64url", () => {
    const bytes = Uint8Array.from([251, 255, 0, 62, 63])
    assert.deepEqual(unb64(b64(bytes)), bytes)
  })
})

describe("passkey support", () => {
  it("is off where the webview has no WebAuthn", async () => {
    assert.equal(await passkeySupported({}), false)
    assert.equal(
      await passkeySupported({
        PublicKeyCredential: function () {},
        navigator: {},
      }),
      false,
    )
  })

  it("is on only with a user-verifying platform authenticator", async () => {
    const win = (ok) => ({
      PublicKeyCredential: Object.assign(function () {}, {
        isUserVerifyingPlatformAuthenticatorAvailable: async () => ok,
      }),
      navigator: { credentials: { get() {} } },
    })
    assert.equal(await passkeySupported(win(true)), true)
    assert.equal(await passkeySupported(win(false)), false)
  })
})

describe("the device", () => {
  const bio = (o) => ({
    info: async () => ({
      available: true,
      accessGranted: true,
      tokenSaved: true,
      ...o,
    }),
    authenticate: async () => o?.token,
    requestAccess: async () => ({
      available: true,
      accessRequested: o?.accessRequested === true,
      accessGranted: o?.grant === true,
    }),
  })

  it("supports Face ID only with a saved token", async () => {
    assert.equal((await createDevice({}, bio({})).support({})).biometric, true)
    assert.equal(
      (await createDevice({}, bio({ tokenSaved: false })).support({}))
        .biometric,
      false,
    )
    assert.equal(
      (await createDevice({}, bio({ available: false })).support({})).biometric,
      false,
    )
  })

  it("offers a passkey only for the bridge's relying party host", async () => {
    const win = {
      location: { hostname: "app.example.com" },
      PublicKeyCredential: Object.assign(function () {}, {
        isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
      }),
      navigator: { credentials: { get() {} } },
    }
    const d = createDevice(win, bio({}))
    assert.equal(
      (await d.support({ passkey: { rp: "app.example.com" } })).passkey,
      true,
    )
    assert.equal(
      (await d.support({ passkey: { rp: "evil.example" } })).passkey,
      false,
    )
    assert.equal((await d.support({})).passkey, false)
  })

  it("proves possession from the released token, and fails when Face ID releases nothing", async () => {
    const secret = Buffer.from("device-secret-0123456789abcdef!!").toString(
      "base64url",
    )
    const view = { request_hash: "h", challenge: "c" }
    const ok = await createDevice(
      {},
      bio({ token: "dX." + secret }),
    ).biometricProof(view)
    assert.deepEqual(ok, {
      device: "dX",
      proof: await biometricProof(secret, "h", "c"),
    })
    assert.match(
      (await createDevice({}, bio({})).biometricProof(view)).error,
      /Face ID/,
    )
  })

  it("asks Telegram for access before enrolling, and reports a refusal", async () => {
    assert.deepEqual(
      await createDevice({}, bio({ accessGranted: true })).prepareBiometric(),
      {},
    )
    assert.deepEqual(
      await createDevice(
        {},
        bio({ accessGranted: false, grant: true }),
      ).prepareBiometric(),
      {},
    )
    assert.match(
      (
        await createDevice(
          {},
          bio({ accessGranted: false, accessRequested: true }),
        ).prepareBiometric()
      ).error,
      /no Face ID permission.*iOS Settings › Telegram › Face ID/,
    )
    assert.match(
      (await createDevice({}, bio({ available: false })).prepareBiometric())
        .error,
      /not available on this phone/,
    )
  })

  const lines = []
  const reporting = () => {
    lines.length = 0
    setReporter((e, d) => lines.push([e, d]))
  }
  const state = {
    inited: true,
    answered: true,
    available: false,
    type: "unknown",
    accessRequested: false,
    accessGranted: false,
    tokenSaved: false,
    deviceId: false,
  }

  it("tells a client that is too old from one that did not answer, and a refusal from a missing question", async () => {
    const prep = (o, version, grant) =>
      createDevice(
        {},
        {
          info: async () => ({ ...state, ...o }),
          requestAccess: async () => ({ ...state, available: true, ...grant }),
        },
        { version },
      ).prepareBiometric()
    assert.match(
      (await prep({ answered: false }, "7.0")).error,
      /too old.*needs 7\.2 or later, and this is 7\.0/,
    )
    assert.match(
      (await prep({ answered: false }, "7.10")).error,
      /did not answer in time/,
    )
    assert.match(
      (await prep({ answered: false }, undefined)).error,
      /did not answer in time/,
    )
    assert.match(
      (await prep({ available: true }, "8.0", { accessRequested: true })).error,
      /no Face ID permission/,
    )
    assert.match(
      (await prep({ available: true }, "8.0", {})).error,
      /did not ask for Face ID/,
    )
  })

  it("reports why, with the manager's state and never a token, when Face ID cannot be used", async () => {
    reporting()
    const device = createDevice(
      {},
      {
        info: async () => ({ ...state, available: true, deviceId: true }),
        requestAccess: async () => ({
          ...state,
          available: true,
          accessRequested: true,
          deviceId: true,
        }),
      },
      { version: "8.0", platform: "ios" },
    )
    await device.prepareBiometric()
    assert.equal(lines.length, 1)
    const [event, data] = lines[0]
    assert.equal(event, "biometric_unavailable")
    assert.deepEqual(data, {
      why: "refused",
      inited: true,
      answered: true,
      available: true,
      type: "unknown",
      requested: true,
      granted: false,
      saved: false,
      device: true,
      version: "8.0",
      platform: "ios",
    })
    await createDevice(
      {},
      {
        info: async () => ({ ...state, available: false }),
      },
    ).prepareBiometric()
    assert.equal(lines[1][1].why, "not_available")
    setReporter(() => {})
  })

  it("reports nothing when Face ID can be used", async () => {
    reporting()
    await createDevice({}, bio({ accessGranted: true })).prepareBiometric()
    assert.deepEqual(lines, [])
    setReporter(() => {})
  })
})

describe("the client version", () => {
  it("compares part by part, not as text", () => {
    assert.equal(versionAtLeast("7.10", "7.2"), true)
    assert.equal(versionAtLeast("7.2", "7.2"), true)
    assert.equal(versionAtLeast("7.1", "7.2"), false)
    assert.equal(versionAtLeast("6.9", "7.2"), false)
    assert.equal(versionAtLeast("8", "7.2"), true)
  })
})
