## Context

The plugin API gives no way to change a queued prompt to steered, or to cancel it. Queuing it with the host and steering a copy later would deliver the message twice.

## Decisions

- **The bridge keeps the message, not the host.** A message for a busy session with queue delivery is held in memory, one timer per session. At the deadline every held message of that session is sent in order, steered if the session is still busy. When the session finishes or is interrupted first, they are sent as normal prompts instead.
- **Stopping releases, never drops.** `stop()` sends what is held as queued prompts. A crash of the process inside the window loses them: the window is 30 seconds by default.
- **Default 30 s.** A turn that ends within it behaves as before; a long one stops starving the message.
- **Retry once in `call`.** The error of the first attempt (not an abort asked for by the caller) is logged as `telegram_call_retry` and the call is repeated on a new connection. A duplicate message is possible if the first request reached Telegram; a lost one was the alternative.

## What a client may rely on

- A message is sent to the session within `chat.queueSteerSeconds` of arriving, or handed to its queue at once if the bridge stops.

Left to the host: when a steered message is read in the turn.
