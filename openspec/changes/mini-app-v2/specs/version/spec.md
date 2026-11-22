## MODIFIED Requirements

### Requirement: One command shows what is installed and what runs

`/oob version` SHALL show the installed version, `git describe` of the install directory when it is a checkout of its own, the version the server half runs, the version of the TUI half, the server pid and start time, the owner instance id, the config file in use and the core API version. `/version` in Telegram SHALL show the version the server runs, the installed version with its `git describe`, the versions the attached TUIs reported, how long the server has been up and the warnings, and SHALL NOT show a path, a pid, an instance id or an address.

#### Scenario: In the TUI

- **WHEN** the operator runs `/oob version`
- **THEN** a dialog lists every field above

#### Scenario: In Telegram

- **WHEN** the operator sends `/version`
- **THEN** the bot answers with the running and installed versions, the TUI versions and the uptime, and nothing that names a path, a pid or an address
