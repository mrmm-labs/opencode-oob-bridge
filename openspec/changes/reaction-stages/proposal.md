## Why

A prompt from Telegram got one reaction once the session had it. Before that nothing showed, and after it nothing told the person whether the session had replied, the delivery had failed, or the message had been ignored. Away from the Mac, that silence reads as "lost".

## What Changes

- **One reaction per stage, set in place on the person's message:** 👀 received, ✍ queued behind a busy session, ⚡ sent or steered into the session, 👌 the session replied, 💔 delivery failed, 🙈 ignored (no session in the topic, or chat refused), 🤷 held because the session waits on a question.
- **The agent emoji is no longer the default** for a sent message (⚡ is). `reactions.agents` still replaces ⚡ for the agents it names.
- **`reactions` takes one key per stage** (`received`, `queued`, `sent`, `steered`, `done`, `failed`, `ignored`, `held`) next to `default` and `agents`.
- **Reactions are best effort and rate limited.** A reaction that fails is logged and never stops the delivery. Calls are spaced at least 400 ms apart, and a message is not given the emoji it already wears.

## Capabilities

### Modified Capabilities

- `reactions`: the acknowledgement becomes a sequence of stages.

## Out of scope

Reactions for commands, answers to a question, and permission requests. A turn that ends without text keeps ⚡.

## Impact

- **Existing surface audit.** `src/connectors/telegram.ts` (`react`, `settle`, `acknowledge`, `reply`, `handle`), `src/connectors/telegram-reactions.ts` (stages, defaults, parsing).
