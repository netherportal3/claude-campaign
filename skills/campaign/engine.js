export const meta = {
  name: 'campaign-engine',
  description: 'One campaign phase: lanes of items through stages (implement, verify, merge or custom), one merge queue, state docs, usage stop',
  whenToUse: 'Launched by the /campaign skill via scriptPath, with args built from <run>/phases/<phase>.json',
  phases: [{ title: 'Usage' }, { title: 'Merge' }],
}

// ---------------------------------------------------------------------------------------------
// args (see <skill>/templates/phase.example.json):
// { runName, run (abs folder), skill (abs folder), phase, mode: 'lanes'|'pilot', stopPct, maxActive,
//   minRemainingTokens, usageEvery, base?, mergeFlags?, rules (run-wide text), pilotBrief?, pilotVerifyModel?,
//   lanes: [{ id, title, brief, doc?, after?: [laneId], concurrent?: bool, maxParallelItems?,
//             stopOnBlock?: bool, maxFixes?, verify?: 'lane'|'independent',
//             model?: { implement, verify, merge, <custom stage> }, effort?: { <stage>: level },
//             stages?: [name | { name, brief?, model?, effort?, worktree?, merge?, failBackTo? }],
//             items: [{ id, title, brief, after?: [laneId], stages?, input? }] }] }
// Every agent returns RESULT. Agents never talk to the user; questions come back in needs_owner.
// ---------------------------------------------------------------------------------------------

const A = args || {}
const RUN = (A.run || '').replace(/[\\/]+$/, '')
const SKILL = (A.skill || '').replace(/[\\/]+$/, '')
const MAX = Math.max(1, Math.min(A.maxActive || 8, 14))
const STOP = typeof A.stopPct === 'number' ? A.stopPct : 100
const MIN_TOKENS = A.minRemainingTokens || 300000
const USAGE_EVERY = A.usageEvery || 4
const BASE = A.base || 'main'
const MERGE_FLAGS = A.mergeFlags || '--squash'

const RESULT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'partial', 'blocked', 'fail', 'skip'] },
    summary: { type: 'string' },
    branch: { type: 'string' },
    pr: { type: 'string' },
    problems: { type: 'array', items: { type: 'string' } },
    needs_owner: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    metrics: { type: 'string' },
  },
  required: ['status', 'summary'],
}
const USAGE = {
  type: 'object',
  properties: { weekly_pct: { type: 'number' }, five_hour_pct: { type: 'number' } },
  required: ['weekly_pct'],
}

// ---- concurrency limiter: at most MAX stage agents at once (usage checks excluded) ----------
let active = 0
const waiting = []
function acquire() {
  if (active < MAX) { active++; return Promise.resolve() }
  return new Promise(r => waiting.push(r))
}
function release() {
  const next = waiting.shift()
  if (next) next(); else active--
}
async function limited(fn) {
  await acquire()
  try { return await fn() } finally { release() }
}
async function limitMap(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) { const k = next++; out[k] = await fn(items[k], k) }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker))
  return out
}

// ---- stop control: weekly usage % and the user's token cap -----------------------------------
let stopping = false
let stopReason = ''
let starts = 0
let lastUsage = null
async function usageNow(label) {
  const u = await agent(
    'Load the tool mcp__ccd_session_mgmt__get_usage with ToolSearch (query "select:mcp__ccd_session_mgmt__get_usage") and call it with no arguments. ' +
    'Return weekly_pct = percentUsed of the weekly all-models window (labelled like "Weekly · all models"), and five_hour_pct if a 5-hour window is listed. ' +
    'If the tool cannot be found or fails, return weekly_pct -1. Do nothing else.',
    { label, phase: 'Usage', model: 'haiku', effort: 'low', schema: USAGE })
  if (u && typeof u.weekly_pct === 'number' && u.weekly_pct >= 0) {
    lastUsage = u.weekly_pct
    if (u.weekly_pct >= STOP) { stopping = true; stopReason = `weekly usage ${u.weekly_pct}% >= stop ${STOP}%`; log(`STOP: ${stopReason}`) }
  } else {
    log('usage read unavailable; relying on the token cap (if any)')
  }
  return u
}
async function maybeCheckUsage() {
  if (stopping) return
  if (budget.total && budget.remaining() < MIN_TOKENS) {
    stopping = true; stopReason = `token cap: ${budget.remaining()} output tokens left`; log(`STOP: ${stopReason}`); return
  }
  starts++
  if (STOP >= 100 || starts % USAGE_EVERY !== 1) return
  await usageNow(`usage check ${starts}`)
}

