## Decisions

- **One tool per plugin instance.** Each instance registers the tool; the owner's bridge answers it, and a clear error is returned when the bridge runs in another process or is starting.
- **Topic from the root.** The tool takes the session id it runs in, resolves its root and uses only a topic that already exists.
- **Checks before reading.** Type, size and symlink target are checked before the file is read; the contents are read once, at send time.
- **Retry.** One retry on a 5xx, none on a 4xx.
- **Logging.** Size, kind, session and trace id only.
