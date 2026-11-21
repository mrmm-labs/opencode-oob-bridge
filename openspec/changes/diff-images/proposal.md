## Why

A diff pasted as text is hard to read on a phone: lines wrap, there is no colour and Telegram cuts long messages. The operator wants a highlighted diff image that is readable on a phone, and the patch file next to it for the cases where an image is not enough.

## What Changes

- The Diff button of the turn card (and a core action) sends **up to three images** of the diff and the **patch file**.
- Images are drawn by the bridge itself: a small PNG encoder on `node:zlib` and an embedded bitmap font. **No new runtime dependency.**
- Layout is made for a phone: 56 columns, large glyphs, red and green line backgrounds, a line-number gutter, wrapped long lines.
- Files that look secret are listed by name and not drawn.

## Capabilities

### New Capabilities

- `diff-images`: the images, their limits, what is hidden, and the patch file.

### Modified Capabilities

None. (`turn-card`'s Diff button is upgraded by this change's requirements once `turn-card` is archived.)

## Out of scope

Syntax highlighting by language, word-level highlighting inside a changed line, characters outside Latin-1 (drawn as a placeholder, the patch holds the real text), side-by-side layout, images for the Mini App (it draws its own).

## Impact

- **Existing surface audit.** The diff summary and patch of `core-api`, the secret filter (`src/filter.ts`), document upload in `src/connectors/telegram-media.ts`, the Diff button of `turn-card`.
- **Supersession.** The patch-only Diff of `turn-card`.
- **Downstream.** None.
- **Estimate.** Agent 2 days (encoder and font are most of it). Operator none.
- **Definition of done.** `pnpm test` ends `fail 0` with golden-image tests, and a recorded Telegram run shows the images and the patch for a real turn, with the image checked on a phone screenshot kept in the PR.
