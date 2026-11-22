## Context

On a real iPhone the stream failed while the same requests through the relay worked, and Face ID reported "not available". A live check through the public hostname with signed init data showed the path from the phone's side to the bridge is healthy: headers at once, the first comment at once, events as they happen, a keep-alive every 25 seconds. So the fault is in the page.

## Decisions

### D1. The stream is read with a reader and every attempt is cancelled

`for await (const chunk of response.body)` needs async iteration on `ReadableStream`, which older iOS WebViews lack: it throws after the page has called the stream live. The attempt is then retried after one second (the back-off reset on "open"), and the abandoned request stays open until the WebView drops it, so requests pile up against the relay's in-flight limit. The page now reads with `body.getReader()`, cancels the request on every exit, calls the stream live on the first bytes (the bridge writes a comment at once), and resets the back-off only then.

### D2. Face ID goes through Telegram's biometric manager

The hand-rolled bridge listened on `Telegram.WebView.receiveEvent` only. The native clients also call `TelegramGameProxy.receiveEvent`, so a reply could be lost and the 3 second wait ended as "not available". The page loads `https://telegram.org/js/telegram-web-app.js`, the script every Mini App uses, and calls `Telegram.WebApp.BiometricManager`. The policy allows that one origin in `script-src`; the relay forwards the bridge's policy and adds none of its own to `/app/`. Without the script (blocked, offline) the hand-rolled bridge runs, now with all three receive hooks.

The cost is one third-party script on a page that holds init data. It is Telegram's own, from the origin that issues the init data, and no other origin is allowed.

### D3. The page reports to the bridge

`POST /v1/log` takes `{ event, data }`, logs `app_<event>` with at most twelve short fields, and answers 429 past 30 a minute. Keys and the event are `[a-z0-9_]`; a value that looks like init data is dropped; the logger filters secrets as for every line.

### D4. A refusal names its reason

401 and 403 on the link carry `{ "error": "<reason>" }`. The reasons say what the sender already knows (it sent the credential) or what the operator must fix (`no_operator`, `no_bot_token`). A refusal the bridge's own set-up causes does not count towards the failed-attempt block, so a missing operator cannot lock the operator out.

### D5. The operator id may come from the file

`channels.telegram.operator` is read when pairing stored no id. The stored id wins. A bridge paired to a group sets the menu button in the operator's own chat, once.
