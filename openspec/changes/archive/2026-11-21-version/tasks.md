## 1. Report

- [x] 1.1 Capture the running version once at load; read the disk, `git describe` and the config path on request. Verify: `version.test.ts` (upgrade on disk, a checkout, a directory inside another repository, the legacy config name).
- [x] 1.2 Compare installed, server and TUI versions. Verify: `version.test.ts` mismatch cases, including server older than the disk.
- [x] 1.3 TUIs report their version with the heartbeat; the server keeps it per window. Verify: `control.test.ts`.
- [x] 1.4 Owner instance id in the lock. Verify: `lock.test.ts`.

## 2. Where it is shown

- [x] 2.1 `/oob version` and `/oob-version`. Verify: `tui.test.ts` registry lists, `sidebar.test.ts` for the lines.
- [x] 2.2 `/version` in Telegram and in the command menu. Verify: `control.test.ts` and `commandmenu.test.ts`.
- [x] 2.3 Warning in the sidebar header, full and compact. Verify: `sidebar.test.ts`.
- [x] 2.4 README. Verify: `readme.test.ts`.
