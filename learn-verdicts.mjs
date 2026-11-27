// A verdict on every rule change: when an agent's rules change (the user's own edit on the Agents page, or a Learn
// proposal accepted on the Learn page), the dashboard records the numbers of the 14 days BEFORE (learn-numbers.mjs),
// and once `verdictAfterDays` have passed the Learn page shows a Verdict due card: before against after, one plain
// sentence, and Keep, Revert, Wait two more weeks. Nothing reverts by itself. Without this, rules only pile up.
//
//   data/learn/verdicts.json   { changes: [{ id, at, label, by: you|learn, added, removed, spec, specFrom?, specTo?,
//                              from?: { run, n }, baseline, dueAt, state: waiting|kept|reverted, waits, decidedAt?,
//                              after?, verdict?, backfilled? }] }, the newest KEEP kept
//
//   verdictOf(before, after)                 PURE: { overall: better|worse|same|few, rows, sentence }
//   revertBody(entry, current)               PURE: { body: { rules?, spec? }, notes } for the rules path, or { error }
//   recordChange(change, opts)               the rule-change listener (agent-rules-routes.mjs onRuleChange): one entry
//   backfillChanges(lines, opts)             an entry for each log line made before verdicts were kept
//   verdictView(opts)                        { due, changes } for the page, newest first
//   decideChange(id, keep|wait|revert, opts) the user's press
//
// THE VERDICT (the help says the same: public/learn-view.js VERDICT_HELP)
// - TOO FEW FLOWS TO TELL: fewer than MIN_FLOWS (3) finished in the 14 days before, or in the days after.
// - Each number moves enough to count, or not: right first time by 10 points, the median time per job and the cost
//   per job by 20 percent, QA failures per finished flow by a quarter of a failure. A number with fewer than 3 flows
//   under it on either side, or missing on one, is left out.
// - BETTER: at least one number got better and none got worse. WORSE: the other way round. Otherwise NO CLEAR CHANGE
//   (nothing moved enough, or one got better while another got worse).
//
// Rules this file keeps:
// - The baseline is taken AT THE MOMENT of the change (the listener runs right after the save), from stored records
//   only. A change made before this file existed is filled in later from the same stored flows (`backfilled`), and
//   the page says so. A Revert made on the Learn page records no new entry: it undoes one that is judged already.
// - The after window is the change to its due day: 14 days, or longer after each Wait two more weeks. A decided
//   change keeps the numbers and verdict it was decided on.
// - Revert goes through the SAME rules path the user's own edit uses (the route passes agent-rules-routes.mjs
//   rulesPut, marked `revert`), and it puts back exactly the text the change removed and takes off exactly the text
//   it added; a rule edited since is said in a note, never guessed at.
// - Reads take the file as an argument, so tests never touch data/; writes go through atomic-write.mjs.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR } from './factory-state.mjs'
import { duration } from './learn-retro-facts.mjs'

export const VERDICTS_FILE = path.join(DATA_DIR, 'learn', 'verdicts.json')
export const MIN_FLOWS = 3
const KEEP = 500
const DAY = 86_400_000
const WAIT_DAYS = 14
const EPS = 1e-9

