## 1. Renderer

- [ ] 1.1 Embed the 8×16 font (ASCII and Latin-1) with its licence note. Verify: a test renders every glyph and compares to a stored hash.
- [ ] 1.2 Write the PNG encoder on `node:zlib` and a test-only decoder. Verify: a round trip returns the same pixels.
- [ ] 1.3 Lay out a diff: 56 columns, wrap with ↪, gutter, colours, hunk headers. Verify: golden images for a plain, a wrapped and a multi-file diff.
- [ ] 1.4 Contrast check. Verify: a test computes each colour pair's ratio and asserts at least 4.5.

## 2. Delivery

- [ ] 2.1 Split into at most three images of at most 70 lines and name the rest in the caption. Verify: a test with a 500-line diff.
- [ ] 2.2 Send an album and the patch document; exclusions and masking. Verify: tests for `diff.exclude`, a masked secret and a binary file.
- [ ] 2.3 Fall back to the patch and a file list when drawing fails. Verify: a test forces an encoder error.
- [ ] 2.4 Wire the Diff button and the core action. Verify: a card test taps Diff and gets images and a document.
- [ ] 2.5 README and a phone screenshot in the PR. Verify: `readme.test.ts` passes; the screenshot is attached.
