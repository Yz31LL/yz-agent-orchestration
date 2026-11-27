// Tests for the insight pages in the browser (public/insight-view.js, public/insight-pages.js) and their place in the
// shell: #/suggestions after Learn in the Quality group, #/health last in the Agents group, index.html, the Agents page
// slot. Browser scripts in a vm with a bare window: only the pure half runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const w = {}
const ctx = { window: w }
// as index.html loads them: the shell first (Shell.ago, THE relative-time helper), then the insight scripts
for (const f of ['rail-groups.js', 'shell.js', 'insight-view.js', 'insight-pages.js']) vm.runInNewContext(read(f), ctx)
const V = w.InsightView
const shellWindow = {}
const shellCtx = { window: shellWindow }
for (const f of ['rail-groups.js', 'shell.js']) vm.runInNewContext(read(f), shellCtx)
const resolve = h => JSON.parse(JSON.stringify(shellWindow.Shell.resolve(h)))

const NOW = Date.parse('2026-11-26T12:00:00.000Z')
const S = (over = {}) => ({ id: 's000001', at: '2026-11-26T09:00:00.000Z', by: 'Master', kind: 'rule', target: 'Agent 1', text: 'Agent 1 runs the whole suite <before> QA.', why: 'QA failed 4 of 9 flows.\nSee agent-rules.', effort: 'small', state: 'open', decidedAt: null, reason: '', outcome: '', ...over })

test('the routes and the rail: Suggestions after Learn in Quality, Health last in Agents, each with its section, page and icon', () => {
  assert.deepEqual(resolve('#/suggestions'), { view: 'suggestions', params: {}, redirect: null })
  assert.deepEqual(resolve('#/suggestions?id=s000001'), { view: 'suggestions', params: { query: { id: 's000001' } }, redirect: null })
  assert.deepEqual(resolve('#/health'), { view: 'health', params: {}, redirect: null })
  const groups = JSON.parse(JSON.stringify(shellWindow.RailGroups.groups()))
  assert.deepEqual(groups.find(g => g.id === 'quality').entries.map(e => e.view), ['qa', 'lessons', 'learn', 'suggestions'])
  assert.equal(groups.find(g => g.id === 'agents').entries.at(-1).view, 'health')
  for (const v of ['suggestions', 'health']) assert.match(shellWindow.RailGroups.linkFor(v).icon, /<path/)
  const shell = read('shell.js')
  assert.match(shell, /suggestions: 'suggestionsView', health: 'healthView'/)
  assert.match(shell, /suggestions: 'SuggestionsPage', health: 'HealthPage'/)
  const html = read('index.html')
  assert.match(html, /<section id="suggestionsView" aria-label="Suggestions" hidden><\/section>/)
  assert.match(html, /<section id="healthView" aria-label="Health" hidden><\/section>/)
  assert.match(html, /<div id="homeInsight" data-insight-home hidden><\/div>/)
  for (const f of ['insight-view.js', 'insight-pages.js']) assert.match(html, new RegExp(`<script src="${f}"></script>`))
  assert.match(html, /<link rel="stylesheet" href="insight.css">/)
  assert.match(read('agents-page.js'), /<div class="pl-insight" id="plInsight" data-insight-agents hidden><\/div>\r?\n\s*<div class="pl-alerts"/)
  assert.equal(typeof w.SuggestionsPage.open, 'function')
  assert.equal(typeof w.HealthPage.open, 'function')
})

