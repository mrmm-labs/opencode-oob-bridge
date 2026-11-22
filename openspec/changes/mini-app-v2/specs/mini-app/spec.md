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

### Requirement: Every file of the app carries the build

The bridge SHALL give the app a build stamp made of its version and a hash of the app files, and SHALL put it in the URL of every file the page and its modules load (`?v=<stamp>`). The meta SHALL carry the stamp as `app`.

#### Scenario: The page

- **WHEN** `/app/` is requested, directly or through the relay link
- **THEN** its stylesheet and script URLs carry the stamp

#### Scenario: A module

- **WHEN** `app.js?v=<stamp>` is requested
- **THEN** each relative import in it carries the stamp

### Requirement: A stale copy of the app is not kept

The page SHALL be answered `Cache-Control: no-store`. A file asked for with the current stamp SHALL be answered `public, max-age=31536000, immutable`. A file asked for without the stamp, or with another one, SHALL be answered with the current content and `no-store`.

#### Scenario: The page

- **WHEN** `/app/` is requested
- **THEN** it is answered `no-store`

#### Scenario: A module without the stamp

- **WHEN** `app.js` or `app.js?v=old` is requested
- **THEN** it is answered `no-store`

#### Scenario: A module with the stamp

- **WHEN** `app.js?v=<current stamp>` is requested
- **THEN** it is answered `immutable`

### Requirement: The Info screen says which bridge version runs and for how long

The Info screen SHALL end with a line that names the bridge version the server runs, from the API's `version` field, how long the server has been up, from the start time in the status, and the build the page was loaded from. When the page's build is not the one the meta names, it SHALL say the page is an old copy and offer a reload. When the start time is not known it SHALL leave the uptime out, and when the version is not known it SHALL say so.

#### Scenario: Version, uptime and build

- **WHEN** the server runs 0.37.0 and started 90 minutes ago
- **THEN** the footer reads "opencode-oob-bridge 0.37.0 · up 1h 30m · page" followed by the build

#### Scenario: An old copy

- **WHEN** the page's build differs from the build in the meta
- **THEN** a card says the page is an old copy, with a Reload button, and the app reports it to the bridge log

### Requirement: Face ID says why it cannot be used

When Face ID cannot be used, the app SHALL say which of these it is: Telegram too old (below 7.2), no answer from Telegram in time, Face ID not available on the phone, Telegram refused the permission, or Telegram did not ask. It SHALL send the bridge a `biometric_unavailable` line with the reason and the manager's state (initialised, available, type, requested, granted, saved, whether it has a device id, the client version and platform), and SHALL NOT send a token or the device id.

#### Scenario: Telegram too old

- **WHEN** the manager does not answer and Telegram is version 7.0
- **THEN** the app says Telegram needs 7.2 or later, and logs `too_old`

#### Scenario: Permission refused

- **WHEN** access was requested and is not granted
- **THEN** the app says to allow Face ID for Telegram in iOS Settings and in the app's menu, and logs `refused`
