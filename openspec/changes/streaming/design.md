## Decisions

### D1. A capability decides the transport

A connector declares `draft` (native partial streaming) next to `edit`. The core picks `draft` when the target chat supports it, else `edit`, else sends the final message only. The core never reads the connector type.

### D2. Draft path

One `draft_id` per reply. Each update sends the whole text so far; the draft is refreshed at least every 20 seconds while the model is silent (the preview lives 30 seconds). When the turn ends the bridge sends the final message with `sendMessage` and the draft disappears. A rejected draft call switches that chat to the edit path for ten minutes and logs why.

### D3. Edit path

Edits keep `chat.streamMs` as the floor. A 429 with `retry_after` pauses edits for that long and doubles the interval up to 8 seconds; the interval halves back after 30 quiet seconds. A per-chat budget of `chat.streamBudget` edits a minute (default 30 [proposal]) caps the rate. Updates in a pause are coalesced: only the newest text is sent.

### D4. One text pipeline

Redaction, secret masking, Markdown to HTML and splitting at 3,800 characters happen before either transport, so both show the same text.

## Risks

The draft limits are not documented numerically. Mitigation: D2's fallback, and the interval floor of 300 ms for drafts is a [proposal] to confirm against a live bot.
