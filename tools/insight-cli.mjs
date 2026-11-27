// Master's insight commands, behind `node tools/factory.mjs …` (tools/factory.mjs hands them here):
//
//   orchestration [--json] [--section <name>] --by <label>
//       The whole orchestration in one read (insight-digest.mjs): Pipeline, Work, Numbers, Signals, Health and
//       Suggestions, at most about 12,000 characters. It asks the running dashboard first (GET /api/insight/digest,
//       the same in-memory stores its pages read); with no dashboard running it builds the parts it can from the
//       files and names every part it left out. Read by the coordinator (--by is its label), the inbox items it
//       showed are marked read (insight-inbox.mjs): the next read starts from there.
//   suggest "<what to change>" --why "<evidence>" --kind rule|setting|process|fix [--target <agent|key>]
//       [--effort small|medium|large] --by <coordinator>
//   suggestions [--open] --by <coordinator>          its suggestions, newest first, with what the user did
//   suggest-drop <id> --by <coordinator>             takes back its own unanswered suggestion
//
// ⚠️ ONLY THE COORDINATOR suggests, lists and drops: --by (or FACTORY_BY) must be exactly config's coordinator label,
// like the other role commands (tools/senior-cli.mjs). Anyone may read the digest; only the coordinator's read moves
// the inbox marker. Every command returns { out, code } (orchestration a Promise of one) and never prints: tests call
// them directly and tools/factory.mjs prints.

import { CONFIG } from '../config.mjs'
import { agentLabels } from '../agent-rules.mjs'
import { listFlowIds } from '../flows.mjs'
import { pipelineGraph } from '../pipeline.mjs'
import { drop, readSuggestions, suggest, SUGGESTIONS_FILE } from '../insight-suggestions.mjs'
import { renderDigest, SECTION_NAMES } from '../insight-digest.mjs'
import { fileProviders } from '../insight-files.mjs'
import { gatherDigest } from '../insight-gather.mjs'
import { markRead } from '../insight-inbox.mjs'

/** The flags these commands take with no value, so `--json --by X` keeps the name (tools/factory.mjs parses with them). */
export const INSIGHT_BOOLEAN = Object.freeze(['json', 'open'])
export const INSIGHT_COMMANDS = Object.freeze(['orchestration', 'suggest', 'suggestions', 'suggest-drop'])

const fail = out => ({ out, code: 1 })
const ok = out => ({ out, code: 0 })
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = iso => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** One line when `by` may not run a coordinator command; null when it may. */
export function notCoordinator(by, label = CONFIG.coordinatorLabel) {
  if (!by) return 'Say who you are with --by "<your dashboard label>" (or FACTORY_BY).'
  return by === label ? null : `Only ${label} suggests: --by must be "${label}" (config coordinator), not "${by}".`
}

/** A sentence that ends once: `It is.` stays, `It is` gets its full stop. */
const sentence = t => (/[.!?]$/.test(t) ? t : `${t}.`)

/** A suggestion as the list prints it: the head line, then its evidence and the user's answer, indented. */
function lines(s) {
  const head = `${s.id}  ${s.state.padEnd(8)} ${s.kind.padEnd(7)} ${s.target ? `${s.target} · ` : ''}${day(s.at)}  ${s.text}`
  const answer = s.state === 'rejected' ? `  Rejected ${day(s.decidedAt)}${s.reason ? `: ${sentence(s.reason)}` : ' with no reason given.'} Do not propose it again.`
    : s.state === 'accepted' ? `  Accepted ${day(s.decidedAt)}.${s.outcome ? ` ${sentence(s.outcome)}` : ' Act on it.'}`
      : s.state === 'done' ? `  Done.${s.outcome ? ` ${sentence(s.outcome)}` : ''}` : ''
  return [head, `  Evidence: ${s.why.replace(/\s+/g, ' ')}`, answer].filter(Boolean).join('\n')
}

/**
 * The three suggestion commands. `deps` lets the tests pass their own file, clock, graph and flow ids.
 * `f` is the parsed flags ({ _, why, kind, target, effort, open }).
 */
export function runSuggestions(cmd, f, { by }, { file = SUGGESTIONS_FILE, config = CONFIG, now = Date.now(), flowIds = () => new Set(listFlowIds()) } = {}) {
  const refused = notCoordinator(by, config.coordinatorLabel)
  if (refused) return fail(refused)
  if (cmd === 'suggest') {
    const r = suggest(
      { text: f._.join(' '), why: f.why, kind: f.kind, target: f.target, effort: f.effort },
      { by, coordinator: config.coordinatorLabel, now, targets: agentLabels(pipelineGraph(config)), flowIds: flowIds() },
      file,
    )
    if (r.error) return fail(r.error)
    return ok(`Suggestion ${r.suggestion.id} is saved. The user decides on the Suggestions page; the decision comes back in your next digest (factory.mjs orchestration).`)
  }
  if (cmd === 'suggest-drop') {
    const r = drop(f._[0], { by }, file)
    return r.error ? fail(r.error) : ok(`Suggestion ${r.dropped.id} is dropped.`)
  }
  const { list, broken } = readSuggestions(file)
  if (broken) return fail('The suggestions file is damaged: data/suggestions.json does not parse. Tell the user; the Health page keeps a copy of it.')
  const shown = list.filter(s => !f.open || s.state === 'open').reverse()
  if (!shown.length) return ok(f.open ? 'No open suggestions.' : 'No suggestions yet.')
  const open = list.filter(s => s.state === 'open').length
  return ok([`${open} open of ${list.length}, newest first:`, ...shown.map(lines)].join('\n'))
}

// ═══ the digest ═══

/** How long the CLI waits for the running dashboard before it builds the digest from the files itself. */
const ASK_MS = 15_000

/**
 * The digest from the running dashboard: { at, inbox, sections } as GET /api/insight/digest answers it, or null when
 * no dashboard answers (not running, an older one with no such route, too slow). Never throws.
 */
export async function askDashboard({ port = CONFIG.port, section = null, fetchFn = fetch, timeoutMs = ASK_MS } = {}) {
  try {
    const q = new URLSearchParams(section ? { section } : {})
    const r = await fetchFn(`http://127.0.0.1:${port}/api/insight/digest${q.size ? `?${q}` : ''}`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return null
    const j = await r.json()
    return j && typeof j === 'object' && j.sections && typeof j.at === 'string' ? j : null
  } catch {
    return null
  }
}

/**
 * `orchestration [--json] [--section <name>]`: the digest, from the running dashboard or else from the files. Read
 * by the coordinator (and the whole digest, so the inbox lines were shown), the inbox is marked read up to the time
 * the digest was built: anything added after that stays new for the next read.
 */
export async function runOrchestration(f, { by }, { config = CONFIG, ask = askDashboard, files = () => fileProviders({ config }), now = () => Date.now(), mark = markRead } = {}) {
  const section = typeof f.section === 'string' && f.section ? f.section.toLowerCase() : null
  if (section && !SECTION_NAMES.includes(section)) return fail(`There is no part called ${f.section}. The parts: ${SECTION_NAMES.join(', ')}.`)
  let digest = await ask({ port: config.port, section })
  let source = 'dashboard'
  if (!digest) {
    digest = await gatherDigest(files(), { now: now(), only: section })
    source = 'files'
  }
  const out = f.json ? JSON.stringify({ ...digest, source }, null, 1) : renderDigest({ ...digest, by, only: section, source })
  if (by && by === config.coordinatorLabel && !section) mark(digest.at)
  return ok(out)
}
