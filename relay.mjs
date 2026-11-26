// The answer relay: pushes the user's answer to an ask to the agent that asked,
// with one short headless Claude turn (spec 7.4a).
//
// The turn is a fresh session in the repo, on `factory.relayModel`, with
// exactly two tools: `--tools ListAgents,SendMessage` makes them available
// (⚠️ `--tools ""` removes every built-in, these two included, and
// `--allowedTools` only pre-approves, it never adds a tool back) and
// `--allowedTools ListAgents SendMessage` runs them without a permission
// prompt. See relayArgs. It resolves the flow's agent by name and
// sends ONE message holding every answer queued for that agent; it replies
// SENT or FAILED: <reason>. On SENT each node gets `sentAt`; otherwise each
// gets `deliveryError` and the page offers a retry (deliverNow).
//
// The same batch also carries a status the USER set by hand on a node after
// an ask (`queueStatus`, spec 7.4a): one line naming the node and its status
// as read when the batch goes. Such a line has no sentAt; its outcome is
// only in status().last. So does the user's request for manual test steps
// (`queueRequest`, the Output view's Request test steps): one line per flow,
// with the user's optional note, the latest note winning. So does the user's
// question about a marked word (`queueQuestion`, the page's ask-term): one line
// per flow and word, asking the agent to answer it with `factory.mjs term`;
// nothing is stamped on the flow, and like the rest it lives only in memory.
// So does the user's delete of a flow (`queueDeleted`, trash-routes.mjs): one line telling the agent
// to stop. ⚠️ It is the one item that needs NO flow file, at queue time or when the batch goes: the
// flow is in the flow archive by then, so the item carries the agent and the title itself. `drop` forgets
// everything else queued for that flow at delete time.
// So does the user's Ask the agent for steps (`queueHandRequest`, human-routes.mjs): the same path as a request
// for test steps, one line per flow, the latest note winning, its outcome stamped on `hand.requestSentAt` or
// `hand.requestError` (hand-steps.mjs) instead of the output's.
// So does a QA failure going back to its producer (`queueRework`, qa-rework.mjs): one line per flow,
// sent to `qa.rework.to` (not necessarily the flow's agent), stamped as `qa.rework.sentAt` or `.error`,
// and marked by the startup sweep like a request when the restart lost it.
//
// ⚠️ NO PAID TURN FOR NOBODY (QA, 2026-11-26): before any turn, `present(agent)` is asked whether that agent has a
// session open (server.mjs: a live, not pinned-and-closed, session by that name or label). With none, the turn does
// NOT run (it could only answer FAILED and still cost money): each item is stamped not delivered with the plain reason
// (NO_SESSION) and waits in the queue; every `waitMs` the waiting agents are asked again, and the first time one has
// a session its items go in one turn, which stamps them sent. A presence check that fails or cannot tell lets the
// turn run, as before. A restart forgets the waiting items; their stamped reason stays, and the page offers its retry.
//
// THE WATCHDOG'S HOLD (heal-checks.mjs hold-deliveries, heal-runner.mjs): `health()` says which agents have items
// waiting for a session (and since when) and how many paid turns to each failed in a row. After 3 failures in a row the
// watchdog calls `hold(agent)`: from then on that agent's items are kept, stamped not delivered with the reason
// (HELD), and NO paid turn runs for it, until the user presses Release on the Health page (`release(agent)`: one turn
// for everything held) or Retry on a flow (deliverNow, which always runs). A success clears the count and the hold.
// The hold is in memory only, like the queue.
//
// Rules this file keeps:
// - `queue` runs AFTER the answer route has sent its 200, so it never throws
//   and the delivery promise never rejects: every failure lands in the node's
//   `deliveryError` or in `status().last`.
// - Answers for one agent within `delayMs` of each other go as one message
//   (the timer restarts on each answer). `deliverNow` skips the wait.
// - Every write re-reads the flow and goes through writeFlow (atomic). A node
//   whose answer changed while the turn ran is left alone: applyAnswer cleared
//   its delivery record and the route queued the new answer.
// - `run` is injected, so tests never spawn Claude; `claudeRun` is the real one.
// - The turn answers in json (`--output-format json`): the SENT or FAILED reply
//   is in `.result` and the turn cost in `.total_cost_usd`, recorded as `relay`
//   spend (spend.mjs) whether the delivery worked or not. A reply that is NOT
//   json is read as the plain text it is (exit 0 with SENT still delivers) and
//   records no cost. See unwrap.

