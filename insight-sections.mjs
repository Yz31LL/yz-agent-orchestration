// The digest's six parts as DATA (insight-digest.mjs puts them in words): what the coordinator needs to plan from,
// worked out from the same stores the pages read. ⚠️ PURE: no file, no clock, no config, no git, no gh, no model,
// no transcript scan. Every input is passed in (insight-gather.mjs reads them, from the running server's memory or
// from the files), so a test seeds exactly what it wants.
//
//   pipelineData({ graph, status, settings })            the boxes in route order and who is on each
//   workData({ flows, graph, now, prs })                 open flows by stage, what waits on the user, gate stops, PRs
//   numbersData({ flows, graph, now, tokens })           score, time and tokens for 7 and 30 days, against the period before
//   signalsData({ alerts, misses, lessons, runs, verdicts, outcomes, now })
//   suggestionsData({ list, readAt })                    Master's own suggestions and what the user did
// Health is the runner's own view (heal-runner.mjs view), passed through as it is.
//
// LEFT OUT, NEVER INVENTED: an input that is null (not available here: no running dashboard, a store still being
// built) puts one plain line in the part's `left` list, and the words say it is left out. A figure with nothing under
// it is null, never 0.

import { entryOf, FIXED, FIXED_ROLES } from './agent-settings.mjs'
import { outputsSummary } from './completed.mjs'
import { stoppedBy } from './flows.mjs'
import { humanItems } from './human.mjs'
import { stageOf } from './pipeline.mjs'
import { currentStage } from './predict-stage.mjs'
import { cellOf, scoreOf } from './score.mjs'
import { timeStats } from './time-stats.mjs'
import { tokenStats } from './token-usage.mjs'

export const DAY = 86_400_000
export const PERIODS = Object.freeze([7, 30])
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const timeOf = v => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? null : t
}
/** A live flow: not dropped, archived, deleted or signed off. */
const live = f => isObj(f) && isText(f.id) && f.status !== 'dropped' && !f.archivedAt && !f.deletedAt && !f.completedAt

// ═══ Pipeline ═══

/** What an agent box's session is doing: busy, idle, or no session (no live session under that label). */
function stateOf(sessions) {
  if (!sessions.length) return 'no session'
  return sessions.some(s => s.status === 'busy' || s.state === 'active') ? 'busy' : 'idle'
}

/**
 * The boxes in route order. An agent box carries its session state, the model and effort set for it on the Agents
 * page (or the fixed ones of the planner, Security and Senior), the model its newest reply ran on, and its running
 * subagents. `status` null: the states are left out.
 */
export function pipelineData({ graph, status = null, settings = { agents: {} } }) {
  const left = []
  if (!status) left.push('who is busy, idle or has no session: the dashboard is not running, so no session was read')
  const agents = Array.isArray(status?.agents) ? status.agents : []
  const boxes = (graph?.nodes || []).map(n => {
    if (n.kind !== 'agent') return { label: n.label, role: n.role, kind: n.kind }
    const mine = agents.filter(a => a.label === n.label)
    const fixed = FIXED_ROLES.includes(n.role)
    const set = fixed ? FIXED : entryOf(settings, n.label)
    const subs = mine.flatMap(a => (Array.isArray(a.subagents) ? a.subagents : [])).filter(s => s?.state === 'working' || s?.state === 'active')
    return {
      label: n.label, role: n.role, kind: n.kind,
      state: status ? stateOf(mine) : null,
      model: set.model || null, effort: set.effort || null, fixed,
      ranOn: mine.map(a => a.model).find(isText) || null,
      subagents: status ? subs.map(s => String(s.description || s.id || 'a subagent')) : null,
      lastTool: mine.map(a => a.lastTool?.tool).find(isText) || null,
    }
  })
  return { boxes, left }
}

// ═══ Work ═══

const STAGE_WORDS = {
  ask: 'a question is open', blocked: 'blocked', stopped: 'stopped by a gate', human: 'by-hand steps',
  push: 'passed, waiting to be pushed', rework: 'back for a fix', planning: 'planning', producing: 'producing', qa: 'with QA', security: 'with Security', senior: 'with Senior',
}

/**
 * Open flows by stage (currentStage: where it stands and since when; a flow it cannot date stands where stageOf puts
 * it, with no age), oldest at its stage first; what waits on the user; flows a gate stopped; open pull requests.
 * `prs` null: the pull requests are left out (they are read from GitHub by the running dashboard only).
 */
