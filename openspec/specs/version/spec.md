# version Specification

## Purpose

Tell the operator which plugin version is loaded: what is installed on disk, what the server half and each TUI half run, and a warning when they differ, so a half-upgraded install is seen at once.

## Requirements

### Requirement: The running version is the one in memory

Each half SHALL read its own version once, when its code is loaded, and SHALL report that value as the version it runs. It SHALL NOT read it from disk again, so an upgrade on disk does not change what a running half reports. The installed version SHALL be read from the disk when asked.

#### Scenario: Upgrade on disk

- **WHEN** `package.json` changes after the plugin was loaded
- **THEN** the installed version changes and the running version does not

### Requirement: One command shows what is installed and what runs

`/oob version` and `/version` SHALL show the installed version, `git describe` of the install directory when it is a checkout of its own, the version the server half runs, the version of the TUI half (the asking TUI, or each attached TUI in a chat), the server pid and start time, the owner instance id, the config file in use and the core API version.

#### Scenario: In the TUI

- **WHEN** the operator runs `/oob version`
- **THEN** a dialog lists every field above

#### Scenario: In Telegram

- **WHEN** the operator sends `/version`
- **THEN** the bot answers with the same fields, with the versions the attached TUIs reported

### Requirement: A difference is a warning

Where two of the installed, server and TUI versions differ, the report SHALL print a line starting with `⚠` that names the part that runs another version and says to restart OpenCode. With no readable installed version, the running parts SHALL be compared with each other. When all agree it SHALL say so.

#### Scenario: Server older than the disk

- **WHEN** 0.23.0 is installed and the server runs 0.22.0
- **THEN** the report holds "the server runs 0.22.0 but 0.23.0 is installed: restart OpenCode"

#### Scenario: TUI older than the disk

- **WHEN** a TUI runs 0.22.0 and the server runs 0.23.0, installed 0.23.0
- **THEN** the report warns about the TUI only

### Requirement: The sidebar repeats the warning

When any two versions differ, the sidebar SHALL show the first warning under its header in full mode and a leading warning in compact mode.

#### Scenario: Mismatch

- **WHEN** the server runs a version other than the installed one
- **THEN** the full sidebar shows the warning under its header

### Requirement: The owner has an instance id

The owner lock SHALL record an id for its holder, and a loader that finds the lock held SHALL learn it. A lock written without an id SHALL still be read.

#### Scenario: Second loader

- **WHEN** a second loader finds the lock held
- **THEN** it is told the owner's pid and id
