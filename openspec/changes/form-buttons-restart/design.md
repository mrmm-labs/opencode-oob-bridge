## Decisions

- **Rebuild, don't persist.** The choices are cheap to make again, and writing them to disk would add a second store to keep in step with the pending store. The pending entry already holds the questions; the connector rebuilds a stepper from it.
- **The stale tap is not applied.** After a restart a button may belong to any step, so applying it would guess. The form is redrawn at question 1 and the person is told why.
- **Only still-pending questions are rebuilt,** and only forms of two or more fields use the stepper; a single question rebuilds its tick list.
- **Not multi-instance.** One instance polls Telegram and holds the connector state; the Mini App answered the same form through the owning instance, so the reply path was fine.
