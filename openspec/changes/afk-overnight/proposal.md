## Why

Away mode only decides when to push. It does not help a session keep working while the operator sleeps. A session that asks a question, gets suspended, or runs out of queued work simply stops, and the operator finds out in the morning. The operator wants to set sessions up before leaving, have the bridge keep them moving within limits he set, be woken only for what needs him, and read a report of the night.

## What Changes

- **Overnight plan.** Started at the Mac only. For each watched session the bridge runs a **preflight checklist** and takes a **brief**: queued tasks, scope (as an instruction), budget, stop conditions, and what to do with a question nobody answers (park or take the recommended option).
- **The bridge keeps it moving.** It resumes suspended sessions, sends the next task to an idle session that has one, and stops a session that breaks its budget or keeps failing. It never answers a permission and never widens a permission rule.
- **Escalation is narrow.** Only things that need the operator are listed, in the morning digest; nothing wakes him unless he named a wake condition.
- **Night report.** The digest gains a night section: per session, what ran, what the bridge did, and why anything stopped.
- **Better AFK.** Timed AFK (`/oob afk on 8h`) and a short "while you were away" summary when the operator comes back.

## Capabilities

### New Capabilities

- `overnight`: the plan, preflight, brief, automation, limits, escalation and report.

### Modified Capabilities

- `watch-afk`: timed away mode and the return summary.

## Out of scope

Starting or extending a plan from a chat or the API, enforcing scope inside the agent (scope is an instruction, see the design), answering permissions, keeping the Mac awake, spending limits in money (turns and time only), more than one plan at a time.

## Impact

- **Existing surface audit.** `src/control.ts` (scan loop, stuck rows, away rule), `src/settings.ts` (persistent settings), `src/subcommands.ts` and `src/menu.ts` (TUI commands and dialogs), `src/sidebar.ts`, the core actions, `quiet-digest`, `resume` and `deadman`.
- **Supersession.** None. It adds to away mode and does not replace it.
- **Downstream.** The Mini App shows and ends the plan.
- **Estimate.** Agent 3 days. Operator 20 minutes to try a real night.
- **Definition of done.** `pnpm test` ends `fail 0` with the overnight tests, and a recorded run with a fake clock shows a plan resuming a suspended session, sending a task, parking a question, stopping on its budget, and producing the night section of the digest.
