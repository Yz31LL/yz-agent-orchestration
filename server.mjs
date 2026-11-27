// Yz Agent Orchestration: what each Claude session is building in one repo, per ticket,
// at three levels (local worktree, origin/dev, origin/stage).
//
//   node server.mjs            -> http://127.0.0.1:4317
//
// READ ONLY on the repo, with ONE opt-in exception. The git commands that
// write anything are `git fetch`, which updates remote-tracking refs and
// nothing else, and, only when config pr.enabled is on and only on the user's
// click of Send, `git push <remote> <branch>` (never forced) followed by
// `gh pr create` (pr-routes.mjs). Nothing here commits, merges, checks out,
// deletes a branch or rebases. Every git call runs with GIT_OPTIONAL_LOCKS=0 so
// `git status` never takes index.lock and collides with an agent that is
// committing, and with GIT_TERMINAL_PROMPT=0 so a push never waits on a prompt.
//
// Stops itself at config.stopHour local time, when one is set (config.mjs).

import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG, labelLookup, prNow } from './config.mjs'
import { chatStatus } from './chat.mjs'
import { collections, readSource, startAutoRefresh } from './factory.mjs'
import { factoryRoute } from './factory-routes.mjs'
import { makePrStates } from './subagent-prs.mjs'
import { makeSubagentRoutes } from './subagent-routes.mjs'
import { makeScriptRoute } from './script-routes.mjs'
import { findSkill } from './script-skill.mjs'
import { makeContextGatherer, makeScriptContextRoute } from './script-context-routes.mjs'
import { makeAgentSettingsRoute } from './agent-settings-routes.mjs'
import { makeScriptLogRoute } from './script-log-routes.mjs'
import { appendRun } from './script-log.mjs'
import { makeStandupServerRoute } from './standup-wiring.mjs'
import { makeQualityServer } from './quality-wiring.mjs'
import { makeLearnServerRoute } from './learn-wiring.mjs'
import { orchestrationBrief } from './script-brief.mjs'
import { briefExtras } from './script-brief-extras.mjs'
import { pipelineGraph } from './pipeline.mjs'
import { listRepoSubagents, oneSubagent, sessionFile, ticketBuilders, windowStart } from './subagents.mjs'
import { listFlows } from './flows.mjs'
import { pinnedSessions } from './pinned-agents.mjs'
import { hostAllowed } from './local-origin.mjs'
import { pushEnv } from './pr-routes.mjs'
import { makeOrchestration, pulse } from './orchestration.mjs'
import { buildFlow, pushCount } from './flow.mjs'
import { buildReport } from './report.mjs'
import { compareTickets } from './ticket-ids.mjs'
import { claudeRun, makeRelay } from './relay.mjs'
import { startReworkWatch } from './qa-rework.mjs'
import { makeProjectRoutes } from './projects-routes.mjs'
import { makeTokenRoute } from './token-routes.mjs'
import { makePredictRoute } from './predict-routes.mjs'
import { makeRoutingRoute } from './routing-routes.mjs'
import { makePrListRoute } from './prlist-routes.mjs'
import { makeInsightServer } from './insight-wiring.mjs'
// the four smart features connected through their contracts (smart-wiring.mjs)
import { learnLessons, learnSignals, riskLevelOf, tokensFinal, wireRouting } from './smart-wiring.mjs'
import { listLessons } from './quality-lessons.mjs'
import { riskOf } from './quality-risk.mjs'
import { signals } from './predict-signals.mjs'
import { flowTokens } from './predict-flow-tokens.mjs'
import { startPhone } from './phone-wiring.mjs'
import { makePhoneDesktopRoute } from './phone-desktop-routes.mjs'
import { listenWhenFree, makeRestarter, underKeepAlive, waitForPredecessor } from './restart.mjs'
import {
  CLAUDE_DIRS,
  conversationsOf,
  feedSince,
  idsInBranch,
  idsInText,
  ticketPrefixes,
  listSubagents,
  newestKeys,
  scanTranscript,
  stateOf,
  subagentFile,
  subagentNames,
  subagentsSince,
  transcriptFile,
} from './transcripts.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = CONFIG.repo
const PORT = CONFIG.port
const CACHE_MS = 45_000
const FETCH_EVERY_MS = 5 * 60_000
const CURFEW_HOUR = CONFIG.stopHour

/** Sessions that write code, and the names the user calls them. */
const CODING_AGENTS = CONFIG.codingAgents
/** The label a session shows under: the coordinator by its configured label, any other by codingAgents, then aliases (config.mjs labelLookup). */
const labelOf = labelLookup(CONFIG)
/** The branches the levels compare (config levels): the coordinator's working branch, remote dev and stage. */
const LEVELS = CONFIG.levels

// ─── git ──────────────────────────────────────────────────────────────────────

/** One command, as an argv array (never a shell): { ok, out, err, code } (`code` the exit code, null when it did not run). */
function run(bin, args, cwd, env = {}, timeout = 60_000) {
  return new Promise(resolve => {
    execFile(
      bin,
      args,
      { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true },
      (err, stdout, stderr) => resolve({
        ok: !err, out: String(stdout ?? '').trim(), err: String(stderr || err?.message || '').trim(),
        code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
      })
    )
  })
}

function git(args, cwd = REPO) {
  return run('git', args, cwd, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' })
}

/**
 * Send's push (pr-routes.mjs), the one git command that writes outside the machine: its own 180 s, and ssh
 * in batch mode unless the repo or the environment names its own ssh command (pr-routes.mjs pushEnv).
 */
async function push(args) {
  const own = await git(['config', '--get', 'core.sshCommand'])
  return run('git', args, REPO, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...pushEnv(own.ok ? own.out : '') }, 180_000)
}