test('Suggestions: open first with the text, the evidence, kind, target and effort; Accept and add the rule only for a rule for an agent', () => {
  const html = V.suggestionsHtml({ list: [S(), S({ id: 's000002', kind: 'process', target: '', effort: '' })], agents: ['Master', 'Agent 1'], counts: { open: 2 } }, {}, NOW)
  assert.match(html, /Open · 2/)
  assert.match(html, /Agent 1 runs the whole suite &lt;before&gt; QA\./, 'escaped')
  assert.match(html, /<dt>Evidence<\/dt><dd>QA failed 4 of 9 flows\.\nSee agent-rules\.<\/dd>/)
  assert.match(html, /<span class="ins-tag">Rule<\/span><span class="ins-tag ins-tag-quiet">Agent 1<\/span><span class="ins-tag ins-tag-quiet">small effort<\/span>/)
  assert.match(html, /Master · 3h/)
  assert.equal((html.match(/data-ins-do="rule"/g) || []).length, 1)
  assert.match(html, /data-ins-do="accept" data-ins-id="s000001"[^>]*>Accept as a note</)
  assert.match(html, /class="primary" data-ins-do="accept" data-ins-id="s000002"[^>]*>Accept</)
  assert.equal((html.match(/data-ins-reject="/g) || []).length, 2)
  // a rule for an agent no longer on the pipeline: no rule button
  assert.doesNotMatch(V.suggestionsHtml({ list: [S()], agents: ['Master'] }, {}, NOW), /data-ins-do="rule"/)
})

test('Suggestions: the reject form with its reason, busy and error states, decided ones with what came of them, the empty and damaged states', () => {
  const form = V.suggestionsHtml({ list: [S()], agents: ['Agent 1'] }, { rejecting: 's000001', drafts: { s000001: 'Too slow <now>' } }, NOW)
  assert.match(form, /<label for="ins-why-s000001">Why not\? \(optional: Master reads it and does not propose this again\)<\/label>/)
  assert.match(form, /<textarea class="set-input" id="ins-why-s000001" rows="2" maxlength="300">Too slow &lt;now&gt;<\/textarea>/)
  assert.match(V.suggestionsHtml({ list: [S()], agents: [] }, { busy: 's000001', errors: { s000001: 'It is already accepted.' } }, NOW), /disabled[\s\S]*role="alert">It is already accepted\./)
  const decided = V.suggestionsHtml({ list: [S({ state: 'rejected', decidedAt: '2026-11-26T10:00:00.000Z', reason: 'QA runs it.' }), S({ id: 's000003', state: 'accepted', decidedAt: '2026-11-26T10:00:00.000Z', outcome: 'Added as a rule of Agent 1; its verdict is due on 10 Dec.' })], agents: [] }, {}, NOW)
  assert.match(decided, /Open · 0/)
  assert.match(decided, /No suggestion waits for you/)
  assert.match(decided, /Decided · 2/)
  assert.match(decided, /Rejected 26 Nov, \d\d:00: QA runs it\./)
  assert.match(decided, /Accepted 26 Nov, \d\d:00\. Added as a rule of Agent 1; its verdict is due on 10 Dec\./)
  assert.match(decided, /data-ins-do="done" data-ins-id="s000003"[^>]*>Mark done/)
  assert.match(V.suggestionsHtml({ list: [], broken: true }, {}, NOW), /The suggestions file is damaged/)
})

const VIEW = {
  enabled: true, repairs: true, seenAt: '2026-11-26T11:59:00.000Z', worst: 'failing',
  checks: [
    { id: 'loops', name: 'Background loops', looksAt: 'Does each still run?', on: true, state: 'ok', text: 'Every loop ran in time.', repair: 'Start a silent background loop once more.', lastRepair: null, extra: null },
    { id: 'refresh', name: 'Paid ticket refresh', looksAt: 'Whether it works.', on: true, state: 'failing', text: 'The ticket refresh failed 3 times and is paused. It has cost $52.32 since it last worked.', repair: 'Pause the timer.', lastRepair: { at: '2026-11-26T11:00:00.000Z', did: 'Paused the timer of Production checklist.', result: 'done' }, extra: { collections: [{ id: 'prod', name: 'Production checklist', paused: true }] } },
    { id: 'strays', name: 'Stray dashboard copies', looksAt: 'Copies.', on: true, state: 'degraded', text: '2 copies.', repair: null, extra: { strays: [{ pid: 11, port: 4497, ageMs: 9 * 3_600_000, folder: 'C:/d/.worktrees/x', canStop: true, startedAt: '2026-11-26T01:00:00Z' }, { pid: 12, port: null, ageMs: 7 * 3_600_000, folder: '', canStop: false }] } },
    { id: 'deliveries', name: 'Deliveries to agents', looksAt: 'Waiting.', on: true, state: 'failing', text: 'Held.', repair: 'Hold.', extra: { held: [{ agent: 'Agent 1', items: 2 }] } },
    { id: 'agents', name: 'Agents', looksAt: 'Hung.', on: true, state: 'degraded', text: 'Master has no session open.', repair: null, extra: { nudges: [{ agent: 'Master', text: 'Read the digest.' }] } },
    { id: 'disk', name: 'Disk and data growth', looksAt: 'Sizes.', on: false, state: 'off', text: 'Switched off.', repair: null },
  ],
  log: [{ at: '2026-11-26T11:00:00.000Z', name: 'Paid ticket refresh', saw: 'prod: 3 failed', did: 'Paused <it>.', result: 'done' }],
}

test('Health: failing first, each with its state, what it looks at, its one repair or why it only reports, its switch and its buttons', () => {
  const html = V.healthHtml(VIEW, {}, NOW)
  assert.match(html, /<b>2 checks failing<\/b>, <b>2 degraded<\/b>, 1 OK, 1 switched off\. It may do its four safe repairs\. Last look at \d\d:59\./)
  const order = [...html.matchAll(/data-heal-check="([a-z]+)"/g)].map(m => m[1])
  assert.deepEqual(order, ['refresh', 'deliveries', 'strays', 'agents', 'loops', 'disk'])
  assert.match(html, /<li class="card ins-check is-failing" data-heal-check="refresh">/)
  assert.match(html, /Paid ticket refresh <span class="ins-state">Failing<\/span>/)
  assert.match(html, /data-heal-resume="prod"[^>]*>Resume Production checklist</)
  assert.match(html, /Last repair 26 Nov, \d\d:00: Paused the timer of Production checklist\. <span class="ins-result">\(done\)<\/span>/)
  assert.match(html, /data-heal-release="Agent 1"[^>]*>Release Agent 1</)
  assert.match(html, /Port 4497 · 9 h · C:\/d\/\.worktrees\/x<\/span><button type="button" class="danger" data-heal-stop="11" data-heal-started="2026-11-26T01:00:00Z"/)
  assert.match(html, /No port · 7 h · folder not known<\/span><span class="ins-meta">Stop it in its own terminal\.<\/span>/)
  assert.equal((html.match(/data-heal-stop=/g) || []).length, 1, 'no Stop for a copy whose folder is not known')
  assert.match(html, /Report only: a copy may be a preview someone is looking at, so only you stop one\./)
  assert.match(html, /data-heal-nudge="0" title="Copies a sentence to paste into that session\. It sends nothing\.">Copy a nudge for Master</)
  assert.match(html, /<input type="checkbox" data-heal-switch="disk" aria-label="Watch Disk and data growth"> On<\/label>/)
  assert.match(html, /<input type="checkbox" data-heal-switch="refresh" aria-label="Watch Paid ticket refresh" checked> On<\/label>/)
  // QA, 2026-11-27: nine switches all named On; each now says which check it switches, and no two share a name
  const names = [...html.matchAll(/data-heal-switch="[a-z]+" aria-label="([^"]+)"/g)].map(m => m[1])
  assert.equal(names.length, VIEW.checks.length)
  assert.equal(new Set(names).size, names.length)
  assert.match(V.healthHtml({ ...VIEW, checks: [{ ...VIEW.checks[0], name: 'A "quoted" <name>' }] }, {}, NOW), /aria-label="Watch A &quot;quoted&quot; &lt;name&gt;"/)
  assert.match(html, /<td>Paused &lt;it&gt;\.<\/td>/)
  assert.match(V.healthHtml({ ...VIEW, repairs: false }, {}, NOW), /Repairs are off \(<code>healing\.repairs<\/code>\): it only reports\./)
  assert.match(V.healthHtml({ ...VIEW, enabled: false }, {}, NOW), /The watchdog is off/)
  assert.match(V.healthHtml({ ...VIEW, checks: [{ ...VIEW.checks[1], would: 'Pause.' }] }, {}, NOW), /Repairs are off: it would have done this, and did nothing\./)
  assert.match(V.healthHtml(null), /has not looked yet/)
  assert.match(V.healthHtml({ ...VIEW, log: [] }), /No repair yet\./)
})

test('the Agents page lines: health grouped like the alerts with the paused refresh and its Resume; the open suggestions; nothing when all is well', () => {
  const sum = { suggestions: { open: 2 }, health: { enabled: true, worst: 'failing', failing: [{ id: 'refresh', name: 'Paid ticket refresh', text: 'The ticket refresh failed 3 times and is paused. It has cost $52.32 since it last worked.' }], degraded: [{ id: 'loops', name: 'Background loops', text: 'x' }], paused: [{ id: 'prod', name: 'Production checklist' }] } }
  const html = V.linesHtml(sum)
  assert.match(html, /class="pe-line ins-line is-failing"[\s\S]*<b>Health: 1 failing, 1 degraded<\/b><span class="pe-kinds">The ticket refresh failed 3 times and is paused\. It has cost \$52\.32 since it last worked\.<\/span>/)
  assert.match(html, /data-heal-resume="prod">Resume Production checklist<\/button><a class="link" href="#\/health">Open Health<\/a>/)
  assert.match(html, /<b>2 suggestions from Master<\/b><span class="pe-kinds">They wait for your decision\.<\/span><span class="pe-line-end"><a class="link" href="#\/suggestions">Open them<\/a>/)
  const degraded = V.linesHtml({ suggestions: { open: 0 }, health: { enabled: true, failing: [], degraded: [{ id: 'loops', name: 'Background loops' }, { id: 'disk', name: 'Disk and data growth' }], paused: [] } })
  assert.match(degraded, /<b>Health: 2 degraded<\/b><span class="pe-kinds">Background loops degraded · Disk and data growth degraded<\/span>/)
  assert.equal(V.linesHtml({ suggestions: { open: 0 }, health: { enabled: true, failing: [], degraded: [] } }), '')
  assert.equal(V.linesHtml({ suggestions: { open: 0 }, health: { enabled: false, failing: [{ id: 'x', name: 'X' }], degraded: [] } }), '')
  assert.equal(V.linesHtml(null), '')
  const home = V.homeHtml(sum)
  assert.match(home, /class="pe-line ins-line ins-home is-failing"[\s\S]*<b>1 health check failing<\/b><span class="pe-kinds">2 suggestions from Master<\/span><span class="pe-line-end"><a class="link" href="#\/health">Open Health<\/a><a class="link" href="#\/suggestions">Open suggestions<\/a><\/span>/)
  assert.match(V.homeHtml({ suggestions: { open: 1 }, health: { enabled: true, failing: [], degraded: [] } }), /ins-home is-note"[\s\S]*<b>1 suggestion from Master<\/b><span class="pe-line-end"><a class="link" href="#\/suggestions">Open suggestions/)
  assert.equal(V.homeHtml({ suggestions: { open: 0 }, health: null }), '')
})

test('a phone: the page header of Suggestions and Health wraps onto a second line instead of pushing the page sideways', () => {
  // QA, 2026-11-27: at 390 px the title with its count, the waiting count and Refresh made #/suggestions 397 px wide
  const css = read('insight.css')
  const narrow = /@media \(max-width: 720px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] || ''
  const rule = /body:has\(#suggestionsView:not\(\[hidden\]\)\) #pageHead,\s*body:has\(#healthView:not\(\[hidden\]\)\) #pageHead \{([^}]*)\}/.exec(narrow)?.[1] || ''
  assert.match(rule, /flex-wrap: wrap/)
  assert.match(rule, /height: auto/)
  assert.match(rule, /min-height: var\(--header-h\)/)
})
