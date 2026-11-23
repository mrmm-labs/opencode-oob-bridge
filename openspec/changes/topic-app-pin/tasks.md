## 1. The app message of a topic (one PR)

- [ ] 1.1 Post and pin silently when a topic is bound; remember the id and the pin. Verify: `src/connectors/telegram-pin.test.ts`.
- [ ] 1.2 A restart does not post or pin again; the message is edited in place. Verify: `src/connectors/telegram-pin.test.ts`.
- [ ] 1.3 An edit that finds the message gone posts and pins a new one. Verify: `src/connectors/telegram-pin.test.ts`.
- [ ] 1.4 A missing pin right logs `topic_pin_failed` and leaves the message unpinned. Verify: `src/connectors/telegram-pin.test.ts`.
