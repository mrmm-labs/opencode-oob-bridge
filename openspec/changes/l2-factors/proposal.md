## Why

L2 asks for a typed TOTP code. That works, but it is the slowest part of a phone approval, and the seed is only as safe as the device that holds it. Telegram's Mini App can ask for Face ID and release a device secret, and a passkey can prove the same thing where the webview allows it. L2 should accept any of these, with Face ID first and the code as the fallback.

## What changes

- **L2 is any listed factor.** New `approvals.l2.factors`, an ordered list, default `["biometric", "passkey", "totp"]`.
- **biometric.** The bridge issues a per-device secret at enrolment, started at the Mac. The Mini App keeps it behind Face ID with Telegram's biometric manager and proves possession with an HMAC over the request hash and a one-time challenge. The secret can be revoked; enrolling again needs the Mac.
- **passkey (WebAuthn).** Offered only where the webview can use it. Registration is started at the Mac. An assertion over the request hash and a challenge counts as L2.
- **totp.** Unchanged. Typed in the chat, or in the Mini App. It is the fallback when the Mini App or biometrics are unavailable.
- **push** (ntfy, Apple Watch) is specified as L1 only and is not built.
- **The signed answer records the factor** (`factor`), so a caller and the audit see how L2 was met.
- **The Mini App** gets an approval view that offers the first factor available on the device and a "use another method" button.

## Capabilities

### New Capabilities

- `l2-factors`: the factors, their order, the enrolment, and what each proves.

### Modified Capabilities

- `approvals`: L2 is met by any listed factor, and the answer records it.
- `mini-app`: an approval view and an enrolment view.

## Out of scope

Building the push path. Passkey support on iOS where Telegram's webview lacks it (the app detects and does not offer it). Turning a phone permission reply (`gate`) into anything but a typed code. Hosting the Mini App. More than one operator. A web-based enrolment that does not start at the Mac.

## Impact

- **Existing surface audit.** `src/approvals/engine.ts` (`create`, `tap`, `typed`, `finish`, `levels`), `sign.ts` (the signed string), `config.ts`, `service.ts`, `src/core/api.ts` (init-data door), `src/connectors/telegram.ts` (`approvalCode`), `miniapp/tg.js`, `controller.js`, `views.js`, `docs/approvals.md`.
- **Supersession.** The "L2 uses a one-time code" requirement is replaced by "L2 is met by a listed factor"; the code rules stay as the `totp` factor.
- **Downstream.** A caller that copies `verifyAnswer` must take the new `signedString`: an answer with a `factor` signs the tag `oob-approval-v2`, so an old copy refuses it. The harness tier `telegram-totp` becomes "L2 from any factor".
- **Estimate.** Agent 1 day. Operator 10 minutes (enrol Face ID once the Mini App is hosted).
- **Definition of done.** `pnpm test` ends `fail 0`; a recorded approval on a phone with Face ID once the Mini App is hosted (not verifiable before).
