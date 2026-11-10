---
name: campaign
description: Run a massive multi-part coding job (many features, audits, sweeps) unattended from ONE Claude Code session, as phases of Workflow scripts driven by a reusable engine. Scout with read-only agents, write a plan and STOP for the user's go, run a 4-agent pilot, then run phases where every item flows implement -> verify -> one serialized merge queue. State docs for every path, no extra sessions, no timers or watchdogs, questions never block, usage stop, crash-safe resume. Use when the user types "/campaign <task | run name | run folder | plan file> <stop %> [+NM]", or asks to "kick off a campaign", "run this big plan with agents/workflows", "do this whole multi-stage thing autonomously".
argument-hint: "<task text | run name | run folder | plan file> <weekly usage stop %> [+token cap e.g. +30M]"
---

# /campaign

One session (this one, the ROOT) runs the whole job. Work happens in Workflow scripts launched from here; every
agent nests under its workflow in `/workflows` and ends when its item is done.

Why one session: fleets of separate sessions (a courier, a detached orchestrator, one session per lane, a watchdog
on a timer) go wrong in practice. Timers do not fire, sessions sprawl and are never cleaned up, scheduled tasks fail,
and coordination eats tokens. A script that sequences agents inside one session avoids all of that.

Needs: Claude Code with the Workflow tool, `git`, and the GitHub CLI (`gh`) logged in with push and merge rights on
the repo. The weekly-usage stop needs a usage tool (the Claude desktop app's `mcp__ccd_session_mgmt__get_usage`);
without one, run with stop 100 and a `+NM` token cap instead.

Paths (always absolute; forward slashes work on every OS):
- `<skill>` = this skill's base directory (shown when the skill loads; `~/.claude/skills/campaign` for a manual
  install). It holds `engine.js` and `templates/`.
