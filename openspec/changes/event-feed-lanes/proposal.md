## Why

For about four hours the operator's Telegram chat got no replies from a session, while messages sent to it were still delivered and given a reaction. The bridge's own counters show it: replies (196) and stream edits (567) stayed flat from 16:09 to 19:54, while prompts were still accepted. After the bridge restarted in place, both counters moved again at once. Nothing was logged: no error, no stall, no restart.

The server half reads the host's event stream in one loop and, for each event, waits for `sessions.ensure`, which calls `session.get` on the host. When the host never answers for one session (an instance being reloaded or disposed), that wait never ends, the loop stops reading, and every later event of every session queues behind it. Replies, streams, turn cards and form pushes all come from that stream.

## What Changes

- **The stream is read at once.** Each event is handed to a lane for its session. Events of one session run in order; a session with no host answer holds up no other.
- **Host calls have a time limit.** `session.get` gets 8 seconds. After that the bridge goes on without the answer and logs `host_timeout`.
- **Visibility.** A stream that ends without an error logs `event_stream_ended` (events seen, how long it lived).

## Capabilities

### Modified Capabilities

- `server-bridge`: the event feed.

## Out of scope

A watchdog that restarts a silent stream, per-update traces and metrics, a `/trace` command, reactions per state.

## Impact

- **Existing surface audit.** `src/server.ts` (`boot`: the feed loop and `Sessions`), `src/util.ts`, `src/fake-server.test-util.ts`.
