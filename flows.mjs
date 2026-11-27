// The flow store: one JSON file per flow at data/flows/<id>.json, the notebook
// agents write their work into and the dashboard draws (spec 7.1).
//
// Shared by the server and tools/factory.mjs, so agents on two Claude accounts
// and the server's answer route may write the same file. Every write goes to a
// temp file and is renamed into place, so a reader never sees half a file, and
// is validated first, so a bad shape never replaces a good file.
//
// Rules this file enforces:
// - A flow file that fails validateFlow is reported (one line per problem),
//   never thrown at the server: listFlows puts it under `invalid`.
// - `after` may only name an EARLIER node, so the chart has no cycles.
// - `verified` means the user looked: only applyVerify sets it ({ by: 'you' }).
//   When an agent rewrites the whole flow, mergeKeepingAnswers takes every
//   tick and answer from the existing file, never from the agent.
// - `output` (optional) is the storyboard the agent fills: result shots, a
//   diagram of how it works, a summary with its changes, manual test steps.
//   Its `requestedAt` is the user's, kept by mergeKeepingAnswers like an answer.
// - `output.story` (optional) is the agent's plain story, a few lines of who did what and why
//   (flow-story.mjs); agent-owned like the rest of `output`.
// - `output.merge` (optional) is the agent's record of the pull request its work becomes; `output.pr`
//   is the server's, written only when the user clicks Send (flow-merge.mjs, pr-routes.mjs).
// - `derived` (progress, current, waiting, pending, proof, output, story, reasons, terms) is computed on
//   read; listFlows attaches it and mergeKeepingAnswers drops it again.
// - `archivedAt` (optional, a time) is the USER'S, like `verified`: only the page's Archive sets or
//   clears it (trash-routes.mjs), mergeKeepingAnswers takes it from the stored file only, and listFlows
//   leaves an archived flow out unless asked. A NEW open ask clears it (writeFlow), so archiving never
//   hides a later question. Deleting is the Trash (trash.mjs), not a field.
// - `completedAt` and `completedBy` (optional; 'you') are the USER'S sign-off on a finished flow (completed.mjs):
//   only the page's Completed sets them (completed-routes.mjs), always together with archivedAt, and the agent's
//   rewrite keeps or drops them EXACTLY as it does archivedAt (never sets them). `signoff` is the history of every
//   time the user set or took off the mark ([{ at, did }], completed.mjs), for the Log, kept from the stored file too. A new open ask clears the mark with the archive.
// - `qa` (optional) is QA's record of testing the flow (flow-qa.mjs validateQa): only the QA commands
//   (tools/qa-cli.mjs) write it, and mergeKeepingAnswers takes it from the stored file only (keepQa),
//   so a producer's rewrite can neither drop a failure nor forge a pass.
// - `route` (optional on the file, required of a NEW flow by the CLI) is the planned way through the
//   pipeline (flow-route.mjs): its shape is checked here, the graph when an agent sets it, and a rewrite
//   keeps the stored one (keepRoute); only `flow route` changes it, keeping the old one in its history.
// - `hand` (optional) is the by-hand steps an agent wrote for the user (hand-steps.mjs): each step's `done` is the
//   USER'S tick, like `verified`, kept by mergeKeepingAnswers only from the stored file and only while the step asks
//   the same thing (keepHand).
// - `plan` (optional) is the planner's record of planning the flow and handing it to a producer (flow-plan.mjs):
//   only the plan commands (tools/plan-cli.mjs) write it, and mergeKeepingAnswers takes it from the stored file only.
// - `senior` (optional) is Senior's review of work with no code to test (flow-senior.mjs): only the Senior commands
//   (tools/senior-cli.mjs) write it, and mergeKeepingAnswers takes it from the stored file only (keepSenior).
// - `selfcheck`, `critic` and `risk` (optional) are the producer's self-check before QA, the second opinion on the plan
//   and the risk label (quality-flow.mjs): only the quality commands and the server write them, and
//   mergeKeepingAnswers takes them from the stored file only (keepQuality).
// - ⚠️ THE SENIOR GATE lives HERE, in writeFlow, the one door every writer goes through (the agent CLI's set and
//   write, the dashboard's status route, anything added later): while Senior holds a flow (flow-senior.mjs
//   seniorHolds), a write that moves it to done is refused with that one sentence. Only Senior's own pass, which
//   records the pass in the same write, gets through. The pipeline is the live config's (config.mjs); the CLI runs
//   each command inside withPipeline(its config), so a test config is honoured.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { SIGNOFF_MAX, validateSignoff } from './completed.mjs'
import { DIAGRAM_KINDS, DIAGRAM_MAX } from './diagram-text.mjs'
import { hasBefore, validateChange } from './flow-change.mjs'
import { mergeReady, validateSend } from './flow-merge.mjs'
import { keepPlan, validatePlan } from './flow-plan.mjs'
import { keepQa, validateQa } from './flow-qa.mjs'
import { keepQuality, validateQuality } from './quality-flow.mjs'
import { keepSenior, recordHold, seniorHolds, validateSenior } from './flow-senior.mjs'
import { CONFIG } from './config.mjs'
import { pipelineGraph } from './pipeline.mjs'
import { keepHand, validateHand } from './hand-steps.mjs'
import { keepEstimate, validateEstimate } from './predict-keep.mjs'
import { keepRoute, validateRoute } from './flow-route.mjs'
import { keepRouting, validateRouting } from './routing-flow.mjs'
import { keepRetro, validateRetro } from './learn-retro-text.mjs'
import { sayShorter, STORY_ID, STORY_MAX, storyOf, YOU } from './flow-story.mjs'
import { lookup } from './glossary.mjs'
import { DATA_DIR } from './project-store.mjs'
import { recordFlowStatus } from './since-store.mjs'
import { termsOfFlow } from './terms.mjs'

