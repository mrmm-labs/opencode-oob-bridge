## ADDED Requirements

### Requirement: Tidy keeps a topic whose session is open in a TUI

`/topics` and the `topics` RPC op SHALL give the verdict `keep` to a topic whose session some TUI that is still reporting shows, in a dry run and on apply, whatever its age.

#### Scenario: Open and old

- **WHEN** a TUI shows a session idle for ten days and `/topics apply` is sent
- **THEN** its topic is listed as `keep` and is not closed
