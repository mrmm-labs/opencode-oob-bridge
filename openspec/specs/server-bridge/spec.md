# server-bridge Specification

## Purpose

The bridge runs once, in the OpenCode server, so one process owns the Telegram and ntfy connections. The server half holds the channels, the pending store and the rules, and every TUI reaches it through one RPC.

## Requirements

### Requirement: Every plugin instance answers the RPC through the one bridge

OpenCode sets a server plugin up once per location, in one process, and keeps its RPC registry per location. Every instance SHALL register the RPC and answer through the process's single bridge. The first instance SHALL boot the bridge; when it is disposed, the bridge SHALL stop and the next instance SHALL start it again.

#### Scenario: Two locations

- **WHEN** the plugin is set up for two locations of one server
- **THEN** both answer the status call and only one connector poller runs

#### Scenario: Owner location closes

- **WHEN** the instance that started the bridge is disposed
- **THEN** another instance starts the bridge and keeps answering

### Requirement: One process runs the bridge

The server half SHALL take `owner.lock` in the state directory, refreshed every 10 seconds and stale after 30 seconds or when its pid is gone. A second process SHALL log `server_standby` once per foreign owner and run no bridge, so exactly one `getUpdates` consumer exists. Its instances SHALL answer the RPC with an error naming the owner's pid, and SHALL take over within 15 seconds when the owner dies.

#### Scenario: Two server processes

- **WHEN** a second OpenCode server process loads the plugin
- **THEN** it logs one `server_standby` and its RPC answers name the first process

### Requirement: RPC answers and events hold JSON values only

Every RPC answer and every event the server emits SHALL hold JSON values only: an object key holding `undefined` is refused by the host as `rpc.invalid_output`. A handler that throws SHALL be logged as `rpc_error` with its method.

#### Scenario: Connector not yet connected

- **WHEN** a connector reports `connected: undefined` and the TUI asks for status
- **THEN** the answer is delivered and the key is absent

### Requirement: A restart restarts the bridge, not the server

`/oob restart` SHALL restart the bridge in the server so channels reconnect, and the RPC SHALL stay registered meanwhile.

#### Scenario: Restart while a TUI polls

- **WHEN** `/oob restart` runs
- **THEN** the status call keeps answering

### Requirement: Question forms are answered through an attached TUI

The server plugin API has no form-reply call; only a TUI has one. A form answered from a chat SHALL be relayed to an attached TUI, which makes the reply and reports it done. With no TUI attached the answer SHALL be refused and the chat SHALL say to answer at the Mac.

#### Scenario: No TUI attached

- **WHEN** a question form is answered from Telegram and no TUI is attached
- **THEN** the answer is refused and the chat says to answer at the Mac

#### Scenario: Several windows

- **WHEN** the server emits the same form reply through several locations
- **THEN** one window acts on it once

### Requirement: The core API listener follows the single owner

Only the instance that runs the bridge SHALL listen for the core API. When the bridge restarts the listener SHALL restart with it, and when the owner changes the new owner SHALL take over the listener. A second process SHALL NOT bind it.

#### Scenario: Bridge restart

- **WHEN** `/oob restart` runs
- **THEN** the API listener closes and opens again on the same address

#### Scenario: Second process

- **WHEN** another OpenCode server process holds the owner lock
- **THEN** this process does not bind the core API address
