// The orchestration on the phone (the Agents tab): READ ONLY, built from the very functions the desktop Agents page
// uses, then trimmed to what a 390 px screen shows. Two actions (phone-actions.mjs maps them, phone-server.mjs serves
// them as GET /phone/api/orchestration and GET /phone/api/flow?id=):
//
//   orchestration()   { builtAt, agentsKnown, boxes, others, alerts, prs }
//     boxes    the pipeline's boxes in route order (pipeline.mjs pipelineGraph: Request, the coordinator, the planner,
//              the producers, the chat agent, QA, Security, Human task, Senior, Push, Output, only those the config
//              draws), each { id, label, role, kind, state, flows, more }. `state` is the agent's: busy, idle or none
//              (no session open), null for a fixed step or while the PC still builds the agent list (agentsKnown
//              false). `flows` are the flows standing there, at most FLOWS_MAX (the phone shows CHIPS_MAX of them
//              and a +N more button for the rest, public/phone-agents.js), each { id, title (cut), word, tone },
//              and `more` how many past FLOWS_MAX (said in words on the phone);
//              found as the desktop finds them (pipeline-routes.mjs pipelineGet, the current step of each flow's
//              progress, else its stage); archived and completed ones are not on the board, as on the desktop.
//     others   running sessions that are no box, { label, state }; a raw session id is an Unnamed session
//     alerts   { count, kinds, lines: the first ALERT_LINES in one line each, cut } from Predict and warn
//              (predict-routes.mjs alertsGet, injected), or null when it is off or cannot be read. ⚠️ Grouped,
//              counted and worded by public/predict-group.js, the SAME file the desktop Alerts line uses: an agent
//              holding 8 flows longer than usual is ONE alert on both (the phone once said 10 where the PC said 3).
//     prs      the open pull requests: the desktop's OWN Pull requests list (prlist-store.mjs, the fog block on the
//              Agents page and Home, given here as the `prs` provider), in its order, trimmed to { title, url,
//              number, flow } (`flow` the flow's id, so the phone opens the pull request there: phone-pr.mjs), only https://github.com/<owner>/<repo>/pull/<n> addresses, at most PRS_MAX. ⚠️ The phone
//              never reads pull requests off the flows or asks gh itself: one list, one gh cadence (at most once a
//              minute), so the phone and the desktop never disagree. With no provider, or one that throws, hangs or
//              answers junk, the list is empty and the tab still answers.
//   flow({ id })      one flow's sheet: { id, title, tickets, where, type, route, story, qa, asks, pr }. The id is
//              checked against the flow id pattern BEFORE any lookup (400); a flow that is not there (deleted, in
//              the Trash) is a 404, and so is one that is archived or completed (put away: the PC has it). `asks`
//              are its unanswered questions while the flow is still on its way (the phone answers them with the
//              existing answer action, which refuses anything else); `route` is its progress, each step { label,
//              state }; `qa` QA's last verdict in a word, with its summary cut. `pr` is { url, number, state: open
//              or draft } ONLY when the Pull requests list (the `prs` provider) has one for this flow, else null:
//              the flow record alone can say open after GitHub merged or closed it.
//
// Every text field here is HOSTILE (agents, tickets and transcripts wrote it): it is sent as plain JSON text, cut
// to a length, and the phone renders it with esc only (public/phone-agents.js). Nothing here writes anything.

import { CONFIG } from './config.mjs'
import { qaView } from './flow-qa.mjs'
import { withRoute } from './flow-route.mjs'
import { readFlow, storyOf } from './flows.mjs'
import { pipelineGet } from './pipeline-routes.mjs'
import { pipelineGraph, stageOf } from './pipeline.mjs'
// a plain browser script that puts PredictGroup on globalThis when imported (it has no exports): the page's own
import './public/predict-group.js'

const PredictGroup = globalThis.PredictGroup

export const CHIPS_MAX = 6
/** Flows a box sends: the phone unfolds them behind +N more (QA, 2026-11-26: +N more was plain text). */
export const FLOWS_MAX = 40
export const CHIP_TITLE_MAX = 60
export const ALERT_LINES = 2
export const ALERT_LINE_MAX = 160
const PRS_MAX = 10
const TITLE_MAX = 200
const STORY_LINES = 8
const STORY_TEXT_MAX = 200
const QA_SUMMARY_MAX = 300
const TICKETS_MAX = 10
/** How long the tab waits for the agent list or the alerts: a cold status build can take far longer. */
export const WAIT_MS = 3000
const SLUG = /^[a-z0-9-]{1,80}$/
const GITHUB_PR = /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\/pull\/\d{1,9}$/
const RAW_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i

