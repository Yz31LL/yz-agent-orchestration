// What the dashboard's OWN headless turns cost (spec F4): the chat, the answer
// relay, the term explainer, the ticket-source refreshes and the two Generators tools: the
// Prompt generator (kind `script`) and the Standup creator (kind `standup`), and the quality runs: a lesson extraction
// (kind `lesson`) and a second opinion on a plan (kind `critic`), quality-extract.mjs and quality-critic.mjs. Each turn's
// `total_cost_usd` becomes one line of data/spend.jsonl, and the rail's chip
// shows today's sum (GET /api/spend, public/spend.js).
//
// Rules this file keeps:
// - ⚠️ The file is APPEND-ONLY, written with appendFileSync, one JSON line per
//   turn: { "at": ISO, "kind": "chat|relay|explain|refresh|script|standup|lesson|critic|intake|retro|learn|phone|insight", "usd": number },
//   and for a ticket refresh `"collection": "<id>"` (which collection paid it: the watchdog, heal-checks.mjs).
//   `insight` is an urgent message to the coordinator (insight-inbox.mjs, only with insight.notifyMaster urgent).
//   That is deliberate: atomic-write.mjs (temp file + rename) is for files
//   rewritten whole, while one appended line is a single small write that
//   never rewrites the lines before it. A reader that meets a torn or hand-made
//   line skips it (readSpend), so one bad line never hides the rest.
// - The path follows FACTORY_DATA_DIR like every other data file (through
//   factory-state.mjs's DATA_DIR), so tests never write the real data/ folder.
// - `recordCost` NEVER throws: a cost is a side note on a turn that already
//   ran, so a failed write is logged and the caller carries on.
// - "Today" is the LOCAL calendar day of `now`, the day the user lives in, not
//   the UTC one: a turn at 00:30 in London belongs to the new day.
// - The sums are raw floats; the page rounds to cents (spend.js).

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { DATA_DIR } from './factory-state.mjs'

export const SPEND_FILE = path.join(DATA_DIR, 'spend.jsonl')
/** The headless turns the dashboard runs itself. */
export const KINDS = Object.freeze(['chat', 'relay', 'explain', 'refresh', 'script', 'standup', 'lesson', 'critic', 'intake', 'retro', 'learn', 'phone', 'insight'])
/** The one extra field a line may carry: which collection a refresh was for (an id, as factory.mjs validates them). */
const COLLECTION = /^[A-Za-z0-9_-]{1,60}$/
const RECENT = 20

const isCost = usd => typeof usd === 'number' && Number.isFinite(usd) && usd > 0

/**
 * Append one turn's cost. Writes nothing for an unknown kind or a cost that is
 * not a positive number (a turn whose result had none). Returns whether a line
 * was written; never throws.
 */
export function recordCost(kind, usd, at = new Date(), { collection } = {}) {
  if (!KINDS.includes(kind) || !isCost(usd)) return false
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const named = typeof collection === 'string' && COLLECTION.test(collection) ? { collection } : {}
    appendFileSync(SPEND_FILE, JSON.stringify({ at: at.toISOString(), kind, usd, ...named }) + '\n')
    return true
  } catch (err) {
    console.error(`spend: could not record a ${kind} cost of ${usd}: ${err?.message || err}`)
    return false
  }
}

/** One line as { at, kind, usd }, or null when it is not a well-formed spend line. */
function parseLine(text) {
  let l
  try {
    l = JSON.parse(text)
  } catch {
    return null
  }
  if (!l || typeof l !== 'object' || !KINDS.includes(l.kind) || !isCost(l.usd) || typeof l.at !== 'string') return null
  const t = new Date(l.at)
  const named = typeof l.collection === 'string' && COLLECTION.test(l.collection) ? { collection: l.collection } : {}
  return Number.isNaN(t.getTime()) ? null : { at: l.at, kind: l.kind, usd: l.usd, t, ...named }
}

const sameLocalDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/**
 * Today's spend: `today` (the sum of the lines on the local calendar day of
 * `now`), `byKind` (that sum per kind, every kind present, 0 when none) and
 * `recent` (the last 20 well-formed lines of any day, newest first).
 */
