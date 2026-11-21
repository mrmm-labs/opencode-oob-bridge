## 1. Card

- [ ] 1.1 Decide per turn whether a card is posted (D1). Verify: tests for changed files, long turn, short turn without changes, subagent turn.
- [ ] 1.2 Render header, summary and file list; add the `foldable` capability and the Telegram expandable block. Verify: render tests for 1, 15 and 40 files and for the plain fallback.
- [ ] 1.3 Take counts from the diff summary and omit them when unavailable. Verify: a test with an unavailable summary.
- [ ] 1.4 Redact summary and file names like other text. Verify: a test with a secret in the summary.

## 2. Buttons

- [ ] 2.1 Diff sends the patch document. Verify: a test receives a document with the patch.
- [ ] 2.2 Continue and Stop through the core actions; remove stale buttons. Verify: tests for each button, for chat off, and for a stale card.
- [ ] 2.3 README and config keys `turnCard` and `turnCard.minSeconds`. Verify: `config.test.ts` and `readme.test.ts`.
