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

### Requirement: A session is named by its title, then its project, then a short id

The app SHALL name a session by its title; when it has none, by its project; then by the last part of its directory; and at last by a short form of its id. The API SHALL fill a missing title from what the host knows of the session, and SHALL give only the last part of the directory (`folder`), never the path.

#### Scenario: Title from the host

- **WHEN** the bridge has no title for a session and the host knows one
- **THEN** the list shows the host's title

#### Scenario: Only a short id is known

- **WHEN** a session has no title, no project and no directory
- **THEN** its row shows `#` and the last six characters of its id

#### Scenario: No path on the phone

- **WHEN** a session's directory is `/work/private/shop`
- **THEN** the API gives the folder `shop` and nothing of the rest

### Requirement: The list groups sessions the way Telegram's own lists look

The home screen SHALL show the app name with a one-line description, a search field, a row to start a new session, and the sessions in sections (waiting on you, working, idle), each in one rounded card. Typing in the search field SHALL hide the rows that do not match every word.

#### Scenario: Sections

- **WHEN** one session has a question, one is working and one is idle
- **THEN** each is in its own section, in that order, and an empty section is not shown

#### Scenario: A row

- **WHEN** a session is listed
- **THEN** its row shows a coloured circle with its letter and a status dot, its name, project, agent and model, its age, a badge with the number waiting on the person, and a chevron

#### Scenario: Loading

- **WHEN** the list has not been read yet
- **THEN** placeholder rows are shown

#### Scenario: Search

- **WHEN** the person types "api"
- **THEN** only the sessions with "api" in their name, project, folder, agent, model or id stay

### Requirement: The app uses Telegram's own controls where the client has them

The app SHALL use Telegram's back button for every screen but the list, the settings button for Info, Telegram's confirm popup for stop, undo and resume, haptic feedback for taps, and the secondary background colour for the bar and the page. It SHALL turn off the swipe that closes the app, because the lists scroll. On a client that lacks a control it SHALL draw its own, and it SHALL read each colour from the theme Telegram gives it.

#### Scenario: Back

- **WHEN** a session is open on a client with the back button
- **THEN** the button is shown, and pressing it returns to the list

#### Scenario: Confirm

- **WHEN** the person taps Stop on a client with the popup
- **THEN** Telegram's popup asks, and the app's own sheet is not drawn

#### Scenario: An old client

- **WHEN** the client is older than a control needs
- **THEN** the page draws its own back link and confirm sheet

### Requirement: A session opens as a conversation

The session screen SHALL start with the session's name, model and state, then the question or permission it waits on, then the conversation as chat bubbles, then changes and todos, and a message bar that stays at the bottom. A message SHALL show its markdown, built as elements so no text is read as markup.

#### Scenario: A question waits

- **WHEN** a session has a pending question
- **THEN** its card is above the conversation

#### Scenario: Controls

- **WHEN** the session screen is open
- **THEN** watch and chat are controls inside it, changes are behind one row, and a steer toggle sits by the send button while a turn runs

#### Scenario: Markdown

- **WHEN** a message holds a table and a code block
- **THEN** both are drawn, and an HTML tag in the text shows as text

#### Scenario: Steering

- **WHEN** a turn is running and the person turns Steer on and sends
- **THEN** the message is injected into the turn instead of queued

### Requirement: The app is readable on a small phone

Text SHALL be at least 17 px in the body, taps SHALL have at least 44 px, content SHALL keep a 16 px inset and the safe area, and nothing SHALL scroll sideways at 320 px wide. The app SHALL show a slim bar, not a banner, when it is offline, with the time of the last update.

#### Scenario: 320 px

- **WHEN** the app is shown 320 px wide
- **THEN** no screen is wider than the screen
