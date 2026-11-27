// Suggestions: Master (the coordinator) proposes an improvement with its evidence, the user decides on the
// Suggestions page (#/suggestions). The user asked for "Master to be able to read the whole agent orchestration so it
// can suggest improvements every time possible": this file is where those suggestions live, and the rules that keep
// them worth reading.
//
//   data/suggestions.json   { suggestions: [{ id, at, by, kind, target, text, why, effort,
//                             state: open|accepted|rejected|done, decidedAt, reason, outcome }] }, oldest first
//
//   suggest(input, opts, file)          a new open suggestion, or { error, earlier? }: one plain sentence
//   drop(id, { by }, file)              Master takes back its OWN unanswered one
//   decide(id, { do, reason, outcome }, { now }, file)   the user: accept | reject | done
//   readSuggestions(file)               { list, broken }: broken when the file is there but does not parse
//   similarity(a, b)                    0..1, how alike two texts are (a word set overlap); NEAR or more is the same idea
//
// THE RULES (the brief, 2026-11-26):
// - NO EVIDENCE, NO SUGGESTION: `why` is required and must hold a figure (a number) or name a flow; a hunch is not
//   evidence. The page shows the evidence under every suggestion.
// - IT DOES NOT NAG: a near-duplicate (the same target, and similarity NEAR or more) of an OPEN or a REJECTED one is
//   refused with the earlier id, and for a rejected one with the user's reason. A rejected suggestion is never
//   proposed again in other words.
// - At most LIMITS.open (10) open at once.
// - Only the coordinator suggests (`opts.coordinator`, the label config gives it; the CLI checks --by against it).
// - The dashboard changes NO setting by itself: an accepted suggestion is a note for the user or Master to act on.
//   The one exception is a `rule` with a target agent, whose Accept and add the rule writes the rule through the
//   same rules path the user's own edit uses (insight-routes.mjs, agent-rules-routes.mjs rulesPut, marked `master`).
// - ⚠️ A file that does not parse is NEVER overwritten: every write is refused with a plain sentence, so the user's
//   decisions are never lost to a torn write. The watchdog keeps a copy beside it (heal-checks.mjs, the Stores check).
// - Writes go through atomic-write.mjs; `file` is passed by every caller so tests never touch data/.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR } from './factory-state.mjs'

export const SUGGESTIONS_FILE = path.join(DATA_DIR, 'suggestions.json')
export const KINDS = Object.freeze(['rule', 'setting', 'process', 'fix'])
export const EFFORTS = Object.freeze(['small', 'medium', 'large'])
export const STATES = Object.freeze(['open', 'accepted', 'rejected', 'done'])
/** text fits one agent rule (agent-rules.mjs RULE_LIMITS.rule), so an accepted rule is saved word for word. */
export const LIMITS = Object.freeze({ text: 300, why: 1000, reason: 300, outcome: 300, target: 60, open: 10, keep: 200 })
/** Two texts this alike (or more) for the same target are the same idea. */
export const NEAR = 0.6
const ID = /^s[0-9a-f]{6}$/
export const isSuggestionId = id => typeof id === 'string' && ID.test(id)
const newId = () => `s${randomBytes(3).toString('hex')}`

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isTime = v => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const oneLine = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
const num = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayText = iso => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'an earlier day' : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}
const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

// ═══ how alike two texts are ═══

/** Words that say nothing about the idea itself. */
const STOP = new Set('a an and are as at be before by can could do does for from had has have in is it its make of on or over our should so than that the their them then there these they this to too up use was we were when which while who will with would you your'.split(' '))
/** A word cut to its stem, roughly: runs/run, handing/hand, hands/hand. Enough to see the same idea in other words. */
function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2)
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}
const wordsOf = s => new Set(String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w) && (w.length > 1 || /\d/.test(w))).map(stem))

/** The share of words the two texts have in common, of all the words either has (0 when either has none). */
export function similarity(a, b) {
  const x = wordsOf(a)
  const y = wordsOf(b)
  if (!x.size || !y.size) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / (x.size + y.size - both)
}

// ═══ the file ═══

