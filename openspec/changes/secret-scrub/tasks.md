## 1. Scrub client

- [ ] 1.1 `scrub.socket` and `scrub.timeoutMs` config, strict. Verify: `config.test.ts`, `scrub.test.ts`.
- [ ] 1.2 Socket client for protocol v1 that never carries text in an error. Verify: `scrub.test.ts`.
- [ ] 1.3 Connector decorator for send, update, stream and reply; one round trip per push; title-only fallback. Verify: `scrub.test.ts`.
- [ ] 1.4 Wire it in the server when configured. Verify: `server.test.ts`.
- [ ] 1.5 README and example config, with the limits. Verify: review.
