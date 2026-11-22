## Why

Enrolling Face ID means reading a code at the Mac and typing it on the phone. A QR code that opens the Mini App with the code already filled in is quicker. The "Open" button on a question or permission message also needs to land on that session, and the app ignores what it is given today.

## What Changes

- `/oob approvals enroll-biometric` and `enroll-passkey` show a QR code in the TUI, next to the typed code. It encodes `<miniApp.link>?startapp=enrol_<code>`. It needs `miniApp.link`; without it only the code shows.
- The app reads the start parameter from the hash, the init data (`start_param`) or `?s=`, and acts on its prefix: `enrol_<code>` opens the enrolment screen with the code filled in and Face ID focused, `s_<id>` opens a session, `a_<id>` an approval. A bare id still opens a session.
- The bridge sends `s_<id>` in the "Open" button, in a private chat and in a group.

## Capabilities

### Modified Capabilities

- `mini-app`: what a start parameter opens, and the enrolment screen.

## Out of scope

Sending the QR or the link to Telegram. The Mac is the L3 step, so the code is shown at the Mac only. The code's life (single use, 5 minutes, five tries) and the check that the init data names the operator are unchanged.

## Impact

- **Existing surface audit.** `src/connectors/telegram.ts` (`openButton`), `src/control.ts` and `src/menu.ts` (enrolment), `src/approvals/link.ts` (new), `miniapp/`.
