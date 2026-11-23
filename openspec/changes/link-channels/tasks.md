## 1. Wire format

- [ ] 1.1 `path` argument on `sealUpgrade` and `Verifier.openUpgrade`, channel name syntax and the reserved name in `frame.ts`, copy synced. Verify: `src/link/frame.test.ts`, `src/link/shared-copy.test.ts`.

## 2. Relay

- [ ] 2.1 Config: `LINK_CHANNELS`, per-channel secret and key. Verify: `relay/src/config.test.ts`.
- [ ] 2.2 `/link/<name>` upgrade, per-channel verifier and key, shared nonce cache, per-channel eviction, label check, `onChannel` and `sendTo`. Verify: `relay/src/channels.test.ts`.
- [ ] 2.3 Send-buffer limit on channels. Verify: `relay/src/channels.test.ts`.
- [ ] 2.4 `Link.close()` closes every socket. Verify: `relay/src/channels.test.ts`.
- [ ] 2.5 Channel metric. Verify: `relay/src/metrics.test.ts` or the channel test.

## 3. Client

- [ ] 3.1 `LinkClient` signs its URL path and does not reconnect after 4000. Verify: `src/link/client.test.ts`.

## 4. Docs

- [ ] 4.1 Relay README: channels, variables, the deploy order and the 404, a Helm values example. Verify: `pnpm run hygiene` and review.