/**
 * The GitHub CLI in the repo (config pr.gh), for Send (pr-routes.mjs) and, read only, for the state of the
 * subagents' pull requests (subagent-prs.mjs: gh pr view, with its own short `timeout`). Its token is never read: gh keeps it.
 * FACTORY_TEST_GH (an environment variable, for an end-to-end check against a throwaway repo only) names a
 * Node script that stands in for gh; it is not a setting and is not documented anywhere else.
 */
function gh(args, timeout = 60_000) {
  const stub = process.env.FACTORY_TEST_GH
  return stub ? run(process.execPath, [stub, ...args], REPO, {}, timeout) : run(prNow().gh, args, REPO, { GH_PROMPT_DISABLED: '1' }, timeout)
}

/** Runs async jobs with at most `n` in flight, so a refresh is not 200 processes at once. */
async function pool(items, n, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i])
      }
    })
  )
  return results
}

const fetchState = { at: null, ok: null, err: '' }

async function fetchOrigin() {
  const r = await git(['fetch', 'origin', '--quiet'])
  fetchState.at = new Date().toISOString()
  fetchState.ok = r.ok
  fetchState.err = r.ok ? '' : r.err.slice(0, 300)
  cache = null
}

// ─── ticket ids ───────────────────────────────────────────────────────────────

/** ticket id -> newest commit subject mentioning it, for one range of history. */
async function subjectIndex(range) {
  const r = await git(['log', ...range, '--format=%h%x09%cs%x09%s'])
  const index = new Map()
  if (!r.ok) return { ok: false, index }
  for (const line of r.out.split('\n')) {
    const [sha, date, subject = ''] = line.split('\t')
    const isMerge = /^Merge /.test(subject)
    for (const id of idsInText(subject)) {
      // Prefer a real commit's subject over a merge's, which only names a branch.
      const had = index.get(id)
      if (!had || (had.isMerge && !isMerge)) index.set(id, { sha, date, subject, isMerge })
    }
  }
  return { ok: true, index }
}

// ─── worktrees ────────────────────────────────────────────────────────────────

async function listWorktrees() {
  const r = await git(['worktree', 'list', '--porcelain'])
  const out = []
  let cur = null
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9).replace(/\\/g, '/'), branch: '', head: '' }
      out.push(cur)
    } else if (line.startsWith('HEAD ')) cur.head = line.slice(5, 14)
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '')
    else if (line === 'detached') cur.branch = '(detached)'
    else if (line.startsWith('prunable')) cur.prunable = true // its folder is gone (orchestration.mjs skips it)
  }
  return out
}

async function isAncestor(a, b) {
  return (await git(['merge-base', '--is-ancestor', a, b])).ok
}

async function leftRight(a, b) {
  const r = await git(['rev-list', '--left-right', '--count', `${a}...${b}`])
  if (!r.ok) return null
  const [ahead, behind] = r.out.split(/\s+/).map(Number)
  return { ahead, behind }
}

async function describeWorktree(wt, idx) {
  const name = path.basename(wt.path)
  const isAgentTree = wt.path.toLowerCase().includes('/.claude/worktrees/')
  const b = wt.branch
  const [status, upstream, vsDev, last] = await Promise.all([
    git(['status', '--porcelain'], wt.path),
    git(['rev-parse', '--abbrev-ref', `${b}@{upstream}`]),
    leftRight(b, LEVELS.dev),
    git(['log', '-1', '--format=%h%x09%cI%x09%s', b]), // %cI: an ISO time the page shortens (Shell.ago)
  ])
  const upstreamName = upstream.ok ? upstream.out : ''
  const vsUpstream = upstreamName ? await leftRight(b, upstreamName) : null
  const [inFollowup, inDev, inStage] = await Promise.all([
    isAncestor(b, LEVELS.work),
    idx.devOk ? isAncestor(b, LEVELS.dev) : false,
    idx.stageOk ? isAncestor(b, LEVELS.stage) : false,
  ])
  const [lsha, lwhen, lsubject] = (last.out || '').split('\t')
  const ids = idsInBranch(b)
  return {
    name,
    path: wt.path,
    branch: b,
    isAgentTree,
    ids,
    dirty: status.ok ? status.out.split('\n').filter(Boolean).length : null,
    upstream: upstreamName,
    vsUpstream,
    vsDev,
    last: { sha: lsha, when: lwhen, subject: lsubject },
    // "merged" = the branch tip is in that history. "named" = not these
    // commits, but some commit there names the ticket (older work, or a
    // cherry-pick), which is weaker evidence and shown as such.
    followup: inFollowup ? 'merged' : ids.some(id => idx.followupAll.has(id)) ? 'named' : 'no',
    dev: inDev ? 'merged' : ids.some(id => idx.dev.has(id)) ? 'named' : 'no',
    stage: inStage ? 'merged' : ids.some(id => idx.stage.has(id)) ? 'named' : 'no',
  }
}

// ─── agents (Claude sessions) ─────────────────────────────────────────────────

/** Live sessions in the watched repo, from the harness's session registry. */
async function liveSessions() {
  const sessions = []
  for (const base of CLAUDE_DIRS) {
    const dir = path.join(base, 'sessions')
    let files = []
    try {
      files = (await fs.readdir(dir)).filter(f => /^\d+\.json$/.test(f)) // never the .key files
    } catch {
      continue
    }
    for (const f of files) {
      try {
        const s = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))
        if (!String(s.cwd || '').toLowerCase().includes(CONFIG.sessionCwdMatch.toLowerCase())) continue
        if (!processAlive(s.pid)) continue
        s._claudeDir = base // its transcripts live under this folder
        sessions.push(s)
      } catch {
        /* a session file mid-write; skip it this round */
      }
    }
  }
  // A pinned agent whose session is closed still gets listed, idle, from its saved history.
  sessions.push(...pinnedSessions(CONFIG.pinnedAgents, new Set(sessions.map(x => x.sessionId))))
  return sessions
}

