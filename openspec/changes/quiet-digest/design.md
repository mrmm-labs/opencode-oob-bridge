## Decisions

### D1. Silent delivery, not holding

Holding messages would make topics lie about time and lose questions if the bridge restarted. Quiet hours instead change how a message is delivered: Telegram `disable_notification: true`, ntfy priority 1 (min). The text and the topic are the same. The operator reads the night in the digest and in the topics.

### D2. Break-through is an explicit list

`quiet.breakthrough` lists kinds that still notify: `failed`, `permission`, `question`. The default list is empty. The deadman alert comes from a different sender and is never affected.

### D3. Clock and zone

Hours are `HH:MM` in an IANA zone from `quiet.timezone` (default the host zone). A window may cross midnight. Daylight saving changes are handled by converting each instant, not by adding hours.

### D4. Digest store

Each event that matters (turn finished, turn failed, prompt opened, prompt answered, session stuck) is appended to `digest.jsonl` in the data directory with a time and a redacted title. The digest is built from the records after the last digest. Records older than seven days are dropped. The file is derived data: losing it loses only the next digest's detail.

### D5. No empty digests

A digest with nothing in it is not sent, unless `digest.empty: true`.

## Risks

A digest that repeats yesterday's open question. Mitigation: "waiting on you" is read live from the open prompts, not from the records.