export { clip, sayShorter, STORY_MAX, storyOf } from './flow-story.mjs'

/**
 * The CURRENT PROJECT's data folder (project-store.mjs): data/ (or FACTORY_DATA_DIR) for the first project,
 * data/projects/<id> for any other. Tests point FACTORY_DATA_DIR at a temp folder before importing.
 */
export { DATA_DIR }
export const FLOWS_DIR = path.join(DATA_DIR, 'flows')
export const EVIDENCE_DIR = path.join(DATA_DIR, 'evidence')

export const ENVS = ['local', 'dev', 'stage', 'prod']
export const FLOW_STATUS = ['open', 'done', 'blocked', 'dropped']
export const NODE_STATUS = ['todo', 'doing', 'done', 'blocked', 'skipped']
export const NODE_TYPES = ['step', 'check', 'ask', 'note']
export const EVIDENCE_KINDS = ['commit', 'diff', 'test', 'shot', 'url', 'note']
export const ASK_KINDS = ['yesno', 'text']

const SLUG = /^[a-z0-9-]+$/
const TICKET = /^[A-Z]+-\d+$/
/**
 * The agent's dashboard label, one line. ⚠️ The relay puts it into a Claude
 * prompt (relay.mjs), so a quote or a line break here could steer that turn.
 */
export const AGENT_LABEL = /^[A-Za-z0-9 ._-]{1,40}$/
export const AGENT_RULE = 'a label of 1 to 40 letters, digits, spaces, dots, dashes or underscores'
/** Node types that do work and so carry a status, evidence and the user's tick. */
const WORK = new Set(['step', 'check'])

const now = () => new Date().toISOString()
const oneOf = (list) => `must be one of ${list.join(', ')}`
const isText = (v) => typeof v === 'string' && v.trim() !== ''
/**
 * A real ISO 8601 time as toISOString writes it (seconds and fraction optional, Z or an offset) that is a real
 * date: never a bare `1` or `2026`, which Date.parse accepts. For archivedAt; the older time fields keep isText.
 */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/
const isIsoTime = (v) => typeof v === 'string' && ISO_TIME.test(v) && !Number.isNaN(Date.parse(v))
const flowFile = (id) => path.join(FLOWS_DIR, id + '.json')

// ═══ Validation ═══

/** Every problem with a flow's shape, one line each; `[]` when it is valid. */
export function validateFlow(flow) {
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) return ['flow must be a JSON object']
  const problems = []
  if (typeof flow.id !== 'string' || !SLUG.test(flow.id)) problems.push('id must match /^[a-z0-9-]+$/')
  if (!isText(flow.title)) problems.push('title must be non-empty text')
  if (typeof flow.agent !== 'string' || !AGENT_LABEL.test(flow.agent)) problems.push(`agent must be ${AGENT_RULE}`)
  if (flow.tickets !== undefined) {
    if (!Array.isArray(flow.tickets)) problems.push('tickets must be a list')
    else for (const t of flow.tickets) if (typeof t !== 'string' || !TICKET.test(t)) problems.push(`ticket ${t} must match /^[A-Z]+-\\d+$/`)
  }
  if (flow.env !== undefined && !ENVS.includes(flow.env)) problems.push(`env ${oneOf(ENVS)}`)
  if (!FLOW_STATUS.includes(flow.status)) problems.push(`status ${oneOf(FLOW_STATUS)}`)
  if (flow.why !== undefined && typeof flow.why !== 'string') problems.push('why must be text')
  if (flow.archivedAt !== undefined && !isIsoTime(flow.archivedAt)) problems.push('archivedAt must be a time')
  if (flow.completedAt !== undefined && !isIsoTime(flow.completedAt)) problems.push('completedAt must be a time')
  if (flow.signoff !== undefined) problems.push(...validateSignoff(flow.signoff, isIsoTime))
  if (flow.completedBy !== undefined && flow.completedBy !== 'you') problems.push('completedBy must be you')
  if (flow.retro !== undefined) problems.push(...validateRetro(flow.retro)) // the server's retrospective (learn-retro-text.mjs)
  if (!Array.isArray(flow.nodes)) return [...problems, 'nodes must be a list']

  const allIds = new Set(flow.nodes.map(n => n?.id))
  const seen = new Set()
  flow.nodes.forEach((n, i) => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) { problems.push(`node #${i + 1} must be a JSON object`); return }
    const at = `node ${typeof n.id === 'string' && n.id ? n.id : '#' + (i + 1)}:`
    if (typeof n.id !== 'string' || !SLUG.test(n.id)) problems.push(`${at} id must match /^[a-z0-9-]+$/`)
    else if (seen.has(n.id)) problems.push(`duplicate node id ${n.id}`)
    if (!NODE_TYPES.includes(n.type)) problems.push(`${at} type ${oneOf(NODE_TYPES)}`)
    if (!isText(n.title)) problems.push(`${at} title must be non-empty text`)
    if (n.why !== undefined && typeof n.why !== 'string') problems.push(`${at} why must be text`)
    if (n.env !== undefined && !ENVS.includes(n.env)) problems.push(`${at} env ${oneOf(ENVS)}`)
    if (n.after !== undefined && !Array.isArray(n.after)) problems.push(`${at} after must be a list`)
    for (const a of Array.isArray(n.after) ? n.after : []) {
      if (!allIds.has(a)) problems.push(`${at} after names unknown node ${a}`)
      else if (!seen.has(a)) problems.push(`${at} after must name an earlier node (${a})`)
    }
    if (WORK.has(n.type)) {
      if (!NODE_STATUS.includes(n.status)) problems.push(`${at} status ${oneOf(NODE_STATUS)}`)
      if (n.evidence !== undefined && !Array.isArray(n.evidence)) problems.push(`${at} evidence must be a list`)
      for (const e of Array.isArray(n.evidence) ? n.evidence : []) {
        if (!EVIDENCE_KINDS.includes(e?.kind)) problems.push(`${at} evidence kind ${oneOf(EVIDENCE_KINDS)}`)
        if (!isText(e?.ref)) problems.push(`${at} evidence ref must be non-empty text`)
      }
      if (n.verified != null && (typeof n.verified !== 'object' || !isText(n.verified.at))) problems.push(`${at} verified must be null or { by, at }`)
    }
    if (n.type === 'ask') {
      if (!ASK_KINDS.includes(n.kind)) problems.push(`${at} kind ${oneOf(ASK_KINDS)}`)
      else if (n.answer != null && (n.kind === 'yesno' ? !['yes', 'no'].includes(n.answer) : !isText(n.answer))) {
        problems.push(`${at} answer must be ${n.kind === 'yesno' ? 'yes, no' : 'non-empty text'} or null`)
      }
    }
    if (typeof n.id === 'string') seen.add(n.id)
  })
  if (flow.output !== undefined) problems.push(...validateOutput(flow.output, flow.id))
  if (flow.qa !== undefined) problems.push(...validateQa(flow.qa, flow.id))
  if (flow.route !== undefined) problems.push(...validateRoute(flow.route))
  if (flow.hand !== undefined) problems.push(...validateHand(flow.hand))
  if (flow.plan !== undefined) problems.push(...validatePlan(flow.plan, flow.id))
  if (flow.senior !== undefined) problems.push(...validateSenior(flow.senior))
  problems.push(...validateQuality(flow)) // selfcheck, critic, risk (quality-flow.mjs)
  if (flow.estimate !== undefined) problems.push(...validateEstimate(flow.estimate)) // the server's (predict-keep.mjs)
  if (flow.routing !== undefined) problems.push(...validateRouting(flow.routing))
  return problems
}

