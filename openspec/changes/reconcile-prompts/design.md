## Decisions

- **Ask per request, with `get`.** The service answers a form or permission lookup with a tagged not-found error when it no longer holds it. Only `FormNotFoundError` and `PermissionNotFoundError` count as gone; a missing session, a timeout or any other error changes nothing, so a wrong "gone" cannot close a live question. A form found with status answered or cancelled is closed with that state.
- **Grace.** A prompt asked less than 10 seconds ago is skipped by the periodic check, since OpenCode may not list it yet. The check made before holding a message or posting a question again has no grace: the bridge learned of the prompt from OpenCode's own event.
- **Held messages.** They are the menus that offer Answer, Skip or Send anyway. Reconciliation takes those of the session once no question is open and sends them as normal prompts. A menu lost in a restart cannot be released; its buttons answer "expired".
- **Which state.** A request that is gone is recorded as answered, the usual case; the service's own cancelled state is kept.
