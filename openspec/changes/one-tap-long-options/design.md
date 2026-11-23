## Decisions

- **48, not 40.** The request said "about 40", and its own samples have a 45-character option. A limit of 40 would still send them to the app, so the limit is 48 characters of plain label, which leaves room above the real 40 to 45.
- **Suffix.** "(Recommended)" in any case, as `starred` already matches it, is removed before counting. Only a trailing or leading occurrence is a suffix in practice; the one regex is reused.
- **Button text.** `<keycap> ★ <label>` for the recommended option, `<keycap> <label>` for the others. The star comes before the label so a cut never removes it. The whole text is cut to 40 characters with "…". The same `★ <label>` replaces "<label> ⭐" in the message body so the two agree.
- **Answer.** The callback is `<id>:<n>` and `n` indexes the form's own options, so the answer is the original string, suffix included. Nothing changes there.
- **Unchanged.** One button per row, the 2 to 4 option count, "📱 Answer in app" for a form that allows typing, the typed reply and `#id answer` fallbacks.
