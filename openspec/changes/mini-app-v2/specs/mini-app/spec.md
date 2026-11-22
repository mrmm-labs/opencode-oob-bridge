## MODIFIED Requirements

### Requirement: The app stays live and says when it is not

The app SHALL follow changes over the event stream, read with a reader that needs no async iteration, cancel every attempt it ends, reconnect with the last event id, back off from the first failure, and show the time of the last update. It SHALL call the stream live when the first bytes arrive, not when the headers do. While disconnected it SHALL show a banner and disable the session actions. Approvals and enrolment need no stream and SHALL stay available.

#### Scenario: Stream drops

- **WHEN** the connection is lost
- **THEN** a banner shows and session actions are disabled until it is back

#### Scenario: A WebView without async iteration

- **WHEN** the response body has `getReader` and no async iterator
- **THEN** the stream is live and delivers events

#### Scenario: A failed attempt

- **WHEN** an attempt ends with an error
- **THEN** its request is cancelled, and the next attempt waits at least one second

### Requirement: The app loads nothing from other origins

The app SHALL be served by the bridge, SHALL read its launch parameters from the URL hash, SHALL load no style or font from another origin, and SHALL load one script from another origin: Telegram's own, `https://telegram.org/js/telegram-web-app.js`. It SHALL be served with a content security policy that allows scripts from itself and that origin only, and framing only by Telegram's clients.

#### Scenario: Headers

- **WHEN** `/app/` is requested
- **THEN** the policy allows scripts from itself and `https://telegram.org` and from no other origin

#### Scenario: The script is blocked

- **WHEN** Telegram's script does not load
- **THEN** the app still opens, and Face ID falls back to the page's own event bridge

## ADDED Requirements

### Requirement: Face ID goes through Telegram's biometric manager

The app SHALL use `Telegram.WebApp.BiometricManager` for the Face ID information, access, authentication and token calls when the script is present, and SHALL answer "not available" only when the manager says so or does not answer within a limit. The fallback bridge SHALL define `Telegram.WebView.receiveEvent`, `TelegramGameProxy.receiveEvent` and `TelegramGameProxy_receiveEvent`.

#### Scenario: A phone with Face ID

- **WHEN** the manager reports biometrics available
- **THEN** the enrolment asks for access and goes on

#### Scenario: A client that answers by the game proxy

- **WHEN** a reply arrives on `TelegramGameProxy.receiveEvent`
- **THEN** the fallback bridge reads it

### Requirement: The app reports what it cannot do to the bridge

The app SHALL send short diagnostic lines to `POST /v1/log` for the stream and for biometrics, and SHALL NOT send init data, a token or a message. The bridge SHALL log each as `app_<event>`, accept at most 30 a minute, and drop a value that looks like init data.

#### Scenario: Stream failure

- **WHEN** an attempt of the stream fails
- **THEN** the bridge log gets an `app_stream_error` line with the error name

#### Scenario: Over the limit

- **WHEN** 31 lines arrive in a minute
- **THEN** the 31st is refused with 429

### Requirement: The app says why it was refused

The app SHALL show a sentence for each reason the bridge gives for a refusal: no operator configured, no bot token, missing or malformed credential, bad signature, too old, not the operator.

#### Scenario: No operator

- **WHEN** the bridge answers 401 with `no_operator`
- **THEN** the app says the bridge has no operator configured, not that the view expired
