## Why

When a turn ends the operator wants to know what changed without opening the Mac: how many files, how many lines, a short summary, and a way to look at the diff or carry on. Today a finished turn only edits the pinned card, and `notify.finished` posts one plain line.

## What Changes

- A **turn card** is posted when a mirrored session's turn ends with changes or after a long turn.
- The card has a one-line header that is always visible: result, files, lines added and removed, duration.
- Summary and file list sit in a **foldable** block (Telegram expandable blockquote), so a long turn does not flood the topic.
- Buttons: Diff, Continue, Stop.
- Channels without folding get the header and a short summary.

## Capabilities

### New Capabilities

- `turn-card`: when a card is posted, what it shows, how it folds and what its buttons do.

### Modified Capabilities

- `pinned-card`: a finished turn may now add a turn card.

## Out of scope

The diff image (`diff-images`), a card for subagent turns, editing old cards into stubs, per-file buttons.

## Impact

- **Existing surface audit.** `src/bridge.ts` (finished and failed pushes, `notify.finished`), `src/connectors/telegram-render.ts` (HTML rendering, `capabilities` in `types.ts`), the diff summary view-model of `core-api`.
- **Supersession.** `notify.finished` keeps its meaning (one plain message per finished turn); the turn card replaces it when on.
- **Downstream.** `diff-images` upgrades the Diff button.
- **Estimate.** Agent 1 day. Operator 5 minutes.
- **Definition of done.** `pnpm test` ends `fail 0`, and a recorded Telegram run shows one folded card for a turn that changed files, with the three buttons working.
