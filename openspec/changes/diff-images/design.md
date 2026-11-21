## Decisions

### D1. Pure Node renderer

Telegram does not show SVG, and a rasteriser would be a native dependency, which this repo does not take. A PNG is a header, a few chunks and a zlib stream, and `node:zlib` is built in. The bridge draws text from an embedded 8×16 bitmap font (public domain, ASCII and Latin-1, about 4 KB) scaled ×2 to 16×32 pixels per cell.

Trade-off: no anti-aliasing and no characters outside Latin-1. The patch document is the lossless fallback. Whether to allow an optional native renderer for Unicode is an open question.

### D2. Phone legibility is a number, not a feeling

Width 900 px, cell 16×32 px, so **56 columns**. A phone shows the image about 390 pt wide, so a glyph is about 14 px tall on screen, and a tap opens it at full size. Lines longer than 56 columns wrap with a ↪ marker and are never cut.

### D3. Limits

At most 70 lines per image and at most three images per Diff. Further hunks are only in the patch, and the caption says so. Images go as one album. The patch is a `.diff` document of at most 20 MB.

### D4. Colours

Added lines on green, removed on red, hunk headers and file headers on a dim blue, context on the background. Dark theme by default; `diff.theme` may be `light`. Colour pairs keep a contrast ratio of at least 4.5:1.

### D5. What is not drawn

Files matching `diff.exclude` (default `**/.env*`, `**/*.pem`, `**/*secret*`, `**/id_*`) appear by name with "content hidden" in the image and are left out of the patch. Known secret shapes in any other line are masked in both. Binary files appear as "binary, not shown".

## Risks

A hand-made font and encoder have bugs. Mitigation: golden-image tests, and a check that decodes the PNG back with a small reader in the test.
