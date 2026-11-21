## Why

An agent that produces a file (a report, a screenshot, a log) had no way to put it in the Telegram topic of its session.

## What Changes

- A tool, `oob_send_file`, offered to every agent by the plugin: `path`, `caption`, `as` (`photo`, `document`, `auto`).
- It posts to the topic of the root session. No topic: it fails clearly, never General.
- Limits: 50 MB; no directories, no non-regular files, no symlink that points outside the home directory.
- The caption is redacted like chat replies. The log holds `file_sent` with size and `trace_id`, never contents. A failed send returns a short error; a 5xx is retried once.

## Capabilities

### Added Capabilities

- `media`: files sent by the agent.

## Impact

- **Existing surface audit.** `src/sendfile.ts` (new), `src/server.ts` (tool registration), `src/bridge.ts` (`sendFile`), `src/connectors/telegram.ts` (`file`, `upload`), `src/connectors/types.ts`.