function cleanOne(s) {
  if (!isObj(s) || !isSuggestionId(s.id) || !isTime(s.at) || !KINDS.includes(s.kind) || !STATES.includes(s.state)) return null
  const text = oneLine(s.text)
  if (!text) return null
  return {
    id: s.id, at: s.at, by: oneLine(s.by), kind: s.kind, target: oneLine(s.target).slice(0, LIMITS.target), text: text.slice(0, LIMITS.text),
    why: String(s.why ?? '').trim().slice(0, LIMITS.why), effort: EFFORTS.includes(s.effort) ? s.effort : '', state: s.state,
    decidedAt: isTime(s.decidedAt) ? s.decidedAt : null, reason: oneLine(s.reason).slice(0, LIMITS.reason), outcome: oneLine(s.outcome).slice(0, LIMITS.outcome),
  }
}

/** { list, broken }: the suggestions oldest first; `broken` when the file is there but does not parse. */
export function readSuggestions(file = SUGGESTIONS_FILE) {
  if (!existsSync(file)) return { list: [], broken: false }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return { list: (Array.isArray(raw?.suggestions) ? raw.suggestions : []).map(cleanOne).filter(Boolean), broken: false }
  } catch {
    return { list: [], broken: true }
  }
}

const DAMAGED = 'The suggestions file is damaged: data/suggestions.json does not parse, so nothing was saved. The Health page keeps a copy of it.'

/** Keep the newest LIMITS.keep: the oldest decided ones go first, an open one never. */
function trimmed(list) {
  const extra = list.length - LIMITS.keep
  if (extra <= 0) return list
  const drop = new Set(list.filter(s => s.state !== 'open').slice(0, extra).map(s => s.id))
  return list.filter(s => !drop.has(s.id))
}

/** Read, change and write back in one step; `fn(list)` returns { list?, ...answer } or { error }. */
function change(file, fn) {
  const { list, broken } = readSuggestions(file)
  if (broken) return { error: DAMAGED }
  const out = fn(list)
  if (out.error) return out
  if (out.list) writeAtomic(file, JSON.stringify({ suggestions: trimmed(out.list) }, null, 1))
  const { list: _written, ...answer } = out
  return answer
}

// ═══ Master's commands ═══

/** The input checked: { kind, target, text, why, effort } or { error }. */
function check(input, { targets = [], flowIds = new Set() } = {}) {
  const b = isObj(input) ? input : {}
  const text = oneLine(b.text)
  if (!text) return { error: 'Say what to change: the text is empty.' }
  if (text.length > LIMITS.text) return { error: `Keep the text to ${LIMITS.text} characters: one change, said plainly.` }
  const why = typeof b.why === 'string' ? b.why.trim() : ''
  if (!why) return { error: 'A suggestion needs evidence: say with --why what you saw (numbers, flows, alerts).' }
  if (why.length > LIMITS.why) return { error: `Keep the evidence to ${num(LIMITS.why)} characters.` }
  const namesFlow = [...flowIds].some(id => new RegExp(`(^|[^a-z0-9-])${id.replace(/[-]/g, '\\-')}($|[^a-z0-9-])`, 'i').test(why))
  if (!/\d/.test(why) && !namesFlow) return { error: 'The evidence must hold a number or name a flow: say what you saw, such as 4 of 9 flows failed QA.' }
  const kind = b.kind ?? ''
  if (!KINDS.includes(kind)) return { error: 'The kind must be rule, setting, process or fix.' }
  const effort = b.effort === undefined || b.effort === '' ? '' : b.effort
  if (effort && !EFFORTS.includes(effort)) return { error: 'The effort must be small, medium or large.' }
  const target = oneLine(b.target)
  if (target.length > LIMITS.target) return { error: `Keep the target to ${LIMITS.target} characters: an agent label or a setting key.` }
  if (kind === 'rule') {
    if (!target) return { error: 'A rule suggestion needs --target: the agent the rule is for.' }
    if (!targets.includes(target)) return { error: `There is no agent called ${target}.` }
  }
  return { kind, target, text, why, effort }
}

/**
 * Whether two suggestions are about the same thing: the same target, or either one with NO target, which is about
 * every target (QA, 2026-11-27: leaving out --target let a rejected idea come back).
 */
const sameTarget = (a, b) => !a || !b || a.toLowerCase() === b.toLowerCase()

