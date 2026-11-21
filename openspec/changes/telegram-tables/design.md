## Decisions

- **Block level.** Tables are cut out of text runs in `blocks()`, so the splitter and the streaming render see them as one unit.
- **Pipes.** A pipe inside a code span or after a backslash belongs to the cell. A row with fewer cells is padded, one with more is cut at the header's count.
- **Streaming.** A header and separator already make a table, so a half-written table renders as a grid of what has arrived; a row still open is padded.
- **Width.** Measured on the cells with markdown removed, columns plus two spaces between them.
- **Known limit.** A single row whose block alone exceeds 4096 characters is not cut.
