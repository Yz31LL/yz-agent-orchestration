// Tests for the Learn page in the browser (public/learn-view.js, public/learn-page.js) and a flow's Retrospective
// (public/learn-retro.js), with their place in the shell: the route #/learn, the rail link last in the Quality group,
// index.html. Browser scripts in a vm with a bare window: only the pure half runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { MIN_FLOWS, VERDICT_RULES } from '../learn-verdicts.mjs'

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const w = {}
vm.runInNewContext(read('learn-view.js'), { window: w })
vm.runInNewContext(read('learn-retro.js'), { window: w })
vm.runInNewContext(read('learn-page.js'), { window: w })
const V = w.LearnView
const R = w.LearnRetro
const shellWindow = {}
const shellCtx = { window: shellWindow }
for (const f of ['rail-groups.js', 'shell.js']) vm.runInNewContext(read(f), shellCtx) // as index.html loads them
const resolve = h => JSON.parse(JSON.stringify(shellWindow.Shell.resolve(h)))

const NOW = Date.parse('2026-11-25T12:00:00.000Z')
const SETTINGS = { enabled: true, autoRetro: true, weekly: false, verdictAfterDays: 14, model: 'claude-opus-5-5', retroModel: 'claude-sonnet-5-5' }
const P = (n, over = {}) => ({ n, target: 'Agent 1', action: 'add', rule: `Test every <limit> ${n}.`, old: '', flows: ['agent-rules'], evidence: 'agent-rules failed QA once.', effect: 'Fewer failures.', check: 'QA failures go down.', state: 'open', ...over })
const RUN = { id: '2026-11-25-a1b2c3', at: '2026-11-25T09:05:00.000Z', ok: true, cost: 0.84, window: { from: '2026-11-18T09:05:00.000Z', to: '2026-11-25T09:05:00.000Z', days: 7, widened: false }, read: 'Read: 5 finished flows', left: '', nothing: null, proposals: [P(1), P(2, { target: 'settings', action: 'change', rule: 'Set outputs.max to 5.' }), P(3, { action: 'change', old: 'Old rule.' })], dropped: [{ why: 'A proposal for QA names no flow from the evidence pack, so it was thrown away.' }] }
const nums = (rft, finished = 5) => ({ finished, rightFirstTime: { value: rft, right: 1, judged: finished }, medianMs: { value: 7_200_000, flows: finished }, costPerJob: { value: 2, usd: 10, jobs: finished }, qaFailures: { value: 0.4, failures: 2, flows: finished } })
const DUE = {
  id: 'v1', at: '2026-11-10T10:00:00.000Z', label: 'Agent 1', by: 'learn', added: ['Test every limit.'], removed: [], spec: null, state: 'waiting', due: true, dueAt: '2026-11-24T10:00:00.000Z',
  baseline: nums(0.5), after: nums(0.8), verdict: { overall: 'better', sentence: 'Better: right first time went up from 50% to 80%; nothing got worse.', rows: [{ key: 'rightFirstTime', before: 0.5, after: 0.8, change: 'better' }, { key: 'medianMs', before: 7_200_000, after: 7_200_000, change: 'same' }] },
}
const STATE = { settings: SETTINGS, running: null, lastRunAt: RUN.at, remind: null, runs: [RUN], verdicts: { due: [DUE], changes: [DUE, { ...DUE, id: 'v0', at: '2026-11-01T10:00:00.000Z', by: 'you', due: false, state: 'kept', verdict: { overall: 'same' } }] }, retroBusy: false }