// ═══ Output: the storyboard (result shots, a summary with its changes, manual test steps) ═══

export const CHANGE_KINDS = ['commit', 'diff']
export const SUMMARY_MAX = 4000
export const LINE_MAX = 500
/**
 * The fields of `output` owned by the server, never by an agent: `requestedAt` (the user pressed
 * Request test steps), `requestSentAt` and `requestError` (what the relay made of it, see
 * relay.mjs), and `pr` (the pull request the user's Send opened, pr-routes.mjs).
 * mergeKeepingAnswers takes them from the stored file only.
 */
export const SERVER_OUTPUT = ['requestedAt', 'requestSentAt', 'requestError', 'pr']
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const boundedText = (v, max) => isText(v) && v.length <= max
const SHA_REF = /^[0-9a-f]{7,40}$/i
/**
 * A screenshot ref: ONE file in this flow's evidence folder, `<flow id>/<name>`, never `.` or `..`
 * and no separator, so a hand-written file can never point the page outside that folder. (With a
 * bad flow id, which is its own problem line, any slug folder passes, so one cause is one line.)
 */
const fileRef = (ref, flowId) => {
  const m = /^([a-z0-9-]+)\/([^/\\]{1,200})$/.exec(typeof ref === 'string' ? ref : '')
  return !!m && (m[1] === flowId || !SLUG.test(String(flowId))) && m[2] !== '.' && m[2] !== '..'
}

/**
 * The problems with a flow's optional `output`, one line each. Every part is
 * optional (an agent fills it as it goes); what is there must be the right shape.
 */
function validateOutput(out, flowId) {
  if (!isObject(out)) return ['output must be a JSON object']
  const problems = []
  /** `output.<key>` as a list of objects: calls `check(item, label)` on each object, reports the rest. */
  const each = (key, check) => {
    if (out[key] === undefined) return
    if (!Array.isArray(out[key])) return problems.push(`output.${key} must be a list`)
    out[key].forEach((item, i) => {
      if (!isObject(item)) problems.push(`output.${key} #${i + 1} must be a JSON object`)
      else check(item, `output.${key} #${i + 1}`)
    })
  }
  const FILE = `${flowId}/<file name>, at most 200 characters`
  each('result', (r, at) => {
    if (!fileRef(r.ref, flowId)) problems.push(`${at} ref must be ${FILE}`)
    if (r.caption !== undefined && !(typeof r.caption === 'string' && r.caption.length <= LINE_MAX)) problems.push(`${at} caption must be text of at most ${LINE_MAX} characters`)
  })
  if (out.summary !== undefined && !(typeof out.summary === 'string' && out.summary.length <= SUMMARY_MAX)) {
    problems.push(`output.summary must be text of at most ${SUMMARY_MAX} characters`)
  }
  each('changes', (c, at) => {
    if (!CHANGE_KINDS.includes(c.kind)) problems.push(`${at} kind ${oneOf(CHANGE_KINDS)}`)
    else if (c.kind === 'commit' && !SHA_REF.test(typeof c.ref === 'string' ? c.ref : '')) problems.push(`${at} ref must be a commit sha (7 to 40 hex characters)`)
    else if (c.kind === 'diff' && !boundedText(c.ref, 100)) problems.push(`${at} ref must be a worktree name of at most 100 characters`)
    if (c.label !== undefined && !(typeof c.label === 'string' && c.label.length <= LINE_MAX)) problems.push(`${at} label must be text of at most ${LINE_MAX} characters`)
  })
  const ids = new Set()
  each('testing', (t, at) => {
    if (typeof t.id !== 'string' || !SLUG.test(t.id)) problems.push(`${at} id must match /^[a-z0-9-]+$/`)
    else if (ids.has(t.id)) problems.push(`duplicate test step id ${t.id}`)
    else { ids.add(t.id); at = `output.testing ${t.id}:` }
    if (!boundedText(t.do, LINE_MAX)) problems.push(`${at} do must be non-empty text of at most ${LINE_MAX} characters`)
    if (!boundedText(t.expect, LINE_MAX)) problems.push(`${at} expect must be non-empty text of at most ${LINE_MAX} characters`)
    if (t.shot !== undefined && !fileRef(t.shot, flowId)) problems.push(`${at} shot must be ${FILE}`)
  })
  if (out.diagram !== undefined) problems.push(...validateDiagram(out.diagram))
  if (out.diagramBefore !== undefined) problems.push(...validateDiagram(out.diagramBefore, 'output.diagramBefore'))
  // a before with no now would hide: the page shows the diagram before only beside the diagram
  if (out.diagramBefore !== undefined && out.diagram === undefined) problems.push('output.diagramBefore needs output.diagram: draw how it works now first (flow diagram), then how it worked before')
  problems.push(...validateChange(out)) // before and after: result[].when and change (flow-change.mjs)
  problems.push(...validateSend(out)) // the pull request: merge (the agent's) and pr (the server's), flow-merge.mjs
  if (out.story !== undefined) problems.push(...validateStory(out.story))
  for (const key of ['requestedAt', 'requestSentAt']) if (out[key] != null && !isText(out[key])) problems.push(`output.${key} must be null or a time`)
  if (out.requestError != null && !boundedText(out.requestError, 300)) problems.push('output.requestError must be null or text of at most 300 characters')
  return problems
}

