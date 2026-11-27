// The `flow` commands agents run (spec 7.2), behind `node tools/factory.mjs flow …`.
//
// runFlow is pure in the CLI sense: it returns { out, code } and never prints
// or exits, so tests call it directly and tools/factory.mjs does the printing.
// Every flow change goes through flows.mjs (validated, atomic). The one other
// write is copying an evidence file into EVIDENCE_DIR/<flow>/, also by temp
// file and rename, and never to a path outside EVIDENCE_DIR.
//
// Only the user sets `verified` or answers an ask: there is no verify command,
// and `write` merges the user's ticks and answers back in (mergeKeepingAnswers).
// Only the user archives, completes or deletes a flow, too: no command sets `archivedAt` or `completedAt`,
// and any command on a flow the user deleted (trash.mjs: it waits in the flow
// archive) fails with one line telling the agent to stop (TRASHED), so nothing
// writes into a flow the user deleted, and `write` or `new` can never bring one
// back under the same id. Deleted means what the server means (trash.mjs
// isTrashed): an entry and no live file.
//
// Agents run on two Claude accounts with different working folders, so any
// path printed here is absolute.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { outputsSummary, reminderLine } from '../completed.mjs'
import { CONFIG } from '../config.mjs'
import { parseDiagram } from '../diagram-text.mjs'
import { pipelineGraph } from '../pipeline.mjs'
import {
  addEvidence, addNode, applyChatAnswer, createFlow, derive, EVIDENCE_DIR, EVIDENCE_KINDS, listFlows,
  agentMoveRefusal, mergeKeepingAnswers, readFlow, setNodeStatus, validateFlow, visualOf, withPipeline, writeFlow,
} from '../flows.mjs'
import { securityBlock } from '../flow-security.mjs'
import { seniorBlock } from '../flow-senior.mjs'
import { isTrashed } from '../trash.mjs'
import { changeBlock, changeCommands } from './change-cli.mjs'
import { handBlock, handCommands } from './hand-cli.mjs'
import { planBlock, planCommands } from './plan-cli.mjs'
import { qualityCommands } from './quality-cli.mjs'
import { prBlock, prCommands } from './pr-cli.mjs'
import { qaBlock, qaCommands } from './qa-cli.mjs'
import { newRoute, routeBlock, routeCommands, settleRoute } from './route-cli.mjs'
import { withRoutingNew, withRoutingPlan } from './routing-cli.mjs'
import { rulesCommands, withQaRules, withRules } from './rules-cli.mjs'
import { securityCommands } from './security-cli.mjs'
import { seniorCommands } from './senior-cli.mjs'
import { sayCommands, storyBlock } from './story-cli.mjs'

/** Flags that take no value. Every other `--x` takes the next argument. */
const BOOLEAN = new Set(['text', 'open', 'waiting', 'replace', 'clear', 'archived'])
/** `result` and `diagram` take `--before` alone (a before shot, the diagram before); `change --before` takes a line. */
const BEFORE_BOOLEAN = new Set([...BOOLEAN, 'before'])
/**
 * Every flag that is boolean for ANY flow subcommand, for a parse that only wants --by (tools/factory.mjs):
 * there `--before --by X` must not let --before swallow --by. A subcommand still parses its own flags.
 */
export const ANY_BOOLEAN = BEFORE_BOOLEAN
/** The flags `summary` takes more than once (`--commit a --commit b`); every other command keeps the last one. */
const SUMMARY_REPEAT = new Set(['commit', 'diff'])
/** `qa` takes --shot more than once (its --step groups are read from the raw argv, tools/qa-cli.mjs). */
const QA_REPEAT = new Set(['shot'])

/**
 * `a --x 1 b --text` → { _: ['a', 'b'], x: '1', text: true }. Shared with tools/factory.mjs.
 * A flag in `repeat` given twice collects into a list; any other repeat keeps the last value.
 */
export function flags(argv, repeat = new Set(), booleans = BOOLEAN) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const k = a.slice(2)
    if (!a.startsWith('--')) out._.push(a)
    else if (booleans.has(k)) out[k] = true
    else {
      const v = argv[++i] ?? ''
      out[k] = repeat.has(k) && Object.hasOwn(out, k) ? [].concat(out[k], v) : v
    }
  }
  return out
}

