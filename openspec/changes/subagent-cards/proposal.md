## Why

A session that starts subagents shows nothing of them until one asks a question: the work of each is folded into the parent's posts. In a topic there is no way to see which subagents run, which wait for an answer, which are done.

## What Changes

- **One card per subagent** (child session) in the topic of its root session. It shows the description, the agent, the status (`running`, `waiting` for a question or permission, `done`, `idle`, `error`), the time it has run, and the last line of its last text, trimmed.
- **The card is edited in place**, never deleted. Edits are debounced, spaced at least 8 s apart per card, skipped when nothing changed, and the elapsed time changes the text at most once a minute. A final status and result stay on the card.
- **A subagent's question or permission is posted as a reply to its card.** The answer reaches the child session, as before.
- **A grandchild** has its own card in the root's topic, led by `↳` (one per level below the first).
- **Shared `<project> · agents` topic: no change.** Cards are made only where the root session has a topic of its own. A headless root (which posts in the shared topic), a chat that is not a forum, and a session without a topic get no card, and its subagents post as before.

## Capabilities

### New Capabilities

- `subagent-cards`: the card of a subagent in its parent's topic.

## Out of scope

A setting to turn cards off, buttons on the card, a card for a subagent whose root has no topic of its own, history of past cards after a restart.

## Impact

- **Existing surface audit.** `src/bridge.ts` (card state, events of children, reply target of prompts), `src/subcards.ts` (text of the card), `src/connectors/types.ts` (`Push.own`, `Push.replyTo`), `src/connectors/telegram.ts` (send in the own topic only, reply), README.
