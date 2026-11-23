## ADDED Requirements

### Requirement: The relay accepts named channels on /link/<name>

For each channel the operator configures, the relay SHALL accept a WebSocket upgrade on `/link/<name>` with the same HMAC scheme as `/link`. A channel name SHALL match `^[a-z][a-z0-9-]{0,23}$` and SHALL NOT be `chat`. A path with a name that is invalid, reserved or not configured SHALL get 404 with no upgrade. `/link` SHALL behave as before.

#### Scenario: A configured channel

- **WHEN** the channel `gw` is configured and a client upgrades on `/link/gw` with a valid proof for that path
- **THEN** the relay accepts the connection

#### Scenario: Reserved or malformed name

- **WHEN** a client upgrades on `/link/chat`, `/link/Bad_Name` or a name of 25 characters
- **THEN** the relay answers 404 and makes no connection

#### Scenario: An old relay

- **WHEN** a relay without channels receives an upgrade on `/link/gw`
- **THEN** it answers 404 and the chat bridge on `/link` stays connected

### Requirement: A channel never evicts the chat bridge

The relay SHALL keep one connection per channel and one for the chat bridge. A new connection on a channel SHALL close the previous one on the same channel with code 4000. A connection on a channel SHALL NOT close, replace or fail the requests of the chat bridge, and the other way round.

#### Scenario: A channel connects while the bridge is up

- **WHEN** the chat bridge is connected and a client connects on `/link/gw`
- **THEN** the bridge stays connected and a heartbeat on `/link` is still acknowledged

#### Scenario: Same channel twice

- **WHEN** a second client connects on `/link/gw` while a first one is connected
- **THEN** the first is closed with code 4000 and the second stays

### Requirement: The proof and every frame are bound to the channel

The upgrade proof SHALL be signed for the path it is sent to, and a proof signed for another path SHALL be refused with 401. Every frame on a channel SHALL carry `ch` equal to the channel of its socket in its signed body, and a frame without it or with another name SHALL be refused and dropped.

#### Scenario: Proof for another path

- **WHEN** a client sends a proof signed for `/link` to `/link/gw`, or one signed for `/link/gw` to `/link`
- **THEN** the relay answers 401

#### Scenario: Wrong label

- **WHEN** a client on `/link/gw` sends a frame whose `ch` is missing or is `other`
- **THEN** the relay drops it, counts it as refused and does not pass it on

### Requirement: Each channel has its own secret

The relay SHALL read a secret, and optionally a key, for each channel from its configuration. The bridge secret SHALL NOT open a named channel, a channel secret SHALL NOT open `/link` or another channel, and the key of `/link` SHALL NOT apply to a channel. The relay SHALL refuse to start with a channel secret under 32 characters, a channel secret equal to the bridge secret or to another channel's, or an invalid or reserved name.

#### Scenario: Bridge secret on a channel

- **WHEN** a client upgrades on `/link/gw` with a proof made with the bridge secret
- **THEN** the relay answers 401

#### Scenario: Channel key

- **WHEN** a channel has a key and an upgrade on it carries none or the key of `/link`
- **THEN** the relay answers 401 before the HMAC is looked at

#### Scenario: Reused secret

- **WHEN** two channels, or a channel and the bridge, are given the same secret
- **THEN** the relay refuses to start and names the variables

### Requirement: Nonces are shared across channels

The relay SHALL keep one nonce cache for the bridge and all channels, so that a frame or proof accepted once SHALL be refused as a replay on any other socket.

#### Scenario: Replay into another channel

- **WHEN** a frame accepted on `/link/gw` is sent again on `/link/other`
- **THEN** it is refused

### Requirement: Channel frames go only to the channel consumer

The relay SHALL pass a verified channel frame only to the consumer registered for channels, with its channel name, and SHALL NOT pass it to the chat bridge handlers, to the phone or to an HTTP route. With no consumer the frame SHALL be refused with reason `unrouted`. The relay SHALL send to a channel only frames sealed with the channel's secret and carrying its name.

#### Scenario: No consumer

- **WHEN** a verified frame arrives on a channel and no consumer is registered
- **THEN** the relay counts it as refused and does nothing else

#### Scenario: Send to a channel

- **WHEN** the consumer sends a frame to `gw`
- **THEN** only the client on `/link/gw` receives it, sealed with the `gw` secret and labelled `gw`

### Requirement: A slow channel is closed

When the send buffer of a channel socket is above `channelBufferBytes` (1 MiB by default) the relay SHALL close the channel with code 1013 and the reason `slow consumer`, count it as refused with reason `backpressure` and report the frame as not sent. Other sockets SHALL NOT be affected.

#### Scenario: A client that does not read

- **WHEN** a channel client stops reading and its send buffer passes the limit
- **THEN** the relay closes that channel with 1013 and the bridge stays connected

### Requirement: Shutdown closes every socket

`Link.close()` SHALL close the bridge's socket and every channel socket with code 1001 and fail the pending requests.

#### Scenario: Stop with a bridge and two channels

- **WHEN** the relay stops while the bridge and two channels are connected
- **THEN** all three clients see close code 1001

### Requirement: The client stops when it is replaced

`LinkClient` SHALL NOT reconnect after the relay closes it with code 4000. It SHALL report the state `down` with the reason `replaced by another client` and log it. It SHALL keep the backoff for every other close and error. It SHALL sign the upgrade for the path of its URL.

#### Scenario: Closed with 4000

- **WHEN** the relay closes the connection with code 4000
- **THEN** no reconnect is scheduled and the status names the reason

#### Scenario: Closed with another code

- **WHEN** the relay closes the connection with 1001 or the network drops
- **THEN** the client reconnects with backoff