/** Evidence files the dashboard will serve (Task 3 serves the same list). */
const EVIDENCE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'webm', 'mp4', 'pdf', 'txt']
const EVIDENCE_ERROR = 'evidence must be an existing png, jpg, jpeg, webp, gif, webm, mp4, pdf or txt file'
/** What a result or test-step shot may be: a picture or a recording, drawn on the Output storyboard. */
const SHOT_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'webm', 'mp4']
const SHOT_ERROR = 'a shot must be an existing png, jpg, jpeg, webp, gif, webm or mp4 file'

export const USAGE = `usage: flow <command>
  new <id> "<title>" --type build|review|ask [--tickets ABC-1,ABC-2] [--env dev] [--why "..."]
   every request gets a flow FIRST, with its type: build for a code change (Request, coordinator, you, QA, Push,
   Output), review for a code review of a ticket (the chat agent), ask for a question, an explanation or an
   investigation (Request, you, Output); then follow that route
  route <flow> --type build|review|ask   change the planned route on purpose (the old one stays in its history)
  step|check <flow> "<title>" [--id n5] [--env stage] [--why "..."] [--after n2,n3] [--status doing]
  ask <flow> "<question>" --why "<why you need this answer>" [--yes "..."] [--no "..."] [--text] [--after n2]
   always pass --why: the user sees it under the question everywhere the ask shows (an ask without one warns)
  answered <flow> <node> --answer yes|no|"<text>" [--note "<the user's words>"]
   the user answered your open ask in your chat instead: it stops waiting in Human review (never changes a set answer)
  note <flow> "<text>" [--after n2]
  status <flow> <node> <todo|doing|done|blocked|skipped>
  evidence <flow> <node> --commit <sha> | --diff <worktree> | --test "<line>" [--file path] | --shot <path> | --url <url> | --note "<text>" [--label "..."]
  set <flow> [--status open|done|blocked|dropped] [--title "..."] [--why "..."] [--tickets ABC-1,ABC-2]
  write <path.json>     whole flow in one go; keeps the answers and ticks the user gave, and the stored output when the file has none;
   a new flow needs "route": { "type": "build" } (or review, ask), and a rewrite keeps the stored route
  show <flow>           the JSON with derived, to read back answers (stdout); what its Output holds (stderr)
  list [--open] [--waiting] [--agent X] [--ticket ABC-1] [--archived]   archived flows only with --archived
  rules [--by "<label>"] [<flow>]   your specification and rules, set by the user on the dashboard (new and qa-start print them too),
   then the lessons from earlier work that match the flow
  self-check <flow> [--done "<id>=ok|no:<what is missing>"]...   before you hand a code flow to QA: without --done the
   checklist for this flow; answer every item at once, a no needs a note. QA reads it at qa-start
  Only the user archives, completes or deletes a flow. A command refused with "deleted" means stop work on that flow.
  new may note on stderr that finished flows wait for the user to mark them completed: tell the user once, calmly.
The Output, what the user sees first: when a piece of work is finished, record
  say <flow> "<what was done>" [--why "<the reason>"] [--who "<label>"] [--id s2 --replace]   one story line
  say-clear <flow>      empties the story, to tell it again
  story: who did what in one short plain sentence (at most 140 characters), then why (160), at most 8 lines;
   not a commit message: no file names, flags or ticket ids. Put a technical word in square brackets the first
   time, like [idempotency], so the dashboard can explain it; define an unusual one with factory.mjs term
  result <flow> --shot <path> [--caption "..."] [--before]   a screenshot of the result; --before: how it looked before
  diagram <flow> "[actor] User -> Page: clicks; Page -> [store] Storage" [--before] [--clear]   how it works, when there is nothing to screenshot
  change <flow> --before "<how it was>" --after "<how it is now>"   one plain line each (140), or --clear
  before and after: before you change anything visible take a result --before shot; after, the result shot;
   always say the change with flow change; for work with no screen, draw diagram --before when the structure changed
  summary <flow> "<markdown>" [--commit <sha>]... [--diff <worktree>]...   what changed and why; replaces the changes
  test-step <flow> "<do this>" --expect "<you should see>" [--shot <path>] [--id t3] [--replace]
  test-clear <flow>     empties the test steps, to record them again
Work only the user can do (a human decision, CI/CD, cloud setup, a console setting): record the steps, then STOP;
never do that work yourself. The user ticks each step off on the dashboard.
  hand-step <flow> "<do this>" --expect "<you should see>" [--where "<path or click path>"] [--copy "<value to paste>"]
   [--why "<one line>"] [--id h3] [--replace]   one step each, in order; at most 20 steps, a line of 200 (where 300,
   copy 2000, why 160); --replace rewrites a step, and a changed step loses the user tick
  hand-clear <flow>     empties the by-hand steps, to record them again
  pr <flow> --head <branch> --base <branch> --title "<title>" --body-file <path>   when the work is ready for the
   base branch: a plain-English title and a body that follows the repo pull request template; never push or open
   the pull request yourself: hand the flow to QA, which tests it and pushes it on a pass; the user then sends it.
   No line may credit an AI tool. pr <flow> --clear
QA only (--by must be config pipeline.qa):
  qa-start <flow> [--commit <sha>] [--status testing|pending]   a new attempt, or the same one before a result
  qa <flow> --status passed|failed --report <file.md> --commit <sha> [--summary "..."] [--shot <file>]...
     [--step "<do>" --expect "<see>" [--step-shot <file>]]...   passed: the flow is done; failed: back to its producer
  qa-push <flow> [--branch <b>] [--remote origin] [--repo <path>]   after a pass: pushes exactly the tested commit,
     never forced, never a protected branch (with Security on the pipeline, only after Security passed it too)
Security only (--by must be config pipeline.security):
  security-start <flow> [--commit <sha>]   review the commit QA passed
  security <flow> --status passed|failed --report <file.md> --commit <sha> [--summary "..."]   passed: QA may
     push it; failed: back to its producer, like a QA failure
Work with no code to test (CI/CD, a cloud console, a terminal, an account setting) is reviewed by Senior when the
pipeline has one (config pipeline.senior): a flow with by-hand steps goes to it once the user ticked them all.
  senior-ask <flow> "<what to review>"   send a no-code flow to Senior on purpose, steps or not (any agent but Senior)
Senior only (--by must be config pipeline.senior):
  senior-start <flow>   review a flow that waits at Senior
  senior <flow> pass|fail "<what was checked / what to redo>" [--steps h1,h2]   pass: the flow is done; fail: back to
     Human task, the named steps (all when none) unticked for the user to do again
The planner only (--by must be config pipeline.planner):
  plan-start <flow>     you took the request from the coordinator and are planning it
  plan <flow> --file <plan.md> --to "<producer>"   hand the task out: the flow becomes that producer's
  Every flow needs a visual: a result shot for work you can see, else a diagram (an API, a job, a deploy).
  diagram: statements split by ; or new lines, each A -> B, A -> B: arrow label, a chain A -> B -> C, or a lone A;
   a kind before a label: [actor] a person or outside system, [store] data at rest, [decision], [box] (the default);
   the same label is the same box; each call replaces the diagram. Keep it high level, the big picture only:
   at most 8 boxes and 10 arrows, a box name of 32 characters and an arrow of 24, named the way you would to a
   colleague, never file names or commit subjects
  (repeat --commit and --diff, or comma-separate them; --replace keeps the old shot unless --shot is given;
   run them one at a time, never in parallel: each rewrites the flow file)
new, write and the Output commands need --by "<your dashboard label>" (or FACTORY_BY): the answers are sent to that name.
Screenshots: save them under ${EVIDENCE_DIR}${path.sep}<flow>${path.sep} (or anywhere), then evidence --shot <path>.`

