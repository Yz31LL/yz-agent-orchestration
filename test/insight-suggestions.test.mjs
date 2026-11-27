// Tests for insight-suggestions.mjs: Master proposes, the user decides. A suggestion needs evidence; a near-duplicate
// of an open or rejected one is refused with the earlier id; at most 10 are open; only its own unanswered one can be
// dropped; the decision (accept, reject with a reason, done) is kept. Plus insight-settings.mjs. Temp folders only.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-suggestions-test-'))
process.env.FACTORY_DATA_DIR = TMP
const S = await import('../insight-suggestions.mjs')
const { healingSettings, insightSettings } = await import('../insight-settings.mjs')
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

let k = 0
const file = () => path.join(TMP, `s${k++}`, 'suggestions.json')
const NOW = Date.parse('2026-11-26T10:00:00.000Z')
let n = 0
const opts = (over = {}) => ({ by: 'Master', now: NOW, newId: () => `s${String(++n).padStart(6, '0')}`, targets: ['Master', 'Agent 1', 'QA'], ...over })
const GOOD = { text: 'Agent 1 runs the whole test suite before handing to QA.', why: 'QA failed 4 of the last 9 flows from Agent 1 on a test that did not run.', kind: 'rule', target: 'Agent 1', effort: 'small' }

test('a suggestion is kept with every field, open, and the file is written whole', () => {
  const f = file()
  const r = S.suggest(GOOD, opts(), f)
  assert.equal(r.error, undefined)
  const s = r.suggestion
  assert.equal(s.state, 'open')
  assert.equal(s.by, 'Master')
  assert.equal(s.at, new Date(NOW).toISOString())
  for (const key of ['text', 'why', 'kind', 'target', 'effort']) assert.equal(s[key], GOOD[key])
  assert.equal(s.decidedAt, null)
  assert.equal(s.reason, '')
  assert.equal(s.outcome, '')
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'))
  assert.equal(saved.suggestions.length, 1)
  assert.deepEqual(S.readSuggestions(f).list, [s])
})

test('no evidence, no suggestion: the why is required and must hold a figure or name a flow', () => {
  const f = file()
  assert.match(S.suggest({ ...GOOD, why: '' }, opts(), f).error, /evidence/i)
  assert.match(S.suggest({ ...GOOD, why: undefined }, opts(), f).error, /evidence/i)
  assert.match(S.suggest({ ...GOOD, why: 'It would be nicer and cleaner this way, I think.' }, opts(), f).error, /a number|a flow/i)
  assert.equal(S.suggest({ ...GOOD, why: 'The flow agent-rules went back to Agent 1 for a missed test.' }, opts({ flowIds: new Set(['agent-rules']) }), f).error, undefined)
  assert.equal(fs.existsSync(f), true)
})

test('the fields are checked: kind, effort, target, lengths, and an empty text', () => {
  const f = file()
  assert.match(S.suggest({ ...GOOD, text: '   ' }, opts(), f).error, /what to change/i)
  assert.match(S.suggest({ ...GOOD, kind: 'wish' }, opts(), f).error, /rule, setting, process or fix/)
  assert.match(S.suggest({ ...GOOD, effort: 'huge' }, opts(), f).error, /small, medium or large/)
  assert.match(S.suggest({ ...GOOD, text: 'x'.repeat(S.LIMITS.text + 1) }, opts(), f).error, /300 characters/)
  assert.match(S.suggest({ ...GOOD, why: '1 '.repeat(S.LIMITS.why) }, opts(), f).error, /1,000 characters/)
  assert.match(S.suggest({ ...GOOD, kind: 'rule', target: '' }, opts(), f).error, /agent/i)
  assert.match(S.suggest({ ...GOOD, kind: 'rule', target: 'Nobody' }, opts(), f).error, /no agent called Nobody/)
  // a setting names a key, any short text; process and fix need no target
  assert.equal(S.suggest({ ...GOOD, kind: 'setting', target: 'outputs.max', text: 'Lower outputs.max to 5 so finished work is signed off sooner.' }, opts(), f).error, undefined)
  assert.equal(S.suggest({ ...GOOD, kind: 'fix', target: undefined, effort: undefined, text: 'Repair the ticket refresh: it has not worked for 14 days.' }, opts(), f).error, undefined)
  assert.equal(S.readSuggestions(f).list.at(-1).effort, '')
})

