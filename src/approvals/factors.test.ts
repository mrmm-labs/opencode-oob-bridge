import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto"
import { describe, it } from "node:test"

import {
  biometricProof,
  checkRegistration,
  has,
  isFactor,
  newDevice,
  parseEnrolled,
  passkeyChallenge,
  verifyAssertion,
} from "./factors.ts"

describe("factor names", () => {
  it("knows the three and refuses push", () => {
    for (const f of ["biometric", "passkey", "totp"]) assert.ok(isFactor(f))
    for (const f of ["push", "", 1, undefined]) assert.ok(!isFactor(f))
  })
})

describe("the Face ID proof", () => {
  it("is bound to the secret, the request hash and the challenge", () => {
    const k = Buffer.from("k".repeat(32))
    const p = biometricProof(k, "h", "c")
    assert.match(p, /^[0-9a-f]{64}$/)
    assert.equal(p, biometricProof(k, "h", "c"))
    assert.notEqual(p, biometricProof(Buffer.from("j".repeat(32)), "h", "c"))
    assert.notEqual(p, biometricProof(k, "h2", "c"))
    assert.notEqual(p, biometricProof(k, "h", "c2"))
  })

  it("makes 32-byte secrets and ids that cannot hold the token separator", () => {
    const a = newDevice()
    const b = newDevice()
    assert.notEqual(a.secret, b.secret)
    assert.equal(Buffer.from(a.secret, "base64url").length, 32)
    assert.doesNotMatch(a.id + a.secret, /\./)
  })

  it("derives the passkey challenge from the hash and the nonce", () => {
    assert.notEqual(passkeyChallenge("h", "n"), passkeyChallenge("h", "m"))
    assert.notEqual(passkeyChallenge("h", "n"), passkeyChallenge("g", "n"))
  })
})

describe("enrolled devices", () => {
  it("reads what the Keychain holds, and nothing from garbage", () => {
    const e = parseEnrolled(
      JSON.stringify({ biometric: { d1: "s" }, passkeys: { c: "k" }, x: 1 }),
    )
    assert.deepEqual({ ...e.biometric }, { d1: "s" })
    assert.ok(has(e.passkeys, "c"))
    for (const bad of [undefined, "", "{", "[]", "null"]) {
      const g = parseEnrolled(bad)
      assert.deepEqual(
        Object.keys(g.biometric).concat(Object.keys(g.passkeys)),
        [],
      )
    }
  })

  it("does not find a device by an inherited property name", () => {
    const e = parseEnrolled(JSON.stringify({ biometric: { d1: "s" } }))
    for (const k of ["__proto__", "constructor", "toString"])
      assert.ok(!has(e.biometric, k))
    assert.ok(!has(e.biometric, 5))
  })
})

describe("passkeys", () => {
  const ORIGIN = "https://app.example.com"
  const RP = "app.example.com"
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  })
  const spki = (
    publicKey.export({ type: "spki", format: "der" }) as Buffer
  ).toString("base64url")

  const assertion = (
    o: {
      flags?: number
      origin?: string
      type?: string
      challenge?: string
      rp?: string
    } = {},
  ) => {
    const data = Buffer.concat([
      createHash("sha256")
        .update(o.rp ?? RP)
        .digest(),
      Buffer.from([o.flags ?? 0x05, 0, 0, 0, 7]),
    ])
    const client = Buffer.from(
      JSON.stringify({
        type: o.type ?? "webauthn.get",
        challenge: o.challenge ?? "chal",
        origin: o.origin ?? ORIGIN,
      }),
    )
    const sig = signBytes(
      "sha256",
      Buffer.concat([data, createHash("sha256").update(client).digest()]),
      privateKey,
    )
    return {
      authenticatorData: data.toString("base64url"),
      clientDataJSON: client.toString("base64url"),
      signature: sig.toString("base64url"),
    }
  }
  const check = (a: unknown, over: Record<string, unknown> = {}) =>
    verifyAssertion({
      publicKey: spki,
      rpId: RP,
      origin: ORIGIN,
      challenge: "chal",
      assertion: a,
      ...over,
    })

  it("accepts a valid assertion", () => assert.equal(check(assertion()), true))

  it("refuses another origin, relying party, challenge or type", () => {
    assert.equal(check(assertion({ origin: "https://evil.example" })), false)
    assert.equal(check(assertion({ rp: "evil.example" })), false)
    assert.equal(check(assertion({ challenge: "other" })), false)
    assert.equal(check(assertion({ type: "webauthn.create" })), false)
    assert.equal(check(assertion(), { challenge: "other" }), false)
  })

  it("needs user presence and user verification", () => {
    assert.equal(check(assertion({ flags: 0x01 })), false)
    assert.equal(check(assertion({ flags: 0x04 })), false)
  })

  it("refuses a signature of another key, a cut signature and junk", () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" })
    const o = (
      other.publicKey.export({ type: "spki", format: "der" }) as Buffer
    ).toString("base64url")
    assert.equal(check(assertion(), { publicKey: o }), false)
    const a = assertion()
    assert.equal(check({ ...a, signature: a.signature.slice(0, -4) }), false)
    for (const junk of [null, {}, "x", { authenticatorData: 1 }])
      assert.equal(check(junk), false)
  })

  it("accepts a registration with our challenge and origin, and a readable key", () => {
    const client = (over: object = {}) =>
      Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge: "chal",
          origin: ORIGIN,
          ...over,
        }),
      ).toString("base64url")
    const cred = (over: object = {}) => ({
      id: "cred-1",
      clientDataJSON: client(),
      publicKey: spki,
      ...over,
    })
    const go = (c: unknown, challenge = "chal") =>
      checkRegistration({ challenge, origin: ORIGIN, credential: c })
    assert.deepEqual(go(cred()), { id: "cred-1", publicKey: spki })
    assert.equal(go(cred(), "other"), undefined)
    assert.equal(
      go(cred({ clientDataJSON: client({ origin: "https://evil.example" }) })),
      undefined,
    )
    assert.equal(
      go(cred({ clientDataJSON: client({ type: "webauthn.get" }) })),
      undefined,
    )
    assert.equal(go(cred({ publicKey: "AAAA" })), undefined)
    assert.equal(go(cred({ id: "a b" })), undefined)
    assert.equal(go(null), undefined)
  })
})