/**
 * The agent's story (`flow say`, flow-story.mjs): [{ id: s1…, who, did, why?, at? }], at most
 * STORY_MAX.lines lines; `did` 1 to 140 characters and `why` at most 160, each one line. One
 * problem per line, in plain words, so an agent knows what to change.
 */
function validateStory(story) {
  if (!Array.isArray(story)) return ['output.story must be a list']
  if (story.length > STORY_MAX.lines) return [`output.story has ${story.length} lines, at most ${STORY_MAX.lines}: keep the story short`]
  const problems = []
  const ids = new Set()
  /** A did or why: text on one line within `max`; `need` when it must be there. */
  const line = (at, key, v, max, need) => {
    if (v === undefined && !need) return
    if (typeof v !== 'string' || (need && !v.trim())) return problems.push(`${at} ${key} must ${need ? 'say what was done' : 'be text'}`)
    if (/[\r\n]/.test(v)) return problems.push(`${at} ${key} must be one line`)
    if (v.length > max) problems.push(`${at} ${key}: ${sayShorter(max, v.length)}`)
  }
  story.forEach((l, i) => {
    let at = `output.story #${i + 1}`
    if (!isObject(l)) return problems.push(`${at} must be a JSON object`)
    if (typeof l.id !== 'string' || !STORY_ID.test(l.id)) problems.push(`${at} id must be s1, s2, s3 and so on`)
    else if (ids.has(l.id)) problems.push(`duplicate story line id ${l.id}`)
    else { ids.add(l.id); at = `output.story ${l.id}:` }
    if (typeof l.who !== 'string' || !AGENT_LABEL.test(l.who)) problems.push(`${at} who must be ${AGENT_RULE}`)
    else if (YOU.test(l.who)) problems.push(`${at} who must not be You: that name is kept for what the user did`)
    line(at, 'did', l.did, STORY_MAX.did, true)
    line(at, 'why', l.why, STORY_MAX.why, false)
    if (l.at !== undefined && !isText(l.at)) problems.push(`${at} at must be a time`)
  })
  return problems
}

/**
 * The agent's diagram of how the work works (`flow diagram`, parsed by diagram-text.mjs):
 * { nodes: [{ id, label, kind? }], edges?: [{ from, to, label? }], at? }. A cycle is allowed (the
 * page dashes the arrow that closes it); the limits are diagram-text.mjs DIAGRAM_MAX.
 */
function validateDiagram(d, name = 'output.diagram') {
  if (!isObject(d)) return [`${name} must be a JSON object`]
  const problems = []
  if (!Array.isArray(d.nodes)) problems.push(`${name}.nodes must be a list`)
  if (d.edges !== undefined && !Array.isArray(d.edges)) problems.push(`${name}.edges must be a list`)
  if (problems.length) return problems
  const edges = d.edges || []
  if (!d.nodes.length) return [`${name}.nodes must have at least one box`]
  if (d.nodes.length > DIAGRAM_MAX.nodes) problems.push(`${name} has ${d.nodes.length} boxes, at most ${DIAGRAM_MAX.nodes}: keep it high level`)
  if (edges.length > DIAGRAM_MAX.edges) problems.push(`${name} has ${edges.length} arrows, at most ${DIAGRAM_MAX.edges}: keep it high level`)
  if (problems.length) return problems
  const ids = new Set()
  d.nodes.forEach((n, i) => {
    let at = `${name} node #${i + 1}`
    if (!isObject(n)) return problems.push(`${at} must be a JSON object`)
    if (typeof n.id !== 'string' || !SLUG.test(n.id)) problems.push(`${at} id must match /^[a-z0-9-]+$/`)
    else if (ids.has(n.id)) return problems.push(`duplicate diagram node id ${n.id}`)
    else { ids.add(n.id); at = `${name} node ${n.id}:` }
    if (!boundedText(n.label, DIAGRAM_MAX.label)) problems.push(`${at} label must be text of 1 to ${DIAGRAM_MAX.label} characters`)
    if (n.kind !== undefined && !DIAGRAM_KINDS.includes(n.kind)) problems.push(`${at} kind ${oneOf(DIAGRAM_KINDS)}`)
  })
  edges.forEach((e, i) => {
    const at = `${name} arrow #${i + 1}`
    if (!isObject(e)) return problems.push(`${at} must be a JSON object`)
    for (const end of ['from', 'to']) if (!ids.has(e[end])) problems.push(`${at} ${end} names unknown box ${e[end]}`)
    if (e.label !== undefined && !(typeof e.label === 'string' && e.label.length <= DIAGRAM_MAX.edgeLabel)) problems.push(`${at} label must be text of at most ${DIAGRAM_MAX.edgeLabel} characters`)
  })
  if (d.at !== undefined && !isText(d.at)) problems.push(`${name}.at must be a time`)
  return problems
}