/**
 * A flow with no agent name cannot have its answers delivered (the relay
 * sends to that name), so new, write and decide refuse to guess one.
 */
export const NO_NAME = 'say who you are with --by <your dashboard label> (or set FACTORY_BY)'

const fail = (out) => ({ out, code: 1 })
const ok = (out) => ({ out, code: 0 })

/** What every command on a deleted flow answers: one line, so the agent stops (trash.mjs). */
export const TRASHED = id => `Flow ${id} was deleted by the user: it is in the flow archive. Stop work on it; only the user can restore it.`
/** `flow new` on a deleted id: the deleted flow keeps its id while it waits in the flow archive. */
const TRASHED_NEW = id => `Flow ${id} was deleted and is in the flow archive. Pick another id.`

/**
 * The dashboard shows why the user is asked under every question (flows.mjs askReason). An ask with no
 * why still goes in (older briefs and `decide` callers must keep working), but the agent is told on
 * stderr, next to a good result, so the next ask carries one. A warning, never a refusal.
 */
export const NO_WHY = 'Warning: no --why. The user sees the reason under the question; without one the dashboard ' +
  'can only say which flow and step the ask follows. Next time add --why "<one plain sentence: why you need this answer>".'
const noWhy = node => node?.type === 'ask' && !isText(node.why)

