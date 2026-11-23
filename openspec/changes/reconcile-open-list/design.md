## Decisions

- **List over get.** `session.form.get` and `permission.get` stay, because they say answered or cancelled. They cannot be the only signal: an error other than "not found" says nothing, and a form of a session that is gone fails with another error. The list per session (`session.form.list`, `permission.list`) is fetched once per session and check, and a request missing from it while `get` says open or nothing is treated as gone.
- **Gone is withdrawn, also for permissions.** A permission request that `get` reports as not found stays "answered at the Mac", as before. One that only the list proves gone is withdrawn.
- **A session OpenCode does not know** holds nothing open: the list of a missing session is empty, and `get` on its form is "gone".
- **When OpenCode cannot be asked** (no service, an error), nothing is closed and the prompt is `unverified`. A host with no way to ask at all keeps the old rule: everything pending counts as open, because nothing can be confirmed or refuted.
- **Confirmation window.** A prompt is confirmed when a check saw it open less than two periods (120 s) ago, or when it was asked less than the 10 second grace ago. After that it drops out of `open` into `unverified` until a check confirms it again, so a stuck prompt cannot hold `open` above zero for long.
- **Fresh at the question.** `/oob version` and the chat `/version` run a check first, so their counts are not older than the question.
- **Log.** `reconcile` with `checked`, `open`, `closed`, `withdrawn`, `unverified`, only when something was checked.
