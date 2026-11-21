# Approvals

**Status: specification. Nothing here is implemented.** It describes a capability for a later release.

Local tools sometimes need a human to say yes before they do something that matters: read a secret,
write to a system, resolve a blocked task. This document specifies a small service in the bridge
that lets such a tool ask the operator, and get a signed answer back, from the operator's phone.

## 1. Goals and non-goals

Goals:

- One approval service in the bridge, reused by every local tool that needs consent.
- The phone is a **consent** channel. It never replaces an unlock or a credential.
- Strength is per action class: a tap for low risk, a tap plus a one-time code for higher risk,
  the machine itself for the highest.
- A caller can verify that an answer came from the bridge and not from a process that wrote to its
  socket.
- Where a request goes first, the phone or the machine, follows an explicit presence mode: AFK or present (section 3.1).

Non-goals:

- Answering OpenCode permission prompts remotely. Permissions stay tier 3 in the README: push only,
  never applied from a channel. Approvals are a different thing: a *caller asks*, the bridge relays,
  the caller decides what to do with the answer.
- Unlocking anything. A phone approval only works while the calling tool already holds what it
  needs (for example an unlocked session). If it does not, the caller still needs the machine.
- Storing a master password or any credential that belongs to a caller. The bridge keeps only its own signing key and its TOTP seed, in the macOS Keychain (section 7.3).
- A network listener. The endpoint is a local unix socket.

The README line "Never route production approvals through this plugin" describes the plugin
without this capability. With it, the operator decides which action classes may be approved from a
phone, and at which level (section 6). The default configuration approves nothing.

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| Caller | A local program that asks for approval. Registered by name, with its own key. |
| Action class | A label the caller gives the request (`secrets.read`, `escalation.low`). The operator maps each class to a minimum level. |
| Level | L1 tap, L2 tap plus one-time code, L3 at the machine only. |
| Operator | The one Telegram user id stored at pairing. |
| Answer | The bridge's reply: `approve`, `deny` or `expired`, signed. |

## 3. Levels

