## 1. Signal

- [x] 1.1 `viewed` in `SessionInfo`, from `time.viewed`; `session.viewed` applied to the cache and read from the feed. Verify: `sessions.test.ts`.

## 2. Placement

- [x] 2.1 `Bridge.homeOf` and `Connector.home`. Verify: `headless-topic.test.ts`.
- [x] 2.2 `thread()` order, `track()` early return, `sessionAt` skip, `topicLink`. Verify: `headless-topic.test.ts`.
- [x] 2.3 Tag on push, update, turn card, photo, document. Verify: `headless-topic.test.ts`.
- [x] 2.4 Reply routing and the hint. Verify: `headless-topic.test.ts`.

## 3. Config and docs

- [x] 3.1 `channels.telegram.topics.headless`. Verify: `config.test.ts`.
- [x] 3.2 README and example config.
