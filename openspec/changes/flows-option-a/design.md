## Decisions

Taken without asking, because the operator was away; each can be changed in review.

- **One-tap test.** A question is one-tap when it has exactly one field, that field is single-select, it has 2 to 4 options, and every option label is at most 24 characters. Typing allowed (`custom`) does not disqualify it: the options are buttons and a "📱 Open" row offers the app for another answer. Everything else is in-app. The test is one pure function, so the card, the keyboard and the log agree.
- **Typed text fallback stays.** A reply to the message or `#id answer` still answers, for a form that is one-tap or not, because it needs no state. Only buttons, the stepper and the ✏️ force-reply are removed.
- **Old buttons.** A tap on a stepper button (`s:`) or an approval `ap:` button of a message sent before the upgrade answers with a toast ("This moved to the app: tap 📱 Open") and applies nothing. The next restart or the message's own settlement removes them.
- **Deep links.** `f_<id>` joins `s_<id>`, `a_<id>` and `enrol_<code>`. In a private chat the button is a web-app button with `?s=f_<id>`; in a group it is the direct link, which is the only form a group allows. The pending id is 4 characters, so the parameter stays under Telegram's 64.
- **Approval routing.** The operator's private chat is tried first (the person must have started the bot). If sending there fails, the bridge uses a topic named "Approvals" in the paired forum chat, created on first use and remembered with the other topics. A failed DM is remembered for ten minutes so each request does not retry it. Approvals never go to General. With neither, the request is refused as undeliverable, which the caller already sees as a channel that is down.
- **No inline decision on an approval.** Deny also needs the app. A denial is a cheap proof, but a button that looks like Approve next to one that denies invites a wrong tap, and the app shows the context first.
- **Recommended option.** An option whose label ends with "(Recommended)" (any case) is selected on open and tagged "Recommended"; the suffix is dropped from the label and the answer sent is the label without it. If no option is recommended, nothing is selected, and Send stays disabled until every required single-select field has a value.
- **Phone-side draft.** The app keeps what the person chose for a question in the page's local storage under the pending id, and drops it on Send or when the question is gone. A bridge restart does not touch it. The pending store already holds the questions, so the screen can be rebuilt from it.
- **Withdrawn versus answered.** When OpenCode no longer holds a form, the lookup says not found. Nothing says who ended it, so reconcile records `withdrawn`. A form found with status answered or cancelled keeps that state. An answer given at the Mac while the bridge was up is seen as an event and stays `answered` by `tui`. The cost: a form answered at the Mac while the bridge was down and then purged by OpenCode reads "withdrawn". The wording ("the session stopped asking") does not claim anyone did anything. A reply that finds the form gone is treated the same way.
- **After Send.** The app calls the same answer action as today. The bridge, which knows the question and the answer, edits the Telegram message to "✅ Answered in app · <short answers>", answers joined with " · " and cut to 120 characters, passed through the secret filter and the configured redaction. The app then closes itself.
- **Drain.** `drain` is `{ open, questions, approvals, permissions }`, counted from the pending store (pending entries only) and the approvals engine. It is read-only, has no values in it, and is added to the control snapshot, so `/oob version` prints a line when `open` is above zero and the core API status carries the object.
- **Button style.** One button per row, label starting with 📱, no other buttons on that row.

## What a client may rely on

- The bridge decides one-tap or in-app; a channel that cannot show buttons gets the in-app text only.
- A pending id in a deep link is valid while its entry is `pending`; for any other state the app says it is no longer open.
- The host (OpenCode) owns whether a form is open. The bridge never keeps one alive after the host drops it.

## Rollout

Six small PRs, each releasable. The app opens `f_` links (PR 1) before anything stops showing the stepper, so a multi-field form is always answerable.