// ═══ Files ═══

/** The parsed flow file, unvalidated; null when there is none (or the id is not a slug). Throws on bad JSON. */
export function readFlow(id) {
  if (typeof id !== 'string' || !SLUG.test(id)) return null
  const file = flowFile(id)
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function listFlowIds() {
  if (!existsSync(FLOWS_DIR)) return []
  return readdirSync(FLOWS_DIR)
    .filter(f => f.endsWith('.json') && SLUG.test(f.slice(0, -5)))
    .map(f => f.slice(0, -5))
    .sort()
}

/**
 * Every valid flow with `derived` attached, newest first, filtered; and every
 * file that failed to parse or validate, with its problems, so one bad file
 * shows as a banner instead of breaking the list.
 * Archived flows are left out; `{ archived: true }` lists ONLY them, and
 * `{ archived: 'any' }` lists both (for a caller that looks a flow up, never for a board). `tally`, when
 * given, gets `archived`: how many valid flows are archived, whatever the filter
 * (the page's `Archived · N` link), counted in the same pass and before `derive`.
 */
export function listFlows({ open, waiting, agent, ticket, archived } = {}, tally = null) {
  const flows = []
  const invalid = []
  if (tally) tally.archived = 0
  for (const id of listFlowIds()) {
    let flow
    try { flow = readFlow(id) } catch (err) { invalid.push({ id, problems: [`not valid JSON: ${err.message}`] }); continue }
    const problems = validateFlow(flow)
    if (problems.length) { invalid.push({ id, problems }); continue }
    if (tally && flow.archivedAt) tally.archived++
    if (archived !== 'any' && Boolean(archived) !== Boolean(flow.archivedAt)) continue
    flow.derived = derive(flow)
    if (open && flow.status !== 'open') continue
    if (waiting && !flow.derived.waiting.length) continue
    if (agent && flow.agent !== agent) continue
    if (ticket && !(flow.tickets || []).includes(ticket)) continue
    flows.push(flow)
  }
  flows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  return { flows, invalid }
}

/**
 * Validate, stamp `updatedAt`, write atomically. Throws (one problem per line)
 * and leaves the old file when invalid. Stores the flow exactly as given: this
 * is the trusted path the server uses after applyVerify / applyAnswer; agent
 * input goes through mergeKeepingAnswers first.
 * The one writer of flow files, so it is also where a status change is noted
 * for Home's Since you were away card (since-store.mjs flows-prev.json): the
 * stored status is read before the write and noted when it differs.
 * And where an archived flow comes back: when this write has an open ask the
 * stored copy did not have, `archivedAt` goes, so a question asked after the
 * user archived the flow is never hidden. "Had" is by identity (askKey), never a
 * count: a reworded or replaced ask is a new question even when the number of
 * open asks stays the same. An ask already in the stored copy, open or answered,
 * is not new: the user saw it (archiving with an ask open holds, and so does
 * the user reopening an answer). With no stored copy there is nothing to
 * compare, and the trusted caller's archivedAt stands.
 */
/** The graph the Senior gate reads: the live config's, or the one withPipeline set for the call in progress. */
let gateGraph = () => pipelineGraph(CONFIG)

/** Run `fn` with `config`'s pipeline as the one the Senior gate reads (the CLI passes its own config). */
export function withPipeline(config, fn) {
  const was = gateGraph
  gateGraph = () => pipelineGraph(config || CONFIG)
  try {
    return fn()
  } finally {
    gateGraph = was
  }
}

/** Who stopped a flow after too many failures, so the user decides what happens next: Senior, QA, Security, or ''. */
export function stoppedBy(flow) {
  const qa = flow?.qa && typeof flow.qa === 'object' ? flow.qa : null
  if (!qa && flow?.senior?.status === 'senior-failed') return 'Senior'
  if (qa?.status === 'qa-failed') return 'QA'
  if (qa?.status === 'passed' && qa.security?.status === 'security-failed') return 'Security'
  return ''
}

/**
 * Why an AGENT may not move `stored` to `next` (QA round two B-F3): a flow Senior, QA or Security stopped is moved on
 * (done or open again) by the user only, on the dashboard. The agent CLI's set and write ask this; the page does not.
 * Dropping it is not moving it on, so it is allowed.
 */
export function agentMoveRefusal(stored, next) {
  const who = stored && (next === 'done' || next === 'open') && next !== stored.status ? stoppedBy(stored) : ''
  return who ? `${stored.id} was stopped by ${who}: only the user moves it on, on the dashboard.` : ''
}

/** Why Senior holds `flow` now (flow-senior.mjs seniorHolds) on the pipeline the store reads, or ''. */
export const seniorHold = flow => seniorHolds(flow, gateGraph())

/**
 * `stamp: false` keeps the flow's updatedAt as given (the user's Completed, completed-routes.mjs): the scorecard and
 * Pipeline time date a finished flow by its updatedAt, and a sign-off must not move it. Every other write stamps.
 */
export function writeFlow(flow, { stamp = true } = {}) {
  const problems = validateFlow(flow)
  if (problems.length) throw new Error(problems.join('\n'))
  const stored = storedFlow(flow.id)
  const before = stored?.status ?? null
  // the Senior gate: the hold is recorded on the flow and kept across every rewrite (flow-senior.mjs recordHold), then
  // only the move to done is checked, so a flow done before Senior existed may still be written
  const graph = gateGraph()
  recordHold(flow, stored, graph)
  if (flow.status === 'done' && before !== 'done') {
    const held = seniorHolds(flow, graph)
    // the code lets the page say what the USER can do instead of the agent's sentence (public/flow-hand.js holdText)
    if (held) throw Object.assign(new Error(held), { code: 'senior-hold' })
  }
  if ((flow.archivedAt || flow.completedAt) && stored && hasNewOpenAsk(flow, stored)) {
    // a completed flow reopened by a question: the history says so, by the agent (completed.mjs), so the Log stays true
    if (flow.completedAt) flow.signoff = [...(Array.isArray(flow.signoff) ? flow.signoff : []), { at: now(), did: 'reopened', by: flow.agent }].slice(-SIGNOFF_MAX)
    for (const k of USER_PUT_AWAY) delete flow[k]
  }
  if (stamp || !isText(flow.updatedAt)) flow.updatedAt = now()
  writeAtomic(flowFile(flow.id), JSON.stringify(flow, null, 1))
  if (before && before !== flow.status) recordFlowStatus(flow.id, before, flow.status)
  return flow
}

/** What a new open ask takes off a flow the user put away: the archive and the sign-off on it (completed.mjs). */
const USER_PUT_AWAY = ['archivedAt', 'completedAt', 'completedBy']

/** The flow's file now, parsed, or null (no file, or not readable). */
function storedFlow(id) {
  try {
    return readFlow(id)
  } catch {
    return null
  }
}

/**
 * Which question an ask is: its id and the fields mergeKeepingAnswers matches before it keeps an answer (kind,
 * title, yes, no). So an agent edit that resets an answer always makes a new key. MUST CHANGE IN LOCKSTEP with
 * mergeKeepingAnswers' askKept.
 */
const askKey = n => JSON.stringify([n.id, ...['kind', 'title', 'yes', 'no'].map(k => n[k] ?? '')])
const asksOf = flow => (Array.isArray(flow?.nodes) ? flow.nodes.filter(n => n?.type === 'ask') : [])
/** True when `flow` has an ask waiting on the user (`== null`, like derive's `waiting`) that `stored` does not have at all. */
function hasNewOpenAsk(flow, stored) {
  const known = new Set(asksOf(stored).map(askKey))
  return asksOf(flow).some(n => n.answer == null && !known.has(askKey(n)))
}

export function createFlow({ id, title, agent, tickets, env, why, route }) {
  if (typeof id === 'string' && SLUG.test(id) && existsSync(flowFile(id))) throw new Error(`Flow ${id} already exists`)
  const at = now()
  const flow = { id, title, agent, tickets: tickets || [] }
  if (env !== undefined) flow.env = env
  flow.status = 'open'
  flow.why = why || ''
  flow.createdAt = at
  flow.updatedAt = at
  flow.nodes = []
  if (route !== undefined) flow.route = route
  return writeFlow(flow)
}

// ═══ Mutators (change the flow in memory; the caller writes it) ═══

function findNode(flow, nodeId) {
  const node = (flow.nodes || []).find(n => n.id === nodeId)
  if (!node) throw new Error(`Flow ${flow.id} has no node ${nodeId}`)
  return node
}

/** Append a node with its type's defaults; `id` defaults to n<highest n-number + 1>. Returns the node. */
export function addNode(flow, { type, title, id, why, env, after, status, yes, no, kind }) {
  if (!NODE_TYPES.includes(type)) throw new Error(`type ${oneOf(NODE_TYPES)}`)
  if (id === undefined) {
    const nums = flow.nodes.map(n => /^n(\d+)$/.exec(n.id)?.[1]).filter(Boolean).map(Number)
    id = 'n' + (Math.max(0, ...nums) + 1)
  }
  const node = { id, type, title }
  if (why !== undefined) node.why = why
  if (env !== undefined) node.env = env
  node.after = after || []
  if (WORK.has(type)) Object.assign(node, { status: status || 'todo', evidence: [], verified: null })
  if (type === 'ask') {
    Object.assign(node, { kind: kind || 'yesno', yes: yes || '', no: no || '', answer: null, answeredAt: null, note: '', sentAt: null, deliveryError: null, at: now() })
  }
  flow.nodes.push(node)
  return node
}

export function setNodeStatus(flow, nodeId, status) {
  const node = findNode(flow, nodeId)
  if (!WORK.has(node.type)) throw new Error(`${node.type} nodes have no status`)
  if (!NODE_STATUS.includes(status)) throw new Error(`status ${oneOf(NODE_STATUS)}`)
  node.status = status
  return node
}

/** Push one evidence entry onto a step or check. Returns the node. */
export function addEvidence(flow, nodeId, { kind, ref, label, file }) {
  const node = findNode(flow, nodeId)
  if (!WORK.has(node.type)) throw new Error(`${node.type} nodes take no evidence`)
  if (!EVIDENCE_KINDS.includes(kind)) throw new Error(`evidence kind ${oneOf(EVIDENCE_KINDS)}`)
  if (!isText(ref)) throw new Error('evidence ref must be non-empty text')
  const entry = { kind, ref, label: label || '' }
  if (file !== undefined) entry.file = file
  entry.at = now()
  ;(node.evidence ||= []).push(entry)
  return node
}

/**
 * The user's answer to an ask; null reopens it. Any change clears the
 * delivery record, so the new answer is pushed to the agent afresh (7.4a).
 */
export function applyAnswer(flow, nodeId, answer, note) {
  const node = findNode(flow, nodeId)
  if (node.type !== 'ask') throw new Error(`node ${nodeId} is not an ask`)
  if (answer !== null) {
    // a yes/no ask also takes the user's own words: some questions fit neither button
    if (!isText(answer)) {
      throw new Error(`answer must be ${node.kind === 'text' ? 'non-empty text' : 'yes, no, your own words'} or null`)
    }
  }
  // ⚠️ How long a question has waited counts from when IT was asked (`at`, Human review and the pulse): an ask
  // written before asks carried a time falls back to the flow's last write, which this very write moves. So every
  // other open ask with no time keeps the one it was shown with, the flow's updatedAt as stored, before it moves.
  for (const n of flow.nodes || []) if (n.type === 'ask' && n !== node && n.answer == null && !isText(n.at) && isText(flow.updatedAt)) n.at = flow.updatedAt
  node.answer = answer
  node.answeredAt = answer === null ? null : now()
  if (note !== undefined) node.note = String(note)
  node.sentAt = null
  node.deliveryError = null
  return node
}

/** The user's tick on a step or check. Nothing else ever sets `verified`. */
export function applyVerify(flow, nodeId, on) {
  const node = findNode(flow, nodeId)
  if (!WORK.has(node.type)) throw new Error('only step and check nodes can be verified')
  node.verified = on ? { by: 'you', at: now() } : null
  return node
}

/**
 * For `flow write`, the UNTRUSTED path: an agent rewrites the whole flow.
 * The user-owned fields (a step or check's `verified`; an ask's answer and
 * its delivery record) only ever come from the existing file, matched by
 * node id and type; a node with no match gets them reset to the defaults,
 * whatever the agent wrote. So an agent can never tick its own step or
 * answer its own ask. The flow's createdAt is kept; `derived` is dropped.
 * ⚠️ A match by id is not enough: the user answered THAT question and
 * ticked THAT proof. An answer (with its note and delivery record) is kept
 * only while the ask's kind, title, yes and no are unchanged; a tick only
 * while the title is unchanged and every old evidence entry (kind and ref)
 * is still there. Otherwise they reset, and the ask waits again.
 * Returns `incoming`, changed.
 */
export function mergeKeepingAnswers(incoming, existing) {
  const before = new Map((existing?.nodes || []).map(n => [n.id, n]))
  const same = (a, b, key) => (a[key] ?? '') === (b[key] ?? '')
  for (const n of incoming.nodes || []) {
    const old = before.get(n.id)
    if (WORK.has(n.type)) {
      const proofKept = old && WORK.has(old.type) && same(old, n, 'title') &&
        (old.evidence || []).every(e => (n.evidence || []).some(x => x?.kind === e?.kind && x?.ref === e?.ref))
      n.verified = proofKept ? old.verified ?? null : null
    } else if (n.type === 'ask') {
      // MUST CHANGE IN LOCKSTEP with askKey (writeFlow): a reset answer must be a new question there too
      const askKept = old?.type === 'ask' && ['kind', 'title', 'yes', 'no'].every(k => same(old, n, k))
      const kept = askKept ? old : {}
      for (const key of ['answer', 'answeredAt', 'sentAt', 'deliveryError']) n[key] = kept[key] ?? null
      n.note = askKept ? old.note ?? '' : ''
      // when it was asked: the stored time while it is the same question, else the agent's, else the time of this write
      n.at = askKept && isText(old.at) ? old.at : isText(n.at) ? n.at : now()
    }
  }
  // The storyboard: a rewrite that leaves `output` out keeps the stored one whole (an agent that
  // only rewrites its plan must not wipe its screenshots; `"output": {}` clears it on purpose).
  // The request fields are the server's, like an answer: only ever from the stored file.
  const stored = existing?.output
  if (incoming.output === undefined) {
    if (stored !== undefined) incoming.output = stored
  } else {
    for (const key of SERVER_OUTPUT) {
      if (stored?.[key] != null) incoming.output[key] = stored[key]
      else delete incoming.output[key]
    }
  }
  // Archive and Completed are the user's, like a tick: only ever from the stored file, never set or cleared by an agent.
  for (const key of ['archivedAt', 'completedAt', 'completedBy', 'signoff']) {
    if (existing?.[key]) incoming[key] = existing[key]
    else delete incoming[key]
  }
  keepQa(incoming, existing) // QA's, like a tick is the user's: only ever from the stored file
  keepRoute(incoming, existing) // the plan: only `flow route` changes a stored one
  keepHand(incoming, existing) // the user's ticks on the by-hand steps: only ever from the stored file
  keepPlan(incoming, existing) // the planner's hand-out: only the plan commands write it
  keepSenior(incoming, existing) // Senior's verdict: only the Senior commands write it
  keepQuality(incoming, existing) // the self-check, the plan critic and the risk label: never from an agent's file
  keepEstimate(incoming, existing) // the estimate (predict-keep.mjs): only the server writes it
  keepRouting(incoming, existing) // the routing record: only the dashboard writes it (routing-flow.mjs)
  keepRetro(incoming, existing) // the retrospective: only the server writes it (learn-retro.mjs)
  if (existing?.createdAt) incoming.createdAt = existing.createdAt
  delete incoming.derived
  return incoming
}

// ═══ Derived state (computed on read, never stored) ═══

/** node id → the ids it follows. An empty `after` means the previous node in the list. */
export function resolveAfter(flow) {
  const map = new Map()
  flow.nodes.forEach((n, i) => {
    map.set(n.id, n.after?.length ? [...n.after] : i > 0 ? [flow.nodes[i - 1].id] : [])
  })
  return map
}

/**
 * Whether an ask sits anywhere up `nodeId`'s after chain (resolveAfter, so an
 * empty after counts as following the previous node). A status the user sets
 * on such a node is pushed to the agent (spec 7.4a, factory-routes.mjs).
 */
export function followsAnAsk(flow, nodeId) {
  const after = resolveAfter(flow)
  const type = new Map(flow.nodes.map(n => [n.id, n.type]))
  const seen = new Set()
  const queue = [...(after.get(nodeId) || [])]
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    if (type.get(id) === 'ask') return true
    queue.push(...(after.get(id) || []))
  }
  return false
}