| Level | What the operator does | Typical classes | Reachable from the phone |
| --- | --- | --- | --- |
| L1 | Taps **Approve** or **Deny** | reads, low-risk resolutions | yes |
| L2 | Taps **Approve**, then types a TOTP code in the chat | writes, high-risk resolutions | yes |
| L3 | Answers at the machine (biometric prompt, or the host's attended question tool) | the highest-risk classes | no |

- Each action class has a **minimum level**. A request may ask for a higher level, never a lower one.
- **Deny needs no level.** Refusing is always safe: a tap on **Deny** from the paired operator is
  enough for any class.
- L3 is not relayed. The bridge answers a level-3 request at once with `409 needs_local` and the
  caller uses its own local path. It may send an informational push ("approval waiting at the
  machine") with no buttons.
- The **level used** is part of the answer. Callers must record it as such and never as the
  stronger local method (a phone approval is never recorded as a biometric one).
- L2 is the highest level a phone can reach. The operator may assign it to writes and to production-class actions.

### 3.1 Presence: AFK mode

The bridge keeps an explicit **presence mode**. It decides which path a caller tries first.

| Mode | Meaning | The caller asks |
| --- | --- | --- |
| `afk` | The operator is away from the machine | The phone first. The machine only after the request expires, or never: the caller's `afk_fallback` setting is `local` (default) or `none` |
| `present` | The operator is at the machine | The machine first (biometric or attended prompt). No phone prompt: the bridge refuses a request with `409 needs_local` and `reason: present` |

- **Switching.** `/oob afk on|off|auto` in the TUI. `auto` is the default and uses the away rule: AFK after
  `away.minutes` without a prompt typed in any window (and always when no window is attached), present again at the next typed prompt. `on` and `off`
  hold until changed. The mode is a runtime setting in `settings.json` and holds no secret.
- **Only from the TUI.** Nothing sent from a channel and nothing on the socket can change the mode.
- **Shown** in the sidebar and on the pinned status card of each topic.
- **Callers read it** from `GET /v1/status` before choosing an order. The bridge also stamps the mode on every
  request, copies it into the answer, and callers record it in their audit.
- **Switching to present withdraws pending requests** (`reason_code: present`). The caller moves to its local path
  at once, so a phone prompt and a machine prompt are never open together.
- **No bridge, no AFK.** A caller that cannot reach the bridge behaves as in `present`.
- **AFK lowers no level.** An L3 class stays machine-only in both modes.
- The away rule counts input from every window, not one (section 4.3).

## 4. Endpoint

A local HTTP/1.1 server on a unix socket:

- Path: `<state dir>/approvals.sock`. The directory is `0700`, the socket `0600`.
- Owned by the bridge process. A stale socket is detected by a failed connect and replaced.
- No TCP listener, no webhook, no new outbound connection: the bridge is still the only reader of the
  bot's updates, and callers never talk to Telegram.

| Route | Purpose |
| --- | --- |
| `POST /v1/approvals` | Create a request. Returns `201` with `{ id, state: "pending", expires_at }`. |
| `GET /v1/approvals/{id}/events` | Server-sent events. `pending`, then one terminal `answer` event. Supports `Last-Event-ID`. |
| `GET /v1/approvals/{id}?wait=<seconds>` | Long-poll alternative. Returns the request, with the answer once decided. |
| `DELETE /v1/approvals/{id}` | The caller withdraws a pending request. The chat message is edited to say so. |
| `GET /v1/status` | Which channels are paired and up, which levels they can currently reach, and the presence mode (`afk` or `present`). Lets a caller pick its order and skip straight to its local path. |

Errors are JSON `{ "error": "<code>", "retryable": <bool> }`. Codes: `unauthenticated`,
`forbidden_class`, `needs_local`, `not_paired`, `rate_limited`, `cooldown`,
`idempotency_mismatch`, `invalid_request`, `unavailable`.

### 4.1 Request

| Field | Type | Notes |
| --- | --- | --- |
| `id` | ulid | Chosen by the bridge. Not sent by the caller. |
| `idempotency_key` | string | Required. Scoped to (caller, key), kept 24 hours, persisted in the state dir. A replay with the same body returns the stored request and, once decided, the same answer. The same key with a different body is refused (`idempotency_mismatch`). |
| `requester` | object | `{ session_id, agent, tool }`. Shown to the operator. Attribution only: it grants nothing. |
| `action_class` | string | Must be listed for this caller in the configuration, or the request is refused (`forbidden_class`). |
| `scope_summary` | string | What would be touched. Identifiers and names only (item ids, folder names), never values. At most 500 characters, plain text. |
| `reason` | string | Why the caller wants it. At most 300 characters. |
| `ttl` | seconds | Default 120. The bridge caps it per class (default maximum 600). |
| `required_level` | 1 or 2 or 3 | Optional. The effective level is the larger of this and the class minimum. |
| `mode` | `afk` or `present` | Set by the bridge, never by the caller: the mode when the request was created. A request in `present` mode is refused (`needs_local`, `reason: present`). Copied into the answer. |

The bridge masks anything in `scope_summary`, `reason` and `requester` that matches its secret
filter before it reaches a channel or a log, and escapes markup. The caller is still responsible for
not sending secret values: the filter is a net, not a contract.

### 4.2 Answer

| Field | Notes |
| --- | --- |
| `id` | The request id. |
| `decision` | `approve`, `deny` or `expired`. |
| `approver` | The operator's Telegram user id, or `ntfy:<topic>` / `bridge` where no person is identified (see 5.3). |
| `level` | The level actually used: `0` when the bridge decided alone (expiry, cooldown), otherwise 1 or 2. |
| `decided_at` | RFC 3339 UTC, millisecond precision. |
| `mode` | The mode the request was created in. Signed. |
| `channel` | `{ type, message_ref }`, for example the Telegram chat and message id. |
| `reason_code` | Optional: `timeout`, `cooldown`, `bad_code`, `withdrawn`, `present`, `bridge_restart`. |
| `kid` | Identifier of the signing key. |
| `sig` | Signature, see section 7. |

### 4.3 Who owns the socket

The bridge runs once, in the OpenCode server, as a server plugin. It owns the bot and the socket. Windows
(TUIs) own neither: each one pilots the bridge and reports its last typed input, which the away rule needs.

- **Election.** An exclusive lock on `owner.lock` in the state directory, held by the server-side bridge. The holder
  binds `approvals.sock` and is the only reader of the bot's updates. A second loader of the plugin (another
  location of the same server, or another process) finds the lock held and does nothing.
- **Restart.** The lock is released when the server exits, and goes stale if it crashes (no heartbeat for 30 s, or
  a dead pid). A waiting loader takes it, removes the stale socket, binds, loads the idempotency store and
  resumes reading updates from the stored offset (kept in the state directory, so none are lost or replayed).
  There is no hand-over between windows: closing or opening a window changes nothing for the socket.
- **Pending requests** at a restart expire with `reason_code: bridge_restart`. Callers retry with the same
  idempotency key.
- **Phone approvals need only the server.** With no window open the bridge still runs, and the away rule counts the
  operator as away. A request that needs the machine waits for a window or expires.
- **Deferred.** A standalone daemon that owns the bot and socket independently of the OpenCode server, for
  headless callers, is a future option. This spec does not cover it.

## 5. Flow and rules

### 5.1 Lifecycle

```
POST ──> pending ──┬─ Approve (L1) ─────────────────> approved
                   ├─ Approve, then valid code (L2) ─> approved
                   ├─ Deny ──────────────────────────> denied   (starts the cooldown)
                   ├─ wrong code x3 ─────────────────> denied   (reason_code bad_code)
                   ├─ ttl elapsed ───────────────────> expired
                   └─ DELETE ────────────────────────> withdrawn
                   └─ AFK -> present ────────────────> withdrawn (reason_code present)
```

A decided request never changes. The bridge keeps pending requests in memory: a restart expires them
with `reason_code: bridge_restart`, and the caller may retry with the same idempotency key.

### 5.2 Rules

- **Single use.** One answer per request id. An approval covers the one action named in the request.
  A caller must record an approved id as spent and refuse to reuse it. The signature binds the answer
  to a hash of the request, so it cannot be attached to a different request.
- **Expiry.** After `ttl` the request is `expired` and its buttons are removed. A late tap gets "expired".
- **Only the paired operator counts.** The check is on the Telegram **user id** of the person who
  tapped or typed, stored at pairing, not on the chat id. In a group chat, other members are ignored
  even if they press a button.
- **Cooldown after a deny.** A new request with the same (caller, action class, scope hash) inside the
  cooldown window (default 120 s, configurable) is answered at once with `deny`, `reason_code: cooldown`,
  and nothing is sent to the chat.
- **Rate limit.** Per caller: at most 3 pending requests and 12 per hour by default (`rate_limited`).
  A global cap protects the chat from a looping caller.
- **Redaction.** Messages and bridge logs use the same redaction as every other push.
- **Audit stays with the caller.** The bridge logs request id, caller, class, decision and level, with
  masked text, to its own log. The authoritative record is the caller's (hash-chained where the
  caller has such a log). It must include the level used, the mode, and the answer's `sig` or its hash.