test('only the coordinator suggests: any other --by is refused with the label it must be', () => {
  const f = file()
  assert.match(S.suggest(GOOD, opts({ by: 'Agent 1', coordinator: 'Master' }), f).error, /Only Master suggests/)
  assert.match(S.suggest(GOOD, opts({ by: '', coordinator: 'Master' }), f).error, /--by/)
  assert.equal(S.suggest(GOOD, opts({ by: 'Master', coordinator: 'Master' }), f).error, undefined)
})

test('a near-duplicate of an OPEN one is refused with its id; a different one passes', () => {
  const f = file()
  const first = S.suggest(GOOD, opts(), f).suggestion
  const again = S.suggest({ ...GOOD, text: 'Agent 1 should run the whole test suite before it hands to QA.' }, opts(), f)
  assert.match(again.error, new RegExp(first.id))
  assert.equal(again.earlier, first.id)
  // the same words for another agent are not a duplicate
  assert.equal(S.suggest({ ...GOOD, target: 'QA' }, opts(), f).error, undefined)
  // a different idea for the same agent passes
  assert.equal(S.suggest({ ...GOOD, text: 'Agent 1 writes a test step for every visible change it makes.' }, opts(), f).error, undefined)
})

test('a near-duplicate of a REJECTED one is refused with the reason it was rejected, so it does not nag', () => {
  const f = file()
  const first = S.suggest(GOOD, opts(), f).suggestion
  assert.equal(S.decide(first.id, { do: 'reject', reason: 'The suite takes 20 minutes; QA runs it anyway.' }, { now: NOW + 1000 }, f).error, undefined)
  const again = S.suggest({ ...GOOD, text: 'Agent 1 runs the full test suite before handing over to QA.' }, opts(), f)
  assert.match(again.error, /rejected/)
  assert.match(again.error, /QA runs it anyway/)
  assert.equal(again.earlier, first.id)
})

test('at most 10 open at once; a decided one frees a place', () => {
  const f = file()
  const ids = []
  const ideas = ['Plan', 'Merge', 'Review', 'Test', 'Push', 'Ask', 'Sign', 'Deploy', 'Document', 'Measure']
  for (let i = 0; i < S.LIMITS.open; i++) ids.push(S.suggest({ ...GOOD, kind: 'process', target: '', text: `${ideas[i]} work in batch ${String.fromCharCode(97 + i)}${100 + i}.`, why: `Seen ${i + 2} times this week.` }, opts(), f).suggestion.id)
  const full = S.suggest(GOOD, opts(), f)
  assert.match(full.error, /10 suggestions are open/)
  S.decide(ids[0], { do: 'accept' }, { now: NOW }, f)
  assert.equal(S.suggest(GOOD, opts(), f).error, undefined)
})

test('drop: only its own, only while unanswered; an unknown or malformed id is refused before anything is read', () => {
  const f = file()
  const s = S.suggest(GOOD, opts(), f).suggestion
  assert.match(S.drop(s.id, { by: 'Agent 1' }, f).error, /only drops its own/)
  assert.match(S.drop('s999999', { by: 'Master' }, f).error, /no suggestion s999999/)
  assert.match(S.drop('../x', { by: 'Master' }, f).error, /not a suggestion id/)
  S.decide(s.id, { do: 'reject', reason: 'no' }, { now: NOW }, f)
  assert.match(S.drop(s.id, { by: 'Master' }, f).error, /already rejected/)
  const t = S.suggest({ ...GOOD, text: 'A different thing to do with 3 parts.' }, opts(), f).suggestion
  assert.equal(S.drop(t.id, { by: 'Master' }, f).error, undefined)
  assert.equal(S.readSuggestions(f).list.some(x => x.id === t.id), false)
})

test('decide: accept, reject with a reason, done with an outcome; a decided one is not decided again', () => {
  const f = file()
  const s = S.suggest(GOOD, opts(), f).suggestion
  assert.match(S.decide(s.id, { do: 'maybe' }, { now: NOW }, f).error, /accept, reject or done/)
  assert.match(S.decide(s.id, { do: 'done' }, { now: NOW }, f).error, /accepted first/)
  const acc = S.decide(s.id, { do: 'accept', outcome: 'Rule added to Agent 1.' }, { now: NOW + 5 }, f)
  assert.equal(acc.suggestion.state, 'accepted')
  assert.equal(acc.suggestion.decidedAt, new Date(NOW + 5).toISOString())
  assert.equal(acc.suggestion.outcome, 'Rule added to Agent 1.')
  assert.match(S.decide(s.id, { do: 'reject' }, { now: NOW }, f).error, /already accepted/)
  assert.equal(S.decide(s.id, { do: 'done', outcome: 'Agent 1 follows it.' }, { now: NOW + 9 }, f).suggestion.state, 'done')
  const r = S.suggest({ ...GOOD, text: 'Something else for 2 agents.', target: 'QA' }, opts(), f).suggestion
  assert.match(S.decide(r.id, { do: 'reject', reason: 'x'.repeat(S.LIMITS.reason + 1) }, { now: NOW }, f).error, /300 characters/)
  assert.equal(S.decide(r.id, { do: 'reject', reason: '  Not now.  ' }, { now: NOW }, f).suggestion.reason, 'Not now.')
})

