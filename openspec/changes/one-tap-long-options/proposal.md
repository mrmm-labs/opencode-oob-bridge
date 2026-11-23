## Why

Real one-question forms carry options of 40 to 45 characters, and a recommended one gets the 14-character "(Recommended)" suffix on top. The one-tap rule counted that suffix and capped a label at 24 characters, so these forms were all sent as "📱 Answer in app" although they are a plain choice between two or three options.

## What Changes

- **The length is measured without the "(Recommended)" suffix** and may be up to 48 characters. The field and option count rules stay: one field, single-select, two to four options. A multi-field form stays app-only.
- **One option per row, the recommended one marked ★.** The button is `<number> ★ <label>`. A label that does not fit is cut with "…"; the message above the buttons still lists every option in full.
- **The tap answers the full option**, suffix included, because the form accepts only its own options.
- A form that also allows typing still gets "📱 Answer in app" under the options.

## Capabilities

### Modified Capabilities

- `forms`: the one-tap rule and how its buttons read.

## Impact

`src/classify.ts`, `src/connectors/telegram.ts` (`keyboard`), `src/connectors/telegram-render.ts` (`starred`), README.