async function describeAgent(s, knownTrees) {
  const file = await transcriptFile(s)
  let scan = null
  if (file) {
    try {
      scan = await scanTranscript(file, s.cwd.toLowerCase(), knownTrees)
    } catch {
      scan = null
    }
  }
  const fresh = scan?.mtime && Date.now() - new Date(scan.mtime) < 60_000
  const working = s.status === 'busy' || Boolean(fresh)
  const { state, lastTool } = scan ? stateOf(scan, working) : { state: working ? 'active' : 'idle', lastTool: null }
  const worktreePos = scan ? Object.fromEntries(scan.worktrees) : {}
  return {
    sessionId: s.sessionId,
    name: s.name,
    label: labelOf(s.name),
    coding: s.name in CODING_AGENTS,
    coordinator: s.name === CONFIG.coordinator,
    status: s.status,
    state,
    lastTool,
    cwd: s.cwd,
    updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
    transcriptAt: scan?.mtime ?? null,
    recentWorktrees: scan ? newestKeys(scan.worktrees, 4) : [],
    recentTickets: scan ? newestKeys(scan.tickets, 6) : [],
    subagents: file ? await listSubagents(file, knownTrees) : [],
    model: scan?.model || null, // the model its newest reply ran on (transcripts.mjs), for the agent window
    // only QA pushes (pipeline.mjs): git push commands any other agent ran in the last 24 h, for the page to flag
    pushesOutsideQa: scan && labelOf(s.name) !== CONFIG.pipeline.qa ? pushCount(scan.feed.events, Date.now() - 86_400_000) : 0,
    _worktreePos: worktreePos,
    _lines: scan?.lines ?? 0,
    _scan: scan,
    _socket: s.messagingSocketPath || '',
    _subNames: file ? await subagentNames(file) : new Map(),
  }
}

const INTERNAL = ['_worktreePos', '_lines', '_scan', '_socket', '_subNames']
const stripInternal = a => {
  for (const k of INTERNAL) delete a[k]
  return a
}

/**
 * name or pipe address -> the label the user knows. A session is addressed by
 * name, or by its pipe, which shows up as "\\.\pipe\LOCAL\cc-msg-<hex>" or
 * "uds:\\.\pipe\...": the cc-msg id is the part every spelling shares.
 */
function makeNamer(sessions) {
  const keyOf = v => {
    const s = String(v || '').toLowerCase()
    return (/cc-msg-[0-9a-f]+/.exec(s) || [s])[0]
  }
  const byKey = new Map()
  for (const s of sessions) {
    const label = labelOf(s.name)
    byKey.set(keyOf(s.name), label)
    byKey.set(keyOf(label), label)
    if (s.socket) byKey.set(keyOf(s.socket), label)
    // A subagent is addressed by its bare id: name it by its brief.
    for (const [id, description] of s.subNames || []) byKey.set(keyOf(id), `subagent: ${description}`)
  }
  const isPipe = v => /cc-msg-[0-9a-f]+/i.test(String(v || ''))
  return (key, fallback) =>
    byKey.get(keyOf(key)) ||
    byKey.get(keyOf(fallback)) ||
    // A pipe no live session owns belongs to a session that has since ended.
    (isPipe(key) || isPipe(fallback) ? 'an ended session' : fallback || key || 'unknown')
}

/**
 * Every who-to-whom edge across the live sessions, newest first. A message one
 * tracked session sent shows up twice (its SendMessage, the other's inbox);
 * both resolve to the same from > to > text key, so one copy is kept.
 */