import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { claudeBin } from './claude-cli.mjs'
import { CONFIG } from './config.mjs'
import { hasBefore } from './flow-change.mjs'
import { listFlowIds, NODE_STATUS, readFlow, validateFlow, visualOf, writeFlow } from './flows.mjs'
import { handRequestText } from './hand-steps.mjs'
import { lostRework, lookupRework, reworkLine, stampRework } from './qa-rework.mjs'
import { parseTurn, recordCost } from './spend.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** The CLI agents run, absolute and with forward slashes so it pastes into any shell. */
const FACTORY_CLI = path.join(HERE, 'tools', 'factory.mjs').replace(/\\/g, '/')
const RUN_TIMEOUT_MS = 90_000
const ERROR_CAP = 300
const DEFAULT_DELAY_MS = 30_000
/** How often agents with no session open are asked again. */
const DEFAULT_WAIT_MS = 60_000
/** The reason a delivery waits: the agent has no session open (see the header). */
export const noSession = agent => `${agent} has no session open; it is sent when one opens.`
/** The reason a delivery is kept back after the watchdog held its agent (see the header). */
export const held = agent => `The deliveries to ${agent} failed 3 times in a row, so they are held with no paid turn. Press Release on the Health page, or Retry here.`
/** What the startup sweep writes on an answer the restart lost (see sweep). */
export const RESTARTED = 'not sent: the dashboard restarted'
/** How long the page shows a request as requested (public/flow-output.js FRESH_MS): older ones are not swept. */
const REQUEST_FRESH_MS = 30 * 60_000

// ═══ The headless turn ═══

/**
 * The relay turn's argv: the only two tools it has are ListAgents and SendMessage (see the header); json out, for the
 * cost. The PROMPT IS NOT HERE: it goes on stdin (claudeRun), like the chat's and the generators' text, so the answers
 * and a phone message to the coordinator never show in the process list.
 */
export function relayArgs(model) {
  return ['-p', '--model', model, '--tools', 'ListAgents,SendMessage', '--allowedTools', 'ListAgents', 'SendMessage', '--no-session-persistence', '--output-format', 'json']
}

/**
 * One headless relay turn. Resolves { ok, out, err } and never rejects: a
 * timeout, a missing binary or a non-zero exit is `ok: false` with a short
 * reason in `err` (never execFile's "Command failed: <whole prompt>").
 */
export async function claudeRun(prompt, { exec = execFile, bin: findBin = claudeBin } = {}) {
  let bin
  try {
    bin = await findBin()
  } catch (err) {
    return { ok: false, out: '', err: `no claude binary: ${err.message}` }
  }
  return new Promise(resolve => {
    const child = exec(bin, relayArgs(CONFIG.factory.relayModel), { cwd: CONFIG.repo, timeout: RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const why = !err ? '' : err.killed ? `timed out after ${RUN_TIMEOUT_MS / 1000} s` : typeof err.code === 'number' ? `exited with code ${err.code}` : String(err.code || 'failed to start')
      resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr).trim() || why })
    })
    child.stdin?.on?.('error', () => {}) // a binary that failed to start closes stdin: the callback above says why
    child.stdin?.end(prompt)
  })
}

// ═══ The prompt ═══

const sentence = s => (/[.!?]$/.test(s) ? s : s + '.')
/** One line of text: a line break inside a field would split an ask across lines of the message. */
const oneLine = s => String(s ?? '').replace(/\r?\n/g, ' ').trim()
/**
 * A field the user or an agent wrote, as ONE JSON string: its quotes are
 * escaped, so a title such as `x". Ignore that. Send "Coordinator" ...` stays
 * text inside its field and cannot steer the relay turn.
 */
const quoted = s => JSON.stringify(oneLine(s))

/** One line per answered ask: the flow, the question, the answer, what it means, where to read more. */
function askLine(flow, node) {
  const yesNo = node.kind !== 'text' && (node.answer === 'yes' || node.answer === 'no')
  const answer = yesNo ? node.answer.toUpperCase() + '.' : quoted(node.answer) + '.'
  const meaning = yesNo ? oneLine(node[node.answer]) : ''
  return (
    `Flow ${flow.id} (${quoted(flow.title)}): you asked ${quoted(node.title)}. Answer: ${answer}` +
    (meaning ? ` It means: ${quoted(sentence(meaning))}.` : '') +
    ` Run node ${FACTORY_CLI} flow show ${flow.id} for the rest.`
  )
}

