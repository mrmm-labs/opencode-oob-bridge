## Decisions

- **One entry point.** `Router.input(source, at?)`. `tui` is input at the Mac. `telegram` and `app` are phone activity. `agent` and `rpc` are recorded and change nothing. `touch` and `phone` stay as the two effects.
- **Typed prompt test.** The inbox event carries no source, so the bridge decides: a subagent's prompt is `agent`; a prompt it sent itself (it already tracks these to label turns) is its sender's, counted when that sender entered; an unviewed (headless) session is `agent`; with no TUI attached it is `agent`; otherwise `tui`. An agent that prompts a viewed top-level session while a TUI is attached still looks typed. That residue is stated, and the phone rule still wins because phone activity holds away until input has continued for the grace time.
- **Answers are not input.** `form.replied` and `permission.replied` no longer touch the router: the event cannot say whether the TUI or a client answered.
- **The TUI half** starts with no input and reports one only after `/oob` is used. The server ignores an absent time.
- **App activity** is a request on the relay edge. Other core API requests are `rpc`.
- **Explanation.** The state carries the source and time of the input that decided it. `input`: "here: TUI input 2m ago", or "here: bridge started 2m ago" for the start grace. `phone`: "away: phone active 30s ago".
- **Log.** `presence_change` on each change of away or reason: `away`, `reason`, `source`, `ago_s`.
- **Held asks.** An unsent entry keeps a replay for each held question or permission. When away begins, each still open one is replayed (it routes now) before the digest; the digest counts only what could not be replayed. Replay skips a request that already has a pending entry, so nothing is pushed twice.
