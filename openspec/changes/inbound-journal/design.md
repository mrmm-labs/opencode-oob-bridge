## Context

`TelegramConnector.loop` sets the offset to `update_id + 1` for each update, awaits `onUpdate`, and saves the offset after the batch. `onUpdate` reaches `ctx.session.prompt` through the core, so a host call that does not return stops the loop. Only errors and a few refusals are logged.

## Decisions

- **Journal before offset.** `getUpdates` returns a batch; the batch is appended to `<channel>-inbox.jsonl` (mode 0600), then the offset is moved and saved, then the updates are dispatched. If the append fails the offset stays where it was, the error is logged, the loop backs off and Telegram offers the same updates again. A `done` line follows each handled update. When nothing is open and the file holds 100 lines it is emptied. Ids done lately are remembered so an update Telegram sends twice is handled once.
- **Lanes.** The key is chat and topic. Updates of a lane run one after another; lanes run in parallel. The poll loop only dispatches.
- **Time limit.** One update may take 90 s. After that it ends as `error`, the topic is told, and the lane moves on. It is not retried: the session may have taken it.
- **Retry only a known failure.** The core marks `Outcome.retry` when the host refused the prompt, and only for a connector that declares `retriesInbound`. The connector tells the topic, keeps the entry open and tries again after 5 s, 30 s and 2 min. A stopping bridge leaves the entry open for the next start.
- **Outcome log.** The handler of an update records its outcome with an `AsyncLocalStorage` store, so the many return paths of `onUpdate` need one call each and the log line is written in one place.

## What a client may rely on

- An update Telegram has been told about is on disk until it is handled.
- Every update gets one `telegram_inbound` line.

Left to the host: whether a prompt is accepted. Left to Telegram: redelivery of updates whose offset was not saved.

## Risks

A crash after the prompt reached the session and before `done` is written handles the message again at the next start. A duplicate is preferred to a loss.