- `<run>` = `~/.claude/campaigns/<name>/` (or the folder the user names). It holds `PLAN.md`, `RUN.md` (live status:
  the root's memory), `recon/*.md`, `lanes/*.md`, `clusters/*.md`, `phases/*.json`, `summaries/*.md`.

## Hard rules (root and every agent)
- ONE session. Never start other sessions, and never use `CronCreate`, `ScheduleWakeup`, scheduled tasks or Monitor
  wakes. The root wakes only on a workflow's completion notice or the user's message.
- Every path has a state doc, recon agents included. Agents read it first and append as they go.
- Questions never block. Agents put them in `needs_owner` with a recommended default. The root picks the default at
  once, logs it under Decisions in RUN.md and reports it in the phase summary. Only true user-only steps
  (credentials, payments, secret-manager prompts, risky security changes) wait under "Needs owner"; other work
  continues.
- Secrets come from one key file per run, made once at setup, kept outside any repo and readable only by the user
  (`chmod 600`, or `icacls` owner-only on Windows). Never call a secret-manager CLI in a loop (some, like 1Password's
  `op`, pop an approval prompt on every call): read each secret once into the file, then use the file only. Never
  print key values.
- Agents never touch the user's own windows, browser sessions or accounts.
- Security findings stay local (run folder + SendUserFile), never in detail in GitHub issues or PR bodies.
- Repo rules from CLAUDE.md and memory bind every agent (they get CLAUDE.md automatically). Finished work is merged
  (and deployed, if the repo deploys from its base branch) by the merge stage; the root never leaves an
  "I'll merge when green".
- Project-specific rules (prod safety, a model pinned for one kind of work, where browser windows may open) go in
  the plan's `rules` text. The engine puts that text in every agent's prompt.

## Invocation
1. `<run>/RUN.md` exists: status `planning` -> continue planning; `ready` -> treat this message as the go (Kickoff);
   `running`/`paused`/`stopped` -> Resume.
2. A plan file path: new run from that plan (skip Scout unless the plan lacks file:line pointers).
3. Anything else: new run from the free text.
Missing stop %: ask once (AskUserQuestion), default 50. A `+NM` token cap in the user's message becomes the
workflow's hard output-token ceiling (`budget.total`), shared by all workflows started in that turn.

## Stage 1: Scout (new runs)
- Keep a task list; name the run (kebab-case, <= 40 chars); create `<run>` with `recon/`, `lanes/`, `phases/`,
  `summaries/` and RUN.md from `<skill>/templates/RUN.md` (status: planning).
- At most 5 read-only scouts in parallel (Agent tool, background): Explore for code maps, general-purpose for
  prod/SSH/DB reads (small queries only). Create each one's `recon/<name>.md` from the template FIRST. Each brief:
  the exact questions, the memory notes to read, "read-only", "append findings to your doc as each is settled",
  and "return at most ~90 lines". Explore agents cannot write: the root saves a condensed copy of their report.
- Keep the root lean: never read files the scouts already summarised.

## Stage 2: Plan, then STOP
- Write `<run>/PLAN.md`: task, lanes (id, title, owned files, deps, verify mode lane|independent, models),
  items (each with done criteria a command or test can check), shared files and their one-line registration rule,
  user-gated steps, run-wide Never list, and the phase order. Lanes must be file-disjoint; a finding in another
  lane's files becomes an item in THAT lane. Use `verify: independent` for auth, security, migrations, money,
  cross-service protocols and deploy scripts.
- Write `<run>/phases/<phase>.json` for the first phases (format: `<skill>/templates/phase.example.json`), and the
  run-wide rules text that goes into every agent's prompt (`rules`).
- Show the user: the lane table, what each phase does, agent counts (total and at once), costs/risks, the decisions
  you defaulted, and the questions only they can answer. Set RUN.md `status: ready`. END THE TURN. Nothing runs until
  the user says go (their go message may carry the stop % and +NM).

## Stage 3: Kickoff (the user's go)
1. Read usage (`get_usage`, if available): at or over the stop % -> say so and stop. If the host can keep the
   machine awake (the desktop app's `request_keep_awake`), turn that on for the run.
2. Make the run's key file if the plan needs keys (see Hard rules), test each key printing only pass/fail.
3. Pilot (required for the first campaign in a repo, and after any engine.js change): Workflow with
   `scriptPath: <skill>/engine.js` and args `{runName, run, skill, phase: "pilot", mode: "pilot", stopPct}`.
   It runs a Haiku usage read, a Sonnet docs fix in a worktree, an Opus verify (reports its model id) and a
   Haiku merge with a foreground CI wait. Pass = merged + deploy started (if the repo deploys) + model id confirmed +
   usage read (skipped when stop is 100). On fail: fix the cause (or the engine), re-run. Record
   `pilot: passed <UTC>` in RUN.md. To prove a pinned model id works before a lane relies on it, pass it as
   `pilotVerifyModel`; if it is rejected, fall back to the alias (`opus`, `sonnet`, `haiku`) and tell the user.
4. Run the phases (below).

## Running a phase
- Create any missing lane/cluster docs from the templates (never overwrite existing ones).
- `Workflow({ scriptPath: "<skill>/engine.js", args: <the phase JSON as an object> })`. Pass args as a JSON
  object, never a string. Write the returned runId, the scriptPath and the args file into RUN.md "Now" at once.
- End the turn. Do not poll. The completion notice wakes you.
- On the notice: read ONLY the workflow's return value. Then, in the same turn:
  1. update RUN.md (Done, Decisions, Needs owner, Log; status);
  2. write `summaries/<phase>.md` (what shipped with PR links, metrics such as tests added or pages fixed, decisions
     made, needs-owner, what is next) and SendUserFile it with status proactive;
  3. clean up: `git worktree list`, and remove only worktrees of this run whose branch is merged
     (`git worktree remove`); look before you delete;
  4. if `stopped` is true (usage or token cap), stop here: RUN.md status `stopped`, PushNotification the user;
  5. otherwise build the next phase's JSON (items not done carry over; blocked items get one retry with their
     blocker in the brief, then stay blocked) and launch it.
- Loop phases (e.g. discovery rounds) repeat until two rounds in a row add nothing new, or the stop is hit.
- When every phase is done: RUN.md status `done`, final summary, PushNotification "RUN DONE".

## The engine (engine.js), what it guarantees
- Lanes run in parallel; items in a lane run in order unless the lane is `concurrent`; `after: [laneId]` on a lane
  or item waits for that lane to finish (deps must form a DAG; an item must never wait on its own lane).
- Each item flows through `stages` (default implement -> verify -> merge; custom stages for waves such as
  audit -> implement -> verify -> merge -> report). A stage returning `fail` goes back to its `failBackTo`
  stage with the problems, at most `maxFixes` (2) times; `skip` ends the item cleanly; `partial` re-launches a
  fresh agent on the same stage that continues from the state doc (at most 4 rounds).
- Merges go through ONE queue: rebase, foreground CI wait (`gh pr checks --watch`, 10-min calls, 60-min cap),
  `gh pr merge` with `mergeFlags` (default `--squash`; add `--admin` only if the user wants branch protection
  bypassed), deploy confirmed when the repo has one. Idempotent: an already-merged PR only gets its deploy confirmed.
- PRs target `base` (default `main`).
- At most `maxActive` (cap 14) agents at once. Usage is read by a Haiku agent every `usageEvery` item stages; at or
  over `stopPct`, no new stages start (verified work still merges), and the result says `stopped`.
- Every agent prompt carries: the state doc rule, crash safety (continue from doc/branch/PR, never a second PR or a
  duplicate external account or record, push WIP to the item branch), the partial rule, never-ask-the-user, no
  timers/sessions/secret-manager CLI.
- Branches: `campaign/<run>/<lane>-<item>`.

## Models (cheapest capable model on each job)
| Job | Model |
|---|---|
| merge, CI wait, usage read, mechanical edits with an exact spec | `haiku` (effort low) |
| implement from a precise spec, tests, docs | `sonnet` |
| design calls, verify, debugging what Sonnet could not fix, security | inherit (the session's model) |
| work the user wants on one specific model end to end | pin it on every stage of that lane via `model` |

## Token efficiency
- No coordinator LLM: the script sequences everything. The root reads only typed return values, never transcripts.
- Briefs point at file:line from recon instead of asking agents to explore. Keep briefs stable so caching helps.
- One verifier per item (it fixes small issues itself), never a panel; no per-finding verifier fan-out.
- Text-first tools (e.g. a browser harness that returns forms and requests as text) instead of screenshots.

## Resume (user says "resume", or after a crash or the app closing)
- Read RUN.md. Relaunch the last phase with `Workflow({ scriptPath, args, resumeFromRunId })`: finished agents return
  cached results instantly; interrupted ones restart and continue from their state docs and branches.
- `resumeFromRunId` works only in the session that started the run. From any other session (or if it fails): build
  a continuation phase JSON that keeps only items the lane docs and `gh pr list` do not show as done, and launch it.
- Context: the root auto-compacts; RUN.md is its memory. If a context-handoff hook asks a campaign root to hand off,
  update RUN.md and keep going instead (a new session cannot resume the running workflows from cache).

## Known limits (tell the user when relevant)
- Workflows run inside this session: the app must stay open and the machine awake. A crash pauses the run; resume
  loses only in-progress items' unpushed minutes.
- The user steers through the root only (agents cannot be chatted with); the root edits the plan/args and the
  next items pick it up. A stuck agent can be skipped in `/workflows`.
- Agents never type credentials into production sign-in pages, so visual checks of logged-in pages run on the
  repo's local/e2e server; prod is checked by API, logs and timings, and the summary lists pages for the user.