/**
 * A new suggestion. `opts`: { by, coordinator?, now, newId, targets (the agent labels), flowIds (the flow ids the
 * evidence may name) }. Refused: no --by, not the coordinator, a field that is wrong, no evidence, a near-duplicate of
 * an open or rejected one (with `earlier`, its id), or LIMITS.open open already.
 */
export function suggest(input, opts = {}, file = SUGGESTIONS_FILE) {
  const by = oneLine(opts.by)
  if (!by) return { error: 'Say who you are with --by "<your dashboard label>".' }
  if (opts.coordinator !== undefined && by !== opts.coordinator) return { error: `Only ${opts.coordinator} suggests: --by must be "${opts.coordinator}", not "${by}".` }
  const c = check(input, opts)
  if (c.error) return c
  return change(file, list => {
    for (const s of list) {
      if (s.state !== 'open' && s.state !== 'rejected') continue
      if (!sameTarget(s.target, c.target) || similarity(s.text, c.text) < NEAR) continue
      if (s.state === 'open') return { error: `This is close to ${s.id}, which is still open: "${short(s.text)}". It waits for the user; do not suggest it again.`, earlier: s.id }
      const why = s.reason ? `: "${short(s.reason, 160)}"` : ' with no reason given'
      return { error: `This is close to ${s.id}, which the user rejected on ${dayText(s.decidedAt || s.at)}${why}. Do not propose it again.`, earlier: s.id }
    }
    if (list.filter(s => s.state === 'open').length >= LIMITS.open) {
      return { error: `${LIMITS.open} suggestions are open already. Wait for the user to decide on some, or drop one of yours with suggest-drop <id>.` }
    }
    const make = opts.newId || newId
    let id = make()
    while (list.some(s => s.id === id)) id = make()
    const suggestion = { id, at: new Date(opts.now ?? Date.now()).toISOString(), by, ...c, state: 'open', decidedAt: null, reason: '', outcome: '' }
    return { list: [...list, suggestion], suggestion }
  })
}

/** Master takes back one of its own suggestions the user has not answered yet: it is removed. */
export function drop(id, { by } = {}, file = SUGGESTIONS_FILE) {
  if (!isSuggestionId(id)) return { error: `${String(id ?? '')} is not a suggestion id: it looks like s1a2b3c.` }
  const who = oneLine(by)
  return change(file, list => {
    const s = list.find(x => x.id === id)
    if (!s) return { error: `There is no suggestion ${id}.` }
    if (s.by !== who) return { error: `${who || 'You'} only drops its own suggestions; ${id} is by ${s.by}.` }
    if (s.state !== 'open') return { error: `${id} is already ${s.state}: only an unanswered suggestion can be dropped.` }
    return { list: list.filter(x => x.id !== id), dropped: s }
  })
}

// ═══ the user's decision ═══

/**
 * accept (open -> accepted), reject (open -> rejected, with an optional reason kept so it is not proposed again),
 * done (accepted -> done). `outcome` is what came of it, one line (the rules path's note on an added rule).
 */
export function decide(id, b = {}, { now = Date.now() } = {}, file = SUGGESTIONS_FILE) {
  if (!isSuggestionId(id)) return { error: 'That is not a suggestion.' }
  const what = b?.do
  if (!['accept', 'reject', 'done'].includes(what)) return { error: 'Say what to do: accept, reject or done.' }
  const reason = oneLine(b.reason)
  if (reason.length > LIMITS.reason) return { error: `Keep the reason to ${LIMITS.reason} characters.` }
  const outcome = oneLine(b.outcome).slice(0, LIMITS.outcome)
  return change(file, list => {
    const s = list.find(x => x.id === id)
    if (!s) return { error: 'That suggestion is gone.', status: 404 }
    if (what === 'done' && s.state !== 'accepted') return { error: s.state === 'open' ? 'Only an accepted suggestion is marked done: it must be accepted first.' : `It is already ${s.state}.` }
    if (what !== 'done' && s.state !== 'open') return { error: `It is already ${s.state}.` }
    const at = new Date(now).toISOString()
    const next = what === 'done'
      ? { ...s, state: 'done', outcome: outcome || s.outcome }
      : { ...s, state: what === 'accept' ? 'accepted' : 'rejected', decidedAt: at, reason: what === 'reject' ? reason : '', outcome }
    return { list: list.map(x => (x.id === id ? next : x)), suggestion: next }
  })
}
