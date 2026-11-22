// The L2 factors on the phone: which ones this device can use, in the bridge's order, and the proofs.
// The bridge checks every proof; nothing here decides whether an approval is granted.
import { biometric, note, versionAtLeast } from "./tg.js"

export { versionAtLeast }

const TAG = "oob-l2-biometric-v1"

export const unb64 = (s) => {
  const t = String(s).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(t + "=".repeat((4 - (t.length % 4)) % 4))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

export const b64 = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

/** The factors to offer: the bridge's, in its order, that this device can use. */
export function orderFactors(offered, device) {
  const can = {
    biometric: device?.biometric === true,
    passkey: device?.passkey === true,
    totp: true,
  }
  return (offered ?? []).filter((f) => can[f] === true)
}

/** The stored token is `<device id>.<secret>`. */
export function parseToken(token) {
  const i = typeof token === "string" ? token.indexOf(".") : -1
  return i > 0 && i < token.length - 1
    ? { device: token.slice(0, i), secret: token.slice(i + 1) }
    : undefined
}

/** HMAC-SHA256 over the tag, the request hash and the challenge: what the bridge recomputes. */
export async function biometricProof(
  secret,
  requestHash,
  challenge,
  subtle = globalThis.crypto.subtle,
) {
  const key = await subtle.importKey(
    "raw",
    unb64(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(TAG + "\n" + requestHash + "\n" + challenge),
  )
  return [...new Uint8Array(mac)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
}

/** A passkey is offered only where the webview has WebAuthn and a platform authenticator that verifies the user. */
export async function passkeySupported(win = globalThis) {
  try {
    return (
      typeof win.PublicKeyCredential === "function" &&
      typeof win.navigator?.credentials?.get === "function" &&
      (await win.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.()) ===
        true
    )
  } catch {
    return false
  }
}

/** Telegram added the biometric manager in 7.2. */
const FACE_ID_FROM = "7.2"

/**
 * Why Face ID cannot be used, in a sentence the person can act on. `why` is the short code that goes
 * to the bridge's log with the manager's own state.
 */
export function biometricProblem(info, version, afterAccess = false) {
  if (info?.answered === false)
    return version && !versionAtLeast(version, FACE_ID_FROM)
      ? {
          why: "too_old",
          text: `Telegram is too old for Face ID: it needs ${FACE_ID_FROM} or later, and this is ${version}. Update Telegram.`,
        }
      : {
          why: "no_answer",
          text: "Telegram did not answer in time. Close this app and open it again.",
        }
  if (!info?.available)
    return {
      why: "not_available",
      text: "Face ID is not available on this phone: set it up in iOS Settings › Face ID & Passcode, and allow Telegram to use it.",
    }
  if (afterAccess && !info.accessGranted)
    return info.accessRequested
      ? {
          why: "refused",
          text: "Telegram has no Face ID permission for this app. Allow it in iOS Settings › Telegram › Face ID and in this app's ⋯ menu › Settings, then try again.",
        }
      : {
          why: "not_asked",
          text: "Telegram did not ask for Face ID. Close this app and open it again.",
        }
  return undefined
}

/** What the controller calls for the parts that need the phone. `env` is what Telegram said about itself. */
export function createDevice(win = globalThis, bio = biometric(win), env = {}) {
  const REASON = "Approve this request"
  const report = (why, i) =>
    note("biometric_unavailable", {
      why,
      inited: i?.inited ?? "",
      answered: i?.answered !== false,
      available: i?.available === true,
      type: i?.type ?? "",
      requested: i?.accessRequested === true,
      granted: i?.accessGranted === true,
      saved: i?.tokenSaved === true,
      device: i?.deviceId === true,
      version: env.version ?? "",
      platform: env.platform ?? "",
    })
  return {
    async support(view) {
      const info = await bio.info()
      return {
        biometric: info.available && info.tokenSaved,
        passkey:
          view?.passkey !== undefined &&
          (await passkeySupported(win)) &&
          view.passkey.rp === win.location?.hostname,
      }
    },

    async biometricProof(view) {
      const token = await bio.authenticate(REASON)
      const t = parseToken(token)
      if (!t) return { error: "Face ID did not release the secret." }
      return {
        device: t.device,
        proof: await biometricProof(
          t.secret,
          view.request_hash,
          view.challenge,
        ),
      }
    },

    async passkeyProof(view) {
      try {
        const c = await win.navigator.credentials.get({
          publicKey: {
            challenge: unb64(view.passkey.challenge),
            rpId: view.passkey.rp,
            allowCredentials: view.passkey.credentials.map((id) => ({
              type: "public-key",
              id: unb64(id),
            })),
            userVerification: "required",
            timeout: 60_000,
          },
        })
        const r = c.response
        return {
          credential: {
            id: c.id,
            authenticatorData: b64(r.authenticatorData),
            clientDataJSON: b64(r.clientDataJSON),
            signature: b64(r.signature),
          },
        }
      } catch {
        return { error: "The passkey was not used." }
      }
    },

    /** Asks Telegram for biometric access before the code is spent, so a refusal wastes nothing. */
    async prepareBiometric() {
      let info = await bio.info()
      let bad = biometricProblem(info, env.version)
      if (bad) {
        report(bad.why, info)
        return { error: bad.text }
      }
      if (!info.accessGranted) info = await bio.requestAccess(REASON)
      bad = biometricProblem(info, env.version, true)
      if (bad) report(bad.why, info)
      return bad ? { error: bad.text } : {}
    },
    saveToken: (token) => bio.saveToken(token),

    async createPasskey(o) {
      if (!(await passkeySupported(win)))
        return { error: "Passkeys are not available in this app." }
      try {
        const c = await win.navigator.credentials.create({
          publicKey: {
            challenge: unb64(o.challenge),
            rp: o.rp,
            user: {
              id: unb64(o.user.id),
              name: o.user.name,
              displayName: o.user.name,
            },
            pubKeyCredParams: [
              { type: "public-key", alg: -7 },
              { type: "public-key", alg: -257 },
            ],
            authenticatorSelection: {
              authenticatorAttachment: "platform",
              residentKey: "preferred",
              userVerification: "required",
            },
            attestation: "none",
            timeout: 60_000,
          },
        })
        return {
          credential: {
            id: c.id,
            clientDataJSON: b64(c.response.clientDataJSON),
            publicKey: b64(c.response.getPublicKey()),
          },
        }
      } catch {
        return { error: "The passkey was not made." }
      }
    },
  }
}