test('the route #/learn, and the shell wires it: title, section, page object, icon, a rail link after Lessons in the Quality group', () => {
  assert.deepEqual(resolve('#/learn'), { view: 'learn', params: {}, redirect: null })
  assert.deepEqual(resolve('#/learn?run=2026-11-25-a1b2c3'), { view: 'learn', params: { query: { run: '2026-11-25-a1b2c3' } }, redirect: null })
  const shell = read('shell.js')
  assert.match(shell, /learn: 'Learn'/)
  assert.match(shell, /learn: 'learnView'/)
  assert.match(shell, /learn: 'LearnPage'/)
  const quality = shellWindow.RailGroups.groups().find(g => g.id === 'quality').entries
  assert.equal(quality.map(e => e.view).join(' '), 'qa lessons learn suggestions') // Suggestions (insight-pages.js) follows Learn
  assert.equal(shellWindow.RailGroups.linkFor('learn').href, '#/learn')
  assert.match(shellWindow.RailGroups.linkFor('learn').icon, /<path/, 'its icon: a light bulb')
  const html = read('index.html')
  assert.match(html, /<section id="learnView" aria-label="Learn" hidden><\/section>/)
  for (const f of ['learn-retro.js', 'learn-view.js', 'learn-page.js']) assert.match(html, new RegExp(`<script src="${f}"></script>`))
  assert.match(html, /<link rel="stylesheet" href="learn.css">/)
  assert.equal(typeof w.LearnPage.open, 'function')
})

test('the Run card: Run Learn, the reminder when it is due, the running line, and the off switch', () => {
  assert.match(V.pageHtml(STATE, {}, NOW), /<button type="button" class="primary" data-ln-run>Run Learn<\/button>/)
  assert.match(V.pageHtml({ ...STATE, remind: 'The last Learn run was 9 days ago. Run it to review the week.' }, {}, NOW), /class="ln-remind">The last Learn run was 9 days ago/)
  const running = V.pageHtml({ ...STATE, running: { startedAt: RUN.at } }, {}, NOW)
  assert.match(running, /data-ln-run disabled>Running…/)
  assert.match(running, /you can leave this page/)
  const off = V.pageHtml({ ...STATE, settings: { ...SETTINGS, enabled: false } }, {}, NOW)
  assert.doesNotMatch(off, /data-ln-run/)
  assert.match(off, /switched off in config\.json/)
})

test('a Verdict due card: what changed, before against after with the flow counts, the sentence, Keep, Revert, Wait', () => {
  const html = V.verdictCardHtml(DUE)
  assert.match(html, /Agent 1: a rule change from 10 Nov/)
  assert.match(html, /From Learn/)
  assert.match(html, /class="ln-add"><span class="ln-sign" aria-label="added">\+<\/span> Test every limit\./)
  assert.match(html, /14 days before <span class="faint">· 5 flows<\/span>/)
  assert.match(html, /<th scope="row">Right first time<\/th><td>50%<\/td><td>80%<\/td><td><span class="ln-chg ln-chg-better">Better<\/span>/)
  assert.match(html, /<td>2 h<\/td><td>2 h<\/td>/)
  assert.match(html, /<p class="ln-sentence ln-overall-better"><b>Better\.<\/b> Right first time went up from 50% to 80%; nothing got worse\.<\/p>/)
  for (const d of ['keep', 'revert', 'wait']) assert.match(html, new RegExp(`data-ln-decide="${d}" data-ln-id="v1"`))
  assert.match(V.verdictCardHtml({ ...DUE, backfilled: true }), /worked out later from the stored flows/)
  assert.match(V.verdictCardHtml(DUE, { busy: 'change:v1' }), /data-ln-decide="keep" data-ln-id="v1" disabled/)
})

test('the help says the verdict rule with the same thresholds learn-verdicts.mjs uses', () => {
  assert.equal(VERDICT_RULES.rightFirstTime.needs, 10)
  assert.match(V.VERDICT_HELP, /right first time changes by 10 points/)
  assert.equal(VERDICT_RULES.medianMs.needs, 20)
  assert.equal(VERDICT_RULES.costPerJob.needs, 20)
  assert.match(V.VERDICT_HELP, /the time or the cost by 20 percent/)
  assert.equal(VERDICT_RULES.qaFailures.needs, 0.25)
  assert.match(V.VERDICT_HELP, /a quarter of a failure per flow/)
  assert.match(V.VERDICT_HELP, new RegExp(`fewer than ${MIN_FLOWS} flows finished before or after`))
  assert.match(V.HELP, /never|Nothing changes until you accept/)
})

