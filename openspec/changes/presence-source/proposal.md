## Why

With AFK on `auto`, the bridge counted the person as at the Mac ("here: recent input") and kept questions off Telegram while they were on the phone. The input was not theirs at the Mac: every user prompt that reached any session, including ones sent from Telegram and by agents, was counted as typing at a TUI, and so were answers to forms and permissions, whoever gave them.

## What Changes

- **Presence at the Mac comes only from input at the Mac**: a prompt typed in a TUI (a prompt of a top-level session that a TUI has viewed, that the bridge did not send and no subagent sent, with a TUI attached) and the TUI's own `/oob` use. Nothing else.
- **Never presence at the Mac**: a Telegram message, button or form reply; the mini-app (boot, stream, reply); a prompt that an agent, a subagent or an RPC call delivered; an answer to a form or permission, whoever gave it; a TUI that is attached but has had no input.
- **Phone activity keeps the person away**: Telegram and mini-app activity count as being on the phone (`away.phoneMinutes`), which holds away until real input at the Mac has continued for the grace time.
- **Every input has a source** (`tui`, `telegram`, `app`, `agent`, `rpc`). Each change of presence is logged with the source that decided it, and `afk.why` says it: "here: TUI input 2m ago", "away: phone active 30s ago".
- **A held question is pushed when the state turns away.** Today it is only counted in the digest, with no buttons. The question, or permission, is now sent as it would have been, once.

## Capabilities

### Modified Capabilities

- `watch-afk`: where presence comes from, the logged source, the explanation, and held questions.

## Out of scope

Reading the macOS HID idle time (not read today; a keystroke hook the TUI plugin API does not offer). The grace after the server starts stays: the bridge counts as having had input when it starts, for `away.minutes`, and phone activity overrides it.

## Impact

- **Existing surface audit.** `src/routing.ts` (sources, state, explanation), `src/bridge.ts` (inbox event, replies, presence tick, held asks), `src/control.ts` (heartbeat, snapshot), `src/remote.ts` (the TUI half no longer reports its start as input), `src/core/api.ts` (app activity), README.
