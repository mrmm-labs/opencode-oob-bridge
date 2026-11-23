## Why

The status card of a topic carries a 📱 Open button, but it can be turned off (`statusCard: false`), it is edited often, and its first line is what the pinned bar shows. There is no steady, always-present way to open a session in the app from its topic.

## What Changes

- **A pinned "📱 Open app" message in every topic bound to a session.** It has one Mini App deep-link button, `s_<session id>`, in the `t.me` link form that works in groups. It is pinned without a sound.
- **Posted once, then edited in place.** When a topic is bound, and once at startup for each topic already bound, the bridge makes sure the message exists. It is never deleted and never pinned twice. When it is gone from Telegram, a new one is posted and pinned.
- **A missing right is reported, not fatal.** Without the right to pin, the message stays unpinned and `topic_pin_failed` is logged with the reason.

## Capabilities

### Modified Capabilities

- `topics`: the app message of a topic.

## Impact

`src/connectors/telegram.ts` (the topic record and a new `appMessage` step), README.