/** Each number: its words, which way is better, the move that counts, and how the page and the sentence say it. */
export const VERDICT_RULES = Object.freeze({
  rightFirstTime: { name: 'right first time', up: true, count: n => n.judged, moved: (b, a) => (a - b) * 100, needs: 10, say: v => `${Math.round(v * 100)}%` },
  medianMs: { name: 'the median time per job', up: false, count: n => n.flows, moved: (b, a) => (b > 0 ? ((a - b) / b) * 100 : 0), needs: 20, say: v => duration(v) },
  costPerJob: { name: 'the cost per job', up: false, count: n => n.jobs, moved: (b, a) => (b > 0 ? ((a - b) / b) * 100 : 0), needs: 20, say: v => `$${v.toFixed(2)}` },
  qaFailures: { name: 'QA failures per flow', up: false, count: n => n.flows, moved: (b, a) => a - b, needs: 0.25, say: v => v.toFixed(1) },
})

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const andList = a => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`)

/** Before against after: each number's change, the overall word and one plain sentence. */
export function verdictOf(before, after) {
  const rows = Object.entries(VERDICT_RULES).map(([key, r]) => {
    const b = before?.[key]
    const a = after?.[key]
    const row = { key, name: r.name, before: b?.value ?? null, after: a?.value ?? null, beforeCount: b ? r.count(b) : 0, afterCount: a ? r.count(a) : 0 }
    if (row.before === null || row.after === null) return { ...row, change: 'none' }
    if (row.beforeCount < MIN_FLOWS || row.afterCount < MIN_FLOWS) return { ...row, change: 'few' }
    const m = r.moved(row.before, row.after)
    const goodWay = r.up ? m : -m
    return { ...row, change: goodWay >= r.needs - EPS ? 'better' : goodWay <= -r.needs + EPS ? 'worse' : 'same' }
  })
  const fb = before?.finished ?? 0
  const fa = after?.finished ?? 0
  if (fb < MIN_FLOWS || fa < MIN_FLOWS) {
    return { overall: 'few', rows, sentence: `Too few flows to tell: ${fb} finished before and ${fa} after. Each side needs at least ${MIN_FLOWS}.` }
  }
  const better = rows.filter(r => r.change === 'better')
  const worse = rows.filter(r => r.change === 'worse')
  const moved = r => `${r.name} went ${r.after > r.before ? 'up' : 'down'} from ${VERDICT_RULES[r.key].say(r.before)} to ${VERDICT_RULES[r.key].say(r.after)}`
  if (better.length && !worse.length) return { overall: 'better', rows, sentence: `Better: ${andList(better.map(moved))}; nothing got worse.` }
  if (worse.length && !better.length) return { overall: 'worse', rows, sentence: `Worse: ${andList(worse.map(moved))}; nothing got better.` }
  if (better.length) {
    return { overall: 'same', rows, sentence: `No clear change: ${andList(better.map(r => r.name))} got better but ${andList(worse.map(r => r.name))} got worse.` }
  }
  if (!rows.some(r => r.change === 'same')) return { overall: 'few', rows, sentence: 'Too few flows to tell: no number has enough flows on both sides.' }
  return { overall: 'same', rows, sentence: 'No clear change: no number moved by enough to count.' }
}

// ═══ the store ═══

export function readVerdicts(file = VERDICTS_FILE) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return { changes: (Array.isArray(raw?.changes) ? raw.changes : []).filter(c => isObject(c) && typeof c.id === 'string' && typeof c.at === 'string' && typeof c.label === 'string') }
  } catch {
    return { changes: [] }
  }
}

const save = (store, file) => writeAtomic(file, JSON.stringify({ changes: store.changes.slice(-KEEP) }, null, 1))
const newId = () => `v${randomBytes(5).toString('hex')}`
const keyOf = c => `${c.at}|${c.label}`

function entryOf(line, { before = null, after = null, numbers, afterDays, id, link = null, backfilled = false }) {
  const at = Date.parse(line.at)
  const e = {
    id, at: line.at, label: line.label, by: line.by === 'learn' || line.by === 'master' ? line.by : 'you',
    added: Array.isArray(line.added) ? [...line.added] : [], removed: Array.isArray(line.removed) ? [...line.removed] : [], spec: line.spec ?? null,
    baseline: numbers(at - 14 * DAY, at), dueAt: new Date(at + afterDays * DAY).toISOString(), state: 'waiting', waits: 0,
  }
  if (e.spec && before && after) Object.assign(e, { specFrom: before.spec ?? '', specTo: after.spec ?? '' })
  if (link) e.from = { run: String(link.run), n: Number(link.n) }
  if (backfilled) e.backfilled = true
  return e
}

/**
 * The listener: one entry for a saved change ({ line, before, after } from agent-rules-routes.mjs), with its baseline
 * now. `numbers(from, to)` is learn-numbers.mjs windowNumbers bound to the flows; `link` the Learn proposal it came
 * from, when it did. A Revert (`by: 'revert'`) records nothing: returns null.
 */
export function recordChange({ line, before, after }, { file = VERDICTS_FILE, numbers, afterDays = 14, newId: makeId = newId, link = null }) {
  if (!isObject(line) || line.by === 'revert' || Number.isNaN(Date.parse(line.at))) return null
  const store = readVerdicts(file)
  if (store.changes.some(c => keyOf(c) === keyOf(line))) return null
  const e = entryOf(line, { before, after, numbers, afterDays, id: makeId(), link })
  store.changes.push(e)
  save(store, file)
  return e
}

/** An entry for each change log line that has none (made before verdicts were kept); returns how many were added. */
export function backfillChanges(lines, { file = VERDICTS_FILE, numbers, afterDays = 14, newId: makeId = newId }) {
  const store = readVerdicts(file)
  const have = new Set(store.changes.map(keyOf))
  let added = 0
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!isObject(line) || line.by === 'revert' || have.has(keyOf(line)) || Number.isNaN(Date.parse(line.at))) continue
    store.changes.push(entryOf(line, { numbers, afterDays, id: makeId(), backfilled: true }))
    have.add(keyOf(line))
    added++
  }
  if (added) {
    store.changes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    save(store, file)
  }
  return added
}

/**
 * The numbers from the change to its due day (or now). ⚠️ A due day before the change (a bad verdictAfterDays, or a
 * hand edit) would be a window that ends before it starts: it is clamped to nothing, which reads Too few flows to tell.
 */
function afterNumbers(e, now, numbers) {
  const from = Date.parse(e.at)
  const to = Math.min(now, Date.parse(e.dueAt))
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? numbers(from, to) : { finished: 0 }
}

/** For the page: the changes whose verdict is due (with the numbers since and the verdict), and every change, newest first. */
export function verdictView({ file = VERDICTS_FILE, now = Date.now(), numbers }) {
  const changes = readVerdicts(file).changes.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const due = []
  const all = changes.map(e => {
    const isDue = e.state === 'waiting' && now >= Date.parse(e.dueAt)
    if (!isDue) return { ...e, due: false }
    const after = afterNumbers(e, now, numbers)
    const shown = { ...e, due: true, after, verdict: verdictOf(e.baseline, after) }
    due.push(shown)
    return shown
  })
  return { due: due.reverse(), changes: all } // the oldest due first: it has waited longest
}

/**
 * The user's press on a change: `keep` (the verdict is stored as it stands), `wait` (two more weeks), or `revert`
 * (`revert(entry)` saves it through the rules path and answers { status, body }; only a 200 marks it reverted).
 */
export function decideChange(id, what, { file = VERDICTS_FILE, now = Date.now(), numbers, revert = null }) {
  if (!['keep', 'wait', 'revert'].includes(what)) return { status: 400, body: { error: 'Choose Keep, Revert or Wait two more weeks.' } }
  const store = readVerdicts(file)
  const e = store.changes.find(c => c.id === id)
  if (!e) return { status: 404, body: { error: 'There is no such rule change.' } }
  if (e.state !== 'waiting') return { status: 409, body: { error: `That change was ${e.state} already.` } }
  if (what === 'wait') {
    e.dueAt = new Date(Math.max(now, Date.parse(e.dueAt)) + WAIT_DAYS * DAY).toISOString() // two weeks from the press
    e.waits = (e.waits || 0) + 1
    save(store, file)
    return { status: 200, body: { ok: true, change: e } }
  }
  const after = afterNumbers(e, now, numbers)
  if (what === 'revert') {
    const r = typeof revert === 'function' ? revert(e) : { status: 500, body: { error: 'Revert is not available.' } }
    if (r.status !== 200) return r
  }
  Object.assign(e, { state: what === 'keep' ? 'kept' : 'reverted', decidedAt: new Date(now).toISOString(), after, verdict: verdictOf(e.baseline, after) })
  save(store, file)
  return { status: 200, body: { ok: true, change: e } }
}

/**
 * What a Revert saves for `entry`, given the agent's entry now: the rules with each text the change added taken off
 * (one for one) and each text it removed put back at the end, and the specification put back while it still reads as
 * the change left it. `notes` says what could not be undone because it changed since. { error } when nothing is left.
 */
export function revertBody(entry, current) {
  const rules = (current?.rules || []).map(r => (typeof r === 'string' ? r : r.text))
  const next = [...rules]
  const notes = []
  for (const text of entry.added || []) {
    const i = next.indexOf(text)
    if (i >= 0) next.splice(i, 1)
    else notes.push(`${text} was already removed.`)
  }
  for (const text of entry.removed || []) if (!next.includes(text)) next.push(text)
  const body = {}
  if (next.length !== rules.length || next.some((t, i) => t !== rules[i])) body.rules = next
  if (entry.spec && typeof entry.specFrom === 'string' && (current?.spec ?? '') === entry.specTo) body.spec = entry.specFrom
  if (!Object.keys(body).length) return { error: `Nothing to revert: the rules of ${entry.label} already read as they did before this change.` }
  return { body, notes }
}
