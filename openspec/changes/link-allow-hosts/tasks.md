## 1. Link hosts and key

- [x] 1.1 `link.allowHosts` check and config. Verify: `hosts.test.ts`.
- [x] 1.2 `link.key` config, header on the dial, trim. Verify: `client.test.ts`, `hosts.test.ts`.
- [x] 1.3 Relay `LINK_KEY`: length, constant-time check before the upgrade, rate-limited log. Verify: `relay/src/link.test.ts`, `relay/src/config.test.ts`.
- [x] 1.4 README, relay README, deploy examples.