test('a proposal card: target, rule, evidence with flow links, effect and check, and the three choices; escaped', () => {
  const html = V.proposalHtml(RUN, RUN.proposals[0])
  assert.match(html, /Add a rule to Agent 1/)
  assert.match(html, /<p class="ln-rule">Test every &lt;limit&gt; 1\.<\/p>/)
  assert.match(html, /<a class="ln-flow" href="#\/flows\?flow=agent-rules">agent-rules<\/a>/)
  assert.match(html, /<dt>How to tell in two weeks<\/dt><dd>QA failures go down\.<\/dd>/)
  assert.match(html, /data-ln-accept="2026-11-25-a1b2c3:1"/)
  assert.match(html, /data-ln-edit="2026-11-25-a1b2c3:1"/)
  assert.match(html, /data-ln-reject="2026-11-25-a1b2c3:1"/)
  const change = V.proposalHtml(RUN, RUN.proposals[2])
  assert.match(change, /Change a rule of Agent 1/)
  assert.match(change, /<p class="ln-old"><span class="faint">Now:<\/span> Old rule\.<\/p>/)
})

test('a settings proposal is text to apply by hand: no Edit, and Accept says so', () => {
  const html = V.proposalHtml(RUN, RUN.proposals[1])
  assert.match(html, /A settings change, to apply by hand/)
  assert.match(html, /Accept, I will apply it/)
  assert.doesNotMatch(html, /data-ln-edit/)
})

