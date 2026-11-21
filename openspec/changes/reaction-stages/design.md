## Context

Telegram lets a bot keep one reaction per message and use a fixed set of emoji. Setting a new one replaces the old, so a stage is one call.

## Decisions

- **One serial queue per connector** spaces every `setMessageReaction` call by 400 ms and skips a call that would set the emoji the message wears. The cache holds 500 messages.
- **Only the delivery acknowledgement is awaited.** The 👀, 🙈, 🤷, 💔 and 👌 calls are not waited for. The ⚡ or ✍ call is: if Telegram refuses it, the old "→ sent to" line still says where the message went.
- **👌 follows the reply.** When a message is delivered, its id is kept under the session. The connector's `reply` posts the session's final text and then marks every kept message 👌. Up to 20 ids per session and 20 sessions are kept.
- **Agent emoji become an override.** The default for a sent message is ⚡. `reactions.agents` replaces it for the agents it names.
- **Only plain prompts get 👀.** A reply that answers a question, a command and a pairing code do not.

## What a client may rely on

- A prompt's message wears the emoji of its latest stage; a failed reaction never changes what is sent to the session.

Left to Telegram: the rate at which it accepts reaction changes.
