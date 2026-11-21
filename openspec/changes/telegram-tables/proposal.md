## Why

A GFM table in a reply reached Telegram as raw `| a | b |` lines, which wrap and are unreadable on a phone.

## What Changes

- A table (header row, `---` separator, rows) is recognised in a reply.
- Narrow (about 40 monospace characters): a `<pre>` grid with padded, aligned columns and no inline markdown.
- Wide: one block per row, first column bold, then `header: value` per remaining column, inline markdown kept.
- A long table is split at row boundaries, each message with its header, within 4096 characters.

## Capabilities

### Added Capabilities

- `chat`: how tables are shown in a reply.

## Impact

- **Existing surface audit.** `src/connectors/telegram-markdown.ts` only; every reply, stream and split goes through `markdownToHtml` and `splitReply`.