/** MUST CHANGE IN LOCKSTEP with public/pipeline-tickets.js WORD and QA_WORD: the desktop's words for a stage. */
const WORD = { working: 'Working', blocked: 'Blocked', waiting: 'Waiting', pending: 'Queued', testing: 'Being tested', reviewing: 'Being reviewed', rework: 'Sent back', failed: 'Failed', passed: 'Passed', done: 'Done', dropped: 'Dropped' }
const QA_WORD = { passed: 'Passed', failed: 'Failed', 'qa-failed': 'Failed', testing: 'Being tested', pending: 'Queued' }
/** What needs the user comes first on a box, as on the desktop (pipeline-tickets.js ATTENTION). */
const ATTENTION = { failed: 0, rework: 1, blocked: 2, waiting: 3 }

const ok = body => ({ status: 200, body })
const no = (status, error) => ({ status, body: { error } })
const cut = (v, max) => {
  const s = String(v ?? '')
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s
}
/** Only a flow still on its way waits on a question: MUST CHANGE IN LOCKSTEP with phone-actions.mjs live. */
const live = f => (f.status === 'open' || f.status === 'blocked') && !f.archivedAt && !f.completedAt
const shownLabel = l => {
  const s = String(l || '').trim()
  return !s || RAW_ID.test(s) ? 'Unnamed session' : s
}

/** `promise`, or `fallback` once `ms` pass; a throw is the fallback too. */
async function within(promise, ms, fallback) {
  let timer
  try {
    const late = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms) })
    return await Promise.race([Promise.resolve(promise).catch(() => fallback), late])
  } finally {
    clearTimeout(timer)
  }
}

/** Where a flow stands on the board: its progress's current step, the Output once every step is done, else its stage. */
function nodeOf(t) {
  const list = Array.isArray(t.progress) ? t.progress : []
  const now = list.find(s => s.state === 'current')
  if (now) return now.node
  const last = list.at(-1)
  if (last?.node === 'outcome' && last.state === 'done') return 'outcome'
  return t.stage?.node || null
}
const statusOf = t => (t.stage?.node ? String(t.stage.status || '') : 'dropped')
const toneOf = t => {
  const s = statusOf(t)
  if (s === 'failed' || s === 'rework' || t.qa?.status === 'failed' || t.qa?.status === 'qa-failed') return 'bad'
  return s === 'passed' ? 'ok' : ''
}