/** How much of a step's title the fallback reason quotes. */
const REASON_STEP_MAX = 80

/**
 * Why the user is asked, as every view of an ask shows it under the question: the agent's
 * `--why` ({ auto: false }), else where the ask sits ({ auto: true }): the flow's title and the
 * step it follows (resolveAfter, so an empty after is the node before it), never a bare
 * question. derive() puts one per ask in `reasons`; the pulse and the page read it from there.
 */
export function askReason(flow, node, after = resolveAfter(flow)) {
  const why = String(node.why ?? '').trim()
  if (why) return { text: why, auto: false }
  const prev = (after.get(node.id) || []).map(id => flow.nodes.find(n => n.id === id)).find(n => isText(n?.title))
  const step = prev ? String(prev.title).trim() : ''
  const cut = step.length > REASON_STEP_MAX ? step.slice(0, REASON_STEP_MAX - 1).trimEnd() + '…' : step
  const where = `Part of ${String(flow.title ?? '').trim()}`
  return { text: cut ? `${where}, after: ${cut}` : where, auto: true }
}

export function derive(flow) {
  const nodes = flow.nodes
  const work = nodes.filter(n => WORK.has(n.type))
  // `== null`: a hand-written ask with no answer key at all is open too (the page reads it the same way).
  const waiting = nodes.filter(n => n.type === 'ask' && n.answer == null).map(n => n.id)

  // Pending: everything downstream of an ask that is open or answered No,
  // found breadth-first over the forward edges. An ask never reaches itself
  // (after only names earlier nodes), but a second ask further down is pending.
  const next = new Map(nodes.map(n => [n.id, []]))
  const after = resolveAfter(flow)
  for (const [id, froms] of after) for (const f of froms) next.get(f)?.push(id)
  const blockers = nodes.filter(n => n.type === 'ask' && (n.answer == null || n.answer === 'no')).map(n => n.id)
  const reached = new Set()
  const queue = [...blockers]
  while (queue.length) {
    for (const id of next.get(queue.shift()) || []) {
      if (!reached.has(id)) { reached.add(id); queue.push(id) }
    }
  }
  const pending = nodes.map(n => n.id).filter(id => reached.has(id))

  const free = work.filter(n => !reached.has(n.id))
  const current = (free.find(n => n.status === 'doing') || free.find(n => n.status === 'todo'))?.id ?? null

  const proof = {}
  for (const n of work) {
    proof[n.id] = n.verified ? 'verified'
      : n.status === 'done' ? (n.evidence?.length ? 'claimed' : 'unproven')
      : null
  }

  return {
    progress: { done: work.filter(n => n.status === 'done').length, total: work.length },
    current,
    waiting,
    pending,
    proof,
    output: deriveOutput(flow),
    story: storyOf(flow),
    reasons: Object.fromEntries(nodes.filter(n => n.type === 'ask').map(n => [n.id, askReason(flow, n, after)])),
    terms: termsOfFlow(flow).map(({ term, key }) => ({ term, key, known: !!lookup(key) })),
  }
}