test('a damaged file is never overwritten: every write is refused with a plain sentence, the reads say broken', () => {
  const f = file()
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, '{"suggestions": [ torn')
  assert.equal(S.readSuggestions(f).broken, true)
  assert.deepEqual(S.readSuggestions(f).list, [])
  assert.match(S.suggest(GOOD, opts(), f).error, /damaged/)
  assert.equal(fs.readFileSync(f, 'utf8'), '{"suggestions": [ torn')
  // a missing file is simply empty
  assert.deepEqual(S.readSuggestions(path.join(TMP, 'none', 'x.json')), { list: [], broken: false })
  // hand-made entries that are not whole are left out of the list
  fs.writeFileSync(f, JSON.stringify({ suggestions: [{ id: 'bad' }, { ...GOOD, id: 's000001', at: new Date(NOW).toISOString(), by: 'Master', state: 'open', decidedAt: null, reason: '', outcome: '' }] }))
  assert.deepEqual(S.readSuggestions(f).list.map(x => x.id), ['s000001'])
})

test('similarity: the same idea in other words is near, a different idea is not', () => {
  assert.ok(S.similarity('Agent 1 runs the whole test suite before handing to QA.', 'agent 1 should run the whole test-suite before it hands to QA') >= S.NEAR)
  assert.ok(S.similarity('Agent 1 runs the whole test suite before handing to QA.', 'Lower outputs.max to 5 so work is signed off sooner.') < S.NEAR)
  assert.equal(S.similarity('', ''), 0)
})

test('settings: healing and insight blocks with their defaults, and a wrong value warned and replaced', () => {
  const warns = []
  const warn = w => warns.push(w)
  assert.deepEqual(healingSettings(undefined, warn), { enabled: true, repairs: true })
  assert.deepEqual(healingSettings({ repairs: false }, warn), { enabled: true, repairs: false })
  assert.deepEqual(healingSettings({ enabled: 'yes' }, warn), { enabled: true, repairs: true })
  assert.deepEqual(healingSettings('on', warn), { enabled: true, repairs: true })
  assert.deepEqual(insightSettings(undefined, warn), { notifyMaster: 'off' })
  assert.deepEqual(insightSettings({ notifyMaster: 'urgent' }, warn), { notifyMaster: 'urgent' })
  assert.deepEqual(insightSettings({ notifyMaster: 'always' }, warn), { notifyMaster: 'off' })
  assert.equal(warns.length, 3)
  assert.match(warns[0], /healing\.enabled/)
  assert.match(warns[2], /notifyMaster/)
})

test('a near-duplicate with --target left out matches every target: a rejected idea cannot come back without one', () => {
  // QA, 2026-11-27: leaving out --target got past the duplicate check
  const f = file()
  const first = S.suggest(GOOD, opts(), f).suggestion
  assert.equal(S.decide(first.id, { do: 'reject', reason: 'QA runs it anyway.' }, { now: NOW + 1000 }, f).error, undefined)
  const bare = S.suggest({ ...GOOD, kind: 'process', target: '', text: 'Agent 1 runs the full test suite before handing over to QA.' }, opts(), f)
  assert.match(bare.error, /rejected/)
  assert.equal(bare.earlier, first.id)
  // and the other way round: an open one with no target is matched by the same idea for any target
  const g = file()
  const open = S.suggest({ ...GOOD, kind: 'process', target: '' }, opts(), g).suggestion
  const aimed = S.suggest({ ...GOOD, text: 'Agent 1 should run the whole test suite before it hands to QA.' }, opts(), g)
  assert.equal(aimed.earlier, open.id)
  // a different idea with no target still passes
  assert.equal(S.suggest({ ...GOOD, kind: 'process', target: '', text: 'Name the ticket in every commit subject.' }, opts(), f).error, undefined)
})