/** `a, b` → ['a', 'b']; undefined stays undefined so the store applies its default. */
const list = (v) => v === undefined ? undefined : String(v).split(',').map(s => s.trim()).filter(Boolean)
const tickets = (v) => list(v)?.map(t => t.toUpperCase())
/** A flag that may repeat and may hold commas → one flat list; absent → []. */
const many = (v) => (v === undefined ? [] : [].concat(v).flatMap(x => list(String(x))))
const isText = (v) => typeof v === 'string' && v.trim() !== ''
const now = () => new Date().toISOString()

function load(id) {
  const flow = readFlow(id)
  if (!flow) throw new Error(`No flow ${id}`)
  return flow
}

// ═══ Commands (each takes the parsed flags and the context, returns { out, code }) ═══

function cmdNew(f, { by, config }) {
  if (!by) return fail(NO_NAME)
  const [id, title] = f._
  if (isTrashed(id)) return fail(TRASHED_NEW(id))
  createFlow({ id, title, agent: by, tickets: tickets(f.tickets), env: f.env, why: f.why, route: newRoute(f.type, by, by, config) })
  const pile = pileUp(config)
  return pile ? { ...ok(`Flow ${id} created`), err: pile } : ok(`Flow ${id} created`)
}

/**
 * The pile-up reminder (completed.mjs): when the finished flows waiting for the user's sign-off reach outputs.max,
 * `flow new` says so on stderr and still creates the flow (exit 0), so the agent tells the user. Only the user
 * completes a flow, on the dashboard: there is no command for it here. '' below the limit.
 */
function pileUp(config) {
  const c = config || CONFIG
  const s = outputsSummary(listFlows({ archived: 'any' }).flows, pipelineGraph(c), c.outputs, Date.now()) // archiving is no sign-off
  return s.piled ? reminderLine(s.counts.waiting) : ''
}

/** step, check, ask and note: append one node. */
function addCmd(type) {
  return (f) => {
    const [id, title] = f._
    const flow = load(id)
    const node = addNode(flow, {
      type, title, id: f.id, why: f.why, env: f.env, after: list(f.after), status: f.status,
      yes: f.yes, no: f.no, kind: type === 'ask' ? (f.text ? 'text' : 'yesno') : undefined,
    })
    writeFlow(flow)
    const done = ok(`${flow.id} ${node.id}: ${type === 'ask' ? 'waiting on the user' : node.title}`)
    return noWhy(node) ? { ...done, err: NO_WHY } : done
  }
}

// The user answered an open ask in the agent's chat: record it so the dashboard stops asking.
function cmdAnswered(f) {
  const [id, nodeId] = f._
  const flow = load(id)
  applyChatAnswer(flow, nodeId, f.answer === undefined ? null : String(f.answer), f.note)
  writeFlow(flow)
  return ok(`${flow.id} ${nodeId}: answered in the chat`)
}

function cmdStatus(f) {
  const [id, nodeId, status] = f._
  const flow = load(id)
  setNodeStatus(flow, nodeId, status)
  writeFlow(flow)
  return ok(`${flow.id} ${nodeId}: ${status}`)
}

/**
 * Check an evidence file and say where its copy goes: <flow>/<prefix>-<basename>
 * (the prefix is the node id, or `out` / `out-<test id>` for the Output),
 * with -2, -3 … before the extension when that name is taken, so two
 * screenshots both called shot.png (the Playwright default) never overwrite
 * each other or point two nodes at one file. Returns null when the file is
 * missing, not a file, the wrong type, or would land outside EVIDENCE_DIR (a
 * flow id and a node id are slugs and a basename has no separators, so that
 * last check is a backstop).
 */
