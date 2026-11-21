## Observed behaviour (task 1.1 and 1.2)

Checked against an isolated `opencode serve` v2.3.2 (own XDG directories, own port, no provider configured), driven by `pnpm test:real`.

- `POST /api/session/{id}/synthetic` with `resume: false` leaves the session suspended: the message appears in `GET /api/session/{id}/inbox` (type `synthetic`) and `GET /api/session/active` is empty. That is the stuck state the bridge looks for.
- The same call with `resume: true` answers 200, empties the inbox within about 250 ms and the session is listed as `running` in `/api/session/active`. This is what `host.resume` does.
- With no provider configured the woken session stays `running`; the check does not need a model.

Before the call: inbox 1, active {}. After: inbox 0, running. The bridge reported `working`.

## Decisions

- **Resume answers at once and the outcome follows.** The button toast cannot wait 30 seconds, so the immediate answer is "Waking it" and the alert is edited when the outcome is known. `working` (the host reports a running turn) wins over `drained` (the inbox emptied); neither within 30 seconds is `no_effect`.
- **Alert state is per session.** Control keeps, for each stuck session, the suspension it alerted for, the waiting count and the time; the bridge keeps the alert message and whether its button was used.
- **The real check is a test utility, not a test.** It lives in `src/real/resume.real.test-util.ts` so `pnpm test`, the type check and the build leave it out.
