## Decisions

- **A shared file, not a call to the owner.** Plugin instances of one data directory already share state through files there (the lock, settings, the pending store). A file needs no new call, works whichever instance the TUI or the phone reaches, and survives the owner moving. Routing to the owner over the RPC would need to find the owner first, which is what failed.
- **The code is hashed.** A salted SHA-256 of the 5-byte code: the file is 0600 and short-lived, and a hash keeps the code out of any copy of it. The code space is small, so the five-try limit and 5-minute expiry are what protect it, as before.
- **Writes are atomic** (a temp file renamed over it). A TUI instance only writes when it opens one; the instance that serves the phone does the counting, one request at a time.
- **Reasons logged:** `none-open`, `expired`, `wrong-code`, `wrong-kind`, `too-many-tries`, `keychain-refused`, `no-miniapp-url`, `passkey-rejected`, `ok`.
- **Token on the phone.** `controller.enroll` stores the token only after a successful reply, so a refusal leaves nothing on the phone; a later success overwrites it.
