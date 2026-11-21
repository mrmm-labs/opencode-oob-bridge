## Decisions

### D1. When a card is posted

A card is posted for a mirrored top-level session when a turn ends and either at least one file changed or the turn ran at least `turnCard.minSeconds` (default 20). A turn that changed nothing and was short adds nothing: the pinned card's state line is enough. Subagent turns never get a card.

### D2. Foldable through a capability

A connector declares `foldable`. Telegram renders the body as `<blockquote expandable>` (entity type `expandable_blockquote`, collapsed by default). A connector without it gets the header and a summary of at most 300 characters and no file list. The core never branches on the connector type.

### D3. Numbers come from the core

Files and lines come from the diff summary view-model. When it is unavailable the header leaves the counts out. The card never shows a number it did not get.

### D4. Buttons act on the session now

Diff sends the patch as a document (the image comes with `diff-images`). Continue sends `continue` as a prompt with the session's delivery mode and is left out when chat is off. Stop interrupts a running turn, or says nothing is running. Buttons are removed from the previous card when a new one is posted, and after one hour.

## Risks

Cards for fast back-to-back turns would flood. Mitigation: D1's thresholds, and one card per turn.
