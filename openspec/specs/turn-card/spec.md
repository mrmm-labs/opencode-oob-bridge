# turn-card Specification

## Purpose

The turn card tells the operator what a finished turn did without opening the Mac: a one-line result, a collapsed summary and file list, and buttons to look at the diff, carry on or stop.

## Requirements

### Requirement: A turn card is posted for a turn with changes or a long turn

When a turn of a mirrored top-level session ends and at least one file changed, or the turn ran at least `turnCard.minSeconds` (default 20), the bridge SHALL post one turn card in the session's topic. A turn of a subagent SHALL NOT get a card, and `turnCard: false` SHALL turn the cards off.

#### Scenario: Turn with changes

- **WHEN** a turn ends after changing three files
- **THEN** one card is posted

#### Scenario: Short turn with no changes

- **WHEN** a turn lasts five seconds and changes nothing
- **THEN** no card is posted

#### Scenario: Subagent turn

- **WHEN** a subagent's turn ends
- **THEN** no card is posted

### Requirement: The header shows the result at a glance

The card's first line SHALL show the result (done or failed), the number of files changed, the lines added and removed, and the duration. When the diff summary is unavailable the line SHALL leave the counts out and SHALL NOT show invented ones.

#### Scenario: Done

- **WHEN** a turn ends after 3 minutes 12 seconds with 14 files, 320 lines added and 41 removed
- **THEN** the first line reads `✅ Done · 14 files · +320 −41 · 3m12s`

#### Scenario: Summary unavailable

- **WHEN** the diff summary is unavailable
- **THEN** the first line shows the result and the duration only

### Requirement: The body is foldable

The summary (the last paragraph of the assistant's final text, at most 700 characters) and the file list (at most 15 files, then "+N more") SHALL be in a block that Telegram shows collapsed. A channel that cannot fold SHALL get the header and a summary of at most 300 characters and no file list. Secrets SHALL be masked and `redact` SHALL apply.

#### Scenario: Telegram

- **WHEN** a card is sent to Telegram
- **THEN** the summary and the files are inside an expandable quote

#### Scenario: Channel without folding

- **WHEN** a card goes to a channel without the foldable capability
- **THEN** it holds the header and a short summary and no file list

### Requirement: The card has Diff, Continue and Stop buttons

Diff SHALL send the session's patch as a document. Continue SHALL send `continue` as a prompt with the session's delivery mode, and SHALL be left out when chat is off for the session. Stop SHALL interrupt the running turn, or say that nothing is running.

#### Scenario: Diff

- **WHEN** the person taps Diff
- **THEN** a patch document is sent to the topic

#### Scenario: Continue with chat off

- **WHEN** chat is off for the session
- **THEN** the card has no Continue button

#### Scenario: Stop while idle

- **WHEN** the person taps Stop and no turn is running
- **THEN** the bot says nothing is running and interrupts nothing

### Requirement: Old cards cannot act on a newer turn

When a new card is posted, or one hour after a card was posted, the bridge SHALL remove the buttons of the earlier card.

#### Scenario: Second card

- **WHEN** a second card is posted in the same topic
- **THEN** the first card has no buttons
