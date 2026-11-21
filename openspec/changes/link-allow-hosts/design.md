## Decisions

- **Exact names only.** No wildcard, subdomain or suffix match, and no addresses: a certificate is issued for a name, and `wss` to a bare IP has none. Config refuses anything else by key name.
- **wss only.** An allowed host is accepted over `wss://`; `ws://` stays for loopback and the tailnet, where the network is the protection.
- **The key is a header on the dial.** Name `X-OOB-Link-Key`, env `LINK_KEY` or `LINK_KEY_FILE` on the relay, `link.key` on the bridge. It sits in `frame.ts` so both sides use one constant.
- **Checked before the upgrade, constant time.** The relay hashes both values with SHA-256 and compares the digests with `timingSafeEqual`, so length does not leak. A failure is 401 with no upgrade.
- **Rate-limited log.** At most one `link_refused` line with reason `key` a minute, with a count of the ones left out; the refusal counter counts all. No key material is logged on either side; the bridge also registers the key as a secret.
- **The key never replaces the HMAC.** Both are required when `LINK_KEY` is set.
- **An unreadable key waits.** If `link.key` is set and cannot be read, the bridge stays down with the reason "no key" rather than dialing without it.

## What a client may rely on

- Unset `LINK_KEY` and empty `allowHosts` behave as before.