### 5.3 Channels

The level a request can reach depends on what the connector can prove. A connector declares:

```ts
approvals?: {
  buttons: boolean              // can render Approve / Deny
  approver: "verified" | "none" // does it tell us who answered
  replyText: boolean            // can it receive a typed code
}
```

| Connector | L1 | L2 | Notes |
| --- | --- | --- | --- |
| Telegram | yes | yes | Buttons on the message; the user id of the tapper is verified by Telegram. |
| ntfy | yes, weak | no | Buttons are HTTP actions the publisher writes; the app proves nothing about who tapped. Each button carries a one-time token bound to the request id and a nonce, stored hashed and valid for that request only. Anyone who can read the out-topic can use the token once, so the answer records `approver: ntfy:<topic>`. A class can exclude it with `channels`. |
| Signal (future) | yes | yes | No buttons: the message shows a short random code, and the operator replies `<code> yes` for L1 or `<code> yes <totp>` for L2. The sender identity is verified by the connector. |

A class lists the channels it accepts (default `["telegram"]`). If no accepted channel is up at the
required level, the request fails fast with `unavailable` and does not wait for its ttl.

### 5.4 L2 and the one-time code

1. The operator taps **Approve** on the request message.
2. The bridge replies in the same chat: "Type the 6-digit code for #ab12".
3. The operator types the code. The bridge checks it, deletes the message with the code (best effort)
   and edits the request message to its final state.

The code is a standard TOTP (RFC 6238, SHA-1, 6 digits, 30 s step, one step of tolerance). Each time
step is accepted at most once, so a code seen by someone cannot be replayed. Three wrong codes deny
the request. The seed is enrolled from the TUI (`/oob approvals totp`, a QR code shown in the terminal only) and stored in the macOS Keychain (section 7.3). It is never written to a file or to `settings.json`, and never sent over a channel. L2 requires a seed to be enrolled; without one, L2 classes fail with `unavailable`.

