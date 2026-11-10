# campaign

A Claude Code skill for running a big, multi-part coding job unattended from one session.

You give it a task ("ship these 30 UI fixes", "audit every dependency and upgrade what's safe"). It scouts the repo
with read-only agents, writes a plan, and stops for your go. Then it runs the work as phases of Workflow scripts.
Each item flows through implement, verify and a single serialized merge queue, so `main` stays green.

```
/campaign <task | run name | run folder | plan file> <weekly usage stop %> [+token cap]

/campaign "move every settings page to the new form components" 60
/campaign ~/plans/q4-cleanup.md 50 +30M
/campaign q4-cleanup            # resume a run by name
```

## How it works

1. **Scout.** Up to 5 read-only agents map the code and write what they find into recon docs.
2. **Plan, then stop.** The root writes `PLAN.md`: file-disjoint lanes, items with checkable done criteria, models
   per stage, risks, and the questions only you can answer. Nothing runs until you say go.
3. **Pilot.** On the first run in a repo, a 4-agent pilot proves the mechanics on one tiny docs fix: worktree, PR,
   model ids, CI wait, merge.
4. **Phases.** `engine.js` runs lanes in parallel. Each item goes through `implement -> verify -> merge`, or custom
   stages you define. Failures go back with the problem list (at most 2 fix rounds). Long work hands over to a fresh
   agent through the state doc. All merges go through one queue: rebase, wait for CI in the foreground, then merge.
5. **Summaries.** After each phase the root updates `RUN.md`, writes a phase summary, cleans up merged worktrees and
   launches the next phase. It stops on its own at your usage % or token cap.

Design choices:

- **One session.** No fleet of sessions, no timers, no watchdogs. The root wakes only when a workflow finishes or
  you send a message.
- **State docs for everything.** Every lane and recon agent keeps a doc it reads first and appends to as it goes. A
  crash or a context limit costs minutes, not the run.
- **Questions never block.** Agents return questions with a recommended default. The root takes the default, logs
  it, and reports it. Only steps that truly need you (credentials, payments) wait.
- **Cheapest capable model per job.** Haiku merges and reads usage, Sonnet implements from precise specs, and the
  session's model handles verify and design calls.

## Install

As a plugin:

```
/plugin marketplace add netherportal3/claude-campaign
/plugin install campaign@claude-campaign
```

Plugin skills are namespaced, so it shows up as `/campaign:campaign`. You can also just ask Claude to "kick off a
campaign".

Or by hand, which gives you plain `/campaign`:

```bash
git clone https://github.com/netherportal3/claude-campaign
cp -r claude-campaign/skills/campaign ~/.claude/skills/
```

## Requirements

- Claude Code with the **Workflow** tool. Typing `/campaign` counts as opting in to multi-agent workflows, and the
  plan stop gives you a checkpoint before anything spends real tokens.
- `git`, and the GitHub CLI (`gh`) logged in with push and merge rights on the repo.
- For the weekly-usage stop, a usage tool. The Claude desktop app's Code tab has one. Without it, use stop `100` and
  a `+NM` token cap.
- The app must stay open and the machine awake while a run is going. After a crash, say "resume" in the same
  session: finished agents return cached results and the rest continue from their docs and branches.

## Files

| Path | What it is |
|---|---|
| `skills/campaign/SKILL.md` | The skill: stages, hard rules, models, resume |
| `skills/campaign/engine.js` | The Workflow script that runs one phase |
| `skills/campaign/templates/RUN.md` | Live run status, the root's memory |
| `skills/campaign/templates/lane.md` | Per-lane state doc |
| `skills/campaign/templates/recon.md` | Per-scout state doc |
| `skills/campaign/templates/phase.example.json` | Phase args: lanes, items, custom stages |

A run lives in `~/.claude/campaigns/<name>/`: `PLAN.md`, `RUN.md`, `recon/`, `lanes/`, `phases/`, `summaries/`.

## Things to know

- Merges use `gh pr merge --squash` by default. Set `mergeFlags` to `--squash --admin` only if you want the merge
  stage to bypass branch protection.
- Put project rules (prod safety, pinned models, anything agents must never do) in the phase's `rules` text. Every
  agent gets it, along with your repo's `CLAUDE.md`.
- Use `verify: "independent"` for lanes that touch auth, security, migrations, money or deploy scripts. Their
  verifier is told to try to break the change before passing it.
- A big run spends a lot of tokens. Start with a small plan and a low stop %.

## License

MIT
