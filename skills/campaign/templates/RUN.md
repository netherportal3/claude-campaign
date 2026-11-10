---
run: <name>
status: planning
stop_pct: <n>
token_cap: <+NM or none>
pilot: not run
updated: <UTC ISO>
---
# Run <name>

## Now
- phase: <name> | workflow runId: <id> | scriptPath: <path> | args: phases/<phase>.json | launched: <UTC>

## Done
- <phase>: <one line per merged PR / result>

## Next
- <the next phase and what it needs>

## Decisions (made without the owner; the owner can overrule)
- <decision> (default chosen because ...)

## Needs owner (owner-only steps; nothing else waits on these)
- <exact step or command>

## Log
- <UTC> <one line>
