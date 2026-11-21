import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { OFF } from "./config.ts"
import { parseEnrolled } from "./factors.ts"
import { MemoryKeyStore } from "./keystore.ts"
import { ApprovalService } from "./service.ts"

const APP = "https://app.example.com/app/"

async function rig(app = APP) {
  const keys = new MemoryKeyStore()
  const t = { now: Date.parse("2026-11-21T12:00:00.000Z") }
  const svc = new ApprovalService({
    cfg: () => ({ ...OFF, enabled: true }),
    dir: await mkdtemp(join(tmpdir(), "oobb-svc-")),
    keys,
    connectors: () => [],
    away: () => true,
    now: () => t.now,
    sweepMs: 0,
    app: () => app,
  })
  const held = () => parseEnrolled(keys.items.get("l2-devices"))
  return { svc, keys, t, held }
}

const body = (r: { body: unknown }) => r.body as Record<string, any>

describe("enrolling Face ID", () => {
  it("needs the Mac to open it first", async () => {
    const r = await rig()
    const out = await r.svc.enrol({ kind: "biometric", code: "AAAAAAAA" })
    assert.equal(out.status, 409)
    assert.deepEqual(Object.keys(r.held().biometric), [])
  })

  it("returns the secret once, keeps it in the Keychain item, and spends the code", async () => {
    const r = await rig()
    const { code } = r.svc.openEnrolment("biometric")
    const out = await r.svc.enrol({
      kind: "biometric",
      code: code.toLowerCase(),
    })
    assert.equal(out.status, 200)
    const b = body(out)
    const [id, secret] = String(b.token).split(".")
    assert.equal(id, b.device)
    assert.equal(r.held().biometric[id], secret)
    assert.deepEqual(await r.svc.devices(), { biometric: [id], passkeys: [] })
    assert.equal((await r.svc.enrol({ kind: "biometric", code })).status, 409)
  })

  it("refuses a wrong code, and gives up after five wrong ones", async () => {
    const r = await rig()
    const { code } = r.svc.openEnrolment("biometric")
    for (let i = 0; i < 4; i++)
      assert.equal(
        (await r.svc.enrol({ kind: "biometric", code: "ZZZZZZZZ" })).status,
        403,
      )
    assert.equal((await r.svc.enrol({ kind: "biometric", code })).status, 200)
    r.svc.openEnrolment("biometric")
    for (let i = 0; i < 5; i++)
      await r.svc.enrol({ kind: "biometric", code: "ZZZZZZZZ" })
    const again = await r.svc.enrol({ kind: "biometric", code })
    assert.equal(again.status, 409)
  })

  it("refuses the right code after 5 minutes, and for the other kind", async () => {
    const r = await rig()
    const { code } = r.svc.openEnrolment("biometric")
    assert.equal((await r.svc.enrol({ kind: "passkey", code })).status, 403)
    r.t.now += 5 * 60_000
    assert.equal((await r.svc.enrol({ kind: "biometric", code })).status, 409)
    assert.deepEqual(Object.keys(r.held().biometric), [])
  })

  it("enrols nothing when the Keychain refuses the write", async () => {
    const r = await rig()
    r.keys.set = async () => {
      throw new Error("denied")
    }
    const { code } = r.svc.openEnrolment("biometric")
    assert.equal((await r.svc.enrol({ kind: "biometric", code })).status, 503)
  })

  it("revokes a device, and says so for an unknown one", async () => {
    const r = await rig()
    const { code } = r.svc.openEnrolment("biometric")
    const id = String(
      body(await r.svc.enrol({ kind: "biometric", code })).device,
    )
    assert.equal(await r.svc.revokeDevice("nope"), false)
    assert.equal(await r.svc.revokeDevice(id), true)
    assert.deepEqual(await r.svc.devices(), { biometric: [], passkeys: [] })
  })
})

describe("enrolling a passkey", () => {
  const client = (challenge: string, over: object = {}) =>
    Buffer.from(
      JSON.stringify({
        type: "webauthn.create",
        challenge,
        origin: "https://app.example.com",
        ...over,
      }),
    ).toString("base64url")
  const key = async () =>
    (await import("node:crypto"))
      .generateKeyPairSync("ec", { namedCurve: "P-256" })
      .publicKey.export({ type: "spki", format: "der" })
      .toString("base64url")

  it("needs the address of the app", async () => {
    const r = await rig("")
    const { code } = r.svc.openEnrolment("passkey")
    assert.equal((await r.svc.enrol({ kind: "passkey", code })).status, 409)
  })

  it("gives a challenge, then keeps the credential it names", async () => {
    const r = await rig()
    const { code } = r.svc.openEnrolment("passkey")
    const first = body(await r.svc.enrol({ kind: "passkey", code }))
    assert.equal(first.rp.id, "app.example.com")
    const credential = {
      id: "cred-1",
      clientDataJSON: client(first.challenge),
      publicKey: await key(),
    }
    const done = await r.svc.enrol({ kind: "passkey", code, credential })
    assert.equal(done.status, 200)
    assert.deepEqual(Object.keys(r.held().passkeys), ["cred-1"])
    assert.equal(
      (await r.svc.enrol({ kind: "passkey", code, credential })).status,
      409,
    )
  })

  it("refuses a credential made for another challenge or origin", async () => {
    const r = await rig()
    const { code } = r.svc.openEnrolment("passkey")
    const first = body(await r.svc.enrol({ kind: "passkey", code }))
    for (const c of [
      client("other"),
      client(first.challenge, { origin: "https://evil.example" }),
    ])
      assert.equal(
        (
          await r.svc.enrol({
            kind: "passkey",
            code,
            credential: { id: "c", clientDataJSON: c, publicKey: await key() },
          })
        ).status,
        422,
      )
    assert.deepEqual(Object.keys(r.held().passkeys), [])
  })
})

describe("status", () => {
  it("counts the devices and lists the factors in order", async () => {
    const r = await rig()
    const { code } = r.svc.openEnrolment("biometric")
    await r.svc.enrol({ kind: "biometric", code })
    const s = await r.svc.status()
    assert.equal(s.biometric, 1)
    assert.equal(s.passkeys, 0)
    assert.deepEqual(s.factors, ["biometric", "passkey", "totp"])
  })
})
