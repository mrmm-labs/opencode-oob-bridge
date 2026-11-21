## Context

L2 is a tap and a TOTP code typed in the chat. The signing key and the seed are in the Keychain. The Mini App already authenticates with Telegram init data (`public-edge`), and loads no third-party script.

## Decisions

### D1. L2 is a list of factors

`approvals.l2.factors` is an ordered list of `biometric`, `passkey`, `totp`; the default is all three in that order. `push` is refused in the list: it never counts as L2. A factor is **offered** only when it is configured and ready: `totp` needs a seed and a channel that takes typed text; `biometric` needs an enrolled device and a channel that can open the app; `passkey` needs an enrolled credential, an app origin and the same channel. An L2 request fails fast as `unavailable` when no factor is offered.

### D2. The app chooses among what the device has

The bridge sends the offered factors in config order. The app keeps those the device supports (biometrics available and a token saved here; WebAuthn present and a credential enrolled; the code always) and shows the first, with "Use another method" for the next. The ordering is one pure function in the app. In the chat, the code prompt carries an Open button when the app is reachable and still takes a typed code, so a phone without the app, or without Face ID, falls back to the code with nothing else to do.

### D3. biometric: a device secret released by Face ID

The Mac opens an enrolment (`/oob approvals enroll-biometric`): an 8-character code, single use, 5 minutes, shown in the TUI. The app posts the code with its init data; the bridge makes 32 random bytes and an id, keeps them in the Keychain item `l2-devices`, and returns `<id>.<secret>` once. The app stores that string with the biometric manager's `updateBiometricToken`, which keeps it behind Face ID on the device.

At approval the app fetches a challenge (16 random bytes, single use, bound to one request), asks Face ID with `authenticate`, receives the token, and sends `HMAC-SHA256(secret, "oob-l2-biometric-v1\n" + request_hash + "\n" + challenge)` with the device id. The bridge recomputes it and compares in constant time. The secret never travels again. Revoking removes the id from the item; a revoked device's proof fails.

The app speaks Telegram's biometry events itself (`web_app_biometry_*`), as it already does for `web_app_ready`, because loading Telegram's script is excluded by the app's content policy. Those event names are taken from Telegram's documented `BiometricManager` and are not yet exercised against a client.

### D4. passkey: WebAuthn where the webview has it

The app offers a passkey only when `PublicKeyCredential` exists, a user-verifying authenticator is available, and the page's host is the relying party id the bridge derived from `miniApp.url`. Registration is opened at the Mac like D3, in two steps (challenge, then credential). The bridge keeps the credential id and public key (SPKI) in `l2-devices`. An assertion is accepted when the client data names `webauthn.get`, the challenge and origin are ours, the authenticator data carries the hash of the relying party id and the user-verified flag, and the signature verifies. The challenge is derived from the request hash and a single-use nonce. Attestation is not checked: registration is already gated by the code from the Mac. The signature counter is not persisted: writing the Keychain would ask for presence at the Mac while the operator is away, and the single-use challenge already stops replay.

On iOS, Telegram's webview is a plain WKWebView and probably lacks WebAuthn for this host. The app detects that and does not offer a passkey. Nothing pretends otherwise.

### D4b. push is L1 only

An ntfy or watch Approve button identifies nobody, so it is L1 at most, the same rule as today. It is written down here and not built.

### D5. totp is unchanged and can also be entered in the app

Same seed, same step-used-once rule, same three-strikes rule. A code typed in the chat or in the app goes through one check. A request whose factors exclude `totp` ignores typed codes.

### D6. The answer records the factor

`Answer.factor` is `biometric`, `passkey` or `totp` on an L2 approve, and absent otherwise. It is part of the signature: when present the signed string uses the tag `oob-approval-v2` and ends with a `factor` line; without it the string is unchanged (`oob-approval-v1`). An old copy of `verifyAnswer` therefore refuses a v2 answer instead of ignoring the field.

### D7. Only the app's init-data door reaches the factor routes

`/v1/approvals/*` answers only a request that came through the relay with verified init data of the operator. A bearer token is refused: it cannot start a factor, and these routes can settle an approval. Three wrong proofs deny the request (`bad_code` for the code, `bad_proof` for the others).

## What a client may rely on

The bridge verifies the init data, the proof and the single use of the challenge. Telegram gives consent and the device's Face ID prompt; it never unlocks the vault. The channel is relied on only to show the Open button. The host is not involved.

## Risks

- Biometric is the same phone as the tap: a thief with the unlocked phone and the face (or a coerced face) passes L2. TOTP kept on another device is stronger against that; the default order trades that for speed. Operators who want a second device list only `["totp"]`.
- A script that runs in the Mini App origin could ask the biometric manager. The origin is ours and the policy forbids other scripts.
- The secret crosses the relay once, at enrolment, under init data and a code shown at the Mac.
- Telegram event names for biometrics are unverified against a client.