/**
 * What the storyboard holds: complete once it has a result shot, a summary and a test step. Its
 * `visual` is what leads the Output (visualOf); `complete` does not depend on it.
 */
function deriveOutput(flow) {
  const out = flow.output || {}
  // a before shot (`result --before`) is how it was: the result is how it is now
  const hasResult = (out.result || []).some(r => r?.when !== 'before')
  const hasSummary = isText(out.summary)
  const tests = out.testing?.length || 0
  const hasDiagram = (out.diagram?.nodes?.length || 0) > 0
  return {
    hasResult, hasSummary, tests, hasDiagram, hasBefore: hasBefore(out), visual: visualOf(flow),
    complete: hasResult && hasSummary && tests > 0, merge: { ready: mergeReady(out) },
  }
}

/**
 * The visual a flow's Output leads with, by priority: `shots` (a result shot, or a screenshot in
 * any step's evidence, which the page shows in its place), `diagram` (the agent's `flow diagram`),
 * else `auto` (the page draws a chart from the flow's own steps). The request for test steps asks
 * for a visual when this is `auto` (relay.mjs requestText). MUST CHANGE IN LOCKSTEP with
 * public/flow-output.js model().visual.
 */
export function visualOf(flow) {
  const out = flow.output || {}
  if (out.result?.length || (flow.nodes || []).some(n => (n.evidence || []).some(e => e?.kind === 'shot'))) return 'shots'
  return out.diagram?.nodes?.length ? 'diagram' : 'auto'
}