function conversations(agents) {
  const nameOf = makeNamer(agents.map(a => ({ name: a.name, socket: a._socket, subNames: a._subNames })))
  const all = agents.flatMap(a => (a._scan ? conversationsOf(a._scan, a.label, nameOf) : []))
  const seen = new Set()
  return all
    .filter(c => {
      const k = `${c.from}>${c.to}>${c.text.slice(0, 60)}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((x, y) => String(y.t).localeCompare(String(x.t)))
    .slice(0, 80)
}

async function listAgents(knownTrees) {
  return pool(await liveSessions(), 4, s => describeAgent(s, knownTrees))
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/**
 * Which agent is on a worktree: the coding agent (not the coordinator, who merges
 * everything) that touched it most recently; the coordinator if only it did.
 * Positions are per transcript, so "most recent" compares how close to the end
 * of each transcript the last touch was.
 */
function ownerOf(worktreeName, agents) {
  let best = null
  for (const a of agents) {
    const p = a._worktreePos[worktreeName]
    if (p == null) continue
    const recency = a._lines - p
    const rank = a.coding && !a.coordinator ? 0 : a.coordinator ? 1 : 2
    if (!best || rank < best.rank || (rank === best.rank && recency < best.recency)) best = { label: a.label, rank, recency }
  }
  return best?.label ?? ''
}

// ─── tickets ──────────────────────────────────────────────────────────────────

/** Every collection's ticket source merged into one map (data/sources/<id>.json, see factory.mjs). */
function loadSources() {
  const tickets = {}
  let fetchedAt = null
  for (const c of collections()) {
    const s = readSource(c.id)
    if (!s) continue
    Object.assign(tickets, s.tickets)
    if (s.fetchedAt && (!fetchedAt || s.fetchedAt > fetchedAt)) fetchedAt = s.fetchedAt
  }
  return { tickets, fetchedAt }
}

/**
 * One level (dev or stage) for a whole ticket:
 *   yes    every branch is merged there and nothing for it is still waiting
 *   partly the ticket has commits there, but some of its work is not (an
 *          earlier round shipped; the current branch or followup has more)
 *   no     nothing there names it
 */
function ticketLevel(level, branches, named, stillWaiting) {
  const allMerged = branches.length > 0 && branches.every(b => b[level] === 'merged')
  if (allMerged && !stillWaiting) return 'yes'
  if (named || branches.some(b => b[level] === 'merged')) return 'partly'
  return 'no'
}

/** Tickets of one prefix together, in ticketPrefixes order (others alphabetical), newest number first. */
const ticketSort = (a, b) => compareTickets(a, b, ticketPrefixes())

// ─── snapshot ─────────────────────────────────────────────────────────────────

let cache = null
let building = null

async function buildStatus() {
  const started = Date.now()
  const worktrees = await listWorktrees()
  const knownTrees = new Set(worktrees.map(w => path.basename(w.path)))
  const [devIdx, stageIdx, followupOnly, followupAll, devOnly, sources, agents, followupVsDev] = await Promise.all([
    subjectIndex([LEVELS.dev, '--since=9.months']),
    subjectIndex([LEVELS.stage, '--since=9.months']),
    subjectIndex([`${LEVELS.dev}..${LEVELS.work}`]),
    subjectIndex([LEVELS.work, '--since=9.months']),
    subjectIndex([`${LEVELS.stage}..${LEVELS.dev}`]),
    loadSources(),
    listAgents(knownTrees),
    leftRight(LEVELS.work, LEVELS.dev),
  ])
  const idx = {
    dev: devIdx.index,
    stage: stageIdx.index,
    followupAll: followupAll.index,
    devOk: devIdx.ok,
    stageOk: stageIdx.ok,
  }

  const trees = await pool(
    worktrees.filter(w => w.branch && w.branch !== '(detached)'),
    6,
    w => describeWorktree(w, idx)
  )
  for (const t of trees) t.agent = t.isAgentTree ? ownerOf(t.name, agents) : t.branch === LEVELS.work ? CONFIG.coordinatorLabel : ''

  // Tickets in flight: every id on an agent worktree, plus every id followup
  // holds that dev does not have yet.
  const ids = new Set([...followupOnly.index.keys()])
  for (const t of trees) if (t.isAgentTree) t.ids.forEach(id => ids.add(id))

  const tickets = [...ids]
    .map(id => {
      const branches = trees.filter(t => t.ids.includes(id))
      const sb = sources.tickets[id] ?? null
      const commitHere = followupOnly.index.get(id) || null
      const agentsOn = [...new Set(branches.map(b => b.agent).filter(Boolean))]
      return {
        id,
        title:
          sb?.title ||
          (commitHere && !commitHere.isMerge ? commitHere.subject : '') ||
          branches.map(b => b.last.subject).find(s => s && !/^Merge /.test(s)) ||
          commitHere?.subject ||
          '',
        titleSource: sb ? 'switchboard' : commitHere || branches.length ? 'git' : '',
        switchboard: sb
          ? { state: sb.state, status: sb.column, mine: sb.owner === 'me', owners: sb.owner === 'none' ? 0 : 1, type: sb.type }
          : null,
        switchboardNote: sb ? '' : 'not in any ticket source',
        agents: agentsOn,
        branches: branches.map(b => ({ branch: b.branch, worktree: b.name, dirty: b.dirty, followup: b.followup, dev: b.dev, stage: b.stage })),
        local: {
          worktrees: branches.length,
          dirty: branches.reduce((n, b) => n + (b.dirty || 0), 0),
          // yes = every branch merged into followup; partly = some, or only by name
          inFollowup:
            branches.length && branches.every(b => b.followup === 'merged')
              ? 'yes'
              : commitHere || branches.some(b => b.followup !== 'no')
                ? 'partly'
                : 'no',
          unpushed: Boolean(commitHere),
        },
        dev: ticketLevel('dev', branches, idx.dev.has(id), Boolean(commitHere)),
        devCommit: idx.dev.get(id) || null,
        stage: ticketLevel('stage', branches, idx.stage.has(id), Boolean(commitHere) || devOnly.index.has(id)),
        stageCommit: idx.stage.get(id) || null,
      }
    })
    .sort(ticketSort)

  const talk = conversations(agents)
  const nameOf = makeNamer(agents.map(a => ({ name: a.name, socket: a._socket, subNames: a._subNames })))
  for (const a of agents) {
    if (a.lastTool?.tool === 'SendMessage') a.lastTool.summary = `to ${nameOf(String(a.lastTool.summary).replace(/^to /, ''))}`
    // Who this agent is talking with: the newest edge it is part of, in 30 min.
    const c = talk.find(x => (x.from === a.label || x.to === a.label) && Date.now() - new Date(x.t) < 30 * 60_000)
    a.talkingWith = c ? { with: c.from === a.label ? c.to : c.from, direction: c.from === a.label ? 'to' : 'from', t: c.t, via: c.via } : null
    stripInternal(a)
  }
  agents.sort((a, b) => Number(b.coding) - Number(a.coding) || a.label.localeCompare(b.label))

  return {
    builtAt: new Date().toISOString(),
    buildMs: Date.now() - started,
    repo: REPO,
    repoOk: existsSync(REPO),
    // who coordinates: its session name and the label every page shows (config coordinator, coordinatorLabel)
    coordinator: { name: CONFIG.coordinator, label: CONFIG.coordinatorLabel },
    fetch: fetchState,
    ticketSnapshotAt: sources.fetchedAt,
    followup: { vsDev: followupVsDev, unpushedTickets: [...followupOnly.index.keys()].sort() },
    remotesOk: { dev: devIdx.ok, stage: stageIdx.ok },
    agents,
    conversations: talk,
    tickets,
    worktrees: trees,
  }
}

async function getStatus(force) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data
  if (!building) {
    building = buildStatus()
      .then(data => {
        cache = { at: Date.now(), data }
        return data
      })
      .finally(() => {
        building = null
      })
  }
  return building
}

// ─── one agent, live ──────────────────────────────────────────────────────────

// Any file in public/ is served, by extension, so a new page file needs no
// server restart. Paths are resolved inside public/ and anything outside it,
// or of an unknown type, is a 404.
const PUBLIC = path.join(HERE, 'public')
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', // glossary.json (explain.js)
}

async function publicFile(pathname) {
  let rel
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname).slice(1)
  } catch {
    return null
  }
  const full = path.resolve(PUBLIC, rel)
  const type = TYPES[path.extname(full).toLowerCase()]
  if (!type || !full.startsWith(PUBLIC + path.sep)) return null
  try {
    const stat = await fs.stat(full)
    return stat.isFile() ? { full, type } : null
  } catch {
    return null
  }
}

/** The agent's activity since `since`, plus who it is and where it works. */
/** Adds readable names to message events, without touching the cached ones. */
function withNames(page, nameOf) {
  return {
    ...page,
    events: page.events.map(e =>
      e.tool === 'SendMessage' ? { ...e, summary: `to ${nameOf(e.to, e.to)}` } : e.kind === 'msg-in' ? { ...e, from: nameOf(e.fromSocket, e.from) } : e
    ),
  }
}

const ENDED_LABEL = 'Ended session' // what a session that is no longer running is called
const SUBAGENT_STATE = { working: 'active', done: 'done' } // a subagent's state as the live view's chip says it; anything else is idle

/**
 * A session by its id: the live one, or one that has ended, found by its transcript among the repo's
 * project folders (subagents.mjs sessionFile), so a subagent of an ended coordinator can still be opened.
 * null when there is no such session.
 */
async function sessionFor(sessionId) {
  const sessions = await liveSessions()
  const live = sessions.find(x => x.sessionId === sessionId)
  if (live) return { s: live, file: await transcriptFile(live), sessions, ended: false }
  const file = await sessionFile({ claudeDirs: CLAUDE_DIRS, match: CONFIG.sessionCwdMatch, sessionId })
  return file ? { s: { sessionId, name: ENDED_LABEL, cwd: REPO, status: 'ended' }, file, sessions, ended: true } : null
}

/** The agent block of an ended session: what the live view reads, with nothing running. */
function endedAgent(s, scan) {
  return {
    sessionId: s.sessionId, name: s.name, label: ENDED_LABEL, coding: false, status: 'ended', state: 'idle', ended: true, lastTool: null,
    cwd: s.cwd, updatedAt: null, transcriptAt: scan?.mtime ?? null,
    recentWorktrees: scan ? newestKeys(scan.worktrees, 4) : [], recentTickets: scan ? newestKeys(scan.tickets, 6) : [], subagents: [],
  }
}

/** One subagent for the live view, from the Subagents listing: found by id whatever its age or its parent's state. */
async function repoSub(sessionId, subId, trees) {
  const h = await oneSubagent({ claudeDirs: CLAUDE_DIRS, match: CONFIG.sessionCwdMatch, sessionId, id: subId, trees })
  return h && { id: h.id, description: h.description, agentType: h.agentType, model: h.model, finished: h.finished, state: SUBAGENT_STATE[h.state] || 'idle', updatedAt: h.updatedAt, worktree: h.worktree, tickets: h.tickets }
}

async function agentDetail(sessionId, subId, since) {
  const found = await sessionFor(sessionId)
  if (!found?.file) return null
  const { s, file, sessions, ended } = found
  const trees = await listWorktrees()
  const known = new Set(trees.map(w => path.basename(w.path)))
  const target = subId ? subagentFile(file, subId) : file
  let scan
  try {
    scan = await scanTranscript(target, subId ? '' : s.cwd.toLowerCase(), known)
  } catch {
    return null
  }
  const agent = ended ? endedAgent(s, subId ? null : scan) : await describeAgent(s, known)
  let sub = null
  if (subId) {
    // The agent's own list drops a subagent 30 minutes after it finishes and only knows worktrees under
    // .claude/worktrees: the Subagents listing finds any of them, and the worktree it really worked in.
    const listed = agent.subagents.find(x => x.id === subId)
    const subagent = await repoSub(sessionId, subId, trees)
    sub = listed ? { ...listed, worktree: listed.worktree || subagent?.worktree || '' } : subagent || { id: subId, description: 'subagent', state: 'idle' }
  }
  stripInternal(agent)
  return {
    agent,
    sub,
    state: sub ? sub.state : agent.state,
    worktrees: subId ? [sub.worktree].filter(Boolean) : agent.recentWorktrees,
    repoName: path.basename(REPO),
    ...withNames(feedSince(scan, since), makeNamer(sessions.map(x => ({ name: x.name, socket: x.messagingSocketPath })))),
  }
}

async function agentReport(sessionId, subId, hours) {
  const found = await sessionFor(sessionId)
  if (!found?.file) return null
  const { s, file, sessions, ended } = found
  const trees = await listWorktrees()
  const known = new Set(trees.map(w => path.basename(w.path)))
  let scan
  try {
    scan = await scanTranscript(subId ? subagentFile(file, subId) : file, subId ? '' : s.cwd.toLowerCase(), known)
  } catch {
    return null // an ended session whose transcript is gone
  }
  const label = ended ? ENDED_LABEL : labelOf(s.name)
  let subLabel = ''
  if (subId) {
    const sub = (await listSubagents(file, known)).find(x => x.id === subId) || (await repoSub(sessionId, subId, trees))
    subLabel = ` › subagent: ${sub?.description || subId}`
  }
  return buildReport({
    label: label + subLabel,
    events: scan.feed.events,
    hours,
    worktrees: Object.fromEntries(trees.map(w => [path.basename(w.path), w])),
    git,
    nameOf: makeNamer(sessions.map(x => ({ name: x.name, socket: x.messagingSocketPath }))),
    repoName: path.basename(REPO),
    prefixes: ticketPrefixes(),
  })
}

/**
 * `git status --porcelain` lines -> { code, file }. git() trims its output, so
 * the first line loses its leading space (" M a.js" arrives as "M a.js"):
 * cutting at a fixed column ate the path's first letter. Split at the first
 * space after the code instead. A rename ("R  old -> new") keeps the new path,
 * the one `git diff` names.
 */
function parseStatus(out) {
  return String(out || '')
    .split('\n')
    .filter(l => l.trim())
    .map(l => {
      const t = l.trimStart()
      const at = t.indexOf(' ')
      let file = t.slice(at + 1).trimStart()
      const arrow = file.indexOf(' -> ')
      if (arrow >= 0) file = file.slice(arrow + 4)
      return { code: t.slice(0, at), file }
    })
}

/** Uncommitted changes in one worktree ('main' = the main checkout). */
const diffCache = new Map()
async function worktreeDiff(name) {
  const trees = await listWorktrees()
  const wt = name === 'main' ? trees[0] : trees.find(w => path.basename(w.path) === name)
  if (!wt) return null
  const hit = diffCache.get(wt.path)
  if (hit && Date.now() - hit.at < 4000) return hit.data
  const [status, patch, log] = await Promise.all([
    git(['status', '--porcelain'], wt.path),
    git(['diff', 'HEAD', '--no-color', '--no-ext-diff'], wt.path),
    git(['log', '-5', '--format=%h%x09%cI%x09%s'], wt.path),
  ])
  const MAX = 400_000
  const data = {
    worktree: name,
    path: wt.path,
    branch: wt.branch,
    at: new Date().toISOString(),
    files: parseStatus(status.out),
    patch: patch.out.length > MAX ? `${patch.out.slice(0, MAX)}\n… diff cut at 400 KB` : patch.out,
    log: log.out.split('\n').filter(Boolean).map(l => {
      const [sha, when, subject] = l.split('\t')
      return { sha, when, subject }
    }),
  }
  diffCache.set(wt.path, { at: Date.now(), data })
  return data
}

// ─── flow ─────────────────────────────────────────────────────────────────────

/**
 * What each coding agent did on each task, as a flowchart (flow.mjs). Built
 * from the same transcript scans as the rest (cached, read incrementally) and
 * read-only git. `hours` 0 = everything the feeds still hold.
 */
const flowCache = new Map() // hours -> { at, data }
const flowBuilding = new Map()
async function getFlow(hours, force) {
  const hit = flowCache.get(hours)
  if (!force && hit && Date.now() - hit.at < 20_000) return hit.data
  if (!flowBuilding.has(hours)) {
    flowBuilding.set(
      hours,
      buildFlowData(hours)
        .then(data => {
          flowCache.set(hours, { at: Date.now(), data })
          return data
        })
        .finally(() => flowBuilding.delete(hours))
    )
  }
  return flowBuilding.get(hours)
}

async function buildFlowData(hours) {
  const started = Date.now()
  const [sessions, trees, sources] = await Promise.all([liveSessions(), listWorktrees(), loadSources()])
  const known = new Set(trees.map(w => path.basename(w.path)))
  const coordinator = labelOf(CONFIG.coordinator)
  const lanes = []
  for (const s of sessions.filter(x => x.name in CODING_AGENTS)) {
    const file = await transcriptFile(s)
    if (!file) continue
    let scan
    try {
      scan = await scanTranscript(file, s.cwd.toLowerCase(), known)
    } catch {
      continue
    }
    const events = scan.feed.events
    const since = hours > 0 ? Date.now() - hours * 3600_000 : new Date(events[0]?.t || Date.now()).getTime()
    const subs = await subagentsSince(file, known, since)
    const fresh = scan.mtime && Date.now() - new Date(scan.mtime) < 60_000
    lanes.push({
      label: labelOf(s.name),
      sessionId: s.sessionId,
      coordinator: s.name === CONFIG.coordinator,
      state: stateOf(scan, s.status === 'busy' || Boolean(fresh)).state,
      events,
      subagents: subs.map(x => ({ ...x, events: x.scan.feed.events, scan: undefined })),
    })
  }
  lanes.sort((a, b) => Number(b.coordinator) - Number(a.coordinator) || a.label.localeCompare(b.label))
  const dirty = new Map((cache?.data.worktrees || []).map(w => [w.name, w.dirty]))
  const data = await buildFlow({
    lanes,
    hours,
    worktrees: trees,
    git,
    nameOf: makeNamer(sessions.map(x => ({ name: x.name, socket: x.messagingSocketPath }))),
    coordinator,
    titleOf: id => sources.tickets?.[id]?.title || '',
    dirtyOf: name => dirty.get(name) ?? null,
    repo: REPO,
  })
  data.buildMs = Date.now() - started
  return data
}

// ─── http ─────────────────────────────────────────────────────────────────────

const SUBAGENT_CREDIT_DAYS = 7 // how far back the Tickets grid looks for the subagent that built a ticket

/** ticket id -> the subagent that built it, for the Tickets grid (subagents.mjs ticketBuilders), labelled by the session that started it. */
async function subagentBuilds() {
  const [trees, sessions] = await Promise.all([listWorktrees(), liveSessions()])
  const labels = new Map(sessions.map(s => [s.sessionId, labelOf(s.name)]))
  const subagents = await listRepoSubagents({ claudeDirs: CLAUDE_DIRS, match: CONFIG.sessionCwdMatch, sinceMs: windowStart(SUBAGENT_CREDIT_DAYS), trees })
  return ticketBuilders(subagents, id => labels.get(id) || '')
}

const orchestration = makeOrchestration({ git, getStatus, listWorktrees, subagentBuilds })
/**
 * Whether `agent` has a session open: a live session by that name or by its dashboard label; a pinned agent whose
 * session is closed does not count. The relay asks this before every paid turn (relay.mjs, no turn for nobody).
 */
async function agentHasSession(agent) {
  const want = String(agent ?? '').trim().toLowerCase()
  return (await liveSessions()).some(s => !s.pinned && [s.name, labelOf(s.name)].some(n => String(n ?? '').trim().toLowerCase() === want))
}
/** Pushes the user's flow answers to the agent that asked, with a headless Claude turn (relay.mjs). */
const relay = makeRelay({ run: claudeRun, present: agentHasSession })
// Answers a previous run queued but never delivered get a retry on the page, not silence (relay.mjs sweep).
const lostAnswers = relay.sweep()
if (lostAnswers.length) console.log(`relay: ${lostAnswers.length} answer(s) not sent before the last stop are marked for retry`)
// A QA failure going back to its producer is written by QA's own shell: the server notices it, now and every 15 s (qa-rework.mjs).
startReworkWatch(relay)
/**
 * The Subagents page (subagent-routes.mjs): every subagent of the repo's sessions, live or ended, read
 * from the transcripts, with the state of its pull requests from `gh pr view` (read only).
 */
const subagentRoute = makeSubagentRoutes({
  claudeDirs: CLAUDE_DIRS,
  match: CONFIG.sessionCwdMatch,
  listWorktrees,
  sessions: async () => new Map((await liveSessions()).map(s => [s.sessionId, { label: labelOf(s.name) }])),
  flows: () => listFlows({ archived: 'any' }).flows, // an archived flow is still its subagent's flow
  prStates: makePrStates({ gh }),
})
/** The SCRIPT Generator (script-routes.mjs): POST /api/script/generate, one paid Opus run at a time, streamed. */
/**
 * What SCRIPT can be told (script-context-routes.mjs): the orchestration brief, written fresh from the config, the
 * agents' saved rules and the pipeline score (script-brief-extras.mjs) on
 * each read, and the RUNNING sessions by dashboard label (a pinned session that is closed is not running), each
 * with its transcript, read only when the user presses Generate.
 */
const scriptContext = {
  brief: () => {
    const graph = pipelineGraph(CONFIG)
    return orchestrationBrief({ config: CONFIG, graph, extras: briefExtras({ graph }) })
  },
  sessions: async () => (await liveSessions()).filter(s => !s.pinned).map(s => ({ label: labelOf(s.name), state: s.status === 'busy' ? 'working' : 'idle', transcript: () => transcriptFile(s) })),
}
const scriptRoute = makeScriptRoute({ port: PORT, gather: makeContextGatherer(scriptContext), log: appendRun, skill: findSkill })
const scriptContextRoute = makeScriptContextRoute({ port: PORT, ...scriptContext })
/** The SCRIPT run log (script-log-routes.mjs): the newest 50 runs, for the page's History list. */
const scriptLogRoute = makeScriptLogRoute({ port: PORT })
/** The Standup creator (standup-routes.mjs): POST /api/standup/generate and GET /api/standup/log. */
const standupRoute = makeStandupServerRoute({ port: PORT, git, prefixes: ticketPrefixes })
const qualityRoute = makeQualityServer({ port: PORT, git }) // the lessons, the self-check, the plan critic, risk labels
/**
 * The Project menu and the Orchestration bank (projects-routes.mjs). A switch restarts this process (restart.mjs):
 * whether the keep-alive loop runs it is read once now, off the request path.
 */
const supervised = underKeepAlive()
const projectRoute = makeProjectRoutes({
  port: PORT, relay, restart: () => restartServer(), chatBusy: () => chatStatus().busy,
  gitTop: async dir => { const r = await git(['rev-parse', '--show-toplevel'], dir); return r.ok ? r.out : null },
  sessionNames: async () => (await liveSessions()).map(s => s.name),
})
/** Each agent's model, effort, files and notes, from its window on the Agents page (agent-settings-routes.mjs). */
const agentSettingsRoute = makeAgentSettingsRoute({ port: PORT })
/** The Phone card on Settings (phone-desktop-routes.mjs): on this 127.0.0.1 listener only. */
const phoneRoute = makePhoneDesktopRoute({ port: PORT })
/** Pipeline tokens (token-routes.mjs): what the transcripts spent, from a running index built in the background. */
const tokenRoute = makeTokenRoute({ claudeDirs: CLAUDE_DIRS, match: CONFIG.sessionCwdMatch, names: async () => new Map((await liveSessions()).map(s => [s.sessionId, s.name])), labelOf, placed: o => predictRoute.placed(o) })
/** Predict and warn (predict-routes.mjs): alerts, estimates and per flow tokens, on Pipeline tokens' own index. No model runs. */
const predictRoute = makePredictRoute({ index: tokenRoute.index, names: async () => new Map((await liveSessions()).map(s => [s.sessionId, s.name])), live: async () => new Map((await liveSessions()).filter(s => !s.pinned).map(s => [s.sessionId, s.name])), labelOf, riskOf: riskLevelOf(riskOf) })
// Routing reads the risk level (quality) and a flow's tokens (predict); a flow's outcome line waits until its tokens
// are final: its finishing hour closed in the transcripts Predict last placed from
wireRouting({ riskOf, flowTokens, tokensReady: at => tokensFinal(at, { building: tokenRoute.snapshot().building, placedThrough: predictRoute.placedThrough() }) })
const routingRoute = makeRoutingRoute({ port: PORT }) // the Routing page, ticket intake, a flow task type (routing-routes.mjs)
/** The Pull requests list (prlist-routes.mjs): every flow's open pull request, read only, gh asked at most once a minute. */
const prListRoute = makePrListRoute({ gh, git, remote: () => prNow().remote })
/** The Learn page (learn-wiring.mjs): retrospectives, the weekly Learn run and a verdict on every rule change. */
const learnRoute = makeLearnServerRoute({ port: PORT, tokens: () => tokenRoute.snapshot(), lessons: learnLessons(listLessons), signals: learnSignals(signals) })
/** Master's insight (insight-wiring.mjs): the digest it reads in one go, its suggestions, and the self-healing watchdog. */
const insightServer = makeInsightServer({ port: PORT, cachedStatus: () => cache?.data ?? null, getStatus, relay, tokenRoute, predictRoute, prListRoute, present: agentHasSession, sessionNames: async () => new Map((await liveSessions()).map(s => [s.sessionId, s.name])), labelOf })
/** The paths factory-routes.mjs answers. */
const FACTORY_PREFIXES = ['/api/factory', '/api/chat', '/api/flows', '/api/trash', '/api/archive', '/api/human', '/api/tickets/', '/api/commit', '/api/explain', '/api/glossary', '/api/since', '/api/spend', '/api/settings', '/api/pipeline', '/api/qa', '/api/agents/rules', '/api/score', '/api/log', '/api/time', '/evidence/', '/api/outputs']

const server = createServer(async (req, res) => {
  // a website that rebinds its name to 127.0.0.1 sends its own Host: only requests addressed to us are answered (local-origin.mjs)
  if (!hostAllowed(req.headers.host, PORT)) return res.writeHead(403, { 'content-type': 'text/plain' }).end('Unknown host.')
  const url = new URL(req.url, 'http://localhost')
  const began = Date.now()
  res.on('finish', () => insightServer.noteWork(`${req.method} ${url.pathname}`, Date.now() - began)) // the watchdog's Server check
  projectRoute.track(req, res) // a write still being answered holds a project switch back
  try {
    if (await projectRoute(req, res, url)) return
    if (FACTORY_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) {
      // `fetched`: Send reuses the server's own fetch of origin when it is under a minute old (pr-routes.mjs)
      const fetched = remote => (remote === 'origin' && fetchState.ok ? fetchState.at : null)
      if (await factoryRoute(req, res, url, { git, gh, push, port: PORT, fetched, relay, getStatus, pipelineConfig: CONFIG, onCompleted: learnRoute.completed })) return
    }
    if (await scriptRoute(req, res, url)) return
    if (await scriptContextRoute(req, res, url)) return
    if (await scriptLogRoute(req, res, url)) return
    if (await standupRoute(req, res, url)) return
    if (await qualityRoute(req, res, url)) return
    if (await agentSettingsRoute(req, res, url)) return
    if (await subagentRoute(req, res, url)) return
    if (await tokenRoute(req, res, url)) return
    if (await predictRoute(req, res, url)) return
    if (await routingRoute(req, res, url)) return
    if (await learnRoute(req, res, url)) return
    if (await phoneRoute(req, res, url)) return
    if (await prListRoute(req, res, url)) return
    if (await insightServer.route(req, res, url)) return
    if (url.pathname === '/api/orchestration') {
      const data = await orchestration(url.searchParams.get('c'), url.searchParams.has('refresh'))
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(data))
    }
    if (url.pathname === '/api/pulse') {
      const data = await pulse({ getStatus, chatStatus })
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(data))
    }
    if (url.pathname === '/api/status') {
      const data = await getStatus(url.searchParams.has('refresh'))
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(data))
    }
    if (url.pathname === '/api/agent') {
      const data = await agentDetail(url.searchParams.get('session'), url.searchParams.get('sub'), Number(url.searchParams.get('since') || 0))
      res.writeHead(data ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(data ?? { error: 'no such session' }))
    }
    if (url.pathname === '/api/report') {
      const md = await agentReport(url.searchParams.get('session'), url.searchParams.get('sub'), Number(url.searchParams.get('hours') ?? 4))
      res.writeHead(md ? 200 : 404, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(md ?? 'no such session')
    }
    if (url.pathname === '/api/flow') {
      const hours = Math.max(0, Number(url.searchParams.get('hours') ?? 24) || 0)
      const data = await getFlow(hours, url.searchParams.has('refresh'))
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(data))
    }
    if (url.pathname === '/api/diff') {
      const data = await worktreeDiff(url.searchParams.get('worktree') || '')
      res.writeHead(data ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(data ?? { error: 'no such worktree' }))
    }
    const file = await publicFile(url.pathname)
    if (file) {
      // Fonts never change; everything else is re-read so an edit shows on reload.
      const cache = file.type === 'font/woff2' ? 'public, max-age=604800' : 'no-store'
      res.writeHead(200, { 'content-type': file.type, 'cache-control': cache })
      return res.end(await fs.readFile(file.full))
    }
    res.writeHead(404).end('not found')
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(e?.stack || e))
  }
})

/** Closes this server and starts the next one after a switch (restart.mjs); never two, never none. */
const restartServer = makeRestarter({ server, loop: () => supervised })
// After a switch started by hand, the old server is still letting the port go: wait for it, then for the port.
await waitForPredecessor()
if (!(await listenWhenFree(server, PORT, '127.0.0.1'))) process.exit(1)
console.log(`Yz Agent Orchestration on http://127.0.0.1:${PORT}${CONFIG.project ? ` (project ${CONFIG.project.name})` : ''}`)
// Phone access (phone-wiring.mjs): a second listener on one private address, ONLY when config.json's remote block turns it on
// prs: the Pull requests list the fog block shows (prlist-store.mjs), read from memory: the phone asks gh nothing itself
startPhone({ getStatus, relay, run: claudeRun, sessions: liveSessions, transcriptFile, gh, alerts: () => predictRoute.alerts(), prs: () => prListRoute.list.snapshot().items })

await fetchOrigin()
setInterval(fetchOrigin, FETCH_EVERY_MS).unref()
startAutoRefresh()
tokenRoute.start() // Pipeline tokens: the first read of the transcripts, in the background
qualityRoute.start() // risk labels, and the automatic lesson and second-opinion runs (quality-watch.mjs)
predictRoute.start() // Predict and warn: an estimate stored once on each open flow, now and every minute
routingRoute.start() // Routing: each finished flow gets its one outcome line (routing-outcomes.mjs), once a minute
prListRoute.start() // the Pull requests list: the states read now and every minute, in the background
insightServer.start() // the watchdog: its checks now and every minute, its four safe repairs (heal-runner.mjs)

// ─── end-of-day stop ───────────────────────────────────────────────────────────────

const startedAt = new Date()
const curfew = new Date(startedAt)
if (CURFEW_HOUR != null) curfew.setHours(CURFEW_HOUR, 0, 0, 0)
if (CURFEW_HOUR != null && startedAt < curfew) {
  setTimeout(() => {
    console.log(`${CURFEW_HOUR}:00: end of the working day, stopping the dashboard`)
    server.close()
    process.exit(0)
  }, curfew - startedAt)
}
