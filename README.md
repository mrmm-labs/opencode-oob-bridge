# opencode-oob-bridge

An OpenCode plugin that sends the questions and permission prompts of selected sessions to your
phone through [ntfy](https://ntfy.sh) and/or Telegram, and lets you answer the questions from
there.

When you step away from the terminal, a session that asks a question stops and waits. With this
plugin the question arrives on your phone as a notification with one button per option. Tap a
button, or reply with text, and the session continues. Permission prompts are sent too, as a
heads-up answered in the TUI, unless you set `permissions.remote`.

Renamed from `opencode-ntfy-bridge` in 0.4.0, because ntfy is no longer the only channel. The old
config file (`ntfy-bridge.jsonc`), state directory and `OPENCODE_NTFY_BRIDGE_*`
variables are still read when the new ones are absent.

## How it runs

The bridge runs **once, in the OpenCode server**, as a server plugin (`index.js`). It sees every
session of the instance, with no TUI, one or several attached. The TUI (`tui.tsx`) holds no bridge
logic: it pilots the server half over the plugin RPC.

| Half   | Where                  | Does                                                                                                                                             |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server | the OpenCode server    | Telegram and ntfy connectors, topics, pushes, chat, reactions, media, the pending store, settings, the away rule, the suspended-session watcher. |
| TUI    | each attached terminal | `/oob` and the sidebar: shows the server half's state, sends it commands, reports input for the away rule, answers question forms.               |

- **One owner.** OpenCode sets the plugin up once per location of the server (a project directory
  or workspace), all in one process, and keeps its RPC registry per location. So every instance
  registers the RPC and answers through the one bridge of the process; the first instance runs it.
  When that instance goes (its location closes), another takes over. The server half takes `owner.lock` in the state directory (pid and start time,
  refreshed every 10 s; stale after 30 s or when the pid is gone). A second process
  logs `server_standby` once and does not run a bridge, so exactly one `getUpdates` consumer exists;
  its instances answer the RPC with an error naming the owner's pid. If the owner process dies, a
  standby takes over within 15 s.
- **Away is instance-wide.** The TUIs report their last input; the bridge counts as away after
  `away.minutes` without input in _any_ of them, and always when no TUI is attached. `/oob afk
on|off|auto` overrides it for the instance.
- **Suspended sessions.** When a session holds messages it is not working on (a prompt you queued
  that never ran, subagent results nobody delivered), the bridge sends a notice to the session's
  topic with a **▶ Resume** button. The button wakes the session through the host's synthetic-message
  call. If the host refuses, the notice says to open it at the Mac. Away mode itself cannot be
  changed from a chat.
- **Question forms.** The server plugin API has no form-reply call; only a TUI has one. A form
  answered from a chat is handed to an attached TUI, which makes the reply. With no TUI attached
  the answer is refused and the chat says to answer at the Mac.

### Upgrading from 0.12.x

The bridge no longer runs in the TUI. Install the plugin where the **server** loads it, restart
OpenCode, and check `/oob status` (it shows the owner pid). Settings and the Telegram chat carry
over. The sidebar size now lives in `tui.json` in the state directory, seeded from the old
`settings.json`. A server that is not running the plugin shows `bridge offline` in the sidebar.

## Install

Needs OpenCode 2 and Node 24 to build.

```sh
mise install && mise run build   # or: pnpm install && pnpm run build
```

Put the folder where OpenCode loads plugins from (OpenCode 2 loads a directory through its
`index.js`, and its TUI through `tui.tsx`), or list the published package in your OpenCode config:

```jsonc
{ "plugins": ["opencode-oob-bridge"] }
```

Then copy [`oob-bridge.example.jsonc`](oob-bridge.example.jsonc) to
`~/.config/opencode/oob-bridge.jsonc` and restart OpenCode. **Without a config file the plugin does
nothing and opens no connection.**

## Configuration

```jsonc
{
  "channels": {
    "ntfy": {
      "server": "https://ntfy.example.com",
      "token": { "env": "OOB_BRIDGE_TOKEN" }, // or { "command": ["pass", "show", "ntfy/opencode"] }
      "topics": { "out": "oc-3k9f2x7q-out", "in": "oc-3k9f2x7q-in" },
    },
    "telegram": {
      "token": { "command": ["pass", "show", "telegram/opencode-bot"] },
    },
  },
  "defaultChannel": "all", // "all", "ntfy" or "telegram"
  "away": { "minutes": 10 },
  "rules": [{ "agent": "^coordinator$" }, { "directory": "**/my-app" }],
  "redact": "head:300",
  "permissions": { "remote": "off" },
}
```

| Key                       | Default  | Meaning                                                                                                                                                                       |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels.ntfy`           | none     | The ntfy channel. See [Channels](#channels).                                                                                                                                  |
| `channels.telegram`       | none     | The Telegram channel. See [Channels](#channels).                                                                                                                              |
| `defaultChannel`          | `all`    | Where pushes go for a session that chose no channel: `all` or a channel name.                                                                                                 |
| `sidebar`                 | `full`   | The sidebar section: `full`, `compact` or `off`. See [Sidebar](#sidebar).                                                                                                     |
| `away.minutes`            | `10`     | Minutes without input in the TUI before matching sessions are mirrored.                                                                                                       |
| `rules`                   | `[]`     | Which sessions are mirrored while you are away. Empty: all.                                                                                                                   |
| `redact`                  | `full`   | `full`, `head:<n>` (first n characters) or `title` (no body at all).                                                                                                          |
| `permissions.remote`      | `off`    | `off`: a permission is answered in the TUI only. `once`: Allow once and Deny buttons. `all`: also Always, which saves a rule. See [Permissions](#permissions-from-a-channel). |
| `messages`                | built in | Push formats per kind, overriding the defaults field by field. See below.                                                                                                     |
| `profiles`                | `[]`     | Per-use-case formats: the first profile matching `agent`/`directory` wins.                                                                                                    |
| `otel`                    | off      | OpenTelemetry export. See [Telemetry](#telemetry).                                                                                                                            |
| `core.bind`               | off      | Where the [core API](#core-api) listens: `tailscale`, `localhost` or an address.                                                                                              |
| `deadman.url`             | off      | Where the [heartbeat](#dead-mans-switch) goes: an https URL (http on loopback only).                                                                                          |
| `deadman.token`           | none     | The receiver's bearer token: `{ "env": NAME }` or `{ "command": [...] }`.                                                                                                     |
| `deadman.intervalSeconds` | `30`     | Seconds between heartbeats.                                                                                                                                                   |
| `turnCard`                | on       | A card when a turn ends with changes or after a long turn: `false` turns it off. See [Turn cards](#turn-cards).                                                               |
| `turnCard.minSeconds`     | `20`     | A turn that changed nothing gets a card only when it ran this long.                                                                                                           |
| `quiet`                   | off      | Silent delivery between `from` and `to` (HH:MM) in `timezone` (default: this computer's). See [Quiet hours and the digest](#quiet-hours-and-the-digest).                      |
| `quiet.breakthrough`      | `[]`     | Kinds that still make a sound at night: `failed`, `permission`, `question`.                                                                                                   |
| `digest`                  | off      | `true`, or `{ at, empty }`: one summary a day at `at` (default the end of quiet hours); `empty: true` also sends it when nothing happened.                                    |
| `core.port`               | `7842`   | The core API port.                                                                                                                                                            |

**A token command that fails** (a locked secret store, say) is not run again in a loop. It is
retried after 30 s, 1 min, 2 min, and then every 5 min; each step is logged once, and the channel
shows `waiting for token (retry hh:mm)` in `/oob` Status. A channel that cannot get its token does
not poll or subscribe in between.

The old single-channel form still works: `server`, `token`, `topics` and `actionAuth` at the top
level mean `channels.ntfy`. Use one form or the other.

A rule has any of `agent` (regular expression on the session's agent), `directory` (glob on the
session's directory: `**` any depth, `*` one segment) and `command` (argv; exit code 0 routes; it
gets `OOB_BRIDGE_SESSION`, `OOB_BRIDGE_AGENT` and `OOB_BRIDGE_DIRECTORY`). Fields in one rule
must all match; any matching rule routes the session. Rules look at the top-level session, so a
subagent follows its parent.

### Push formats

Each push kind (`question`, `permission`, `finished`, `failed`, `closed`, `notice`) has a default
`title`, `message`, `tags` and `priority`, defined in `src/messages.ts`. Override any field in
`messages`; a `profiles` entry (`agent` regular expression and/or `directory` glob, plus
`messages`) overrides it again for matching sessions. `{{name}}` placeholders are filled per push
and an unknown name renders empty; the placeholder list is in `oob-bridge.example.jsonc`. Text
from the session is redacted before it is placed, so `redact` still applies.

```jsonc
"messages": { "finished": { "title": "✅ {{project}}", "priority": 3 } },
"profiles": [
  { "agent": "^coordinator$", "messages": { "question": { "priority": 5, "tags": ["rotating_light"] } } }
]
```

Environment overrides: `OPENCODE_OOB_BRIDGE_CONFIG` (config file), `OPENCODE_OOB_BRIDGE_DATA`
(state directory, default `~/.local/share/opencode/oob-bridge`), `OPENCODE_OOB_BRIDGE_LOG` (log
file, default `bridge.log` in the state directory).

## Channels

A channel is a way to reach your phone. Configure one or both; every enabled channel gets the
pushes of a session (see `defaultChannel` and `/oob on <channel>` below). A question can be
answered from any of them: the first answer wins, and every channel's message is then updated to
say who answered ("Answered from telegram: Yes", "Answered in the TUI").

| Key (under `channels.ntfy`) | Default    | Meaning                                                                               |
| --------------------------- | ---------- | ------------------------------------------------------------------------------------- |
| `server`                    | (required) | ntfy server URL.                                                                      |
| `token`                     | none       | `{ "env": NAME }` or `{ "command": [argv] }`. A literal token in the file is refused. |
| `topics.out`                | (required) | Topic the plugin publishes to. Subscribe to it in the ntfy app.                       |
| `topics.in`                 | (required) | Topic the plugin reads replies from.                                                  |
| `actionAuth`                | `true`     | Put the token in each button so buttons work on an auth-protected server.             |
| `enabled`                   | `true`     | Set `false` to configure it without using it.                                         |

| Key (under `channels.telegram`) | Default                                | Meaning                                                                                                                                      |
| ------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`                         | (required)                             | The bot token, as `{ "env": NAME }` or `{ "command": [argv] }`. A literal token is refused.                                                  |
| `chatId`                        | none                                   | The chat to talk to. Leave it out and run `/oob pair telegram` instead.                                                                      |
| `enabled`                       | `true`                                 | Set `false` to configure it without using it.                                                                                                |
| `apiBase`                       | `https://api.telegram.org`             | Bot API URL, for a local Bot API server.                                                                                                     |
| `statusCard`                    | `true`                                 | In a forum, one pinned status card per session topic (working, idle, failed).                                                                |
| `notify`                        | `{ finished: false, failed: true }`    | Which session-end pushes arrive. `finished` is `true` when `statusCard` is `false`.                                                          |
| `icons`                         | none                                   | `{ "<agent regex or project glob>": "<emoji>" }`: the topic icon for matching sessions.                                                      |
| `reactions`                     | built-in map                           | The reaction a prompt gets: `{ agents: { "<agent>": "<emoji>" }, default, queued, steered }`. See [Chat from Telegram](#chat-from-telegram). |
| `media`                         | `{ maxBytes: 10485760, mimes: [...] }` | Photos and documents taken from the chat: the size limit and the accepted mime types.                                                        |

Which channels are on is also a TUI setting (`/oob channel <name> on|off`). The choice is stored in
`settings.json` in the state directory and layered over the config file, which the plugin never
rewrites.

### Connectors

A channel is an instance of a connector type. The key under `channels` is its name, and
`channels.<name>.type` defaults to the name, so `ntfy` and `telegram` need no `type`. A second
instance of a type needs one: `"phone": { "type": "telegram", ... }`.

The core never looks at a connector's type. It reads what the connector declares it can do and
degrades to match:

| Capability      | Without it                                                               |
| --------------- | ------------------------------------------------------------------------ |
| `buttons`       | The question is numbered text, answered by number or `#id answer`.       |
| `multiselect`   | A multiple-choice question gets no toggle buttons, only numbered text.   |
| `edit`          | The outcome ("Answered from ...") is a follow-up message, not an edit.   |
| `threads`       | The session is named in each message, not given its own thread or topic. |
| `pairing`       | `/oob pair` refuses it.                                                  |
| `inboundPrompt` | Reserved: sending text into a session from a chat. No connector has it.  |

ntfy has buttons and edit; Telegram has all of them but `inboundPrompt`. A new connector is one
file in `src/connectors/` implementing `Connector` from `src/connectors/types.ts`, plus one line
in `src/connectors/index.ts`. Pairing goes through `pair()`, which returns a one-time code, an
optional link (the TUI shows a QR code of it) and an expiry, whatever the connector is. Inbound
messages arrive through one callback as `{ kind: "answer" | "prompt", pendingId?, sessionKey?,
text, choice?, from }`; `prompt` exists in the types only and the core ignores it.

### Telegram

The plugin talks to the Bot API over HTTPS with long polling (`getUpdates`): it only makes
outgoing requests, and exposes no port or webhook.

1. In Telegram, talk to [@BotFather](https://t.me/BotFather), run `/newbot` and keep the token.
2. Put the token in a secret store or an environment variable and reference it in
   `channels.telegram.token` (`{ "command": ["pass", "show", "telegram/opencode-bot"] }`).
3. Restart the TUI and run `/oob pair telegram`. The dialog shows a link and a QR code
   (`https://t.me/<bot>?start=<code>`). Scan it or open the link, press Start, and the plugin
   stores that chat. Typing the six-character code to the bot works too. The code works once and
   expires after 10 minutes. The chat id is saved in `settings.json`, not in your config file.
   If the terminal is too small for the QR code, the dialog shows the link and the code only.
4. To use a group instead of a private chat, open the second link in the dialog
   (`https://t.me/<bot>?startgroup=<code>`) and pick the group, or send `/start@<bot> <code>` (or
   just the code) in a group the bot is in. For one topic per session the group needs **Topics**
   switched on, and the bot must be an admin with the **Manage topics** right.

What you get in Telegram:

- A **question** is a message with one button per option (up to 10), numbered with keycap emoji,
  a star in place of "(Recommended)", and a ✏️ button when a typed answer is allowed:

  ```
  ❓ build asks · shop
  📌 Fix checkout

  Go?

  1️⃣ Ship it ⭐
        Deploy to prod
  2️⃣ Wait

  Tap a button, ✏️ to type, or reply.
  ```

  Tap a button: the phone shows a toast with the outcome at once, and the message itself becomes
  `✅ Answered · Ship it` with a muted "via telegram · 14:02" line, the question quoted, and the
  buttons removed. The same happens when you answer in the TUI ("via TUI"). If Telegram refuses the
  edit, a follow-up message says it instead, and the log notes it.
  **✏️ Type an answer** makes the bot ask "Type your answer for #id" in the same topic; reply to
  that message and your text is the answer (a number is text there, not an option).
  **Multiple choice** shows toggle buttons (a tick marks the chosen ones) and a Done button.
  You can also answer by replying to the question message with a number or text, or with
  `#id answer` as on ntfy.

- **Several questions in one prompt** are answered one field at a time in a single message that is
  edited as you go: the field and its options as buttons (eight to a page, with Prev and Next),
  Back, ✓ ticks and Done on a multiple-choice field, ✏️ to type an answer where that is allowed,
  and `n/N` for progress. After the last field you review every answer and tap Submit, Edit or
  Cancel. Nothing reaches OpenCode before Submit, so an abandoned form changes nothing; the
  first answer still wins, from the phone or the TUI. You can still reply with one answer per
  question, separated by `|` (for example `1 | yes | 2,3`), as on ntfy.
- A question with more than 10 options gets no buttons: reply by number or text.
- A form needs an open OpenCode window to take the reply. With none, the message says to answer
  at the Mac and has no buttons.
- A **permission** prompt has no buttons unless `permissions.remote` allows them (see
  [Permissions](#permissions-from-a-channel)).
- Messages are HTML, with everything escaped, and at most 4096 characters: long text is cut in
  the text, never in a tag. If you set your own `messages` or `profiles` text for a kind of push,
  that text is used for it instead of this layout (as plain bold title and text).
- **Failed** pushes keep their format and make a sound. **Finished** pushes are replaced by the
  status card (see below). Low priority pushes arrive without a sound.
- The plugin acts only on messages and taps from the paired chat. Anything else is ignored and
  logged without its content. The bot token is never logged.
- In a **forum** supergroup (topics enabled; the bot must be an admin who can manage topics), each
  top-level session gets its own topic, named `<project> · <session title>` (just the project when
  `redact` is `title`), and its messages go there. Elsewhere everything goes to the chat, with the
  project and session in each message. The topic is renamed when the session is (at most once a
  minute).
  - Its first message is a **status card**, pinned without a sound. The first line, which is all
    the pinned-message bar shows, reads `<watch> · <chat> — <state>`, for example
    `👁 on·telegram · 💬 on — 💤 Idle 22:06`. Then come the session title, agent and model,
    project, short session id and last activity. It is edited in place, at most once every 10 seconds.
    Set `statusCard: false` to turn it off; `notify.finished: true` brings back one message per
    finished turn.
  - Each topic gets an **icon** and a color. The color follows the project, the icon comes from a
    small family per project and the session picks within it, the same every time. `icons` pins
    an emoji for an agent or a project (for example `{ "^coordinator$": "🎯", "api*": "🛠" }`).
    The card shows the same emoji beside the project. If the icon list is unavailable, only the
    color is set.
  - The **first line of the card says how the session is watched**: `👁 on` (forced on;
    `👁 on·telegram` when forced to one channel), `⏱ auto` (the away rule; a later line adds the
    minutes) or `🔕 off`, then `💬 on` or `💬 off` for chat, then the state: `🟢 Working`,
    `💤 Idle 22:06` or `❌ Failed 22:06`. It follows `/oob on|off|auto` and `/oob chat` at once. The
    topic name is never changed for this, so topics stay easy to tell apart in Telegram's list. A
    session you switch off before it has a topic does not get one.
  - Without the **Manage topics** admin right the bot cannot make topics. It then says so in the
    chat (at most once an hour), posts in the main chat meanwhile, tries again every 5 minutes, and
    `/oob` Status shows the condition. Granting the right needs no restart.

**Privacy.** Telegram bot chats are not end-to-end encrypted: Telegram can read what the bot
sends. Before pointing a sensitive project at it, use `redact: "title"` (no question text), a
`profiles` entry that blanks its messages, or `rules`/`/oob on ntfy` to keep that session off
Telegram. Known secret shapes are masked in every message either way.

## Chat from Telegram

With chat on, a session can be talked to from its Telegram topic. You write in the topic, the
message goes to the session as a prompt, and the session's answer is posted back, so the topic
is a mirror of the conversation. This needs the Telegram channel in a forum group (see above).

```
/oob chat on      turn it on for the session you are looking at
/oob chat off     turn it off (the 🛑 Stop chat button on the status card does the same)
/oob delivery queue|steer|default   how prompts reach this session (see below)
```

How it behaves:

- **A prompt** is any plain message in the session's topic, or a reply to one of that session's
  bot messages. The bot answers with a **reaction on your message** and no text: it shows which
  agent received it, or that it waited or was steered in. Defaults: build 👨‍💻, plan 🤔, general 😎,
  explore 🤓, coordinator 🫡, any other agent 👀; ✍ when the session is busy and the message
  waits (queued); ⚡ when it was steered into the running turn. Change them with
  `reactions` (`agents` is keyed by agent name). Telegram lets a bot use only a fixed set of
  emoji; one outside it is ignored with a log line and the default is used. If Telegram refuses
  the reaction, the bot says `→ sent to <agent> · <project>` instead, and a prompt that could not
  be sent still gets a text message.
- **Photos and documents.** Send a photo or a file in the topic; the caption is the prompt (no
  caption: `Attached: <name>`). The bot downloads it and sends it to the session as an inline
  file, and the same reaction acknowledges it. Photos use the largest size Telegram has. Accepted
  by default: JPEG, PNG, GIF, WebP, PDF, and plain text, Markdown, CSV and JSON, up to 10 MB
  (`media.maxBytes`, at most 20 MB, which is all the Bot API serves; `media.mimes` lists types,
  and `image/*` takes a family). The type is checked against the first bytes, so a renamed file
  is refused. Anything else gets a reply saying why. Voice, video, audio and animations are
  answered with "not supported". Chat must be on for the session, as for text.
- **Delivery.** By default (`chat.delivery: "queue"`) a prompt sent to a busy session waits for the
  turn to end: it never interrupts a step. A message that starts with `!` (the `!` is dropped), or
  `/steer <text>`, is always sent with `steer`: it is injected into the running turn, and the bot
  says `⚡ steered in`. With `chat.delivery: "steer"`, every message to a busy session is steered;
  an idle session just gets the message either way. The sidebar block (below) and
  `/oob delivery` set it for one session.
- **Answers come first.** A reply to a question, or a tap on a button, still answers that question.
  Only a message that answers nothing is a prompt.
- **While the session works**, the topic shows "typing…". The assistant text appears in one message
  that is edited as it grows (the first text at once, then every second, `chat.streamMs`, 800 at
  least), moves to a new message past about 3,800
  characters, and gets its final formatting when the turn ends. At most three messages: anything
  longer is also attached as `reply.md` ("📄 Full reply"). Only the assistant's text is posted,
  never tool calls or reasoning. Markdown becomes Telegram HTML (code blocks, inline code, bold,
  italic, links, lists), with everything else escaped.
- **How the text streams** depends on the chat. In a group (and any topic of it) it is the edited message above, kept inside Telegram's limits: a 429 pauses edits for as long as it asks and doubles the gap up to 8 seconds (halved again after 30 quiet seconds), updates during a pause are merged so only the newest text is sent, and at most `chat.streamBudget` edits go out a minute (default 30). In a **private chat**, with `draft: true` on the Telegram channel (off by default until it has been checked against a live bot), the bot uses Telegram's native draft preview (`sendMessageDraft`): one draft per reply with the whole text so far, sent again every 20 seconds while the model is silent, and replaced by the final message. A refused draft switches that chat to edits for ten minutes and is logged. Both paths show the same text: redaction, secret masking, Markdown to HTML and splitting happen first.
- **`redact` applies** to what is posted, and known secret shapes are masked.

```jsonc
"chat": {
  "stream": true,         // edit one message while the reply is written
  "streamBudget": 30,     // most edits a minute
  "redact": "full",       // replies only; default full, "title" in the top-level redact carries over
  "mirror": "replies",    // "replies": post every final reply; "remote-only": only turns you started from Telegram
  "deny": [ { "directory": "**/payroll" }, { "agent": "^ops$" } ]
}
```

**Security model.**

- **Off by default**, and only switched on for one session at a time, in the TUI. Nothing in
  Telegram can switch it on: the 🛑 button and the topic hint can only turn it off or explain.
- **Paired chat only.** A message from any other chat is dropped unread and logged without its
  content.
- **Topic or reply only.** A message counts only inside the topic of a chat-enabled session, or
  as a reply to one of that session's bot messages. Everything else is ignored. A message in the
  topic of a session whose chat is off gets one hint an hour ("Chat is off for this session").
- **`chat.deny`** blocks sessions by agent or directory glob even after `/oob chat on`, and the
  toggle says why.
- **Permissions are answered remotely only when you set `permissions.remote`** (default off).
- **ntfy never chats.** Only a channel with the `inboundPrompt` capability can, and ntfy does not
  have it.
- **Telegram is not end-to-end encrypted.** Whoever controls the paired chat, or the bot's token,
  can talk to the session, and Telegram can read the conversation. A prompt is an instruction
  to an agent that may run commands in your project: keep the group private, keep chat off for
  sensitive projects, and put them in `chat.deny`. Use `redact: "title"` if replies must not
  leave the machine.

### Permissions from a channel

With `permissions.remote` at `once` or `all`, the permission message carries buttons: **Allow once** and **Deny**, and with `all` also **Always** (which writes a saved rule, so it needs `all`). The reply is made through OpenCode's permission reply; the message then shows who answered, from which channel and when, and the log records the session, the action, the choice, the channel and the time. Leave it `off` unless you accept that whoever controls the paired chat can allow what the session asks for; the first answer wins, from the phone or the TUI.

### Quiet hours and the digest

With `quiet` set, every message between `from` and `to` arrives without a sound or notification (Telegram: notifications off; ntfy: minimum priority). Nothing is held back or dropped, so the topics stay complete; the window may cross midnight and follows the clock of `timezone`, daylight saving included. `quiet.breakthrough` names the kinds that still notify; the default list is empty.

With `digest` set, one message goes out once a day at `digest.at`: what finished and what failed since the last digest, and what waits for you right now (open questions and permissions, stuck sessions; read live, so an answered question is not listed). Titles follow `redact` and secrets are masked. It is not sent when empty. `/digest` sends it on request and counts that period as covered. The records behind it are in `digest.jsonl` in the data directory, kept seven days; losing the file only loses detail.

### Turn cards

When a turn of a mirrored session ends and it changed a file, or ran at least `turnCard.minSeconds`, the bot posts one card in the topic. The first line is always visible: `✅ Done · 14 files · +320 −41 · 3m12s`. The last paragraph of the final reply and the changed files (15, then "+N more") sit in a block Telegram shows collapsed. Under it: **Diff** sends the patch as a file, **Continue** sends `continue` to the session (left out when chat is off), **Stop** interrupts the running turn. A new card, or an hour, takes the buttons off the old one. Counts are what the turn changed in the working tree; when the tree cannot be read the card shows no counts. Subagent turns get no card, and a channel that cannot fold gets the first line and a short summary.

### Commands

The bot registers one command list for the paired chat (Telegram has no per-topic menu), so it
shows after `/`. It starts with `/status`, `/stop`, `/model`, `/agent`, `/compact`, `/undo`, `/resume`,
`/afk` and `/digest`, then the rest; a command whose feature is off (`/undo` without a window to
do it, `/digest` until the digest exists) is left out. The list is sent only when it changed. A
command for another bot (`/cmd@other_bot`) is left alone.

In a session's topic (they act on that session, and need chat on):

| Command               | What it does                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/model`              | Buttons with the allowed models, the current one marked ✓. The pick is set on the session, so the next prompts use it, from Telegram or the TUI. |
| `/agent`              | The same for the primary agents OpenCode lists.                                                                                                  |
| `/variant`, `/effort` | The model's effort variants (and `default`), when it has any.                                                                                    |
| `/status`             | Redraws the status card and pins it again. The card shows agent, model and variant.                                                              |
| `/undo`               | Asks, then reverts the last turn through an open OpenCode window (it says so when none is open).                                                 |
| `/resume`             | Wakes this session when it is stuck with messages waiting.                                                                                       |
| `/afk`                | Shows the away mode, whether you count as away, and the overnight state. Changes nothing.                                                        |
| `/stop`               | Stops the running turn.                                                                                                                          |
| `/compact`            | Compacts the session.                                                                                                                            |
| `/rename <title>`     | Renames the session.                                                                                                                             |
| `/chat off`           | Turns chat off. Chat is only switched on in the TUI.                                                                                             |
| `/help`               | Lists these.                                                                                                                                     |

In General, or a private chat:

| Command                   | What it does                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/new <project> <prompt>` | Starts a session in a listed project.                                                                               |
| `/new [project]`          | Buttons for project, then agent, then model (each with `default`), then asks for the prompt: reply to that message. |
| `/sessions`               | The mirrored sessions, with a link to each topic.                                                                   |
| `/resume`                 | Lists the stuck sessions with a button each, or says none is stuck.                                                 |
| `/afk`                    | The same read-only away status as in a topic.                                                                       |
| `/digest`                 | Sends the digest on request; answers that it is not enabled until it is.                                            |
| `/projects`               | The projects `/new` can use.                                                                                        |
| `/help`                   | Lists these.                                                                                                        |

A session command sent in General, or a General command sent in a topic, gets a hint and does
nothing.

**Starting sessions** is off until `chat.projects` lists the folders it may use. A folder is only
ever one of those entries: a path typed in Telegram is never accepted, and a model is only ever
one of the listed ones (`chat.models`, or the models OpenCode lists for your providers, twelve at
most, six to a page). A new session is routed to Telegram with chat on, gets its topic and card,
and is subject to `chat.deny`. At most five are started an hour. Each one is logged and traced.

```jsonc
"chat": {
  "projects": {
    "shop": { "directory": "/home/me/code/shop", "agent": "build", "model": "anthropic/claude-sonnet-4-5" },
    "docs": { "directory": "/home/me/code/docs" }
  },
  "models": ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]
}
```

## The `/oob` command

One slash command, `/oob` (alias `/ntfy`), with sub-commands. The host completes only the command
name, so `/oob` alone opens a picker instead: a searchable list of every sub-command with what it
does and its usage underneath. Pick one and it asks for what it still needs: a list of the live
values for a choice (the current one marked, with the same descriptions as the sidebar), a prompt
for free text. Esc at any step cancels with nothing changed.

Typing is the fast path:

- `/oob chat on` runs at once. Any prefix of a name works when it fits one sub-command (`/oob au`).
- A prefix that fits several (`/oob o`) opens the picker with just those.
- A missing argument is asked for alone: `/oob delivery` opens the list of values.
- A wrong value (`/oob chat maybe`) says which values are valid and opens that list.
- `/oob help` shows the table below inside the TUI.

The host completes only slash names, so every sub-command is also its own slash entry:
`/oob-on`, `/oob-off`, `/oob-auto`, `/oob-chat`, `/oob-delivery`, `/oob-channel`, `/oob-pair`,
`/oob-test`, `/oob-sidebar`, `/oob-afk`, `/oob-session`, `/oob-resume`, `/oob-restart`, `/oob-status` and `/oob-help` show up in the prompt's slash list with
their usage. `/oob-chat on` does exactly what `/oob chat on` does, and `/oob-chat` alone asks for
the value. Bare `/oob` (and `/ntfy`) stays the picker.

| Command                                                  | What it does                                                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `/oob on [<channel\|all>]`                               | Push this session's questions and notices now, through one channel or all.                                                 |
| `/oob off`                                               | Never push this session.                                                                                                   |
| `/oob auto`                                              | Push this session after the away time without input, if the rules pick it.                                                 |
| `/oob chat <on\|off>`                                    | Let messages in the session's topic reach it, or stop taking them.                                                         |
| `/oob delivery <queue\|steer\|default>`                  | How your messages from a channel reach a busy session: queue, steer, or the config's default.                              |
| `/oob channel <channel> <on\|off>`                       | Turn a channel on or off for every session; kept across restarts.                                                          |
| `/oob pair <channel>`                                    | Show the code or link that binds a channel to a chat (the name can be left out when only one can pair).                    |
| `/oob test`                                              | Push a test message through every enabled channel.                                                                         |
| `/oob sidebar <full\|compact\|off>`                      | How big the section in the session sidebar is: full, compact or off.                                                       |
| `/oob afk <on\|off\|auto>`                               | When you count as away, for the whole OpenCode instance: on, off, or auto after the away time without input in any window. |
| `/oob session <session> <on\|off\|auto\|chat\|chat-off>` | Notify and chat settings of any session of this instance: on, off, auto, chat or chat-off.                                 |
| `/oob resume <session>`                                  | Wake a session that is suspended with messages waiting in its inbox.                                                       |
| `/oob restart`                                           | Restart the bridge in the OpenCode server: channels reconnect. The server keeps running.                                   |
| `/oob core <status\|rotate>`                             | Show the core API (address and token file), or replace its token: the old token is refused at once.                        |
| `/oob status`                                            | Show the bridge, who counts as away, each channel, the open prompts and this session's settings.                           |
| `/oob help`                                              | List every sub-command with its usage.                                                                                     |

## Sidebar

The top of the session sidebar gets a section for the session in view. The channel is on the
right of the title, muted; labels are dim, and a value is green for on, muted for off and amber for
denied or waiting:

```
OOB - Remote access         telegram
  Notify    on                     ▾
  Chat      on                     ▾
  Replies   after turn             ▾
  Waiting   1 question             ▾
  Away      here · auto            ▾
  Bridge    1835 · up 3d           ▾
```

Click a row to open a list of every choice, the current one marked. The sidebar updates at once.

| Row     | Shows                                                                         | The list                                                                                                                               |
| ------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Notify  | Whether questions and finish notices are pushed: `on`, `off`, `when away`.    | On (default channel), On via each channel, On via all, When away (after `away.minutes`), Off.                                          |
| Chat    | Whether you can write to the session from the channel: `on`, `off`, `denied`. | On, Off. When `chat.deny` blocks the session, the list says which rule and On is disabled. Left out when no selected channel can chat. |
| Replies | How your messages arrive: `after turn` (queue) or `immediately` (steer).      | Immediately, After turn, Default (follow `chat.delivery`). A choice is kept per session in the settings file.                          |
| Waiting | Open questions and requests; only when there are some.                        | The open prompts, oldest first; pick one to go to its session.                                                                         |
| Away    | Whether you count as away, instance-wide: `here · auto`, `away · on`.         | Auto (after `away.minutes` without input in any window), Away, Here.                                                                   |
| Stuck   | Sessions suspended with messages waiting; only when there are some.           | The sessions; pick one to resume it.                                                                                                   |
| Bridge  | The owner's pid and uptime, or `offline`, or the channel that is failing.     | Restart the bridge (not the server).                                                                                                   |

`sidebar` sets the size: `"full"` (default), `"compact"` or `"off"`. Compact is one line, and a
click opens the `/oob` picker:

```
OOB - Remote · telegram · notify on · chat on ▾
```

A narrow sidebar truncates the middle of that line with `…`. `/oob sidebar` sets the size, kept
in the settings file; it wins over the config.

Clicking needs a mouse. From the keyboard: `/oob on|off|auto`, `/oob chat on|off`,
`/oob delivery queue|steer|default` and `/oob sidebar full|compact|off`. The section is drawn by
`sidebar.tsx`, which needs `solid-js` and `@opentui/solid` (the OpenCode TUI provides them). If
they cannot be loaded, the bridge works without it. Other plugins that claim the sidebar are
placed after it.

## Telemetry

The plugin can export OpenTelemetry traces and metrics over OTLP/HTTP JSON, using only `fetch`
(no OpenTelemetry packages). It is **off** unless `otel.endpoint` is set (with optional
`otel.headers`) or `OTEL_EXPORTER_OTLP_ENDPOINT` is (with optional `OTEL_EXPORTER_OTLP_HEADERS`);
the config wins.

```jsonc
"otel": { "endpoint": "http://localhost:4318", "headers": { "authorization": "Bearer ..." } }
```

Service `opencode/oob-bridge`, scope `opencode-oob-bridge`. The trace id is the first 32 hex
characters of `sha256(<top-level session id>)`, as in the other OpenCode plugins that export
telemetry, so these spans join the session's trace.

| Spans                | What                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `oob.route`          | A routing decision: mode, reason, channel chosen, number of targets.                                                                                               |
| `oob.push`           | One push of a kind, with a child `oob.send` or `oob.update` per connector (type, ok, HTTP status, retries).                                                        |
| `oob.inbound`        | An answer or prompt from a chat: kind, connector type, outcome (`applied`, `expired`, `duplicate`, `unreadable`, `permission-refused`, `failed`, `rejected-chat`). |
| `oob.pair`           | Pairing, until paired or expired.                                                                                                                                  |
| `oob.command`        | A slash command or menu pick: name and outcome (never the arguments).                                                                                              |
| `oob.session.create` | A session started from a chat: outcome only.                                                                                                                       |
| `oob.reply`          | A reply posted to a chat: parts, characters, documents (never the text).                                                                                           |
| `oob.reconnect`      | A connector's poll or subscription reconnecting.                                                                                                                   |

| Metrics                 | Kind      | Labels                                                                               |
| ----------------------- | --------- | ------------------------------------------------------------------------------------ |
| `oob.pushes`            | counter   | `connector.type`, `push.kind`                                                        |
| `oob.push.errors`       | counter   | `connector.type`, `push.kind`                                                        |
| `oob.answers`           | counter   | `connector.type`, `answered_by` (`phone`, `tui`)                                     |
| `oob.prompts`           | counter   | `connector.type`, `outcome` (`sent`, `queued`, `steered`, `off`, `denied`, `failed`) |
| `oob.replies`           | counter   | `connector.type`                                                                     |
| `oob.stream.edits`      | counter   | `connector.type`                                                                     |
| `oob.stream.throttled`  | counter   | `connector.type`                                                                     |
| `oob.inbound.rejected`  | counter   | `connector.type`, `reason`                                                           |
| `oob.reconnects`        | counter   | `connector.type`                                                                     |
| `oob.answer.latency_ms` | histogram | `connector.type`, `answered_by` (asked to answered)                                  |
| `oob.pending`           | gauge     | none (open prompts)                                                                  |

Attributes are ids, kinds, counts and timings only. Message text, titles, answers, tokens, chat
ids and URLs are never exported. Data is batched every few seconds in a bounded queue (the oldest
is dropped), sent on exit, and a failed export is dropped and logged at most once a minute; it
never affects a session.

## Which sessions are mirrored

- `/oob` opens a picker of sub-commands (see [The `/oob` command](#the-oob-command)). It is also
  in the command palette.
- The same from the prompt: `/oob on` mirrors the session now, through `defaultChannel`;
  `/oob on telegram`, `/oob on ntfy` or `/oob on all` picks the channel for this session;
  `/oob off` never mirrors it; `/oob auto` returns it to the away rule. `/oob status`,
  `/oob test` and `/oob pair telegram` work the same way. `/ntfy` still works as an
  alias. The setting covers the session's subagents and is remembered across restarts (in
  `settings.json`).
- Otherwise, a session is mirrored when nobody has typed a message in the TUI for `away.minutes`
  and a rule matches. Typing again stops it for new prompts.

## Tiers

| Tier | Prompts              | From a channel                                                                     |
| ---- | -------------------- | ---------------------------------------------------------------------------------- |
| 1    | Questions            | Answered: buttons, or a text reply.                                                |
| 2    | `permissions.remote` | Allow once and Deny (`once`), or also Always (`all`), from a channel with buttons. |
| 3    | Every permission     | Push only, with a hint to answer in the TUI. The default (`off`).                  |

### What you receive

- **Question**: title `<project> · <agent> asks`, the top-level session's title, the question
  (redacted per `redact`), a numbered option list with short descriptions, and one line telling
  you how to answer with the prompt's short id. Up to three options also become buttons; with
  more options, multiple choice or several questions you reply by number. A subagent's question
  carries its agent name as a tag.
- **Permission**: title `<project> · <agent> needs permission`, the action and its resources.
- **Session finished / failed**: one low-priority push each time a mirrored top-level session
  stops working. A session woken up again (for example by a background subagent reporting back)
  sends another.
- When a prompt is answered in the TUI, its notification is updated to say so.

### Replying

Buttons post `{"id":"ab12","choice":1}` to `topics.in`. You can also publish text there:

| Reply              | Meaning                                      |
| ------------------ | -------------------------------------------- |
| `#ab12 2`          | Option 2                                     |
| `#ab12 yes`        | The option labelled "yes", or a free answer  |
| `#ab12 1,3`        | Options 1 and 3 (multiple choice)            |
| `#ab12 2 \| later` | One part per question when there are several |

The first answer wins, from the phone or the TUI. A later answer gets an "already answered" push
and is not applied; an unknown or expired id (older than a day) gets a push too.

Every outgoing body passes a secret filter that masks known token shapes (API keys, GitHub and
Slack tokens, private keys, JWTs, `password=` style pairs, URL credentials) and the channel tokens
themselves.

## Core API

The bridge can serve what it knows of your sessions, and the actions you can take on them, over
HTTP under `/v1`. It is off until `core.bind` is set:

```jsonc
{ "core": { "bind": "tailscale", "port": 7842 } }
```

`bind` is `tailscale` (the address of this machine on your tailnet), `localhost`, or an address
inside `127.0.0.0/8`, `::1`, `100.64.0.0/10` or `fd7a:115c:a1e0::/48`. A wildcard (`0.0.0.0`, `::`)
or a public address is refused at startup: the bridge logs why and does not listen. `/oob` Status
shows the address, or why there is none. Only the instance that runs the bridge listens, and the
listener restarts with `/oob restart`.

Every request needs `Authorization: Bearer <token>`. The token is 256 bits, kept in `core-token`
in the data directory (mode 0600), and replaced with `/oob core rotate`: the old one is refused
at once. A request without a valid token gets `401` with no body. Being on the tailnet is a
network path, not a login.

| Route                                   | Purpose                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /v1/meta`                          | API version, bridge version, which actions and fields work now                               |
| `GET /v1/status`                        | Owner, away state, channels, open prompts                                                    |
| `GET /v1/sessions`                      | Session summaries, newest first (`limit`, `offset`)                                          |
| `GET /v1/sessions/{id}`                 | Summary, conversation tail, diff summary, questions, permissions                             |
| `GET /v1/sessions/{id}/messages`        | Conversation tail (`limit`, `before`)                                                        |
| `GET /v1/sessions/{id}/diff`            | Diff summary; the patch with `Accept: text/x-diff`                                           |
| `POST /v1/sessions`                     | Start a session in a `chat.projects` folder                                                  |
| `POST /v1/sessions/{id}/actions/{name}` | `answer`, `resume`, `stop`, `prompt`, `rename`, `compact`, `model`, `agent`, `watch`, `chat` |
| `GET /v1/events`                        | Server-sent events, with `Last-Event-ID` resume                                              |

A field the bridge cannot fill is returned as `{"unavailable": "<why>"}`, never as an empty value;
a field that is filled says which `source` it came from. Text passes the secret filter and
`redact`, and a session that matches `chat.deny` is listed as `blocked` with no conversation. The
events carry a type and a session id only: read the session for the rest. Replies to permission
requests are refused unless `permissions.remote` is set; answer them in the OpenCode TUI.

Within `/v1` changes only add fields, routes and event types, so ignore what you do not know.

## Dead-man's switch

A bridge that has died or hung cannot say so. With `deadman.url` set, the bridge posts a small
heartbeat to a receiver you run elsewhere, every `deadman.intervalSeconds` (default 30), with
`Authorization: Bearer <token>`. The receiver notices silence on its own clock and tells you.

```jsonc
{
  "deadman": {
    "url": "https://relay.example.com/beat",
    "token": { "env": "OOB_DEADMAN_TOKEN" },
  },
}
```

The URL must be https (http only for a loopback address); anything else is refused, logged, and
nothing is sent. The heartbeat is `{ v, id, seq, at, state, reasons, version, pid, channels }`:
no session titles, paths, chat ids, usernames or message text. `state` is:

- `up`: the self-check passed. Each beat first runs the TUI's status call, checks its answer holds
  JSON values only, that the RPC is registered and that this process holds the owner lock, and
  reads each enabled channel's connection.
- `degraded`, with reason codes: `snapshot_invalid`, `rpc_missing`, `lock_lost`,
  `channel_down:<id>`, or `check_failed` when the check itself throws.
- `stopping`: sent before a restart or a shutdown, so a planned stop is not an outage.

Only the instance that runs the bridge sends. A failed send is logged once per change and never
delays anything else; missed beats are not queued.

A receiver that follows the contract alerts when three intervals pass in silence (five minutes
after `stopping`), or on two degraded beats in a row naming the reasons. It alerts once, reminds
every 30 minutes, says when the bridge is back, and uses `sendMessage` only: never `getUpdates`
or a webhook, so the bridge stays the only consumer of the bot. A sleeping laptop looks like a
crash; the alert says "no heartbeat" and does not guess why. `src/deadman.test-util.ts` is a
reference implementation of the receiver side.

## Security

- ntfy `http` buttons are sent by the app with no identity: **anyone who can publish to
  `topics.in` can answer a question.** Use long random topic names, and on your own server give
  `topics.in` write access only to the clients you trust.
- Buttons are `http` actions the app sends itself. With `actionAuth: true` (the default) each
  button carries `Authorization: Bearer <token>`, so it works when the server denies anonymous
  writes. **The token is then stored in the notification**: anyone who can read `topics.out` can
  read it. Give that token the least access it needs (write `topics.in`, write `topics.out`, read
  `topics.in`). The alternative is `actionAuth: false` plus an ACL that lets anonymous users only
  write to `topics.in` (`ntfy access everyone <in-topic> write-only`); then the buttons carry no
  credentials, and anyone who knows the topic name can answer.
- This is why permissions stay tier 3 by default: a hijacked chat could otherwise grant them. `permissions.remote` is the opt-in, and every answer is logged.
- Telegram answers come only from the paired chat, found by its numeric chat id. Anyone who can
  send messages as that chat (or take over that Telegram account) can answer questions.
- Never route production approvals through this plugin.

## Limitations

- OpenCode 2 only. The bridge runs in the server, so a server without a TUI (`opencode serve`)
  sends pushes, but a question can only be answered from a chat while a TUI is attached.
- Away means no input in any attached TUI; keystrokes alone do not count. With no TUI it is always
  away.
- Waking a suspended session uses the host's synthetic-message call; the host has no dedicated
  resume call, so a session it refuses to wake has to be opened at the Mac.
- In OpenCode 2.3 the built-in subagents have no `question` tool, so subagent questions only come
  from agents you give it to. Subagent permission prompts are mirrored as usual.
- A session that is interrupted (for example by rejecting a permission) sends no finished push.

## Development

```sh
mise run check   # lint, typecheck, tests, build, npm pack --dry-run
pnpm test        # unit tests, plus the e2e test when docker is available
pnpm test:e2e    # e2e against a real ntfy (binwiederhier/ntfy), or NTFY_E2E_URL
```

The e2e test starts `binwiederhier/ntfy serve` with docker, or uses `NTFY_E2E_URL`. It skips when
docker is missing or `NTFY_E2E_SKIP` is set.

A test run that did not point `OPENCODE_OOB_BRIDGE_LOG` or `OPENCODE_OOB_BRIDGE_DATA` somewhere of
its own writes no log: the logger refuses the default path under `node --test`, so running one test
file by hand cannot fill the real log.

The test script runs with `--test-force-exit`, and the fake servers do not keep the process alive.
Without that, a test that fails before it closes its server leaves a run that never ends and
prints no summary, because `--test-timeout` only covers a test that is still running. Keep
`--test-force-exit` before `--test-timeout` on the command line: in the other order Node 24 does
not apply it to the test files.

## License

MIT