// ---- one merge at a time --------------------------------------------------------------------
let mergeTail = Promise.resolve()
function queued(fn) {
  const run = mergeTail.then(fn, fn)
  mergeTail = run.then(() => {}, () => {})
  return run
}

// ---- stages and prompts ---------------------------------------------------------------------
const DEFAULT_STAGES = [
  { name: 'implement', worktree: true },
  { name: 'verify', worktree: true, failBackTo: 'implement' },
  { name: 'merge', worktree: true, merge: true, failBackTo: 'implement' },
]
const DEFAULT_MODEL = { merge: 'haiku' }
const DEFAULT_EFFORT = { merge: 'low' }

function stageOf(s) {
  if (typeof s !== 'string') return s
  return DEFAULT_STAGES.find(d => d.name === s) || { name: s, worktree: true }
}
function branchOf(lane, item) { return `campaign/${A.runName}/${lane.id}-${item.id}` }
function docOf(lane) { return `${RUN}/${lane.doc || ('lanes/' + lane.id + '.md')}` }
function modelFor(lane, item, st) {
  return st.model || (item.model && item.model[st.name]) || (lane.model && lane.model[st.name]) || DEFAULT_MODEL[st.name]
}
function effortFor(lane, st) {
  return st.effort || (lane.effort && lane.effort[st.name]) || DEFAULT_EFFORT[st.name]
}

function stageBrief(lane, item, st) {
  const b = branchOf(lane, item)
  if (st.brief) return st.brief
  if (st.name === 'implement') return [
    `Work on branch ${b}: if it exists on origin, check it out; otherwise create it from origin/${BASE}. Use git -C <your worktree's absolute path> (never cd ..).`,
    'Implement the item to its done criteria, with tests. Run the repo\'s typecheck/lint and the targeted tests. Commit and push the branch. Do not open the PR (the merge stage does).',
    'If the input contains problems from a verifier or from CI, fix exactly those first.',
  ].join(' ')
  if (st.name === 'verify') return [
    `You are the verifier. Check out ${b} in your worktree. Read the diff against origin/${BASE}, run typecheck/lint and the targeted tests, and check the item's done criteria and the run rules.`,
    'Fix small issues yourself (commit and push). Return done if it meets the criteria; fail with a concrete problems list if it needs real rework; blocked if it cannot be done.',
    lane.verify === 'independent' ? 'Be adversarial: this lane touches security boundaries, data safety, money, migrations or cross-service protocols. Try to break it before you pass it.' : '',
  ].join(' ')
  if (st.name === 'merge') return [
    `You are the merger for branch ${b}. Exact steps:`,
    `1) gh pr list --head ${b} --state all --json number,state,url. If MERGED: if the repo has a deploy workflow, confirm its run for the merge started (gh run list --branch ${BASE} --limit 8); return done with the PR url.`,
    `2) If there is no PR: gh pr create --base ${BASE} --head ${b} --title "${lane.id}: ${item.title}" with a plain body from the lane doc's item notes (no secrets, no security-exploit detail).`,
    `3) git fetch origin; git checkout ${b}; git rebase origin/${BASE}. On conflict: git rebase --abort and return fail with the conflicting files. Else git push --force-with-lease.`,
    '4) Wait for CI in the FOREGROUND: run gh pr checks <n> --watch --interval 30 in repeated Bash calls of at most 10 minutes each (timeout 600000), at most 60 minutes in total. Never use timers (CronCreate, ScheduleWakeup, Monitor wakes). If the repo has no CI checks, go straight to step 5.',
    `5) Green: gh pr merge <n> ${MERGE_FLAGS}, then (if the repo deploys from ${BASE}) confirm the deploy workflow run started, and return done with the PR url. Red: return fail with the failing check names and the ~20 most relevant lines of gh run view <id> --log-failed. Still running at 60 min: return blocked "ci stuck".`,
  ].join('\n')
  return ''
}

