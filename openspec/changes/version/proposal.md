## Why

After an upgrade the files on disk change at once, but the OpenCode server and each TUI keep running the code they loaded. The operator cannot tell which version is live, and a half-upgraded install (server old, TUI new) fails in ways that look like bugs. One command must say what is installed and what each half runs, and warn when they differ.

## What Changes

- `/oob version` in the TUI, a `/oob-version` slash entry, and `/version` in Telegram (also in the command menu).
- It shows the installed version (`package.json` of the install directory), `git describe` of that directory, the version the server half runs and the version the TUI half runs (both from memory, read once when the module loaded), the server pid and start time, the owner instance id, the config file in use, and the core API version.
- A `⚠` line for each place two versions differ, for example "the server runs 0.22.0 but 0.23.0 is installed: restart OpenCode". The sidebar shows the same line under its header.
- Each TUI sends the version it runs with its heartbeat, so the server (and Telegram) can compare it too.
- The owner lock records an instance id.

## Capabilities

### New Capabilities

- `version`: the report, the comparison and where it is shown.

### Modified Capabilities

None.

## Out of scope

Restarting OpenCode or reloading the plugin from the command, checking for a newer release on the network, a version gate that refuses a mismatched TUI.

## Impact

- **Existing surface audit.** `src/control.ts` (snapshot, heartbeat, ops), `src/server.ts` (the version read from disk at each boot), `src/lock.ts`, `src/remote.ts`, `src/menu.ts`, `src/sidebar.ts`, `src/commands.ts`, `src/commandmenu.ts`.
- **Supersession.** `server.ts` read `package.json` again at every boot, so a bridge restart after an upgrade claimed the new version while still running the old code. The running version is now captured once, at load.
- **Estimate.** Agent 1 hour. Operator 2 minutes.
- **Definition of done.** `pnpm test` ends `fail 0` with a test for the mismatch case.
