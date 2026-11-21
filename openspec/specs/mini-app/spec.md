# mini-app Specification

## Purpose
TBD - created by archiving change mini-app. Update Purpose after archive.

## Requirements

### Requirement: The Mini App is for the operator only

The app SHALL work only for the Telegram user id stored at pairing. Another user SHALL see a refusal and the bridge SHALL answer 403 to any API call carrying their init data.

#### Scenario: Another user opens the app

- **WHEN** a user who is not the operator opens the app
- **THEN** the app shows it is not authorised and no session data is loaded

### Requirement: The app opens from the places the operator uses

In a private chat the bot SHALL offer the app through the menu button and a web_app button. In a group topic it SHALL offer a button that opens a `t.me` direct link with the session id as the start parameter, because web_app buttons work only in private chats. A start parameter that names a session SHALL open that session's detail.

#### Scenario: Group topic

- **WHEN** the person taps Open in a topic
- **THEN** the app opens on that session's detail

#### Scenario: Private chat

- **WHEN** the person taps the menu button
- **THEN** the app opens on the sessions list

### Requirement: The app shows sessions and a session's detail

The app SHALL list the sessions with state, watch mode and open prompts, and SHALL show a session's conversation tail, todos, changed files, pending questions and pending permissions, from the core API. A field the API reports as unavailable SHALL be shown as unavailable with its reason.

#### Scenario: Session with a question

- **WHEN** a session has an open question
- **THEN** the list marks it and the detail shows the question

### Requirement: The app takes the same actions with the same refusals

The app SHALL offer the core actions (answer, resume, stop, undo, compact, model, agent, new session) and SHALL show the core's refusal text when an action is refused. Stop, undo and resume SHALL ask for confirmation. Permission buttons SHALL follow `permissions.remote` and the approval levels.

#### Scenario: Stop

- **WHEN** the person taps Stop
- **THEN** a confirmation is shown and the turn is interrupted only after it

#### Scenario: Permission with the policy off

- **WHEN** `permissions.remote` is off
- **THEN** the app shows a permission without answer buttons

### Requirement: Forms behave as in the chat

A form SHALL be answered with the same stepper and review rules as in the chat, and a form that cannot be sent without a TUI SHALL be shown without buttons.

#### Scenario: Three-field form

- **WHEN** the person answers a three-field form
- **THEN** one reply is made after the review step

### Requirement: The app stays live and says when it is not

The app SHALL follow changes over the event stream, reconnect with the last event id, and show the time of the last update. While disconnected it SHALL show a banner and disable every action.

#### Scenario: Stream drops

- **WHEN** the connection is lost
- **THEN** a banner shows and actions are disabled until it is back

### Requirement: The app can show and end the overnight plan and show the digest

The app SHALL show the overnight plan and the digest, and SHALL be able to end a plan. It SHALL NOT start or extend a plan.

#### Scenario: End the plan

- **WHEN** the person ends the plan in the app
- **THEN** the automation stops at once

### Requirement: The app loads nothing from other origins

The app SHALL be served by the bridge, SHALL read its launch parameters from the URL hash, SHALL load no script, style or font from another origin, and SHALL be served with a content security policy that allows framing only by Telegram's clients.

#### Scenario: Headers

- **WHEN** `/app/` is requested
- **THEN** the response carries a content security policy with no external script source

### Requirement: The app is usable on a phone

Tap targets SHALL be at least 44 by 44 pixels, colours SHALL follow Telegram's theme with a contrast ratio of at least 4.5:1, and text SHALL not be smaller than 14 pixels.

#### Scenario: Dark theme

- **WHEN** Telegram uses its dark theme
- **THEN** the app uses the theme colours and keeps the contrast ratio

### Requirement: The app reads what it needs from the core API

The bridge SHALL give the app, over `/v1` with init data, `GET /v1/options` (models with variants, agents, and the names of the configured projects with their default agent and model, never a folder), `POST /v1/overnight/end`, and `GET /v1/digest` (the digest text, without marking the period as covered). The status SHALL report the overnight plan. A session detail SHALL say whether its questions can be answered now.

#### Scenario: Options

- **WHEN** the app asks for `/v1/options`
- **THEN** it receives model, agent and project names and no directory

#### Scenario: Digest preview

- **WHEN** the app reads the digest
- **THEN** the next digest in the chat still covers the same period

### Requirement: The app files are served without credentials

The bridge SHALL serve `/app/` and `GET /healthz` without credentials, and SHALL serve nothing else outside `/v1`.

#### Scenario: Unauthenticated static files

- **WHEN** `/app/` is requested without credentials
- **THEN** the page is served, and `/v1/sessions` answers 401

### Requirement: A form answer is sent as one value per field

The answer action SHALL accept `answers`, one value per field key, and SHALL apply it only when every field is answered, a single-select field has one value, and each value is an option or, where the field allows typing, non-empty text. It SHALL NOT read option numbers or separators out of it.

#### Scenario: Typed number

- **WHEN** the app sends `answers` with the text `3` for a field that allows typing
- **THEN** the answer is the text 3 and not the third option

#### Scenario: Option with a comma

- **WHEN** a multi-select option reads "Yes, do it" and is chosen
- **THEN** it is sent as that one value

#### Scenario: Incomplete or unknown

- **WHEN** a field is missing, or a value is neither an option nor allowed text
- **THEN** nothing is sent to the host and the refusal says it could not read the answer