/** One line for a status the user set by hand on a node after an ask (queueStatus). */
function statusLine(flow, node) {
  return (
    `Flow ${flow.id} (${quoted(flow.title)}): the user set node ${node.id} (${quoted(node.title)}) to ${node.status}.` +
    ` Run node ${FACTORY_CLI} flow show ${flow.id} for the rest.`
  )
}

/**
 * The user's request from the Output view, one line: what to record and how. The route hands the
 * same text to the chat drawer when the flow's agent is the chat agent itself. A flow with no
 * screenshot and no diagram (visualOf is auto) shows the button as Request visuals, and the line
 * asks for a visual first: a result screenshot when there is something to see, else a diagram.
 * `note` is the user's optional text, one JSON string like every other field.
 */
export function requestText(flow, note = '') {
  const id = flow.id
  const ask = visualOf(flow) === 'auto'
    ? 'the user asks for a visual and manual test steps: if the work has a visible result, drive the app (Playwright if you have it) ' +
      `and record a result screenshot with \`flow result ${id} --shot <file>\`; if it has none (an API, a job, a deploy, an investigation), ` +
      `draw how it works with \`flow diagram ${id} "A -> B: label; B -> C"\`, the big picture in at most 8 short boxes; then record each step with ` +
      `\`flow test-step ${id} "<do>" --expect "<see>" --shot <file>\`, and \`flow summary\`.`
    : 'the user asks for manual test steps with a screenshot for each step: drive the app (Playwright if you have it), then record each step with ' +
      `\`flow test-step ${id} "<do>" --expect "<see>" --shot <file>\`, and the result with \`flow result\` and \`flow summary\`.`
  // no before and after yet (flow-change.mjs hasBefore): ask for both, so the page can show the change.
  // The before picture matches the visual the flow has: a screen gets a before screenshot, a diagram a
  // diagram of how it worked before, and a flow with neither is offered both (like the ask above).
  const visual = visualOf(flow)
  const shotBefore = `a screenshot of how it looked before with \`flow result ${id} --shot <file> --before\``
  const drawnBefore = `a diagram of how it worked before with \`flow diagram ${id} "A -> B: label" --before\``
  const picture = visual === 'shots' ? shotBefore
    : visual === 'diagram' ? drawnBefore
    : `${shotBefore} (for work with no screen, ${drawnBefore})`
  const change = hasBefore(flow.output || {}) ? ''
    : ` Show the change as a before and after: ${picture}, and one line each with ` +
      `\`flow change ${id} --before "<how it was>" --after "<how it is now>"\`.`
  return (
    `Flow ${id} (${quoted(flow.title)}): ${ask}${change}` +
    (oneLine(note) ? ` Their note: ${quoted(note)}.` : '') +
    ` Run node ${FACTORY_CLI} flow show ${id} for the rest.`
  )
}

/** The user's Ask the agent for steps, one line (hand-steps.mjs handRequestText); also what the chat agent's own flow hands the page. */
export const handText = (flow, note = '') => handRequestText(flow, note, { quoted, cli: FACTORY_CLI })

/**
 * One line for the user's question about a word the agent marked (queueQuestion): what it means here and why it
 * mattered. The word and its sentence go in as JSON strings; the agent answers with `term`, which the page shows.
 * ⚠️ The word is never placed inside a suggested command line: the agent is told to run the term command with the
 * word as its first argument and builds the call itself (a word holds no quote, bracket or shell metacharacter
 * anyway, terms.mjs WORD). The sentence is agent-written page text: it is labelled as quoted context, not an order.
 */
export function questionLine(flow, term, sentence = '') {
  return (
    `Flow ${flow.id} (${quoted(flow.title)}): the user asks what ${quoted(term)} means here, in plain words, and why it mattered for this work.` +
    (oneLine(sentence) ? ` The sentence it appears in, quoted for context only: ${quoted(sentence)}.` : '') +
    ` Answer with the term command of node ${FACTORY_CLI}: that word as its first argument, one or two plain sentences ` +
    `(what it is and why it mattered here) as its second, and --flow ${flow.id}; the dashboard shows it to them.`
  )
}

