## Why

A document of a type the model cannot take inline (`.xlsx`, `.docx`, `.zip`) was refused with "not accepted", though the agent can read such files with its own tools.

## What Changes

- A document whose type is not in `media.mimes` is downloaded, within the same size limit, saved under a per-session folder in the bridge's state directory (mode `0600`, folder `0700`, a safe name with the original extension), and the session gets the text `File received: <name> (<mime>, <size>) saved at <abs path>` after the caption.
- Types in `media.mimes` go inline as before. The size limit and its message are unchanged. Each file's outcome (`inline`, `saved`, `refused`, `failed`) is logged.

## Capabilities

### Modified Capabilities

- `chat-files`: documents of any type.

## Impact

- **Existing surface audit.** `src/connectors/telegram-media.ts`, `src/connectors/telegram.ts` (`filesDir`), README.
