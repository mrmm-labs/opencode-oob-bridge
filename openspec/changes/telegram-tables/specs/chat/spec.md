## ADDED Requirements

### Requirement: Tables in a reply are readable on a phone

The bridge SHALL recognise a GFM table in a reply. A table whose columns fit in about 40 monospace characters SHALL be shown as preformatted text with aligned columns and without inline markdown. A wider table SHALL be shown as one block per row, the first column in bold and then one `header: value` line for each other column, with inline markdown kept. A table too long for one message SHALL be split between rows, each message with its header row.

#### Scenario: Narrow

- **WHEN** a reply holds a table of two short columns
- **THEN** it is posted as an aligned preformatted grid

#### Scenario: Wide

- **WHEN** a reply holds a table with long cells
- **THEN** each row is a block with the first column bold and a line per other column

#### Scenario: Pipe in code

- **WHEN** a cell holds a pipe inside a code span
- **THEN** the pipe stays in that cell

#### Scenario: Long table

- **WHEN** a table exceeds one message
- **THEN** it is split between rows and every message stays within the limit