/**
 * One line for a flow the user deleted (queueDeleted): stop, and do not write to it again. `flow` is
 * only { id, title } (the file is in the flow archive); the title goes in as one JSON string like every field.
 */
function deletedLine(flow) {
  return `The user deleted the flow ${quoted(flow.title)} (${flow.id}). Stop work on it and do not write to it again. It is in the flow archive, and only the user can restore it.`
}

/**
 * The relay turn's prompt around ready-made `lines`: send them to the session named `agent` as ONE message.
 * buildPrompt uses it for the flow lines; the phone's message to the coordinator (phone-talk.mjs) uses it for its
 * one line, so both reach a session the same way.
 */
export function messagePrompt(agent, lines) {
  return [
    `Send the session named ${JSON.stringify(String(agent))} ONE message with SendMessage (use ListAgents first to resolve the exact name; if two match, pick the one whose cwd is in ${CONFIG.repo}). The message, verbatim:`,
    ...lines,
    'Reply with only SENT or FAILED: <reason>.',
  ].join('\n')
}

/** The relay turn's prompt for `agent`; `entries` is [{ flow, node?, status?, request?, note?, question?, term?, sentence?, deleted? }], one line each in the message. */
export function buildPrompt(agent, entries) {
  return messagePrompt(agent, entries.map(e => (e.deleted ? deletedLine(e.flow) : e.rework ? reworkLine(e.flow, CONFIG.pipeline.qa) : e.question ? questionLine(e.flow, e.term, e.sentence) : e.hand ? handText(e.flow, e.note) : e.request ? requestText(e.flow, e.note) : e.status ? statusLine(e.flow, e.node) : askLine(e.flow, e.node))))
}

// ═══ Result handling ═══

