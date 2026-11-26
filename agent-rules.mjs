// The user's specification and rules for each agent: what the agent is for, in the user's words, and a short
// numbered list of rules. Set on the Agents page (agent-rules-routes.mjs, public/agent-rules.js) and printed to
// the agent by `flow new`, `flow qa-start` and `flow rules` (tools/rules-cli.mjs), so it reads them at the start
// of every request.
//
//   data/agent-rules.json      { agents: { "<label>": { spec, rules: [{ id, text, addedAt }], updatedAt } } }
//   data/agent-rules-log.jsonl one line per saved change: { at, label, spec: set|changed|cleared|null, added: [text],
//                              removed: [text], by? }, newest last, the newest LOG_KEEP kept. `by` marks a save made
//                              from the Learn page (CHANGE_BY: an accepted proposal, a Revert) or a suggestion of the
//                              coordinator the user accepted as a rule (`master`, insight-routes.mjs); none is the user's edit
//
// Rules this file keeps:
// - The validator and the merge are PURE (checkChange, applyChange, rulesView, rulesBlock, rulesText): no file,
//   no config. Reads and writes take the file as an argument, so tests never touch the real one.
// - The file follows FACTORY_DATA_DIR like every other data file (through factory-state.mjs's DATA_DIR), and
//   is written whole through atomic-write.mjs, so the CLI never reads half a file.
// - A missing or broken file reads as empty; a hand-edited one keeps only what is well formed.
// - A label is checked against the graph by the CALLER (the route, the CLI). Rules for a label that left the
//   graph stay in the file and are simply not shown, so putting the agent back brings them back.
// - Rule ids are kept for rules whose text did not change, so an edit that only adds or removes one leaves the
//   others as they were (and their addedAt with them).
// - The log is APPEND-ONLY, like spend.mjs: one appended line per save that changed something (diffEntries is null
//   for a save that changed nothing, and then nothing is written), written only AFTER the store write succeeded
//   (the route's order). Past LOG_KEEP lines it is cut to the newest, whole, through atomic-write.mjs. appendLog
//   never throws: the save already happened, so a failed log line is said on stderr and the caller carries on.
//   A reader skips a torn or hand-made line (readLog). ruleEvents and changesOf turn lines into plain sentences.
// - It must not import config.mjs or pipeline.mjs: rulesView and rulesText take the graph, so any caller can
//   hand in the one it has.

import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR } from './factory-state.mjs'

export const RULES_FILE = path.join(DATA_DIR, 'agent-rules.json')
export const RULES_LOG = path.join(DATA_DIR, 'agent-rules-log.jsonl')
/** The log keeps its newest 500 lines. */
export const LOG_KEEP = 500
const NL = '\n'
/** The marks a log line may carry (learn-routes.mjs): `learn` an accepted Learn proposal, `revert` a Revert there. */
export const CHANGE_BY = Object.freeze(['learn', 'revert', 'master'])
/** A specification of at most 2,000 characters, a rule of 1 to 300, at most 30 rules per agent. */
export const RULE_LIMITS = Object.freeze({ spec: 2000, rule: 300, rules: 30 })

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isTime = v => typeof v === 'string' && !Number.isNaN(Date.parse(v))
/** 2000 -> "2,000", the same in every locale. */
const num = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
/** A specification keeps its line breaks; a rule is one line. */
const cleanSpec = s => s.replace(/\r\n?/g, '\n').trim()
const cleanRule = s => s.replace(/\s+/g, ' ').trim()

/** The agent labels of a graph, in its order: the coordinator, the producers, the chat agent, QA. */
export const agentLabels = graph => (graph?.nodes || []).filter(n => n.kind === 'agent').map(n => n.label)

/** One stored agent, or null when it is not well formed. Over-long text is cut, never rejected: it is the user's own file. */
function cleanEntry(e) {
  if (!isObj(e)) return null
  const rules = (Array.isArray(e.rules) ? e.rules : [])
    .filter(r => isObj(r) && typeof r.id === 'string' && r.id && typeof r.text === 'string' && cleanRule(r.text))
    .slice(0, RULE_LIMITS.rules)
    .map(r => ({ id: r.id, text: cleanRule(r.text).slice(0, RULE_LIMITS.rule), addedAt: isTime(r.addedAt) ? r.addedAt : null }))
  return { spec: typeof e.spec === 'string' ? cleanSpec(e.spec).slice(0, RULE_LIMITS.spec) : '', rules, updatedAt: isTime(e.updatedAt) ? e.updatedAt : null }
}

