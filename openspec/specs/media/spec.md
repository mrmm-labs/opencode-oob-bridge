# media Specification

## Purpose

A photo or file sent in a chat-enabled topic reaches the session as an inline attachment, with checks that keep a renamed or oversized file out.

## Requirements

### Requirement: Photos and documents become attachments

A photo or document sent in a chat-enabled topic SHALL be downloaded and sent to the session as an inline file. The caption SHALL be the prompt, or `Attached: <name>` when there is none. Photos SHALL use the largest size Telegram has, and the same reaction SHALL acknowledge it. Chat SHALL have to be on for the session, as for text.

#### Scenario: Photo with caption

- **WHEN** a photo with the caption "what is wrong here" is sent in the topic
- **THEN** the session gets that text and the image as one prompt

#### Scenario: Document without caption

- **WHEN** a file `notes.md` is sent without a caption
- **THEN** the prompt text is `Attached: notes.md`

### Requirement: Type and size are checked

By default JPEG, PNG, GIF, WebP, PDF, and plain text, Markdown, CSV and JSON SHALL be accepted, up to 10 MB. `media.maxBytes` SHALL be at most 20 MB, which is all the Bot API serves, and `media.mimes` SHALL list types, with `image/*` taking a family. The type SHALL be checked against the first bytes, so a renamed file is refused. A refusal SHALL say why.

#### Scenario: Renamed executable

- **WHEN** an executable renamed `photo.png` is sent
- **THEN** it is refused with a reason and nothing is sent to the session

#### Scenario: Too large

- **WHEN** a file larger than `media.maxBytes` is sent
- **THEN** it is refused with the limit in the reply

### Requirement: Voice, video, audio and animations are not supported

Voice, video, audio and animations SHALL be answered with "not supported".

#### Scenario: Voice note

- **WHEN** a voice note is sent in a chat-enabled topic
- **THEN** the bot answers that it is not supported and sends nothing to the session
