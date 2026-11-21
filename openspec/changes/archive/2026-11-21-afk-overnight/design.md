## Context

Away mode (`watch-afk`) is a flag and a rule. The bridge already scans every 15 seconds (`SCAN_MS`), knows each session's state, can resume (`resume`), can prompt (core), and will have a digest (`quiet-digest`). Overnight mode is a policy on top of these, not a new engine.

## Decisions

### D1. A plan is a small file

`overnight.json` in the data directory: start time, `until`, wake conditions, and per session the brief and its counters. The file is written before any automated action and read at start, so a restart neither forgets the plan nor repeats a sent task (each task has a state: `pending`, `sent`, `done`).

### D2. Start only at the Mac

`/oob overnight` in the TUI walks through the watched sessions. For each it shows what the bridge knows (state, queued inbox items, last turn, chat setting, open prompts) and asks for the brief, with defaults from `overnight.defaults` or the last plan. Starting sets away mode on until `until`, and turns quiet hours and the digest on for the night. A chat or the API may **end** a plan but never start or extend one: automation can only be reduced from outside the Mac.

### D3. Preflight

Per session: state known, not denied by `chat.deny`, not already running a conflicting task, channel healthy and topic present, inbox readable. Per plan: a channel is up, the deadman is configured and its last heartbeat was acknowledged, the digest is on. Each item is ok, warning or blocker. A blocker refuses the plan for that session or the plan; warnings need an explicit yes.

### D4. Brief

- `tasks`: prompts to send in order, one at a time, when the session is idle.
- `scope`: free text. **It is an instruction.** The bridge sends it to the session as a synthetic message at the start and records it. The bridge cannot enforce what an agent does, and it never answers a permission or edits a permission rule to match the scope. A permission the host asks for waits like any other.
- `maxTurns` and `until`: the budget. Money is not measured.
- `maxFailures`: stop after this many failed turns in a row (default 2).
- `onQuestion`: `park` (default) or `default` with `answerAfter` minutes (default 30).

### D5. Automation loop

On each scan, for each plan session, in this order: (1) if the session is suspended with waiting messages, resume it, at most `maxResumes` times a night (default 3) and at least 5 minutes apart, trusting the outcome from `resume`; (2) if it is idle and a task is pending, send the next task with delivery `queue`; (3) if a question has waited `answerAfter` and the policy is `default` and the question is single-select with a recommended option, answer with it; (4) check the budget and the failure count and stop the session when one is broken (interrupt if running, mark `stopped:<reason>`).

### D6. Never

The loop never answers a permission, never answers free text or a multi-select question, never acts on a session outside the plan or one that matches `chat.deny`, and never acts after `until` or after the plan is ended.

### D7. Escalation

Parked questions, open permissions, repeated failures, a refused resume, a stopped session, an unhealthy bridge or channel: each becomes one line in the morning digest and one silent message in the topic. `overnight.wake` names kinds that notify with sound during the plan; the default is empty.

### D8. Report

The night section of the digest per session: turns run, tasks done of total, resumes, answers given by policy, parked questions, failures, stop reason. Every automated action is also a `overnight_action` log line with session, action and reason.

### D9. Timed AFK and return

`/oob afk on 8h` forces away for that long and then returns to auto. When input resumes after away, the TUI shows a one-time summary: pushes sent, questions answered from the phone, sessions that finished or failed, and the plan's state.

## Risks

- An agent that ignores its scope can still do harm inside what the host already allows. Mitigation: D4 states it, permissions still wait, and `maxTurns` and `until` bound the night.
- Automation fighting the operator who comes back early. Mitigation: any typed prompt in the TUI pauses the loop for that session for ten minutes.
- The Mac sleeping stops everything. Mitigation: the deadman reports silence; keeping the Mac awake is out of scope.
