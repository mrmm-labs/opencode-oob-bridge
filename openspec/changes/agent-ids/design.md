## Decisions

- **One resolver.** `resolveAgent(list, value)` returns the id: an exact id first, then an id ignoring case, then a label ignoring case. The first match wins, so an id is never shadowed by another agent's label.
- **Where it runs.** In `Actions.create` (client value and project default, before the deny check, the hourly limit and `createSession`) and in the `agent` action and `/agent`. Every path to OpenCode therefore carries an id.
- **No list, no refusal.** When the host lists no agents (OpenCode down, or none primary) the value is passed through: refusing would block a project whose agent OpenCode knows but does not list.
- **Refuse before side effects.** The check comes before the hourly counter and before `createSession`. The topic is only opened by the first state of the session, so a refusal leaves nothing behind.
- **Not started.** The bridge notes the time of each session it creates. A `failed` end within 60 seconds marks it `dead` (cleared when it works again). Telegram prefixes the topic name with ⚪ and renders the status card as "Did not start". The view-model state is `unstarted`. The usual failed push still goes out.
- **Log.** `session_create` with `outcome`, `project`, `agent` (the id) and `session`, written by the action, not by the chat flow.
