## Decisions

- **Telling the origin.** The bridge records each prompt and synthetic message it sends into a session (text, 2 minutes). An inbox event that matches one is from a connector; any other is typed at the Mac. Matching is by text because the prompt call does not promise the id it is given.
- **Dedupe.** Inbox ids already handled are kept (500), so a repeated event posts once.
- **Subagents.** Only root sessions are looked at: the task given to a subagent is not typing.
- **Mirroring.** Posted only for a routed session, to chatting channels, silently, and not under `chat.mirror: remote-only`, where Mac replies are not mirrored either.
- **Choice.** Read from the `form.replied` answer and the `permission.replied` reply, redacted and cut at 200 characters.