function promptFor(lane, item, st, input, round) {
  return [
    `You are one agent in campaign run "${A.runName}" (run folder ${RUN}). Lane ${lane.id}: ${lane.title}. Item ${item.id}: ${item.title}. Stage: ${st.name}${round ? ` (continuation round ${round + 1})` : ''}.`,
    `State doc: ${docOf(lane)}. Read it FIRST (if it is missing, create it from ${SKILL}/templates/lane.md). Keep your notes under the heading "## Item ${item.id}" and append what you settle AS YOU GO (what you ran, results, decisions), a few lines each. Set updated: (UTC ISO) in its front matter when you write.`,
    lane.brief ? `Lane brief: ${lane.brief}` : '',
    `Item brief: ${item.brief || item.title}`,
    `This stage: ${stageBrief(lane, item, st)}`,
    input ? `Input from the previous stage: ${JSON.stringify(input).slice(0, 3000)}` : '',
    A.rules ? `Run rules (binding): ${A.rules}` : '',
    'Crash safety: before you change anything, check the state doc, the item branch on origin and any PR for it, and continue from there. Never open a second PR, and never create a duplicate external account, record or resource for the same item. Commit and push WIP to the item branch after each meaningful step; never push to the base branch.',
    'Context: if this work is getting long, stop at a clean point, write exactly where you are and what is left into the state doc, and return status "partial". A fresh agent continues from the doc.',
    'Never ask the user anything and never wait for an answer: put questions in needs_owner with your recommended default, and carry on with the default where it is safe. No new sessions, no timers, no secret-manager CLI calls. Read secrets only from the run\'s key file (if it has one) and never print them.',
    'Return the schema: status done|partial|blocked|fail|skip, summary (at most 400 characters), and pr/branch/problems/needs_owner/decisions/metrics when relevant.',
  ].filter(Boolean).join('\n\n')
}

// ---- running stages, items, lanes -----------------------------------------------------------
const needsOwner = []
const decisions = []

async function runStage(lane, item, st, input) {
  for (let round = 0; round < 4; round++) {
    if (stopping && !st.merge) return { status: 'blocked', summary: 'stopped: ' + stopReason, stopped: true }
    if (!st.merge) await maybeCheckUsage()
    if (stopping && !st.merge) return { status: 'blocked', summary: 'stopped: ' + stopReason, stopped: true }
    const opts = { label: `${lane.id}.${item.id} ${st.name}${round ? ' r' + (round + 1) : ''}`, phase: st.merge ? 'Merge' : `Lane ${lane.id}`, schema: RESULT }
    const m = modelFor(lane, item, st); if (m) opts.model = m
    const e = effortFor(lane, st); if (e) opts.effort = e
    if (st.worktree) opts.isolation = 'worktree'
    const r = await limited(() => agent(promptFor(lane, item, st, input, round), opts))
    if (!r) return { status: 'blocked', summary: 'agent died or was skipped' }
    if (r.status !== 'partial') return r
    input = Object.assign({}, input || {}, { continue_from_doc: true, last_partial: r.summary })
  }
  return { status: 'blocked', summary: `still partial after 4 rounds at stage ${st.name}` }
}

