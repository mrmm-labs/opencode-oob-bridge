## Context

`TelegramConnector.status()` reported `connected` from the last poll result only. A loop awaiting a call that never returns changes nothing in it.

## Decisions

- **Silence is measured from the loop's own steps.** The loop stamps each pass, including passes that end in an error, so network trouble (which backs off for at most 60 s) is not a stall. While the token is being waited for the loop reports no silence: that wait is planned and can last 5 minutes.
- **150 s.** A poll call is abandoned after 40 s and a backoff is at most 60 s, so a live loop steps in under 100 s.
- **Restart, not exit.** The hub's `restart` stops the bridge and elects an owner again, with the lock held. The old loop's signal is aborted, so it cannot poll beside the new one.
- **Degraded, not silent.** The dead-man heartbeat keeps arriving but says `degraded`, so the receiver learns which channel and why. If the whole process is wedged the heartbeat stops anyway.

## What a client may rely on

- A receive loop stuck for 150 s is restarted within the next 30 s and logged.

Left to the channel: whether a send is slow; a stalled send path is not detected here.
