## Decisions

- **Why not the plugin context.** Its session domain has no form call, so the reply goes through the service API instead. The endpoint and credentials come from the client package's discovery of the running service; nothing is configured.
- **Service first, window second.** A reply the service refuses is relayed through a window if one is attached, otherwise it fails with a note to answer at the Mac.
- **The gate asks the service.** `canReplyForm` may be asynchronous: true when a window is attached or the service answers. Discovery is cached for 30 s and retried after a failure.
- **Tests never use the machine's own service.** A test names a service or none.
- **Reactions.** After a reply is posted the waiting messages become 👌; when posting fails they become 💔. A turn that ends with no text keeps ⚡.

## What a client may rely on

- Answering from a channel works with no window open, while the service runs.