/** Anything read from the file as a store; what is not well formed is left out. */
export function cleanStore(raw) {
  const agents = {}
  for (const [label, e] of Object.entries(isObj(raw?.agents) ? raw.agents : {})) {
    const entry = cleanEntry(e)
    if (entry) agents[label] = entry
  }
  return { agents }
}

export function readRules(file = RULES_FILE) {
  if (!existsSync(file)) return { agents: {} }
  try {
    return cleanStore(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { agents: {} }
  }
}

export function writeRules(store, file = RULES_FILE) {
  writeAtomic(file, JSON.stringify(cleanStore(store), null, 1))
}

/**
 * A PUT body `{ spec?, rules? }` checked and cleaned: `{ spec?, rules? }` with only what was given, or `{ error }`,
 * one plain sentence for the page to show as it is.
 */
export function checkChange(b) {
  const out = {}
  if (isObj(b) && b.spec !== undefined) {
    if (typeof b.spec !== 'string') return { error: 'The specification must be text.' }
    out.spec = cleanSpec(b.spec)
    if (out.spec.length > RULE_LIMITS.spec) return { error: `The specification is too long. Keep it to ${num(RULE_LIMITS.spec)} characters.` }
  }
  if (isObj(b) && b.rules !== undefined) {
    if (!Array.isArray(b.rules) || !b.rules.every(r => typeof r === 'string')) return { error: 'The rules must be a list of text.' }
    if (b.rules.length > RULE_LIMITS.rules) return { error: `That is too many rules. An agent can have ${RULE_LIMITS.rules} at most.` }
    out.rules = b.rules.map(cleanRule)
    const empty = out.rules.findIndex(r => !r)
    if (empty >= 0) return { error: `Rule ${empty + 1} is empty. Write it or remove it.` }
    const long = out.rules.findIndex(r => r.length > RULE_LIMITS.rule)
    if (long >= 0) return { error: `Rule ${long + 1} is too long. Keep each rule to ${RULE_LIMITS.rule} characters.` }
  }
  if (!('spec' in out) && !('rules' in out)) return { error: 'Nothing to save. Send a specification or rules.' }
  return out
}

const newRuleId = () => `r${randomBytes(4).toString('hex')}`

/**
 * A new store with `label`'s entry changed by a checked change: the spec when given, the rules when given
 * (each rule whose text is unchanged keeps its old id and addedAt, one old rule per new one), updatedAt now.
 * The store passed in is not changed.
 */
export function applyChange(store, label, change, { now = () => new Date().toISOString(), newId = newRuleId } = {}) {
  const at = now()
  const old = cleanEntry(store?.agents?.[label]) || { spec: '', rules: [], updatedAt: null }
  const next = { ...old, rules: old.rules.map(r => ({ ...r })), updatedAt: at }
  if (change.spec !== undefined) next.spec = change.spec
  if (change.rules !== undefined) {
    const free = [...old.rules]
    next.rules = change.rules.map(text => {
      const i = free.findIndex(r => r.text === text)
      if (i < 0) return { id: newId(), text, addedAt: at }
      const [kept] = free.splice(i, 1)
      return { ...kept }
    })
  }
  return { agents: { ...cleanStore(store).agents, [label]: next } }
}

/** One agent's entry, or the empty one. */
export function rulesOf(store, label) {
  const e = cleanEntry(store?.agents?.[label])
  return e || { spec: '', rules: [], updatedAt: null }
}

/** `{ agents: { label: entry } }` for every agent of the graph, in its order, empty when nothing is saved. */
export function rulesView(store, graph) {
  const agents = {}
  for (const label of agentLabels(graph)) agents[label] = rulesOf(store, label)
  return { agents }
}

/**
 * What an agent is shown at the start of a request, as plain text, or '' when it has nothing:
 *   Rules for Agent 1, set by the user on the dashboard. Follow them:
 *   Specification: Builds the web pages.
 *   1. Never touch the mobile app.
 */
export function rulesBlock(store, label) {
  const { spec, rules } = rulesOf(store, label)
  if (!spec && !rules.length) return ''
  return [
    `Rules for ${label}, set by the user on the dashboard. Follow them:`,
    ...(spec ? [`Specification: ${spec}`] : []),
    ...rules.map((r, i) => `${i + 1}. ${r.text}`),
  ].join('\n')
}

/** Every agent of the graph that has a specification or rules, as rulesBlock does, a blank line between; '' when none. */
export function rulesText(store, graph) {
  return agentLabels(graph).map(label => rulesBlock(store, label)).filter(Boolean).join('\n\n')
}

// ═══ the change log ═══

/** Each text of `a` not matched by one in `b`, one for one (a rule written twice counts twice). */
function minus(a, b) {
  const left = [...b]
  return a.filter(t => {
    const i = left.indexOf(t)
    if (i < 0) return true
    left.splice(i, 1)
    return false
  })
}

/**
 * What a save changed between two entries: { spec: set|changed|cleared|null, added: [text], removed: [text] }, or
 * null when it changed nothing (a new order of the same rules is no change).
 */
export function diffEntries(before, after) {
  const b = cleanEntry(before) || { spec: '', rules: [] }
  const a = cleanEntry(after) || { spec: '', rules: [] }
  const spec = b.spec === a.spec ? null : !b.spec ? 'set' : !a.spec ? 'cleared' : 'changed'
  const [was, now] = [b.rules.map(r => r.text), a.rules.map(r => r.text)]
  const added = minus(now, was)
  const removed = minus(was, now)
  return spec || added.length || removed.length ? { spec, added, removed } : null
}

/** One line on the log, cut to the newest `keep`. Returns whether it was written; never throws. */
export function appendLog(line, file = RULES_LOG, keep = LOG_KEEP) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(line) + NL)
    const lines = readFileSync(file, 'utf8').split(NL).filter(Boolean)
    if (lines.length > keep) writeAtomic(file, lines.slice(-keep).join(NL) + NL)
    return true
  } catch (err) {
    console.error(`agent rules: could not log a change for ${line?.label}: ${err?.message || err}`)
    return false
  }
}

