## 1. Shared code

- [x] 1.1 Frame MAC with direction, window, nonce cache; init data check; tailnet host rule; the relay's copies equal. Verify: `src/link/*.test.ts` (valid, tampered, stale, replayed, reflected; init data valid, tampered, stale, wrong user; hosts).

## 2. Relay

- [x] 2.1 Config from the environment, with `_FILE` variants for secrets. Verify: `config.test.ts`.
- [x] 2.2 Public face: paths, pre-filter and hash check, body cap, limits, forwarding, offline page. Verify: `public.test.ts` for each scenario of the spec.
- [x] 2.3 Link face: upgrade and frame checks, replacement, request and stream frames, close on phone leave. Verify: `link.test.ts`.
- [x] 2.4 Dead-man receiver on both paths, alerts by `sendMessage`, three metrics. Verify: `deadman.test.ts` with a fake clock; a guard test that the source never names `getUpdates` or `setWebhook`.
- [x] 2.5 Logs hold no credential. Verify: a test greps the log of a request with init data.

## 3. Bridge

- [x] 3.1 `link` config and tailnet host check. Verify: `config.test.ts`, `src/link/hosts.test.ts`.
- [x] 3.2 Outbound client, backoff, one link per owner, status. Verify: `src/link/client.test.ts`.
- [x] 3.3 Request frames through the core API handler, init data only, path list, in-flight limit. Verify: `src/link/serve.test.ts`, `src/core/core.test.ts`.
- [x] 3.4 `beat` and `ack` frames next to the HTTPS heartbeat. Verify: `deadman.test.ts`.
- [x] 3.5 A bridge talks to a real relay. Verify: `src/link/integration.test.ts`.

## 4. Image and CI

- [x] 4.1 Dockerfile with context `relay/`, uid 65532, read-only file system, both architectures built in CI without a push. Verify: CI builds both and a run with `--read-only` answers `/healthz`.
- [x] 4.2 Optional release job: masked first, filtered output, no summary, release tag only. Verify: `src/ci/relay-push.test.ts` and a CI dry run whose captured log holds no fake registry value.
- [x] 4.3 Hygiene check with the deny-list and the secret. Verify: `src/ci/hygiene.test.ts` fails on a planted registry host literal and prints `file:line` only.

## 5. Docs

- [x] 5.1 `relay/README.md` and `relay/deploy/` examples. Verify: `docker compose config` and a Kubernetes dry run on the examples.
