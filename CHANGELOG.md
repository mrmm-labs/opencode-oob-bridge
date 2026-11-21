# Changelog

## [0.32.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.31.0...v0.32.0) (2026-11-21)


### Features

* link.allowHosts for wss hosts and an optional pre-shared link key ([#110](https://github.com/mrmm-labs/opencode-oob-bridge/issues/110)) ([e8c21d2](https://github.com/mrmm-labs/opencode-oob-bridge/commit/e8c21d2359b80f20e4af7349eab14aaa10943c45))
* say where to write in a topic with no session, log the loaded version ([#108](https://github.com/mrmm-labs/opencode-oob-bridge/issues/108)) ([df6e707](https://github.com/mrmm-labs/opencode-oob-bridge/commit/df6e707d93b08b9c94b9e1b28b48f17d82c5779f))

## [0.31.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.30.0...v0.31.0) (2026-11-21)


### Features

* trace every Telegram update and send, with log levels, metrics, /trace and a dashboard ([#106](https://github.com/mrmm-labs/opencode-oob-bridge/issues/106)) ([18657ca](https://github.com/mrmm-labs/opencode-oob-bridge/commit/18657ca223f1366cee089fbe1497b46bc97d39fb))

## [0.30.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.29.1...v0.30.0) (2026-11-21)


### Features

* a reaction per stage on each message, from received to replied ([#104](https://github.com/mrmm-labs/opencode-oob-bridge/issues/104)) ([50e6dd3](https://github.com/mrmm-labs/opencode-oob-bridge/commit/50e6dd335c5cc04641734e0f6b9a649fc8681c70))

## [0.29.1](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.29.0...v0.29.1) (2026-11-21)


### Bug Fixes

* keep action names on one line in the Mini App info tab, and space the View patch button ([#101](https://github.com/mrmm-labs/opencode-oob-bridge/issues/101)) ([5cfc13a](https://github.com/mrmm-labs/opencode-oob-bridge/commit/5cfc13ae5d0c47e2234c01603d43a74c892f9bf9))
* steer a queued chat message in after 30 s, and retry a hung Telegram call ([#103](https://github.com/mrmm-labs/opencode-oob-bridge/issues/103)) ([7d04e86](https://github.com/mrmm-labs/opencode-oob-bridge/commit/7d04e8653bab52250a336ec1b39fb531668d0cda))

## [0.29.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.28.0...v0.29.0) (2026-11-21)


### Features

* hold a message for a session that waits on a question, and let the person choose ([#98](https://github.com/mrmm-labs/opencode-oob-bridge/issues/98)) ([2382e56](https://github.com/mrmm-labs/opencode-oob-bridge/commit/2382e56dde72f9ba130c0051dc0e2a7f123f75fd))

## [0.28.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.27.1...v0.28.0) (2026-11-21)


### Features

* a Telegram Mini App served by the core API, for sessions, diffs and forms ([#93](https://github.com/mrmm-labs/opencode-oob-bridge/issues/93)) ([4932d52](https://github.com/mrmm-labs/opencode-oob-bridge/commit/4932d52e0c3a58825f911a9e3733b6b2cacc52d5))

## [0.27.1](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.27.0...v0.27.1) (2026-11-21)


### Bug Fixes

* never poll one bot twice, and report a 409 as a conflict ([#94](https://github.com/mrmm-labs/opencode-oob-bridge/issues/94)) ([7b737d9](https://github.com/mrmm-labs/opencode-oob-bridge/commit/7b737d94fd1c982b3b4822aa8637e6433ae0f760))

## [0.27.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.26.0...v0.27.0) (2026-11-21)


### Features

* restart the bridge when a receive loop stops stepping, and show liveness in /oob status ([#91](https://github.com/mrmm-labs/opencode-oob-bridge/issues/91)) ([5b4cb11](https://github.com/mrmm-labs/opencode-oob-bridge/commit/5b4cb119809b834ae8e4991f55c4488f85a9df0d))

## [0.26.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.25.2...v0.26.0) (2026-11-21)


### Features

* relay with public edge, private link and dead-man receiver ([#88](https://github.com/mrmm-labs/opencode-oob-bridge/issues/88)) ([95be0b3](https://github.com/mrmm-labs/opencode-oob-bridge/commit/95be0b33b7962d4c121de2c2c64476799c4be70d))

## [0.25.2](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.25.1...v0.25.2) (2026-11-21)


### Bug Fixes

* one session the host never answers for no longer stops every reply ([#86](https://github.com/mrmm-labs/opencode-oob-bridge/issues/86)) ([12b9655](https://github.com/mrmm-labs/opencode-oob-bridge/commit/12b96558d8b598fbad9ee8f8c53785d3334d77ab))

## [0.25.1](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.25.0...v0.25.1) (2026-11-21)


### Bug Fixes

* write each Telegram update down before moving the offset, and log what became of it ([#84](https://github.com/mrmm-labs/opencode-oob-bridge/issues/84)) ([1a2180c](https://github.com/mrmm-labs/opencode-oob-bridge/commit/1a2180cd385f469620653229f8a23eeefdc6e7c5))

## [0.25.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.24.0...v0.25.0) (2026-11-21)


### Features

* approvals for local tools over a unix socket, answered on Telegram ([#81](https://github.com/mrmm-labs/opencode-oob-bridge/issues/81)) ([cb8a584](https://github.com/mrmm-labs/opencode-oob-bridge/commit/cb8a584a29e55226b9ca7164d0a693c1a383f388))

## [0.24.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.23.0...v0.24.0) (2026-11-21)


### Features

* /oob version and /version show what is installed and what each half runs ([#78](https://github.com/mrmm-labs/opencode-oob-bridge/issues/78)) ([0d56796](https://github.com/mrmm-labs/opencode-oob-bridge/commit/0d56796165295e31913bf63f0cd1c617c92e61ae))

## [0.23.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.22.0...v0.23.0) (2026-11-21)


### Features

* overnight plan, timed away and return summary ([#73](https://github.com/mrmm-labs/opencode-oob-bridge/issues/73)) ([c97f289](https://github.com/mrmm-labs/opencode-oob-bridge/commit/c97f28954ccb171c695a9324f79dc35ac25b6464))

## [0.22.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.21.0...v0.22.0) (2026-11-21)


### Features

* observed resume outcome, alert lifecycle, real-session check ([#68](https://github.com/mrmm-labs/opencode-oob-bridge/issues/68)) ([6d67e1e](https://github.com/mrmm-labs/opencode-oob-bridge/commit/6d67e1e1052e3adf5af78e2d94cde5f604eef62d))

## [0.21.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.20.0...v0.21.0) (2026-11-21)


### Features

* diff images for the turn card ([#65](https://github.com/mrmm-labs/opencode-oob-bridge/issues/65)) ([1a5291c](https://github.com/mrmm-labs/opencode-oob-bridge/commit/1a5291c84dcdbe8c31928bc1c3621f5c39e28a0c))

## [0.20.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.19.0...v0.20.0) (2026-11-21)


### Features

* streaming limits and an opt-in draft path ([#63](https://github.com/mrmm-labs/opencode-oob-bridge/issues/63)) ([dae0592](https://github.com/mrmm-labs/opencode-oob-bridge/commit/dae0592a1821fc0429c2f41478dc585f3513cc4a))

## [0.19.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.18.0...v0.19.0) (2026-11-21)


### Features

* form stepper and opt-in remote permissions ([#59](https://github.com/mrmm-labs/opencode-oob-bridge/issues/59)) ([6b34308](https://github.com/mrmm-labs/opencode-oob-bridge/commit/6b34308d968b4ae7d825a37b5792073b8ae81cd8))

## [0.18.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.17.0...v0.18.0) (2026-11-21)


### Features

* quiet hours and a daily digest ([#57](https://github.com/mrmm-labs/opencode-oob-bridge/issues/57)) ([54ffe03](https://github.com/mrmm-labs/opencode-oob-bridge/commit/54ffe036faa9ef0e92c84c7574e853c772e3d931))

## [0.17.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.16.0...v0.17.0) (2026-11-21)


### Features

* turn card with diff, continue and stop ([#54](https://github.com/mrmm-labs/opencode-oob-bridge/issues/54)) ([36c009b](https://github.com/mrmm-labs/opencode-oob-bridge/commit/36c009bbfd5fb5fcd58815007990e711b8c52f4e))

## [0.16.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.15.0...v0.16.0) (2026-11-21)


### Features

* command menu with undo, resume, afk and digest ([#51](https://github.com/mrmm-labs/opencode-oob-bridge/issues/51)) ([42f4370](https://github.com/mrmm-labs/opencode-oob-bridge/commit/42f437064fde25be4b8d70dffa8e6c77e7a71915))

## [0.15.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.14.0...v0.15.0) (2026-11-21)


### Features

* dead-man heartbeat to a configured receiver ([#48](https://github.com/mrmm-labs/opencode-oob-bridge/issues/48)) ([1dbc2f8](https://github.com/mrmm-labs/opencode-oob-bridge/commit/1dbc2f8d3598b9cd3f090dcdf4a829d935a9744d))

## [0.14.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.13.2...v0.14.0) (2026-11-21)


### Features

* core API with one action set, view-models and /v1 HTTP+SSE ([#45](https://github.com/mrmm-labs/opencode-oob-bridge/issues/45)) ([0ec928c](https://github.com/mrmm-labs/opencode-oob-bridge/commit/0ec928c96c135d18d0a2abb6cb629506356e2d05))

## [0.13.2](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.13.1...v0.13.2) (2026-11-21)


### Bug Fixes

* **server:** answer the RPC with JSON values only ([#41](https://github.com/mrmm-labs/opencode-oob-bridge/issues/41)) ([8b0eef8](https://github.com/mrmm-labs/opencode-oob-bridge/commit/8b0eef8199d32ace751ed1d217e37aa7b2f134f8))

## [0.13.1](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.13.0...v0.13.1) (2026-11-21)


### Bug Fixes

* register the RPC from every plugin instance, own the bridge per process ([#39](https://github.com/mrmm-labs/opencode-oob-bridge/issues/39)) ([a01cc9a](https://github.com/mrmm-labs/opencode-oob-bridge/commit/a01cc9ae743b9c3abdd06b2d70f6028872c0803f))

## [0.13.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.12.1...v0.13.0) (2026-11-21)


### Features

* run the bridge once in the server, pilot it from the TUI ([#37](https://github.com/mrmm-labs/opencode-oob-bridge/issues/37)) ([d4ede04](https://github.com/mrmm-labs/opencode-oob-bridge/commit/d4ede04454c23cf2221db8c40a66815b955869e5))

## [0.12.1](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.12.0...v0.12.1) (2026-11-20)


### Bug Fixes

* **telegram:** keep the topic name plain, show the watch state on the card's first line ([#34](https://github.com/mrmm-labs/opencode-oob-bridge/issues/34)) ([55287f3](https://github.com/mrmm-labs/opencode-oob-bridge/commit/55287f36cddbb8a823858116830959c2b1f881da))

## [0.12.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.11.0...v0.12.0) (2026-11-20)


### Features

* **telegram:** reaction acks, watch state in the topic, photo and document upload ([#32](https://github.com/mrmm-labs/opencode-oob-bridge/issues/32)) ([379b410](https://github.com/mrmm-labs/opencode-oob-bridge/commit/379b410bc4cc8558633a023f26968c6835570f6a))

## [0.11.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.10.0...v0.11.0) (2026-11-20)


### Features

* /oob-&lt;sub&gt; slash entries; fix: suite hang under CPU load ([#30](https://github.com/mrmm-labs/opencode-oob-bridge/issues/30)) ([b2996dd](https://github.com/mrmm-labs/opencode-oob-bridge/commit/b2996dd5a4576d2381e724f3d6d35357bb5e547c))

## [0.10.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.9.0...v0.10.0) (2026-11-20)


### Features

* one registry of /oob sub-commands, with a searchable picker ([#28](https://github.com/mrmm-labs/opencode-oob-bridge/issues/28)) ([8f15959](https://github.com/mrmm-labs/opencode-oob-bridge/commit/8f1595925b381f92906e0ce3f0cb2ee4478fd941))

## [0.9.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.8.0...v0.9.0) (2026-11-20)


### Features

* sidebar section at the top with rows, dropdowns and a compact mode ([#26](https://github.com/mrmm-labs/opencode-oob-bridge/issues/26)) ([bc79d4a](https://github.com/mrmm-labs/opencode-oob-bridge/commit/bc79d4ad61364c664d95b065199e5387aa9d9067))

## [0.8.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.7.1...v0.8.0) (2026-11-20)


### Features

* steer delivery, faster streaming, token backoff and a sidebar block ([#24](https://github.com/mrmm-labs/opencode-oob-bridge/issues/24)) ([ec58d63](https://github.com/mrmm-labs/opencode-oob-bridge/commit/ec58d6305613e035650af555e2180c75e9163367))

## [0.7.1](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.7.0...v0.7.1) (2026-11-20)


### Bug Fixes

* chat replies are not cut by the prompt preview limit ([#22](https://github.com/mrmm-labs/opencode-oob-bridge/issues/22)) ([ad8e237](https://github.com/mrmm-labs/opencode-oob-bridge/commit/ad8e2373253c3ddcab7f669ff626ff0a69d0591e))

## [0.7.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.6.0...v0.7.0) (2026-11-20)


### Features

* chat with a session from its Telegram topic, with live streaming ([#19](https://github.com/mrmm-labs/opencode-oob-bridge/issues/19)) ([4ae0579](https://github.com/mrmm-labs/opencode-oob-bridge/commit/4ae057985ff5d0d6e441e5780c1d9ecea293ae41))
* start sessions and run slash commands from Telegram ([#20](https://github.com/mrmm-labs/opencode-oob-bridge/issues/20)) ([a77d884](https://github.com/mrmm-labs/opencode-oob-bridge/commit/a77d8840ee36e2e972159aad17603b6fe2099246))

## [0.6.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.5.0...v0.6.0) (2026-11-20)


### Features

* Telegram free-text answers, group pairing, status card, icons and richer messages ([#17](https://github.com/mrmm-labs/opencode-oob-bridge/issues/17)) ([055fc68](https://github.com/mrmm-labs/opencode-oob-bridge/commit/055fc68c6631eb3db61c27be3d2994b5510f163c))

## [0.5.0](https://github.com/mrmm-labs/opencode-oob-bridge/compare/v0.4.0...v0.5.0) (2026-11-19)


### Features

* connectors, Telegram, TUI settings menu and OpenTelemetry ([#15](https://github.com/mrmm-labs/opencode-oob-bridge/issues/15)) ([13d762c](https://github.com/mrmm-labs/opencode-oob-bridge/commit/13d762c818a8ea087955500b777f223bf741b69e))

## [0.4.0](https://github.com/mrmm-labs/opencode-ntfy-bridge/compare/v0.3.0...v0.4.0) (2026-11-19)


### ⚠ BREAKING CHANGES

* rename to opencode-oob-bridge ([#13](https://github.com/mrmm-labs/opencode-ntfy-bridge/issues/13))

### Features

* rename to opencode-oob-bridge ([#13](https://github.com/mrmm-labs/opencode-ntfy-bridge/issues/13)) ([235acea](https://github.com/mrmm-labs/opencode-ntfy-bridge/commit/235acea8bd11b823aeb4134e703e6f9d9a3bc246))

## [0.3.0](https://github.com/mrmm-labs/opencode-ntfy-bridge/compare/v0.2.2...v0.3.0) (2026-11-19)


### Features

* configurable push formats with per-use-case profiles ([#11](https://github.com/mrmm-labs/opencode-ntfy-bridge/issues/11)) ([583b5bf](https://github.com/mrmm-labs/opencode-ntfy-bridge/commit/583b5bf4ccd06ef84547b4b020d4a80b0031e8c5))

## [0.2.2](https://github.com/mrmm-labs/opencode-ntfy-bridge/compare/v0.2.1...v0.2.2) (2026-11-19)


### Bug Fixes

* register /ntfy in the global keymap mode ([#9](https://github.com/mrmm-labs/opencode-ntfy-bridge/issues/9)) ([10db9b2](https://github.com/mrmm-labs/opencode-ntfy-bridge/commit/10db9b2f7917cdf16c4f8e6159deba49abe62314))

## [0.2.1](https://github.com/mrmm-labs/opencode-ntfy-bridge/compare/v0.2.0...v0.2.1) (2026-11-19)


### Bug Fixes

* register /ntfy before setup awaits ([#7](https://github.com/mrmm-labs/opencode-ntfy-bridge/issues/7)) ([ddf3a7a](https://github.com/mrmm-labs/opencode-ntfy-bridge/commit/ddf3a7a4331f8cbc27b2c9a10a410c31436d58c1))

## [0.2.0](https://github.com/mrmm-labs/opencode-ntfy-bridge/compare/v0.1.0...v0.2.0) (2026-11-19)


### Features

* buttons on auth-protected servers and readable question pushes ([#5](https://github.com/mrmm-labs/opencode-ntfy-bridge/issues/5)) ([a9e064d](https://github.com/mrmm-labs/opencode-ntfy-bridge/commit/a9e064d0247ac38953c6c68c505148eb09007348))

## 0.1.0 (2026-11-18)


### Features

* ntfy bridge for OpenCode 2 questions and permission prompts ([#1](https://github.com/mrmm-labs/opencode-ntfy-bridge/issues/1)) ([601eb4a](https://github.com/mrmm-labs/opencode-ntfy-bridge/commit/601eb4acee67bf7d7bb28a7e924a101c708ab3e3))
