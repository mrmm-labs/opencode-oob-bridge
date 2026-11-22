# Telegram Mini App

The static page the bridge serves under `/app/`. No build step: plain ES modules and one stylesheet. No dependency. One script from another origin: Telegram's own `telegram-web-app.js`, for Face ID; the page works without it.

```
index.html   the shell
app.css      layout; colours come from Telegram's theme (CSS variables)
app.js       start: launch parameters, theme, controller, redraw
tg.js        init data and theme from the URL hash; the two events sent to Telegram
api.js       the core API over fetch; the event stream with reconnect and a silence watchdog
controller.js  state and actions (no DOM); every confirmation and gate lives here
form.js      a form answered one field at a time, with a review step
views.js     drawing; every string from the API is set as text, never as markup
format.js    small pure helpers
*.test.js    tests (node:test), run by `pnpm test`
```

## Register the app with BotFather

1. In a chat with @BotFather send `/newapp` and pick your bot.
2. Give it a title and a description, skip the photo and the GIF.
3. When asked for the Web App URL, send the public `https` address of `/app/`, for example `https://app.example.com/app/`.
4. Give it a short name. BotFather answers with the direct link, `https://t.me/<bot>/<short name>`.
5. Put both in the bridge config:

```jsonc
{
  "miniApp": {
    "url": "https://app.example.com/app/",
    "link": "https://t.me/<bot>/<short name>",
  },
}
```

6. Restart OpenCode (`/oob restart`). In a private chat with the bot the menu button now opens the app, and permission and question messages carry a 📱 Open button. In a group topic the button is a direct link (inline `web_app` buttons work only in private chats); it opens the session of that topic.

The menu button is set per private chat by the Bot API, so a group needs the link buttons. `/setmenubutton` in BotFather is not needed.

## What the hosting must provide

The page and the API are the bridge's. Whatever sits in front of it (a relay with a public hostname, or a reverse proxy) must:

- pass only `/app/` and `/v1/` (and `GET /healthz`); answer `404` to everything else;
- serve `https` only, and not buffer `GET /v1/events`: the bridge sends a comment line at least every 25 seconds, so allow an idle timeout of 120 seconds or more;
- keep the `Authorization` header and the query string out of its logs;
- hold neither the bot token nor the core bearer token: the page's only credential is the init data, and the bridge decides;
- optionally refuse early what is not well-formed fresh init data of the operator on `/v1/`; the hash can only be checked where the bot token is, which is the bridge;
- reach the bridge over the relay link: the bridge dials out to the relay over the tailnet (`link.url`), so the bridge opens no port for the internet;

Checks to run against the public hostname once it is set up: a request to `/v1/sessions` without credentials is `401`; with the bearer token it is `401`; with init data of another user it is `403`; with init data older than the limit it is `401`; `/admin` is `404`; `/app/` answers with a `content-security-policy` that has no external script source; the event stream is still open after five quiet minutes.

## Tests

`pnpm test` runs the client tests here and the bridge tests (`src/core/miniapp*.test.ts`), including an end-to-end test of the page logic against a fake relay and the real core API.
