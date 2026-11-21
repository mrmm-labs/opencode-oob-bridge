## Context

Across processes the file lock already keeps one bridge. Inside a process the bridge restarts without the process, and `TelegramConnector.polling` only guards one connector object, not the one that replaces it.

## Decisions

- **Registry by token hash.** A module-level map holds the running loop of each bot (sha256 of the token, first 16 hex, never the token). A new loop awaits the previous one's promise, capped at 5 s. The map survives restarts of the bridge because it lives in the module, and a second copy of the module would be a second process-like world the lock already covers.
- **Conflict handling.** The message of a failed `getUpdates` with HTTP 409 sets the status text and a flag; the first one of an episode is logged. No `telegram_error` is written for it.

## What a client may rely on

- Two receive loops of one bot never run at once in one process.

Left to Telegram: ending the server side of an aborted long poll, up to 30 seconds.