function evidenceTarget(flowId, prefix, given, cwd, exts = EVIDENCE_EXT) {
  const src = path.resolve(cwd, String(given))
  const base = path.basename(src)
  const ext = path.extname(base).slice(1).toLowerCase()
  if (!exts.includes(ext) || !existsSync(src) || !statSync(src).isFile()) return null
  const stem = `${prefix}-${path.basename(base, path.extname(base))}`
  let name = `${prefix}-${base}`
  for (let k = 2; existsSync(path.resolve(EVIDENCE_DIR, flowId, name)); k++) name = `${stem}-${k}${path.extname(base)}`
  const dest = path.resolve(EVIDENCE_DIR, flowId, name)
  const rel = path.relative(EVIDENCE_DIR, dest)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || path.dirname(rel) !== flowId) return null
  return { src, dest, ref: `${flowId}/${name}` }
}

/** Copy by temp file and rename, so the server never serves half a file. */
function copyEvidence({ src, dest }) {
  mkdirSync(path.dirname(dest), { recursive: true })
  copyFileSync(src, dest + '.tmp')
  renameSync(dest + '.tmp', dest)
}

function cmdEvidence(f, { cwd }) {
  const [id, nodeId] = f._
  const given = EVIDENCE_KINDS.filter(k => f[k] !== undefined)
  if (given.length !== 1) return fail(`evidence needs exactly one of ${EVIDENCE_KINDS.map(k => '--' + k).join(', ')}`)
  const kind = given[0]
  const flow = load(id)

  // The node id names the copy, so an unknown one stops here, before any path is built.
  if (!(flow.nodes || []).some(n => n.id === nodeId)) return fail(`Flow ${flow.id} has no node ${nodeId}`)

  let ref = f[kind]
  let copy = null
  let file
  if (kind === 'shot' || (kind === 'test' && f.file !== undefined)) {
    copy = evidenceTarget(flow.id, nodeId, kind === 'shot' ? f.shot : f.file, cwd)
    if (!copy) return fail(EVIDENCE_ERROR)
    if (kind === 'shot') ref = copy.ref
    else file = copy.ref
  }
  // Add first: a missing node or an ask throws here, before any file is copied.
  addEvidence(flow, nodeId, { kind, ref, label: f.label, file })
  if (copy) copyEvidence(copy)
  writeFlow(flow)
  return ok(`${flow.id} ${nodeId}: ${kind} evidence added`)
}

function cmdSet(f) {
  const flow = load(f._[0])
  const changes = { status: f.status, title: f.title, why: f.why, tickets: tickets(f.tickets) }
  const keys = Object.keys(changes).filter(k => changes[k] !== undefined)
  if (!keys.length) return fail('set needs --status, --title, --why or --tickets')
  const stopped = changes.status !== undefined ? agentMoveRefusal(flow, changes.status) : ''
  if (stopped) return fail(stopped)
  for (const k of keys) flow[k] = changes[k]
  writeFlow(flow)
  return ok(`Flow ${flow.id}: ${keys.join(', ')} set`)
}

function cmdWrite(f, { by, cwd, config }) {
  const file = path.resolve(cwd, f._[0] || '')
  let incoming
  try {
    incoming = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return fail(`Cannot read ${file}: ${err.message}`)
  }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return fail('flow must be a JSON object')
  if (isTrashed(incoming.id)) return fail(TRASHED(incoming.id)) // a write would bring the deleted flow back
  if (incoming.agent === undefined) {
    if (!by) return fail(NO_NAME)
    incoming.agent = by
  }
  // a new flow must say its route (route-cli.mjs): its problem lines come first, with the file's own
  const { warning: routeNote, problems: routeProblems } = settleRoute(incoming, readFlow(incoming.id), { by, config })
  // Check the agent's file before merging, so a malformed node is reported
  // as a problem line rather than crashing the merge.
  const problems = [...routeProblems, ...validateFlow(incoming)]
  if (problems.length) return fail(problems.join('\n'))
  const stored = readFlow(incoming.id)
  const stopped = agentMoveRefusal(stored, incoming.status)
  if (stopped) return fail(stopped)
  const flow = mergeKeepingAnswers(incoming, stored)
  flow.createdAt ||= new Date().toISOString()
  writeFlow(flow)
  const bare = (incoming.nodes || []).filter(noWhy).map(n => n.id)
  const written = ok(`Flow ${flow.id} written`)
  const err = [routeNote, bare.length ? `Warning: no why on ask ${bare.join(', ')}. The user sees the reason under the question: give each ask a "why", one plain sentence.` : ''].filter(Boolean).join('\n')
  return err ? { ...written, err } : written
}