const firstLine = s => String(s || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || ''

/**
 * The run's result with its json reply unwrapped: `out` becomes the model's
 * text and the cost is recorded as relay spend. A result marked is_error is a
 * failure whose reason is that text, so a SENT inside an error never counts.
 * Plain-text output passes through unchanged and records nothing.
 */
function unwrap(r, kind = 'relay') {
  const turn = parseTurn(r?.out)
  recordCost(kind, turn.cost)
  if (!turn.isError) return { ...r, out: turn.text }
  return { ok: false, out: '', err: turn.text || r?.err || 'the turn reported an error' }
}

/** SENT anywhere at a line start is success; otherwise the FAILED line, else err, else "no reply". */
function judge(r) {
  const out = String(r?.out || '')
  if (r?.ok && /^SENT/m.test(out)) return { ok: true }
  const error = (/^FAILED:.*$/m.exec(out) || [])[0]?.trim() || firstLine(r?.err) || 'no reply'
  return { ok: false, error: error.slice(0, ERROR_CAP) }
}

/**
 * A finished relay turn judged the relay's way: { ok } on SENT, else { ok: false, error }. Its cost is recorded
 * as `kind` spend (spend.mjs): the phone's messages to the coordinator are their own kind, `phone`.
 */
export const relayOutcome = (r, kind = 'relay') => judge(unwrap(r, kind))

/** The flow and its answered ask, read fresh; throws a one-line reason when either is gone or unanswered. */
function lookup(flowId, nodeId) {
  const flow = readFlow(flowId)
  if (!flow) throw new Error(`Flow ${flowId} is gone`)
  const node = (flow.nodes || []).find(n => n.id === nodeId)
  if (!node) throw new Error(`Flow ${flowId} has no node ${nodeId}`)
  if (node.type !== 'ask') throw new Error(`Node ${nodeId} in flow ${flowId} is not an ask`)
  if (node.answer === null || node.answer === undefined) throw new Error(`Node ${nodeId} in flow ${flowId} has no answer yet`)
  return { flow, node }
}

/** The flow and a step or check, read fresh, for a status line; throws a one-line reason otherwise. */
function lookupStatus(flowId, nodeId) {
  const flow = readFlow(flowId)
  if (!flow) throw new Error(`Flow ${flowId} is gone`)
  const node = (flow.nodes || []).find(n => n.id === nodeId)
  if (!node) throw new Error(`Flow ${flowId} has no node ${nodeId}`)
  if (node.type !== 'step' && node.type !== 'check') throw new Error(`Node ${nodeId} in flow ${flowId} has no status`)
  // The status goes into the prompt bare, so only a known one (a hand-edited file may hold anything).
  if (!NODE_STATUS.includes(node.status)) throw new Error(`Node ${nodeId} in flow ${flowId} has an unknown status`)
  return { flow, node, status: true }
}

/** The flow, read fresh, for a request for test steps; throws a one-line reason when it is gone. */
function lookupRequest(flowId, note) {
  const flow = readFlow(flowId)
  if (!flow) throw new Error(`Flow ${flowId} is gone`)
  return { flow, request: true, note, requestedAt: flow.output?.requestedAt ?? null }
}

/** The flow, read fresh, for a request for by-hand steps; throws a one-line reason when it is gone. */
function lookupHand(flowId, note) {
  const flow = readFlow(flowId)
  if (!flow) throw new Error(`Flow ${flowId} is gone`)
  return { flow, hand: true, note, requestedAt: flow.hand?.requestedAt ?? null }
}

/** The flow, read fresh, for a question about a marked word; throws a one-line reason when it is gone. */
function lookupQuestion(flowId, term, sentence) {
  const flow = readFlow(flowId)
  if (!flow) throw new Error(`Flow ${flowId} is gone`)
  return { flow, question: true, term, sentence }
}

/**
 * The item's entry, read fresh: an answered ask, a node whose status the user set, a request for test steps, or a
 * question. A deleted flow is NOT read (its file is in the flow archive): its entry is built from what the item carries.
 */
const lookupItem = ({ flowId, nodeId, kind, note, term, sentence, title }) =>
  kind === 'deleted' ? { flow: { id: flowId, title }, deleted: true }
    : kind === 'rework' ? lookupRework(flowId)
    : kind === 'status' ? lookupStatus(flowId, nodeId)
    : kind === 'request' ? lookupRequest(flowId, note)
    : kind === 'hand' ? lookupHand(flowId, note)
    : kind === 'question' ? lookupQuestion(flowId, term, sentence)
    : lookup(flowId, nodeId)

/**
 * Record the outcome on each node, one fresh read and atomic write per flow.
 * A node whose answer changed since the prompt was built is skipped, and so
 * is a flow that vanished. A request for test steps records it on the flow's
 * output (requestSentAt, or requestError so the page says not sent), unless
 * the user asked again meanwhile. A read or write that FAILS is never swallowed:
 * each is logged and returned as one line (status().last.stampError), since
 * an ask left with neither sentAt nor deliveryError looks like nothing at all.
 */
function stamp(entries, outcome, at) {
  const errors = []
  const byFlow = new Map() // Map.groupBy needs Node 21; package.json promises 20
  for (const e of entries) byFlow.set(e.flow.id, [...(byFlow.get(e.flow.id) || []), e])
  for (const [flowId, list] of byFlow) {
    try {
      const flow = readFlow(flowId)
      if (!flow) continue
      let changed = false
      for (const entry of list) {
        const { node: sent, status, request, question, deleted, requestedAt, rework, hand } = entry
        if (status || question || deleted) continue // a status line, a question or a delete has no delivery record on the flow
        if (rework) {
          changed = stampRework(flow, entry, outcome, at) || changed
          continue
        }
        if (hand) {
          const h = flow.hand
          if (!h || !requestedAt || h.requestedAt !== requestedAt) continue
          if (outcome.ok) Object.assign(h, { requestSentAt: at, requestError: null })
          else h.requestError = outcome.error
          changed = true
          continue
        }
        if (request) {
          const out = flow.output
          if (!out || !requestedAt || out.requestedAt !== requestedAt) continue
          if (outcome.ok) Object.assign(out, { requestSentAt: at, requestError: null })
          else out.requestError = outcome.error
          changed = true
          continue
        }
        const node = (flow.nodes || []).find(n => n.id === sent.id)
        if (!node || node.answer !== sent.answer || node.answeredAt !== sent.answeredAt) continue
        if (outcome.ok) Object.assign(node, { sentAt: at, deliveryError: null })
        else node.deliveryError = outcome.error
        changed = true
      }
      if (changed) writeFlow(flow)
    } catch (err) {
      const line = `could not record the delivery on flow ${flowId}: ${String(err?.message || err).replace(/\s*\n\s*/g, '; ')}`
      console.error(`relay: ${line}`)
      errors.push(line)
    }
  }
  return errors.join(' | ').slice(0, ERROR_CAP) || null
}

// ═══ The queue ═══

/**
 * makeRelay({ run, now?, delayMs?, present?, waitMs? }) -> { queue, queueStatus, queueRequest, queueQuestion, queueDeleted, queueRework, drop, deliverNow, status, sweep, hold, release, health }.
 * `run(prompt)` resolves { ok, out, err }; it may reject, which counts as a failure.
 */
export function makeRelay({ run, now = () => new Date().toISOString(), delayMs = DEFAULT_DELAY_MS, present = null, waitMs = DEFAULT_WAIT_MS }) {
  /** agent -> { items: [{ flowId, nodeId, kind: 'answer' | 'status' | 'request' | 'question' | 'deleted' | 'rework', note?, term?, sentence?, title? }], timer } */
  const batches = new Map()
  let running = 0
  let last = null

  /** Remember the outcome for status().last (with any stamp failure) and hand it back. */
  const record = (outcome, stampError = null) => {
    last = outcome.ok ? { at: now(), ok: true } : { at: now(), ok: false, error: outcome.error }
    if (stampError) last.stampError = stampError
    return outcome
  }
  const fail = message => ({ ok: false, error: String(message).slice(0, ERROR_CAP) })

  /** false only when `present` says the agent has no session open; no check, or a check that fails, is true. */
  async function isPresent(agent) {
    if (typeof present !== 'function') return true
    try {
      return (await present(agent)) !== false
    } catch {
      return true
    }
  }
  /** agent -> items waiting for a session to open (see the header); one timer asks again for all of them. */
  const waiting = new Map()
  /** agent -> when its oldest waiting item started to wait (ISO), for the watchdog (health()). */
  const waitingSince = new Map()
  /** agent -> { count, lastError, lastAt }: paid turns to it that failed in a row; a success clears it. */
  const fails = new Map()
  /** agent -> the items kept back after the watchdog held it (see the header). */
  const holds = new Map()
  let waitTimer = null
  function wait(agent, items) {
    if (!waitingSince.has(agent)) waitingSince.set(agent, now())
    const list = waiting.get(agent) || []
    for (const i of items) if (!list.some(x => x.flowId === i.flowId && x.nodeId === i.nodeId && x.kind === i.kind && x.term === i.term)) list.push(i)
    waiting.set(agent, list)
    if (waitTimer) return
    waitTimer = setInterval(async () => {
      for (const [a, list] of [...waiting]) {
        if (!(await isPresent(a))) continue
        waiting.delete(a)
        waitingSince.delete(a)
        void deliver(a, list)
      }
      if (!waiting.size) {
        clearInterval(waitTimer)
        waitTimer = null
      }
    }, waitMs)
    waitTimer.unref?.()
  }

  /** Keep `items` for a held agent, once each. */
  function keep(agent, items) {
    const list = holds.get(agent) || []
    for (const i of items) if (!list.some(x => x.flowId === i.flowId && x.nodeId === i.nodeId && x.kind === i.kind && x.term === i.term)) list.push(i)
    holds.set(agent, list)
  }
  /** A paid turn's outcome for the watchdog: a success clears the count (and a hold, sending what it kept). */
  function noteTurn(agent, outcome) {
    if (!outcome.ok) {
      const f = fails.get(agent)
      fails.set(agent, { count: (f?.count || 0) + 1, lastError: outcome.error, lastAt: now() })
      return
    }
    fails.delete(agent)
    const rest = holds.get(agent)
    holds.delete(agent)
    if (rest?.length) void deliver(agent, rest)
  }

  /**
   * One turn for `agent` with every item still answered; resolves { ok, error? } and never rejects. `force` (the
   * user's Retry, Release) runs it even while the agent is held.
   */
  async function deliver(agent, items, { force = false } = {}) {
    running++
    try {
      const entries = []
      let skipped = null
      for (const item of items) {
        try {
          entries.push(lookupItem(item))
        } catch (err) {
          skipped ??= err.message
        }
      }
      if (!entries.length) return record(fail(skipped || 'nothing to deliver'))
      let outcome
      if (!agent) outcome = fail('the flow names no agent to send the answer to')
      else if (!force && holds.has(agent)) {
        outcome = fail(held(agent)) // no turn: the watchdog held it after 3 paid failures (see the header)
        keep(agent, items)
      } else if (!(await isPresent(agent))) {
        outcome = fail(noSession(agent)) // no turn: it could only fail, and it would still cost (see the header)
        wait(agent, items)
      } else {
        let r
        try {
          r = unwrap(await run(buildPrompt(agent, entries)))
        } catch (err) {
          r = { ok: false, out: '', err: err?.message || String(err) }
        }
        outcome = judge(r)
        noteTurn(agent, outcome)
      }
      return record(outcome, stamp(entries, outcome, now()))
    } catch (err) {
      return record(fail(err?.message || String(err)))
    } finally {
      running--
    }
  }

  /**
   * Add an item to its agent's batch and restart the wait; never throws (the route has already replied).
   * The agent is the flow's, read fresh; a deleted flow's item names its own (`agent`), since there is no file.
   */
  function enqueue(flowId, nodeId, kind, note, term, sentence, gone = null) {
    try {
      // a rework goes to the producer QA named (its entry's agent); everything else to the flow's agent
      const entry = gone ? null : lookupItem({ flowId, nodeId, kind, note, term, sentence })
      const agent = gone ? gone.agent : entry.agent ?? entry.flow.agent
      let batch = batches.get(agent)
      if (!batch) batches.set(agent, (batch = { items: [], timer: null }))
      const same = batch.items.find(i => i.flowId === flowId && i.nodeId === nodeId && i.kind === kind && (kind !== 'question' || i.term === term))
      if (!same) {
        batch.items.push(kind === 'request' || kind === 'hand' ? { flowId, nodeId, kind, note }
          : kind === 'question' ? { flowId, nodeId, kind, term, sentence }
          : kind === 'deleted' ? { flowId, nodeId, kind, title: gone.title }
          : { flowId, nodeId, kind })
      } else if (kind === 'request' || kind === 'hand') same.note = note // one request per flow: the latest note wins
      else if (kind === 'question') same.sentence = sentence // one question per flow and word: the latest sentence wins
      else if (kind === 'deleted') same.title = gone.title // one stop line per flow, however often it is deleted
      clearTimeout(batch.timer)
      batch.timer = setTimeout(() => {
        batches.delete(agent)
        void deliver(agent, batch.items)
      }, delayMs)
      batch.timer.unref()
    } catch (err) {
      record(fail(err?.message || String(err)))
    }
  }

  /** Queue an answered ask for its agent. */
  const queue = (flowId, nodeId) => enqueue(flowId, nodeId, 'answer')
  /** Queue a status the user set on a step or check after an ask; the line reads the status when the batch goes. */
  const queueStatus = (flowId, nodeId) => enqueue(flowId, nodeId, 'status')
  /** Queue the user's request for manual test steps on a flow, with their optional note; it batches like the rest. */
  const queueRequest = (flowId, note = '') => enqueue(flowId, null, 'request', String(note ?? ''))
  /** Queue the user's question about a word the agent marked, with the sentence it came up in; it batches like the rest. */
  const queueQuestion = (flowId, term, sentence = '') => enqueue(flowId, null, 'question', undefined, String(term ?? ''), String(sentence ?? ''))
  /** Queue the user's Ask the agent for steps on a flow, with their optional note; the same path as queueRequest. */
  const queueHandRequest = (flowId, note = '') => enqueue(flowId, null, 'hand', String(note ?? ''))
  /**
   * Tell `agent` the user deleted flow `flowId` titled `title`: ONE line, batched like the rest, and needing no flow
   * file. The route calls it only for an open or blocked flow whose agent is not the chat agent (trash-routes.mjs).
   */
  /** Queue a QA failure going back to its producer (qa-rework.mjs noticeReworks); one line per flow, batched like the rest. */
  const queueRework = flowId => enqueue(flowId, null, 'rework')
  const queueDeleted = (flowId, title, agent) => enqueue(flowId, null, 'deleted', undefined, undefined, undefined, { title: String(title ?? ''), agent: String(agent ?? '') })

  /** At delete time: forget every item still queued for `flowId` (answers, statuses, requests, questions, an earlier delete). */
  function drop(flowId) {
    for (const [agent, batch] of batches) {
      batch.items = batch.items.filter(i => i.flowId !== flowId)
      if (!batch.items.length) {
        clearTimeout(batch.timer)
        batches.delete(agent)
      }
    }
  }

  /** The retry: deliver this one node now, dropping any queued copy so it is not sent twice. */
  async function deliverNow(flowId, nodeId) {
    for (const [agent, batch] of batches) {
      batch.items = batch.items.filter(i => !(i.flowId === flowId && i.nodeId === nodeId && i.kind === 'answer'))
      if (!batch.items.length) {
        clearTimeout(batch.timer)
        batches.delete(agent)
      }
    }
    let agent
    try {
      agent = lookup(flowId, nodeId).flow.agent
    } catch (err) {
      return record(fail(err?.message || String(err)))
    }
    return deliver(agent, [{ flowId, nodeId, kind: 'answer' }], { force: true })
  }

  /** The watchdog's hold (heal-runner.mjs): from now on no paid turn runs for `agent` until release. */
  function hold(agent) {
    if (!agent || holds.has(agent)) return false
    holds.set(agent, [])
    return true
  }
  /** The user's Release: the count starts again, and everything kept goes in one turn. Resolves how many were sent. */
  async function release(agent) {
    const items = holds.get(agent)
    if (!items) return { released: false, items: 0 }
    holds.delete(agent)
    fails.delete(agent)
    if (items.length) await deliver(agent, items, { force: true })
    return { released: true, items: items.length }
  }
  /** For the watchdog: who waits for a session (since when, how many items) and whose paid turns failed in a row. */
  function health() {
    const agents = new Set([...fails.keys(), ...holds.keys()])
    return {
      waiting: [...waiting].map(([agent, list]) => ({ agent, since: waitingSince.get(agent) || now(), items: list.length })),
      fails: [...agents].map(agent => ({ agent, count: fails.get(agent)?.count || 0, lastError: fails.get(agent)?.lastError || '', held: holds.has(agent), heldItems: holds.get(agent)?.length || 0 })),
    }
  }

  function status() {
    return {
      pending: [...batches.values()].flatMap(b => b.items.map(({ flowId, nodeId }) => ({ flowId, nodeId }))),
      running: running > 0,
      last,
    }
  }

  /**
   * The startup sweep. The queue lives only in memory, so an answer queued
   * (30 s debounce) or mid-turn when the server stopped would stay answered
   * with neither sentAt nor deliveryError, and the agent would wait forever.
   * Each such ask is MARKED `not sent: the dashboard restarted`, never
   * re-sent: the turn may in fact have gone out before the stop, and a mark
   * costs nothing while the page offers the retry. A request for test steps
   * under 30 minutes old (what the page still shows as requested) with neither
   * requestSentAt nor requestError is marked the same way, as requestError.
   * Runs no turn. Returns the marked [{ flowId, nodeId }] (nodeId null for a
   * request); a file that fails to read or write is logged.
   */
  function sweep() {
    const marked = []
    const at = Date.parse(now())
    for (const flowId of listFlowIds()) {
      try {
        const flow = readFlow(flowId)
        if (!flow || validateFlow(flow).length) continue
        const lost = flow.nodes.filter(n => n.type === 'ask' && n.answer != null && !n.sentAt && !n.deliveryError)
        const out = flow.output
        const asked = Date.parse(out?.requestedAt || '')
        const lostRequest = at - asked <= REQUEST_FRESH_MS && !(out.requestSentAt >= out.requestedAt) && !out.requestError
        const lostQa = lostRework(flow, RESTARTED) // a QA failure queued to go back and never sent (qa-rework.mjs)
        if (!lost.length && !lostRequest && !lostQa) continue
        for (const n of lost) n.deliveryError = RESTARTED
        if (lostRequest) out.requestError = RESTARTED
        writeFlow(flow)
        for (const n of lost) marked.push({ flowId, nodeId: n.id })
        if (lostRequest) marked.push({ flowId, nodeId: null })
        if (lostQa) marked.push({ flowId, nodeId: null, rework: true })
      } catch (err) {
        console.error(`relay: the startup sweep could not mark flow ${flowId}: ${err?.message || err}`)
      }
    }
    return marked
  }

  return { queue, queueStatus, queueRequest, queueHandRequest, queueQuestion, queueDeleted, queueRework, drop, deliverNow, status, sweep, hold, release, health }
}
