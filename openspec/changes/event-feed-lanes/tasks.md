## 1. Feed

- [x] 1.1 Per-session lanes in the feed loop. Verify: `server.test.ts` "a session the host never answers for does not stop the events of the others" (fails on the previous code).
- [x] 1.2 Time limit on `session.get`. Verify: `server.test.ts` "goes on without a host answer after the time limit" and `withTimeout`.
- [x] 1.3 Log `event_stream_ended`. Verify: code review of the log line; the test host's stream does not end.