## 6. Configuration

```jsonc
"approvals": {
  "enabled": false,              // off unless set
  "defaultTtl": 120,
  "cooldown": 120,
  "classes": {
    "secrets.read":   { "level": 1, "channels": ["telegram"] },
    "secrets.write":  { "level": 2, "channels": ["telegram"] },
    "escalation.low": { "level": 1, "channels": ["telegram", "ntfy"] },
    "escalation.high":{ "level": 2, "channels": ["telegram"] }
  },
  "callers": {
    "secrets-tool": { "classes": ["secrets.read", "secrets.write"] },
    "task-runner":  { "classes": ["escalation.low", "escalation.high"] }
  }
}
```

Deny by default: a class not in `classes`, or not listed for the calling caller, is refused. A caller
can never raise its own class's level or add a channel. Operator identity, the TOTP seed reference,
caller keys and the signing key live in the state directory or behind secret references, not in this
file.

## 7. Authentication and signatures

### 7.1 Caller to bridge

Two layers:

1. The socket is `0600` in a `0700` directory, so only the same user can connect.
2. Every request carries a per-caller proof, because the same user also runs other processes:

```
X-Caller: <name>
X-Caller-Ts: <unix seconds>
X-Caller-Mac: hex( HMAC-SHA256(caller_key, METHOD "\n" PATH "\n" ts "\n" sha256(body)) )
```

The bridge rejects a timestamp more than 60 seconds off, and an unknown caller. The class list of
section 6 then limits what the caller can ask for. A caller key is created at pairing: `/oob approvals pair-caller <name>` writes `callers/<name>.json` (mode `0600`) with the caller key, the bridge's **public** key and the key id. The caller key is a request credential only. Anyone who holds it can ask, which is harmless, but it cannot make an answer the caller accepts (7.2), so it may live in a file. Revoking a caller deletes its entry.

### 7.2 Bridge to caller

The answer is signed so that a caller can tell it came from the bridge. The algorithm is **Ed25519**: the bridge keeps the private key in the Keychain (7.3) and callers hold only the public key, so nothing a caller can read lets it forge an approval. There is no shared-key mode: a key the caller can read is a key an agent running as the same user can read.

The signed string, UTF-8, fields joined by newline:

```
oob-approval-v1
<id>
<request_hash>
<decision>
<level>
<mode>
<approver>
<decided_at>
```

`request_hash` is the SHA-256 of the canonical JSON of the stored request (sorted keys, no spaces).
A caller verifies, in order: signature with the key named by `kid`; `id` is one it created;
`request_hash` matches its own copy of the request; `decided_at` lies between its send time and
now (with the skew allowance); `level` is at least what it required for that class; `mode` is `afk`; the id is not
already spent. Any failure is a refusal, logged. Keys rotate by `kid`; both are accepted during an
overlap the operator sets.

### 7.3 Key storage

The bridge's Ed25519 signing key and the TOTP seed are stored in the **macOS Keychain**. Neither is ever a file.

- **Access rule.** The items' access list names only the host executable that runs the plugin (the OpenCode
  binary). It never says "allow all applications". Any other process that asks gets a Keychain prompt on the Mac
  or is refused. An unexpected prompt means something tried to read the item.
- **User presence.** Required to create, replace or delete an item and to change its access rule. It is not
  required on each use: use happens while the operator is AFK, and a biometric prompt per signature would make a
  phone approval impossible.
- **Public key.** Exported to callers at pairing. It is not a secret.
- **In memory.** The private key and the seed are read when needed and held only for the signature or the code
  check.
- **Rotation and loss.** Losing an item means a new key id, re-pairing each caller, and re-enrolling the TOTP
  seed.

Limits to state plainly:

- The trust unit is the host executable. Code running inside it, such as another plugin, can read the items.
- Reinstalling or upgrading the host changes its code identity. macOS may ask again to allow it; allow it at
  the Mac.
- The items must be created and read through the Security framework from the host process. The `security`
  command cannot be used: the access rule would then trust `security`, which any process can run, and a secret
  passed to it appears in the process list. Whether the plugin runtime can call the Security framework is not yet
  verified and is the first thing to check (section 10).
- macOS only. Elsewhere approvals report `unavailable` until an equivalent store exists.

## 8. Threat model