const isList = v => Array.isArray(v) && v.every(t => typeof t === 'string')
/** The log's lines, oldest first; a torn or hand-made line is skipped. */
export function readLog(file = RULES_LOG) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const raw of text.split(NL)) {
    if (!raw.trim()) continue
    try {
      const l = JSON.parse(raw)
      if (isObj(l) && isTime(l.at) && typeof l.label === 'string' && isList(l.added) && isList(l.removed) && [null, 'set', 'changed', 'cleared'].includes(l.spec ?? null)) {
        out.push({ at: l.at, label: l.label, spec: l.spec ?? null, added: l.added, removed: l.removed, ...(CHANGE_BY.includes(l.by) ? { by: l.by } : {}) })
      }
    } catch {
      // a torn line: the rest still reads
    }
  }
  return out
}

const rules = n => `${n} ${n === 1 ? 'rule' : 'rules'}`
const joinAnd = parts => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`)
const SPEC_ALONE = { set: label => `${label} got a specification.`, changed: label => `The specification of ${label} changed.`, cleared: label => `The specification of ${label} was cleared.` }
const SPEC_PART = { set: 'its specification was set', changed: 'its specification changed', cleared: 'its specification was cleared' }

/** What a marked line adds to its sentence (CHANGE_BY). */
const BY_WORDS = { learn: ' From Learn.', revert: ' Reverted on the Learn page.', master: ' A suggestion of the coordinator, accepted by you.' }

/** A log line as one plain sentence: "Agent 1 got 2 new rules and its specification changed.", then its mark's words. */
export function changeSentence(line) {
  return plainSentence(line) + (BY_WORDS[line?.by] || '')
}

function plainSentence({ label, spec, added = [], removed = [] }) {
  if (!added.length && !removed.length) return spec ? SPEC_ALONE[spec](label) : `The rules of ${label} were saved.`
  if (!added.length && !spec) return `${rules(removed.length)} ${removed.length === 1 ? 'was' : 'were'} removed from ${label}.`
  const parts = []
  if (added.length) parts.push(`got ${added.length} new ${added.length === 1 ? 'rule' : 'rules'}`)
  if (removed.length) parts.push(`lost ${rules(removed.length)}`)
  if (spec) parts.push(SPEC_PART[spec])
  return `${label} ${joinAnd(parts)}.`
}

/**
 * The log lines of the last `days` days as events, newest first:
 * { at, kind: 'rule', agent: <label>, flow: null, cell: null, text } (text: changeSentence).
 */
export function ruleEvents(lines, { now = Date.now(), days = 7 } = {}) {
  const since = now - days * 86_400_000
  return (Array.isArray(lines) ? lines : [])
    .filter(l => isTime(l?.at) && Date.parse(l.at) >= since && Date.parse(l.at) <= now)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map(l => ({ at: l.at, kind: 'rule', agent: l.label, flow: null, cell: null, text: changeSentence(l) }))
}

/** `label`'s last `n` changes, newest first, as { at, text }. */
export function changesOf(lines, label, n = 10) {
  return (Array.isArray(lines) ? lines : []).filter(l => l?.label === label && isTime(l.at))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, n).map(l => ({ at: l.at, text: changeSentence(l) }))
}
