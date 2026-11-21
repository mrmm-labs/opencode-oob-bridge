# Changelog

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
