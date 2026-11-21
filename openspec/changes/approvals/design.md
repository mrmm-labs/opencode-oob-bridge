## Context

`docs/approvals.md` holds the full specification: goals, vocabulary, levels, presence modes, endpoint, request and answer fields, lifecycle, rules, channels, TOTP, configuration, authentication, signatures, key storage, threat model and rollout. This design only records the decisions that the specs depend on and the order of work.

## Decisions

### D1. Spike first, and the spike can stop the change

Section 7.3 of the document says it is not verified that the plugin runtime can call the macOS Security framework. The host binary is a compiled JavaScript runtime; a foreign-function call is the likely route. **Task 1 is a spike**: from inside a server plugin, create, read and delete a Keychain item whose access list names the host executable only. If it cannot be done, the change **stops** and the operator decides. The fallback is never a key file and never the `security` command, because both break the custody rules of section 7.3.

### D2. The socket is the bridge's, not a window's

The socket is bound by the instance that runs the bridge (document section 4.3), so a closed window changes nothing. A restart replaces a stale socket and expires pending requests with `bridge_restart`.

### D3. Caller identity is a key, not a user

The same user runs other processes, so every request carries a per-caller HMAC (document section 7.1). Callers are created in the TUI with `/oob approvals pair-caller <name>`.

### D4. Levels are about what the channel can prove

Telegram can prove the user id of the tapper (L1) and carry a typed code (L2). ntfy proves nobody, so classes list their channels and the default is Telegram only.

### D5. Permissions on the phone

When approvals are enabled and `permissions.remote` is not off, a phone Allow once uses the level of the class `permission.<action>` (default L1 for read-like actions, L2 for the rest) and Always always needs L2. [proposal]

### D6. Away mode stays at the Mac

The document says the mode is changed only from the TUI, because an attacker who controls the chat could otherwise switch to AFK and then approve. The operator asked about a phone switch after a second factor. That is **not** specified here: it needs a decision (see the report).

## Risks

- The spike fails. Mitigation: D1, an early and explicit stop.
- Re-installing the host changes its code identity and macOS asks again (document 7.3). Mitigation: allow it at the Mac; approvals report `unavailable` until then.
- Code inside the host process, such as another plugin, can read the Keychain items. Stated in the document; it is a limit, not a bug.
