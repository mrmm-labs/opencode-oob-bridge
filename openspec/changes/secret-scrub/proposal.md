## Why

A prompt, a question or a reply can carry a secret the person pasted or the model printed. The bridge sends that text to third-party services (ntfy, Telegram). A local secret broker can mask known secret values, but only if the bridge asks it before anything leaves the machine.

## What Changes

- **`scrub.socket`**: path of a local scrub socket (newline-delimited JSON, protocol v1). When set, every connector's outbound text is masked through it first. Off by default.
- **Fail closed**: if the socket cannot answer, a push is reduced to its title, and streamed or posted session text is dropped.
- **Limits stated**: text that does not go through a connector (the relay link, Mini App views) is not covered.

## Capabilities

### Added Capabilities

- `secret-scrub`: masking of outbound connector text through a local scrub socket.

## Impact

- **Existing surface audit.** `src/server.ts` (connector construction), `src/config.ts`, `src/connectors/types.ts` (the Connector contract is unchanged), new `src/scrub.ts`.
