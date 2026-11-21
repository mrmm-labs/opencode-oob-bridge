# diff-images Specification

## Purpose

Diff images lets the operator read what a session changed on a phone: highlighted, bounded images drawn by the bridge, with the patch as the lossless fallback and secret files never drawn.

## Requirements

### Requirement: Diff sends images and the patch

The Diff action SHALL send up to three images of the session's diff as one album, and the patch as a document. The images SHALL be drawn by the bridge without a new runtime dependency.

#### Scenario: Small diff

- **WHEN** the diff has 30 changed lines
- **THEN** one image and the patch document are sent

#### Scenario: Drawing fails

- **WHEN** the renderer throws
- **THEN** the patch document and a file list are sent and the failure is logged

### Requirement: The image is readable on a phone

An image SHALL be 900 pixels wide with 56 columns, and a line longer than 56 columns SHALL wrap with a marker and SHALL NOT be cut. Added lines SHALL be on green and removed lines on red, with a line-number gutter and distinct hunk and file headers, and every text and background colour pair SHALL have a contrast ratio of at least 4.5:1.

#### Scenario: Long line

- **WHEN** a changed line is 130 characters long
- **THEN** it is drawn over three rows with a wrap marker

#### Scenario: Contrast

- **WHEN** the colour pairs are checked
- **THEN** every pair has a ratio of at least 4.5

### Requirement: Image count and size are bounded

An image SHALL hold at most 70 lines and a Diff SHALL send at most three images. Content beyond that SHALL be only in the patch and the caption SHALL say so. The patch SHALL be at most 20 MB, and a longer one SHALL be cut with a note.

#### Scenario: Large diff

- **WHEN** the diff has 500 changed lines
- **THEN** three images are sent, the caption says the rest is in the patch, and the patch has all lines

### Requirement: Secret files and shapes are not drawn

Files matching `diff.exclude` (default `**/.env*`, `**/*.pem`, `**/*secret*`, `**/id_*`) SHALL appear by name with "content hidden" and SHALL be left out of the patch. Known secret shapes in other lines SHALL be masked in the images and the patch. A binary file SHALL appear as "binary, not shown".

#### Scenario: Env file in the diff

- **WHEN** the diff touches `.env.local`
- **THEN** the image names it as hidden and the patch has no lines of it

#### Scenario: Token in a line

- **WHEN** a changed line holds a token shape
- **THEN** it is masked in the image and in the patch

### Requirement: Characters outside the font are shown as a placeholder

A character outside ASCII and Latin-1 SHALL be drawn as a placeholder in the image, and the patch SHALL hold the original text.

#### Scenario: Emoji in a line

- **WHEN** a changed line holds an emoji
- **THEN** the image shows a placeholder and the patch shows the emoji

### Requirement: Policy applies

A session that matches `chat.deny` SHALL get no diff, and `redact` SHALL apply to file names.

#### Scenario: Denied directory

- **WHEN** Diff is requested for a denied session
- **THEN** it is refused with the rule's reason