export function readSpend(now = new Date()) {
  const byKind = Object.fromEntries(KINDS.map(k => [k, 0]))
  let text = ''
  try {
    text = readFileSync(SPEND_FILE, 'utf8')
  } catch {
    /* no file yet: nothing spent */
  }
  const lines = text.split(/\r?\n/).map(parseLine).filter(Boolean)
  let today = 0
  for (const l of lines) {
    if (!sameLocalDay(l.t, now)) continue
    today += l.usd
    byKind[l.kind] += l.usd
  }
  const recent = lines.slice(-RECENT).reverse().map(({ at, kind, usd }) => ({ at, kind, usd }))
  return { today, byKind, recent }
}

/**
 * The newest `n` costs of one `kind`, oldest first, as plain numbers: what the phone's message box says a message
 * costs (phone-cost.mjs). A file that is not there is no cost.
 */
export function recentCosts(kind, n = RECENT) {
  let text = ''
  try {
    text = readFileSync(SPEND_FILE, 'utf8')
  } catch {
    return []
  }
  return text.split(/\r?\n/).map(parseLine).filter(l => l && l.kind === kind).slice(-n).map(l => l.usd)
}

/**
 * The spend from `fromMs` (null: the first line) to `toMs`, both inclusive: { usd, turns, byKind }. Pipeline tokens
 * (token-routes.mjs) shows it beside its estimate for the same period, as the exact part, never added to it.
 */
export function spendBetween(fromMs, toMs) {
  const byKind = Object.fromEntries(KINDS.map(k => [k, 0]))
  let text = ''
  try {
    text = readFileSync(SPEND_FILE, 'utf8')
  } catch {
    /* no file yet: nothing spent */
  }
  let usd = 0
  let turns = 0
  for (const l of text.split(/\r?\n/).map(parseLine).filter(Boolean)) {
    const t = l.t.getTime()
    if ((fromMs !== null && t < fromMs) || t > toMs) continue
    usd += l.usd
    turns++
    byKind[l.kind] += l.usd
  }
  return { usd, turns, byKind }
}

/**
 * Every well-formed line of one `kind`, oldest first, as { at, kind, usd, collection? }: the watchdog's look at what the
 * ticket refresh cost since it last worked (heal-runner.mjs). A file that is not there is no lines.
 */
export function spendLines(kind) {
  let text = ''
  try {
    text = readFileSync(SPEND_FILE, 'utf8')
  } catch {
    return []
  }
  return text.split(/\r?\n/).map(parseLine).filter(l => l && l.kind === kind).map(({ t, ...rest }) => rest)
}

/** `s` parsed as JSON, or null when it is not JSON. */
function tryJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * The result object in a turn's stdout: the whole string, else its last
 * non-empty line (something such as an update notice printed before the
 * JSON). An array (`verbose` set in the user's settings turns json output
 * into the whole event list) gives its last element with type 'result'.
 * Null when there is none.
 */
function resultObject(raw) {
  const lastLine = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1) || ''
  for (const candidate of [raw, lastLine]) {
    let j = tryJson(candidate)
    if (Array.isArray(j)) j = j.findLast(x => x && typeof x === 'object' && x.type === 'result') || null
    if (j && typeof j === 'object') return j
  }
  return null
}

/**
 * A `-p --output-format json` turn's stdout as { text, cost, isError }: the
 * model's reply is in `.result`, the cost in `.total_cost_usd`. The result is
 * found even behind a notice line or inside a verbose array (resultObject).
 * Output with no json result object (an older CLI, a plain-text turn) is the
 * text itself with no cost, so a caller that reads the reply keeps working.
 */
export function parseTurn(out) {
  const raw = String(out ?? '')
  const j = resultObject(raw)
  if (!j) return { text: raw, cost: null, isError: false }
  return {
    text: typeof j.result === 'string' ? j.result : '',
    cost: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
    isError: j.is_error === true,
  }
}
