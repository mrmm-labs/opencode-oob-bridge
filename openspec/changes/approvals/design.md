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

## Spike result (task 1.1)

**Outcome: it works. The change goes on.** Evidence, 2026-11-21, macOS, the host executable `opencode` 2.3.2 (hardened runtime, signed):

- The host is a Bun-compiled executable and has `bun:ffi`. With `BUN_BE_BUN=1` the same executable runs a script with the same code identity as a plugin has, so the spike ran that way: `BUN_BE_BUN=1 opencode spike-keychain-run.js`. A server plugin loaded in a second host could not be arranged (that host did not load the spike plugin), so the one thing still to confirm is the same calls from the real plugin, which the first real L1 approval does.
- `SecTrustedApplicationCreateFromPath(NULL)`, `SecAccessCreate`, `SecItemAdd` (with that access object) and `SecItemCopyMatching` all returned 0 and the secret read back, with no prompt. `SecItemDelete` returned 0.
- The item's access list, from `security dump-keychain -a` (which does not decrypt): the entry that authorises `decrypt derive export_clear export_wrapped mac sign` lists **one application**, the host executable, with its designated requirement (`identifier opencode and anchor apple generic and certificate ...`). Any other process is not on the list, so macOS asks before it reads. A live read by another process was not run, to avoid a dialog on the operator's screen.
- How: pointers must be passed as `u64` (BigInt). A CoreFoundation small string is a tagged pointer above 2^53, and a JavaScript number loses its low bits. Data symbols (`kCFTypeDictionaryKeyCallBacks` and the like) are found with `dlsym`, not with `.ptr` of a declared symbol. The attribute keys are plain strings (`class`, `genp`, `svce`, `acct`, `v_Data`, `sacc`, `r_Data`, `m_Limit`, `m_LimitOne`). `spike-keychain.js` in this folder is the working code.
- Limits: the requirement is by identity, not path, so a Homebrew upgrade signed by the same identity keeps access. A differently signed build asks again, as the Risks say. Code inside the host (another plugin) can read the item, as the document says.

## Implementation notes (from reading the code, 2026-11-21)

Written before the build starts, so the next session does not repeat the survey.

- **The operator's user id does not exist yet.** Pairing stores a chat id only, and `Inbound.from` is `{ connector, chat }`. The change must add the Telegram `from.id` at pairing (the `/start <code>` message), keep it in `settings.json`, add `userId` to `Inbound`, and make the connector fill it for button taps and typed text. A group member's tap then differs from the operator's.
- **Approve and Deny can ride the permission buttons.** `Push.permission` already renders buttons and returns an inbound of kind `answer` with `decision` (`once`, `always`, `reject`) and `pendingId`. An approval message can use `choices: ["once", "reject"]` with a pending id prefixed `apr:`, intercepted before `Bridge.decide`. No new connector button type is needed.
- **The typed code** needs a hook before prompt routing: while a code is awaited for a chat, six digits typed there are consumed by approvals and never reach a session. The connector can delete the message through the same path the pairing code uses, or a new `delete` on the connector.
- **One place for the levels.** Phone permission replies go through `Bridge.decide` and `Actions.replyPermission`. The gate belongs in `Actions` (the single action registry), so the core API, the chat and the Mini App get it too. `src/overnight.ts` already never answers a permission: keep it so.
- **Pure core first.** Build the state machine (`create`, `tap`, `code`, `expire`, `withdraw`, `restart`) with injected clock, store, key store and notifier, and test it alone. The socket, the Keychain and the Telegram wiring are thin layers on it.
- **Keychain.** `spike-keychain.js` is the working code. Wrap it in a `KeyStore` interface (`get`, `set`, `delete`) with an in-memory fake for tests, load `bun:ffi` lazily (it does not exist under Node), and report `unavailable` when the import or a call fails. A real check lives beside `src/real/resume.real.test-util.ts` and runs through the host: `BUN_BE_BUN=1 opencode <script>`.
- **Crypto without dependencies.** Ed25519 through `node:crypto` (`generateKeyPairSync`, `sign`, `verify`), TOTP through HMAC-SHA1 (RFC 6238 vectors in the tests), the caller proof through HMAC-SHA256.
- **Presence** is `Router.away()` and `Router.afkMode()`; a switch to present is observable in `Control.trackAway`. Pending requests are withdrawn there.
- **Idempotency store** is persisted in the state directory (24 hours); the pending requests are in memory only.