function cmdShow(f, { config }) {
  const flow = load(f._[0])
  const problems = validateFlow(flow)
  if (problems.length) return fail(problems.join('\n'))
  // The JSON alone on stdout, so `show > f.json`, edit, `write f.json` round-trips; the Output block on stderr.
  return { ...ok(JSON.stringify({ ...flow, derived: derive(flow) }, null, 2)), err: `Output\n${outputBlock(flow, config)}` }
}

const count = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`

/** What the Output storyboard holds, so an agent sees what is still missing (and the user's request for test steps). */
function outputBlock(flow, config) {
  const out = flow.output || {}
  const shots = (out.result || []).filter(r => r?.when !== 'before').length // the before shots have their own line
  const steps = out.testing || []
  const boxes = out.diagram?.nodes?.length || 0
  const lines = [
    ...routeBlock(flow, config),
    ...storyBlock(flow),
    `  result: ${shots ? count(shots, 'shot') : 'none yet'}`,
    ...changeBlock(flow),
    `  diagram: ${boxes ? `${count(boxes, 'box', 'boxes')}, ${count(out.diagram.edges?.length || 0, 'arrow')}`
      : visualOf(flow) === 'auto' ? 'none yet (and no result shot: a flow needs a visual, record flow result or draw flow diagram)' : 'none yet'}`,
    `  summary: ${isText(out.summary) ? `yes, ${count(out.changes?.length || 0, 'change')}` : 'none yet'}`,
    `  test steps: ${steps.length || 'none yet'}`,
    ...steps.map((t, i) => `    ${i + 1}. [${t.id}] ${t.do} -> ${t.expect}${t.shot ? '' : ' (no shot)'}`),
    ...handBlock(flow),
    ...prBlock(flow),
    ...planBlock(flow),
    ...qaBlock(flow),
    ...securityBlock(flow),
    ...seniorBlock(flow),
  ]
  // A request counts until a step arrives after it. The relay records requestError when it could not
  // deliver it (relay.mjs), and then it is NOT an open request: the page says not sent the same way
  // (public/flow-output.js), and the user asks again.
  if (out.requestedAt && !steps.some(t => String(t.at || '') > out.requestedAt)) {
    lines.push(out.requestError
      ? `  the request for test steps at ${out.requestedAt} was not sent (${out.requestError})`
      : `  the user asked for test steps at ${out.requestedAt}: record them with test-step`)
  }
  return lines.join('\n')
}

// ═══ The Output: result shots, a summary with its changes, manual test steps ═══
// Each checks the WHOLE flow before it copies a file, so a refused write never leaves a stray copy.

function writeOutput(flow, copy, line) {
  const problems = validateFlow(flow)
  if (problems.length) return fail(problems.join('\n'))
  if (copy) copyEvidence(copy)
  writeFlow(flow)
  return ok(line)
}

function cmdResult(f, { by, cwd }) {
  if (!by) return fail(NO_NAME)
  const flow = load(f._[0])
  if (f.shot === undefined) return fail('result needs --shot <path>')
  const copy = evidenceTarget(flow.id, 'out', f.shot, cwd, SHOT_EXT)
  if (!copy) return fail(SHOT_ERROR)
  const result = [...(flow.output?.result || []), { ref: copy.ref, caption: f.caption ?? '', ...(f.before ? { when: 'before' } : {}), at: now() }]
  flow.output = { ...flow.output, result }
  return writeOutput(flow, copy, `${flow.id}: ${f.before ? 'before' : 'result'} shot ${result.length} added`)
}

/**
 * How it works, from one line of the arrow language (diagram-text.mjs); REPLACES the diagram, or --clear removes
 * it. With --before it is how it worked BEFORE (output.diagramBefore), set and cleared the same way.
 */
function cmdDiagram(f, { by }) {
  if (!by) return fail(NO_NAME)
  const [id, text] = f._
  const flow = load(id)
  const key = f.before ? 'diagramBefore' : 'diagram'
  const name = f.before ? 'diagram before' : 'diagram'
  if (f.clear && text !== undefined) return fail('diagram takes the text or --clear, not both')
  if (f.clear) {
    // the diagram before only shows beside the diagram, so it goes with it
    const both = !f.before && flow.output?.diagramBefore !== undefined
    if (flow.output) {
      flow.output = { ...flow.output }
      delete flow.output[key]
      if (both) delete flow.output.diagramBefore
    }
    return writeOutput(flow, null, `${flow.id}: ${name} cleared${both ? ', and the diagram before with it' : ''}`)
  }
  if (!isText(text)) return fail('diagram needs the text: diagram <flow> "A -> B: label; B -> C", or --clear')
  const { diagram, errors } = parseDiagram(text)
  if (errors.length) return fail(errors.join('\n'))
  flow.output = { ...flow.output, [key]: { ...diagram, at: now() } }
  return writeOutput(flow, null, `${flow.id}: ${name} set, ${count(diagram.nodes.length, 'box', 'boxes')}, ${count(diagram.edges.length, 'arrow')}`)
}

const SHA = /^[0-9a-f]{7,40}$/i

function cmdSummary(f, { by }) {
  if (!by) return fail(NO_NAME)
  const [id, text] = f._
  const flow = load(id)
  if (!isText(text)) return fail('summary needs the text: summary <flow> "<markdown>"')
  const commits = many(f.commit)
  const bad = commits.find(s => !SHA.test(s))
  if (bad) return fail(`--commit ${bad} is not a commit sha (7 to 40 hex characters)`)
  const changes = [...commits.map(ref => ({ kind: 'commit', ref, label: '' })), ...many(f.diff).map(ref => ({ kind: 'diff', ref, label: '' }))]
  flow.output = { ...flow.output, summary: text, changes }
  return writeOutput(flow, null, `${flow.id}: summary set with ${changes.length} change${changes.length === 1 ? '' : 's'}`)
}

const STEP_ID = /^[a-z0-9-]+$/
/** t<highest t-number + 1>, like addNode's n-numbers. */
const nextTestId = steps => 't' + (Math.max(0, ...steps.map(t => /^t(\d+)$/.exec(t.id)?.[1]).filter(Boolean).map(Number)) + 1)

function cmdTestStep(f, { by, cwd }) {
  if (!by) return fail(NO_NAME)
  const [id, what] = f._
  const flow = load(id)
  const steps = flow.output?.testing || []
  if (f.replace && f.id === undefined) return fail('--replace needs --id <the step to rewrite>')
  // The id names the shot's copy, so it is checked before any path is built.
  if (f.id !== undefined && !STEP_ID.test(f.id)) return fail('--id must match /^[a-z0-9-]+$/')
  const at = f.id === undefined ? -1 : steps.findIndex(t => t.id === f.id)
  if (f.replace && at < 0) return fail(`${flow.id} has no test step ${f.id} to replace`)
  if (!f.replace && at >= 0) return fail(`${flow.id} already has a test step ${f.id}: add --replace to rewrite it`)
  const stepId = f.id ?? nextTestId(steps)
  let copy = null
  if (f.shot !== undefined) {
    copy = evidenceTarget(flow.id, `out-${stepId}`, f.shot, cwd, SHOT_EXT)
    if (!copy) return fail(SHOT_ERROR)
  }
  const step = { id: stepId, do: what, expect: f.expect }
  const shot = copy?.ref ?? (at >= 0 ? steps[at].shot : undefined)
  if (shot !== undefined) step.shot = shot
  step.at = now()
  const testing = at >= 0 ? steps.map((t, i) => (i === at ? step : t)) : [...steps, step]
  flow.output = { ...flow.output, testing }
  return writeOutput(flow, copy, `${flow.id} ${stepId}: test step ${at >= 0 ? 'replaced' : 'added'}`)
}

function cmdTestClear(f, { by }) {
  if (!by) return fail(NO_NAME)
  const flow = load(f._[0])
  flow.output = { ...flow.output, testing: [] }
  return writeOutput(flow, null, `${flow.id}: test steps cleared`)
}

function cmdList(f) {
  const { flows } = listFlows({ open: f.open, waiting: f.waiting, agent: f.agent, ticket: f.ticket, archived: f.archived })
  return ok(flows.map(fl => {
    const { done, total } = fl.derived.progress
    return [fl.id, fl.status, fl.agent, `${done}/${total}`, fl.derived.waiting.length ? 'WAITING' : '', fl.title].join('  ')
  }).join('\n'))
}

const COMMANDS = {
  new: withRules(withRoutingNew(cmdNew)),
  step: addCmd('step'),
  check: addCmd('check'),
  ask: addCmd('ask'),
  answered: cmdAnswered,
  note: addCmd('note'),
  status: cmdStatus,
  evidence: cmdEvidence,
  set: cmdSet,
  write: cmdWrite,
  show: cmdShow,
  list: cmdList,
  result: cmdResult,
  diagram: cmdDiagram,
  summary: cmdSummary,
  'test-step': cmdTestStep,
  'test-clear': cmdTestClear,
  ...sayCommands(NO_NAME),
  ...changeCommands(NO_NAME),
  ...handCommands(NO_NAME),
  ...prCommands(NO_NAME),
  ...routeCommands(NO_NAME),
  ...withQaRules(qaCommands({ noName: NO_NAME, evidenceTarget, copyEvidence, shotExt: SHOT_EXT, shotError: SHOT_ERROR })),
  ...rulesCommands(NO_NAME),
  ...plannerCommands(withRoutingPlan(planCommands({ noName: NO_NAME, copyEvidence }))),
  ...reviewerCommands(securityCommands({ noName: NO_NAME, copyEvidence })),
  ...seniorWithRules(seniorCommands({ noName: NO_NAME })),
}

/** The Senior commands, with `senior-start` printing its rules and settings (it refuses anyone but Senior). */
// the self-check, the lessons after the rules, the risk label (tools/quality-cli.mjs): over new, rules, plan and qa-start
Object.assign(COMMANDS, qualityCommands(COMMANDS, { noName: NO_NAME }))

function seniorWithRules(commands) {
  return { ...commands, 'senior-start': withRules(commands['senior-start']) }
}

/** The Security commands, with `security-start` printing its rules and settings (it refuses anyone but Security). */
function reviewerCommands(commands) {
  return { ...commands, 'security-start': withRules(commands['security-start']) }
}

/** The planner's commands, with `plan-start` printing its rules and settings (it refuses anyone but the planner). */
function plannerCommands(commands) {
  return { ...commands, 'plan-start': withRules(commands['plan-start']) }
}

/**
 * Run one `flow` command: { out, code, err? }. Errors from the store come back as `out` with code 1;
 * `err` is a note for stderr next to a good result (show's Output block). `qa-push` runs git, so it
 * returns a Promise of the same (tools/factory.mjs awaits it). `git` and `config` are for the QA
 * commands, so tests stub the git runner and the pipeline (tools/qa-cli.mjs); left out, the real ones.
 */
export function runFlow(argv, { by, cwd, git, config } = {}) {
  const [cmd, ...rest] = argv
  const command = Object.hasOwn(COMMANDS, cmd ?? '') ? COMMANDS[cmd] : null
  if (!command) return fail(USAGE)
  try {
    const booleans = cmd === 'result' || cmd === 'diagram' ? BEFORE_BOOLEAN : BOOLEAN
    const f = flags(rest, cmd === 'summary' ? SUMMARY_REPEAT : cmd === 'qa' ? QA_REPEAT : undefined, booleans)
    // Every command but new, write and list names its flow first (say, change and pr too): one guard for them all.
    if (!['new', 'write', 'list', 'rules'].includes(cmd) && isTrashed(f._[0])) return fail(TRASHED(f._[0]))
    // every write of this command is checked against this config's pipeline (flows.mjs, the Senior gate)
    return withPipeline(config, () => command(f, { by, cwd, argv: rest, ...(git ? { git } : {}), ...(config ? { config } : {}) }))
  } catch (err) {
    return fail(err.message)
  }
}
