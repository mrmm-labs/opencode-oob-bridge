## Why

The Mini App works in a browser and in tests, and fails on a real iPhone: the live stream shows "Reconnecting…" and disables every action, Face ID enrolment answers "Face ID is not available in this app", and rows show raw session ids. After that it looks crude beside Telegram's own Mini Apps. This change fixes the failures first, then redoes the screens in Telegram's native style.

## What Changes

**Phase 1, the failures**

- The app reads the event stream with a reader (`getReader`), not async iteration, and ends every attempt by cancelling its request. It calls the stream "live" when the first bytes arrive, and backs off from the first failure.
- The app loads Telegram's own script (`telegram-web-app.js`) and uses its biometric manager for Face ID. The content security policy allows that one origin for scripts. The hand-rolled event bridge stays as the fallback and also defines the receive hooks the native clients call.
- The app reports what it cannot do to the bridge (`POST /v1/log`, rate-limited, no credential), so the next failure is visible in the bridge log.
- A refusal on the relay link says why in its body (`no_operator`, `bad_signature`, `too_old`, …) and the bridge logs `edge_refused`. The app shows a sentence for each.
- `channels.telegram.operator` is the operator's user id when pairing stored none. A bridge paired to a group sets the menu button in the operator's own chat.

**Phase 2, the redesign** (added to this change in its own pull request): titles from the host, a native-style session list and detail, native Telegram controls, markdown in the conversation.

## Capabilities

### Modified Capabilities

- `mini-app`: how it loads, stays live and reports.
- `public-edge`: the reason of a refusal, and the operator from the config file.

## Out of scope

Hosting, the relay, a second operator.

## Impact

- **Existing surface audit.** `src/core/app.ts` (the policy), `src/core/api.ts` (refusals, `/v1/log`), `src/connectors/telegram.ts` (operator, menu button), `miniapp/`.
- **Supersession.** The "no third-party script" rule of `mini-app` gives way to one named script of Telegram's.
- **Downstream.** None: the relay forwards the bridge's policy header as it is.
- **Definition of done.** `pnpm test` ends `fail 0`; the stream test passes with a body that has no async iterator; Face ID goes through Telegram's manager on a real phone.