test('Edit then accept and Reject open their forms in the card; decided ones say what was done', () => {
  const key = `${RUN.id}:1`
  assert.match(V.proposalHtml(RUN, RUN.proposals[0], { editing: key }), new RegExp(`<textarea id="ln-edit-${key}" class="set-input" rows="3" maxlength="300">Test every &lt;limit&gt; 1\\.</textarea>`))
  assert.match(V.proposalHtml(RUN, RUN.proposals[0], { rejecting: key }), /Why not\? <span class="faint">\(optional: the next run reads it/)
  assert.match(V.proposalHtml(RUN, P(1, { state: 'accepted', decidedAt: '2026-11-25T10:00:00.000Z', text: 'Edited rule.' })), /Edited rule\.[\s\S]*Accepted 25 Nov\./)
  assert.match(V.proposalHtml(RUN, P(1, { state: 'rejected', decidedAt: '2026-11-25T10:00:00.000Z', reason: 'Too slow.' })), /Rejected 25 Nov\. Reason: Too slow\./)
  assert.match(V.proposalHtml(RUN, P(1), { errors: { [`p:${key}`]: 'Agent 1 already has that rule.' } }), /role="alert">Agent 1 already has that rule\./)
})

test('the page: proposals of the newest run with its cost and window, dropped ideas, nothing worth changing, earlier runs', () => {
  const html = V.pageHtml(STATE, {}, NOW)
  assert.match(html, /Verdict due <span class="faint">· 1<\/span>/)
  assert.match(html, /\$0\.84 · covers 18 Nov to 25 Nov/)
  assert.match(html, /1 idea was thrown away by the checks/)
  assert.match(html, /Rule changes <span class="faint">· 2<\/span>/)
  const none = V.pageHtml({ ...STATE, runs: [{ ...RUN, proposals: [], nothing: 'Every flow passed first time.' }, RUN] }, {}, NOW)
  assert.match(none, /<b>Nothing worth changing\.<\/b> Every flow passed first time\./)
  assert.match(none, /Earlier runs <span class="faint">· 1<\/span>/)
  assert.match(V.pageHtml({ ...STATE, runs: [] }, {}, NOW), /No run yet\. Run Learn/)
  assert.match(V.pageHtml({ ...STATE, runs: [{ ...RUN, ok: false, error: 'The model run stopped.' }] }, {}, NOW), /class="ln-error">The model run stopped\./)
})

test('a rule change row: when, who, what, and its verdict or the day it is due', () => {
  assert.match(V.changeRowHtml({ ...DUE, due: false, dueAt: '2026-12-08T10:00:00.000Z' }), /Verdict due 8 Dec/)
  assert.match(V.changeRowHtml(DUE), /ln-state-due">Verdict due now/)
  assert.match(V.changeRowHtml({ ...DUE, state: 'reverted', verdict: { overall: 'worse' } }), /Reverted · Worse/)
  assert.match(V.changeRowHtml({ ...DUE, by: 'you' }), /<span class="ln-row-who">Agent 1 <\/span>/)
})

test('the header chip: never run, today, days ago, running', () => {
  assert.equal(V.statusLine({ lastRunAt: null }, NOW), 'Not run yet')
  assert.equal(V.statusLine({ lastRunAt: '2026-11-25T09:00:00.000Z' }, NOW), 'Last run today')
  assert.equal(V.statusLine({ lastRunAt: '2026-11-16T09:00:00.000Z' }, NOW), 'Last run 9 days ago')
  assert.equal(V.statusLine({ running: {}, lastRunAt: null }, NOW), 'Learn is running…')
})

const keyed = () => ''
const head = (name, n, tag, extra) => `<div class="ob-head"><h3 class="ob-h">${name}</h3><span class="ob-head-end">${extra}</span></div>`
const RETRO = { at: '2026-11-25T09:05:00.000Z', right: 'QA caught <it>.', wrong: 'A rule was cut.', next: 'Test limits.', cost: 0.0123, source: 'completed' }

test('the Retrospective on the Output tab: three lines, when, the cost; Write it again', () => {
  const html = R.block({ flow: { id: 'a1', status: 'done', retro: RETRO }, keyed, head })
  assert.match(html, /<dt>Went right<\/dt><dd>QA caught &lt;it&gt;\.<\/dd><dt>Went wrong<\/dt><dd>A rule was cut\.<\/dd><dt>Next time<\/dt><dd>Test limits\.<\/dd>/)
  assert.match(html, /when you marked it completed · \$0\.012/)
  assert.match(html, /data-lr-write="a1">Write it again/)
})

test('a finished flow without one offers Write the retrospective; a dropped or unfinished one shows nothing', () => {
  assert.match(R.block({ flow: { id: 'b1', status: 'done' }, keyed, head }), /data-lr-write="b1">Write the retrospective/)
  assert.match(R.block({ flow: { id: 'b2', status: 'open', completedAt: '2026-11-25T09:00:00.000Z' }, keyed, head }), /Write the retrospective/)
  assert.equal(R.block({ flow: { id: 'b3', status: 'dropped' }, keyed, head }), '')
  assert.equal(R.block({ flow: { id: 'b4', status: 'open' }, keyed, head }), '')
  assert.equal(R.sig('b1'), null)
})

test('the archive row folds the retrospective away; no retro, no fold', () => {
  assert.match(R.rowHtml({ id: 'a1', retro: RETRO }), /<details class="lr-row"><summary>Retrospective<\/summary><dl class="lr-lines">/)
  assert.equal(R.rowHtml({ id: 'a2' }), '')
  assert.match(read('archive-page.js'), /window\.LearnRetro\?\.rowHtml\(r\)/)
  assert.match(read('flow-output.js'), /\$\{window\.FlowStory\.html\(c\)\}\$\{window\.LearnRetro\?\.block\(c\) \|\| ''\}/)
})

test('the running dot stops under reduced motion', () => {
  const css = read('learn.css')
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.ln-dot \{ animation: none; \} \}/)
})

// QA 2026-11-26: after Run Learn finished, Learn started. Its proposals show here when it is done. stayed beside the
// finished proposals until a reload.
test('the started line clears once the run it announced has finished; any other line stays', () => {
  const started = V.STARTED
  assert.equal(V.statusAfter(started, true, false), '', 'the run finished: the line goes')
  assert.equal(V.statusAfter(started, true, true), started, 'still running: it stays')
  assert.equal(V.statusAfter('Accepted.', true, false), 'Accepted.')
  assert.equal(V.statusAfter(started, false, false), started, 'no run seen yet (the first load after the press): it stays')
})