export function makeOrchestration({ getStatus, alerts = async () => null, prs = () => [], config = CONFIG, now = Date.now, agentsWaitMs = WAIT_MS }) {
  /** label -> busy | idle for every session running now, or null while the PC still builds the list. */
  async function agentStates() {
    const st = await within(getStatus(false), agentsWaitMs, null)
    if (!st || !Array.isArray(st.agents)) return null
    const states = new Map()
    for (const a of st.agents) {
      const label = shownLabel(a?.label)
      const busy = a?.state === 'active' || a?.status === 'busy'
      if (busy || !states.has(label)) states.set(label, busy ? 'busy' : 'idle')
    }
    return states
  }

  /** Counted and worded as the desktop Alerts line does, with the very same function (public/predict-group.js). */
  async function alertLines() {
    const r = await within(alerts(), agentsWaitMs, null)
    const b = r?.body
    if (!b || b.enabled === false || !Array.isArray(b.alerts)) return null
    const list = PredictGroup.groupAlerts(b.alerts)
    return { count: list.length, kinds: cut(PredictGroup.kindsText(list), ALERT_LINE_MAX * 2), lines: list.slice(0, ALERT_LINES).map(a => cut(PredictGroup.lineOf(a), ALERT_LINE_MAX)) }
  }

  /** The Pull requests list's items (open only, newest first, as the fog block shows them), each re-checked here:
   *  the provider's text came from GitHub and the agents, so it is hostile too. */
  async function fogItems() {
    const items = await within(Promise.resolve().then(prs), agentsWaitMs, [])
    return (Array.isArray(items) ? items : []).filter(p => p && typeof p === 'object' && GITHUB_PR.test(String(p.url || '')))
  }
  async function openPrs() {
    return (await fogItems())
      .slice(0, PRS_MAX)
      .map(p => ({ title: cut(p.title || p.url, TITLE_MAX), url: p.url, number: Number(p.number) || null, flow: typeof p.flow?.id === 'string' && SLUG.test(p.flow.id) ? p.flow.id : null }))
  }
  /** A flow sheet's pull request: the fog list's item for THIS flow, or null. ⚠️ Never the flow record alone
   *  (output.pr): it can still say open after GitHub merged or closed it, and the phone must agree with the PC. */
  async function sheetPr(flowId) {
    const p = (await fogItems()).find(i => i.flow && i.flow.id === flowId)
    return p ? { url: p.url, number: Number(p.number) || null, state: p.draft ? 'draft' : 'open' } : null
  }

  async function orchestration() {
    const { graph, tickets } = pipelineGet({ config, now: now() }).body
    const [states, alertSummary, openList] = await Promise.all([agentStates(), alertLines(), openPrs()])
    const byNode = new Map()
    for (const t of tickets) {
      const node = nodeOf(t)
      if (!node || t.archived || t.completed) continue
      if (!byNode.has(node)) byNode.set(node, [])
      byNode.get(node).push(t)
    }
    const need = t => ATTENTION[statusOf(t)] ?? 9
    const boxes = graph.nodes.map(n => {
      const list = (byNode.get(n.id) || []).sort((a, b) => need(a) - need(b) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      return {
        id: n.id, label: n.label, role: n.role, kind: n.kind,
        state: n.kind === 'agent' && states ? states.get(n.label) || 'none' : null,
        flows: list.slice(0, FLOWS_MAX).map(t => ({ id: t.id, title: cut(t.title || t.id, CHIP_TITLE_MAX), word: WORD[statusOf(t)] || 'Unknown', tone: toneOf(t) })),
        more: Math.max(0, list.length - FLOWS_MAX),
      }
    })
    const onBoard = new Set(graph.nodes.filter(n => n.kind === 'agent').map(n => n.label))
    const others = states ? [...states].filter(([label]) => !onBoard.has(label)).map(([label, state]) => ({ label, state })) : []
    return ok({ builtAt: new Date(now()).toISOString(), agentsKnown: states !== null, boxes, others, alerts: alertSummary, prs: openList })
  }

  async function flow(b) {
    const id = b && typeof b === 'object' ? b.id : undefined
    if (typeof id !== 'string' || !SLUG.test(id)) return no(400, 'That is not a flow id.')
    let f
    try {
      f = readFlow(id)
    } catch {
      f = null
    }
    if (!f) return no(404, 'That flow is gone: it may have been deleted at the PC.')
    if (f.archivedAt || f.completedAt) return no(404, 'That flow is in the archive now: open it at the PC.')
    const graph = pipelineGraph(config)
    const labels = Object.fromEntries(graph.nodes.map(n => [n.id, n.label]))
    const stage = stageOf(f, graph)
    const { route, progress } = withRoute(f, graph)
    const qa = qaView(f.qa)
    const pr = await sheetPr(f.id)
    return ok({
      id: f.id,
      title: cut(f.title || f.id, TITLE_MAX),
      tickets: (Array.isArray(f.tickets) ? f.tickets : []).filter(t => typeof t === 'string').slice(0, TICKETS_MAX).map(t => cut(t, 40)),
      where: stage.node ? `${WORD[stage.status] || 'At'} at ${labels[stage.node] || stage.node}` : 'Dropped',
      type: typeof route?.type === 'string' ? cut(route.type, 20) : '',
      route: progress.map(s => ({ label: cut(s.label, 40), state: s.state })),
      story: storyOf(f).slice(0, STORY_LINES).map(l => ({ who: cut(l.who, 40), did: cut(l.did, STORY_TEXT_MAX), why: cut(l.why, STORY_TEXT_MAX) })),
      qa: qa ? { word: QA_WORD[qa.status] || 'Unknown', attempt: Number.isInteger(qa.attempt) ? qa.attempt : null, at: typeof qa.at === 'string' ? qa.at : null, summary: cut(qa.summary, QA_SUMMARY_MAX) } : null,
      asks: live(f) ? (f.nodes || []).filter(n => n?.type === 'ask' && (n.answer === null || n.answer === undefined)).map(n => ({
        flowId: f.id, nodeId: n.id, flowTitle: cut(f.title, TITLE_MAX), agent: cut(f.agent, 40), question: cut(n.title, TITLE_MAX * 2), why: cut(n.why, STORY_TEXT_MAX * 2),
        kind: n.kind === 'text' ? 'text' : 'yesno', yes: cut(n.yes, 160), no: cut(n.no, 160),
      })) : [],
      pr,
    })
  }

  return { orchestration, flow }
}