async function runItem(lane, item) {
  const stages = (item.stages || lane.stages || DEFAULT_STAGES).map(stageOf)
  const trail = []
  let input = item.input || null
  let i = 0
  let fixes = 0
  let last = null
  let pr = ''
  while (i < stages.length) {
    const st = stages[i]
    const r = st.merge ? await queued(() => runStage(lane, item, st, input)) : await runStage(lane, item, st, input)
    last = r
    if (r.pr) pr = r.pr
    for (const q of r.needs_owner || []) needsOwner.push(`${lane.id}.${item.id}: ${q}`)
    for (const d of r.decisions || []) decisions.push(`${lane.id}.${item.id}: ${d}`)
    trail.push(`${st.name}:${r.status}`)
    if (r.status === 'done') { input = r; i++; continue }
    if (r.status === 'skip') break
    if (r.status === 'fail' && st.failBackTo && fixes < (lane.maxFixes ?? 2) && !stopping) {
      const k = stages.findIndex(s => s.name === st.failBackTo)
      if (k >= 0) { fixes++; input = { problems: r.problems || [r.summary], from: st.name }; i = k; continue }
    }
    break
  }
  const status = i >= stages.length ? 'done' : (last && last.status === 'skip') ? 'skip' : (last && last.stopped) ? 'stopped' : 'blocked'
  return { lane: lane.id, item: item.id, title: item.title, status, pr, summary: last ? last.summary : '', metrics: last && last.metrics || '', trail: trail.join(' > ') }
}

const lanes = A.mode === 'pilot' ? [pilotLane()] : (A.lanes || [])
const done = {}
for (const l of lanes) { let res; const p = new Promise(r => { res = r }); done[l.id] = { p, res } }

async function waitFor(ids) { for (const id of ids || []) if (done[id]) await done[id].p }

async function runOne(lane, it) {
  await waitFor(it.after)
  if (stopping) return { lane: lane.id, item: it.id, title: it.title, status: 'not started', summary: 'stopped: ' + stopReason }
  return runItem(lane, it)
}

async function runLane(lane) {
  try {
    await waitFor(lane.after)
    const items = lane.items || []
    let results = []
    if (lane.concurrent) {
      results = await limitMap(items, lane.maxParallelItems || 3, it => runOne(lane, it))
    } else {
      for (const it of items) {
        const r = await runOne(lane, it)
        results.push(r)
        if (lane.stopOnBlock && r.status !== 'done' && r.status !== 'skip') break
      }
    }
    return { lane: lane.id, title: lane.title, items: results }
  } finally {
    done[lane.id].res()
  }
}

function pilotLane() {
  return {
    id: 'P',
    title: 'Pilot',
    brief: 'Prove the campaign mechanics on one tiny real change: worktree edit, PR, model ids, merge after a foreground CI wait, deploy confirmed (if the repo deploys).',
    items: [{
      id: '1',
      title: 'pilot: harmless docs fix',
      brief: A.pilotBrief || 'Make ONE small, real improvement to an existing docs file in this repo (a typo, a broken link or a stale sentence). Touch nothing else. Done = merged, and the deploy (if any) started.',
    }],
    stages: [
      { name: 'implement', worktree: true, model: 'sonnet' },
      { name: 'verify', worktree: true, failBackTo: 'implement', model: A.pilotVerifyModel || 'opus', brief: 'Verify the docs change (it must be correct and touch one file). ALSO put in metrics the exact model id you are running as.' },
      { name: 'merge', worktree: true, merge: true, model: 'haiku', failBackTo: 'implement' },
    ],
  }
}

log(`campaign ${A.runName} / ${A.phase}: ${lanes.length} lane(s), at most ${MAX} agents at once, stop at ${STOP}% weekly${budget.total ? `, token cap ${budget.total}` : ''}`)
let pilotUsage = null
if (A.mode === 'pilot') pilotUsage = await usageNow('pilot usage read')
const laneResults = await parallel(lanes.map(l => () => runLane(l)))
return {
  run: A.runName,
  phase: A.phase,
  stopped: stopping,
  stop_reason: stopReason,
  last_weekly_pct: lastUsage,
  pilot_usage: pilotUsage,
  lanes: laneResults.filter(Boolean),
  needs_owner: needsOwner,
  decisions,
}