| Threat | What happens | Mitigation | Remaining risk |
| --- | --- | --- | --- |
| **Stolen phone, unlocked** | Attacker taps Approve | L1 classes are exposed. L2 needs the code | If the authenticator app is on the same phone, L2 gives little. Keep the seed on another device |
| **Stolen phone, locked** | None | Device lock, Telegram passcode | Notification previews show the redacted summary |
| **Compromised Telegram account** (session hijack, SIM swap) | Attacker can tap | User id check does not help: it is the same account. L2 code is not in Telegram | L1 classes are exposed. Keep L1 to reads |
| **Leaked bot token** | Attacker can read what the bot sends and can send as the bot, but cannot make Telegram report a tap as the operator's user id | Callback data carries a request id and nonce. The user id comes from Telegram, not from our message | They can read redacted summaries, and can deny by spamming. Rotate the token |
| **Replay** of an answer or a tap | Reuse for another action | Single use per id, request hash in the signature, one-time ntfy tokens, TOTP step used once, ttl | A caller that does not record spent ids is on its own |
| **Malicious local process calls the socket** | Asks the operator to approve something misleading, or floods | Socket perms, per-caller key, class allowlist per caller, rate limit, cooldown, a visible requester line | A process running as the same user can read caller keys. This boundary is the user account |
| **Forged answer to a caller** (a process pretends to be the bridge) | Caller believes it was approved | Signature over the request hash, verified with a public key the process cannot use to sign. The private key is in the Keychain, readable only by the host binary | Code inside the host process (another plugin) can sign |
| **Another process reads the Keychain items** | It could sign answers or compute codes | The access rule admits only the host binary; any other process prompts or is refused | Code inside the host process, and anything the operator allows at a prompt |
| **Presence mode forced to AFK** | A process makes the phone the first path | The mode cannot be changed from a channel or the socket; auto mode needs idle input; AFK lowers no level | An idle operator at the Mac gets a phone prompt instead of a local one |
| **Misleading request text** | Operator approves the wrong thing | The caller writes the summary, but the message states the caller, session, class and level, and the text is plain, redacted and length-capped | Operators still have to read it |
| **Telegram reads the chat** | Metadata and summaries are visible to Telegram | Summaries carry identifiers only, never values | Telegram is not end-to-end encrypted for bots |

### What the L2 code protects

It protects against someone who can tap but does not hold the second factor: a session hijack, a
leaked bot token, a bystander with the unlocked phone if the seed is elsewhere, and an accidental tap.
It does not protect against someone who has both the chat and the seed, or against a compromise of the
machine, where code in the host process can read the seed from the Keychain.

## 9. MCP elicitation

OpenCode 2 supports MCP elicitation: a server can ask for input during a tool call, and OpenCode shows
the request as a form (or a link for URL requests) in the TUI. Dismissing the form cancels the request.
This is documented in the host's MCP page and the binary contains the `elicitation/create` handling.
It has not been exercised against this bridge.

So an **MCP caller** has an alternative path: ask through elicitation instead of the endpoint. It is a
good L3 path (the operator is at the screen). The endpoint is still needed because:

- elicitation is rendered by the host UI, so it does not reach a phone unless the bridge mirrors the
  form like it mirrors questions (unverified);
- callers that are not MCP servers (command line tools, hooks, scripts) cannot use it;
- it has no level, one-time code, cooldown, rate limit or idempotency, and the answer is not signed:
  the server trusts whatever the client sends back;
- it needs a running host with a TUI, the same limit as the bridge itself.

## 10. Rollout

| Step | Work | Estimate |
| --- | --- | --- |
| 1 | First check that the host process can call the Security framework (7.3). Then owner election (server-side bridge), AFK mode, Keychain keys, endpoint, Telegram L1 and L2, signing, caller pairing, first caller: a local secrets tool | 1.5 days (estimate before AFK mode and owner election, which add to it) |
| 2 | Command line resolver for a task-runner's blocked items, using `--via-oob` | 0.5 day |
| 3 | A workflow engine adopts the contract for its own escalations | later |

Each step ships behind `approvals.enabled`, with fixtures for the signature and the rules above
(replay, cooldown, wrong user id, expiry, idempotency mismatch).

## 11. Open questions

1. **Should ntfy offer L1 at all**, given it identifies nobody? The default class config excludes it.
2. **Mirror MCP elicitation forms to the phone** through the existing question path? It needs a test of what
   the plugin API exposes for them.