export function workData({ flows = [], graph, now, prs = null }) {
  const list = (Array.isArray(flows) ? flows : []).filter(live)
  const open = list.filter(f => f.status === 'open' || f.status === 'blocked')
  const stages = new Map()
  for (const f of open) {
    let cs = null
    try {
      cs = currentStage(f, graph)
    } catch {
      cs = null
    }
    let where
    if (cs) where = `${cs.onYou ? 'On the user' : cs.who}, ${STAGE_WORDS[cs.key] || cs.key}`
    else {
      let node = null
      try {
        node = (graph?.nodes || []).find(x => x.id === stageOf(f, graph).node)
      } catch {
        node = null
      }
      where = node ? `${node.label}` : 'where it stands is not known'
    }
    if (!stages.has(where)) stages.set(where, [])
    stages.get(where).push({ id: f.id, title: String(f.title || f.id), agent: String(f.agent || ''), ageMs: cs && Number.isFinite(cs.since) ? Math.max(0, now - cs.since) : null, blocked: f.status === 'blocked' })
  }
  const byStage = [...stages].map(([where, fl]) => ({ where, flows: fl.sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1)) }))
    .sort((a, b) => (b.flows[0].ageMs ?? -1) - (a.flows[0].ageMs ?? -1))

  const { items } = humanItems({ flows: list })
  const since = iso => (timeOf(iso) === null ? null : Math.max(0, now - timeOf(iso)))
  const pick = kind => items.filter(i => i.kind === kind).map(i => ({ id: i.flowId, title: i.title, agent: i.agent, ageMs: since(i.since), text: i.kind === 'ask' ? i.ask.title : i.reason }))
  const signoff = outputsSummary(flows, graph, undefined, now)
  const stopped = list.filter(f => stoppedBy(f)).map(f => ({ id: f.id, title: String(f.title || f.id), by: stoppedBy(f), agent: String(f.agent || ''), ageMs: since(f.updatedAt) }))
  return {
    open: open.length,
    byStage,
    waiting: { asks: pick('ask'), hand: pick('hand'), blocked: pick('blocked'), signoff: { count: signoff.counts.waiting, overdue: signoff.counts.overdue, oldest: signoff.waiting.slice(0, 3).map(w => ({ id: w.id, title: w.title })) } },
    stopped,
    prs: Array.isArray(prs) ? prs.map(p => ({ label: p.label, title: p.title, checks: p.checks || null, needs: p.needs || null, flow: p.flow?.id || null, draft: !!p.draft })) : null,
    left: Array.isArray(prs) ? [] : ['open pull requests and their checks: they are read from GitHub by the running dashboard only'],
  }
}

// ═══ Numbers ═══

const ratio = (top, bottom) => (bottom > 0 ? top / bottom : null)

/**
 * The scorecard's figures over [from, to): ⚠️ scoreOf's window has no end (score.mjs windowOf: every time at or after
 * `from` counts), so the period BEFORE is worked out as the difference of two scorecards that both end now: the
 * counts over 2d days less the counts over the last d days. Every count it sums is one per event at its own time, so
 * the difference is exact.
 */
function scoreBetween(flows, graph, now, days, back) {
  const wide = scoreOf(flows, graph, { now, days: days + back })
  const near = back ? scoreOf(flows, graph, { now, days: back }) : null
  const c = k => wide.counts[k] - (near ? near.counts[k] : 0)
  const right = wide.correctness.right - (near ? near.correctness.right : 0)
  const judged = wide.correctness.judged - (near ? near.correctness.judged : 0)
  return {
    precision: ratio(c('delivered'), c('delivered') + c('slipped')), recall: ratio(c('delivered'), c('delivered') + c('missed')),
    rightFirstTime: ratio(right, judged), judged, delivered: c('delivered'),
  }
}

/**
 * The flows as they stood at `cut`, for Pipeline time's period before: those that finished after it are left out
 * (timeStats, like the scorecard, has no end to its window), the rest are as they are.
 */
function asAt(flows, graph, now, cut) {
  return flows.filter(f => {
    let time = null
    try {
      const c = cellOf(f, graph, now, 7 * DAY)
      time = c.cell === null ? null : c.time
    } catch {
      time = null
    }
    return time === null || time < cut
  })
}

/** Score, time and tokens for the `days` days that end `back` days before `now`. */
function windowNumbers({ flows, graph, now, days, back, tokens }) {
  const at = now - back * DAY
  const time = timeStats(back ? asAt(flows, graph, now, at) : flows, graph, { now: at, days })
  const out = {
    score: scoreBetween(flows, graph, now, days, back),
    time: {
      finished: time.finished.tickets + time.finished.jobs, perDay: time.rates.perDay, medianMs: time.took?.median ?? null, waitShare: time.waiting?.share ?? null,
      stages: time.stages.filter(s => Number.isFinite(s.median)).sort((a, b) => b.median - a.median).slice(0, 3).map(s => ({ label: s.label, medianMs: s.median })),
    },
    tokens: null,
  }
  // the token index counts per local day and stops at the day of `now` (token-usage.mjs tokenStats): a moved `now` is exact
  if (tokens && Array.isArray(tokens.files) && !tokens.building) {
    const t = tokenStats({ files: tokens.files, now: at, days, prices: tokens.prices || {}, names: tokens.names || new Map(), labelOf: tokens.labelOf || (n => n), finished: time.finished })
    out.tokens = {
      all: t.totals.all ?? null, usd: t.cost.usd, cacheShare: t.cacheShare, perJobUsd: t.perJob?.usd ?? null,
      agents: t.agents.slice(0, 4).map(a => ({ label: a.label, usd: a.usd, all: a.all })),
    }
  }
  return out
}

