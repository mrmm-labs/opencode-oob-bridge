## Decisions

- **One line per message, no rate limit.** A person writing in General several times is told each time. Commands (`/status`, `/trace`) are not affected: they are handled before routing.
- **Same helper for text and media.** Both paths ended in the same silent branch.
- **Reaction stays.** 🙈 is still set; the line says what to do.

## What a client may rely on

- The line never holds message text.