/** For each of 7 and 30 days: the numbers now and for the period of the same length just before. */
export function numbersData({ flows = [], graph, now, tokens = null }) {
  const left = []
  if (!tokens) left.push('Pipeline tokens: the token index could not be read')
  else if (tokens.building) left.push('Pipeline tokens: the token index is still being built')
  const periods = PERIODS.map(days => ({
    days,
    now: windowNumbers({ flows, graph, now, days, back: 0, tokens }),
    before: windowNumbers({ flows, graph, now, days, back: days, tokens }),
  }))
  return { periods, left }
}

// ═══ Signals ═══

/**
 * The grouped alerts (public/predict-group.js, the same grouping and words as the Alerts line), estimate misses,
 * the lessons hit most, Learn's last proposals and what the user did with them, rule changes with a verdict due, and
 * the routing suggestions followed or not with how they went. `alerts` null: left out.
 */
export function signalsData({ alerts = null, group = null, misses = [], lessons = [], runs = [], verdicts = [], outcomes = [], now }) {
  const left = []
  let alertPart = null
  if (alerts && group) {
    const items = group.groupAlerts(Array.isArray(alerts.alerts) ? alerts.alerts : [])
    alertPart = { count: items.length, kinds: group.kindsText(items), lines: items.map(group.lineOf), hidden: Number(alerts.hidden) || 0, building: !!alerts.building }
  } else left.push('the alerts: they are worked out by the running dashboard only')
  const run = (Array.isArray(runs) ? runs : [])[0] || null
  const learn = run ? {
    at: run.at, ok: run.ok !== false, error: run.error || null,
    proposals: (run.proposals || []).map(p => ({ target: p.target, action: p.action, rule: p.rule || p.old || '', state: p.state || 'open', reason: p.reason || '' })),
  } : null
  const due = (Array.isArray(verdicts) ? verdicts : []).filter(c => c?.state === 'waiting' && timeOf(c.dueAt) !== null && timeOf(c.dueAt) <= now)
    .map(c => ({ label: c.label, by: c.by, added: c.added || [], removed: c.removed || [], dueAt: c.dueAt }))
  const lines = Array.isArray(outcomes) ? outcomes.filter(isObj) : []
  const side = followed => {
    const l = lines.filter(x => x.followed === followed)
    const judged = l.filter(x => typeof x.passedFirstTime === 'boolean')
    return { flows: l.length, judged: judged.length, firstTime: judged.length ? judged.filter(x => x.passedFirstTime).length / judged.length : null }
  }
  return {
    alerts: alertPart,
    misses: (Array.isArray(misses) ? misses : []).slice(0, 5).map(m => m.text),
    lessons: (Array.isArray(lessons) ? lessons : []).filter(l => l?.status !== 'retired' && Number(l?.count) > 0).slice(0, 3).map(l => ({ text: l.text, count: l.count, area: l.area })),
    learn,
    due,
    routing: { followed: side(true), notFollowed: side(false), recorded: lines.length },
    left,
  }
}

// ═══ Suggestions ═══

/** Master's suggestions: the open ones, every one decided since `readAt` (its last read), and the rejected ideas. */
export function suggestionsData({ list = [], readAt = null, broken = false }) {
  const all = Array.isArray(list) ? list : []
  const from = timeOf(readAt)
  const newer = s => from === null || (timeOf(s.decidedAt) ?? 0) > from
  return {
    broken,
    open: all.filter(s => s.state === 'open').map(s => ({ id: s.id, kind: s.kind, target: s.target, text: s.text, at: s.at })),
    decided: all.filter(s => s.state !== 'open' && newer(s)).map(s => ({ id: s.id, state: s.state, text: s.text, reason: s.reason, outcome: s.outcome, decidedAt: s.decidedAt })),
    rejected: all.filter(s => s.state === 'rejected').slice(-10).map(s => ({ id: s.id, target: s.target, text: s.text, reason: s.reason })),
    counts: { open: all.filter(s => s.state === 'open').length, accepted: all.filter(s => s.state === 'accepted').length, rejected: all.filter(s => s.state === 'rejected').length, done: all.filter(s => s.state === 'done').length },
  }
}
