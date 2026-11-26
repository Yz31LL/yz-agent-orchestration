// Tests for public/bank-page.js (the Orchestration bank page) and its place in the shell: the route #/bank, one
// entry #/bank/<id> and its Use confirmation #/bank/<id>/use, the rail link and the palette. Browser scripts in a
// vm with a bare window: only the pure half runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const w = {}
vm.runInNewContext(read('bank-page.js'), { window: w })
const P = w.BankPage
const shellWindow = {}
const shellCtx = { window: shellWindow }
for (const f of ['rail-groups.js', 'shell.js']) vm.runInNewContext(read(f), shellCtx) // as index.html loads them
const resolve = h => JSON.parse(JSON.stringify(shellWindow.Shell.resolve(h)))

const ENTRIES = [
  { id: 'o00000002', name: 'Careful <two>', savedAt: '2026-11-25T09:05:00.000Z', from: { id: 'dash', name: 'Dash' }, summary: 'Master hands to 2 agents, QA tests, 4 rules' },
  { id: 'o00000001', name: 'Flinki default', savedAt: '2026-11-24T09:05:00.000Z', from: { id: 'flinki-v2', name: 'Flinki v2' }, summary: 'Master hands to 3 agents, QA tests, 6 rules' },
]
const VIEW = {
  graph: { nodes: [], edges: [] },
  summary: 'Master hands to 2 agents through Planner, QA tests, Security checks, 3 rules',
  route: 'Master hands each request to Planner, who plans it and hands it to Agent 1 and Agent 2; QA tests every code change, then Security checks it for security problems before it is pushed; Independent answers questions in Ask.',
  agents: [
    { label: 'Master', role: 'coordinator', roleWords: 'hands out the work', spec: '', rules: [], modelWords: 'Model and effort not chosen' },
    { label: 'Planner', role: 'planner', roleWords: 'plans the work and hands it out', spec: '', rules: [], modelWords: 'Opus 5.5, high effort (fixed)' },
    { label: 'Agent 1', role: 'producer', roleWords: 'writes code', spec: 'Builds <web>.', rules: ['One.', 'Two.'], modelWords: 'Opus 5.5, high effort' },
    { label: 'Agent 2', role: 'producer', roleWords: 'writes code', spec: '', rules: [], modelWords: 'Haiku 5.5, low effort' },
    { label: 'Independent', role: 'chat', roleWords: 'answers questions in Ask', spec: '', rules: [], modelWords: 'Model and effort not chosen' },
    { label: 'QA', role: 'qa', roleWords: 'tests every code change', spec: '', rules: ['Push what you tested.'], modelWords: 'Model and effort not chosen' },
    { label: 'Security', role: 'security', roleWords: 'checks for security problems before the push', spec: '', rules: [], modelWords: 'Opus 5.5, high effort (fixed)' },
  ],
}
const CHANGES = ['Planner is added: plans the work and hands it out.', 'Agent 1: 2 rules added.', 'Agent 2 runs on Haiku 5.5 at low effort instead of Opus 5.5 at high effort.']

test('the routes: #/bank, one entry, its Use confirmation', () => {
  assert.deepEqual(resolve('#/bank'), { view: 'bank', params: {}, redirect: null })
  assert.deepEqual(resolve('#/bank/o00000001'), { view: 'bank', params: { id: 'o00000001', mode: null }, redirect: null })
  assert.deepEqual(resolve('#/bank/o00000001/use'), { view: 'bank', params: { id: 'o00000001', mode: 'use' }, redirect: null })
})

test('the shell wires it: a title, a section, the page object, an icon, a rail link after Subagents in the Agents group, and the palette', () => {
  const shell = read('shell.js')
  assert.match(shell, /bank: 'Orchestration bank'/)
  assert.match(shell, /bank: 'bankView'/)
  assert.match(shell, /bank: 'BankPage'/)
  const agents = shellWindow.RailGroups.groups().find(g => g.id === 'agents').entries
  assert.equal(agents.map(e => e.view).join(' '), 'agents subagents bank routing health') // Health (insight-pages.js) ends the group
  const bank = shellWindow.RailGroups.linkFor('bank')
  assert.equal(bank.href, '#/bank')
  assert.equal(bank.label, 'Orchestration bank')
  assert.match(bank.icon, /<path/, 'its icon: three stacked layers')
  assert.match(read('index.html'), /<section id="bankView" aria-label="Orchestration bank" hidden><\/section>/)
  assert.match(read('index.html'), /<script src="bank-page\.js"><\/script>/)
  vm.runInNewContext(read('palette.js'), shellCtx)
  assert.equal(shellWindow.Palette.gather({}).find(i => i.kind === 'page' && i.label === 'Orchestration bank')?.hint, '#/bank', 'the palette lists it')
})

test('the list: each saved style with its name, time, project and summary, newest first as given, escaped', () => {
  const html = P.listHtml({ entries: ENTRIES, used: { id: 'o00000001', name: 'Flinki default' }, inUse: 'o00000001', current: { id: 'flinki-v2', name: 'Flinki v2' } })
  assert.ok(html.indexOf('Careful &lt;two&gt;') < html.indexOf('Flinki default'))
  assert.match(html, /Saved \d{1,2} Nov 2026, \d{2}:\d{2} from Dash/)
  assert.match(html, /Master hands to 3 agents, QA tests, 6 rules/)
  assert.equal((html.match(/In use here/g) || []).length, 1)
  for (const a of ['Open', 'Rename', 'Duplicate', 'Delete', 'Use on this project']) assert.match(html, new RegExp(`>${a}<`))
  assert.match(html, /href="#\/bank\/o00000002\/use"/)
  assert.ok(!html.includes('href="#/bank/o00000001/use"'), 'the style in use is not offered again')
  assert.match(html, /data-bk-save>Save the current orchestration…/)
})

test('In use here follows the style, not only the last entry taken: edited since, no tag and Use is offered', () => {
  const html = P.listHtml({ entries: ENTRIES, used: { id: 'o00000001', name: 'Flinki default' }, inUse: null })
  assert.doesNotMatch(html, /In use here/)
  assert.match(html, /href="#\/bank\/o00000001\/use"/)
})

test('after a Use the list says, in one calm line, what is in use now and where the earlier one went', () => {
  assert.equal(P.afterUseLine({ entry: 'Careful', project: 'Flinki v2', autosaved: 'Flinki v2, 25 Nov 2026 10:05' }),
    'Careful is now in use on Flinki v2. The orchestration used before is saved in the bank as Flinki v2, 25 Nov 2026 10:05.')
  assert.equal(P.afterUseLine({ entry: 'Careful', project: 'Flinki v2', autosaved: 'Flinki default', existing: true }),
    'Careful is now in use on Flinki v2. The orchestration used before was already in the bank as Flinki default.')
  assert.equal(P.afterUseLine(null), '')
  assert.equal(P.afterUseLine({ entry: 7 }), '')
  assert.match(P.listHtml({ entries: ENTRIES, note: P.afterUseLine({ entry: 'Careful', project: 'P', autosaved: 'A' }) }), /class="pm-status bk-note" role="status">Careful is now in use on P\./)
})

test('an empty bank says what to do; the seeded entry is named once', () => {
  assert.match(P.listHtml({ entries: [], current: { name: 'Flinki v2' } }), /Nothing saved yet/)
  assert.match(P.listHtml({ entries: ENTRIES, seeded: { id: 'o00000001', name: 'Flinki v2, 25 Nov 2026' } }), /was saved here as <b>Flinki v2, 25 Nov 2026<\/b>/)
})

test('rename in place, and delete asks on the page that no project changes', () => {
  const r = P.listHtml({ entries: ENTRIES, renaming: 'o00000002', draft: 'New name' })
  assert.match(r, /data-bk-rename-form="o00000002"/)
  assert.match(r, /value="New name"/)
  const d = P.listHtml({ entries: ENTRIES, deleting: 'o00000001' })
  assert.match(d, /Delete Flinki default\?/)
  assert.match(d, /Only the bank changes: no project loses its orchestration\./)
  assert.match(d, /data-bk-delete-yes="o00000001"/)
  assert.ok(!/confirm\(/.test(read('bank-page.js')), 'never window.confirm')
})

test('the save form starts from a dated name', () => {
  assert.match(P.listHtml({ entries: [], saving: true, saveName: 'Flinki v2, 25 Nov 2026, 10:05' }), /data-bk-save-form.*value="Flinki v2, 25 Nov 2026, 10:05"/)
})

test('one entry opened: the route in words, the diagram box, and each agent with its role words, model, specification and rules', () => {
  const html = P.entryHtml({ entry: ENTRIES[0], view: VIEW, changes: CHANGES, same: false, noSession: [], current: { summary: 'x' }, inUse: false })
  assert.match(html, /data-bk-diagram/)
  assert.match(html, /Master hands each request to Planner, who plans it and hands it to Agent 1 and Agent 2; QA tests every code change, then Security checks it/)
  assert.match(html, /<h3>Agent 1 <span class="bk-role">writes code<\/span><\/h3><p class="bk-model">Opus 5\.5, high effort<\/p><p class="bk-spec">Builds &lt;web&gt;\.<\/p><ol><li>One\.<\/li><li>Two\.<\/li><\/ol>/)
  assert.match(html, /<h3>Planner <span class="bk-role">plans the work and hands it out<\/span><\/h3><p class="bk-model">Opus 5\.5, high effort \(fixed\)<\/p>/)
  assert.match(html, /<h3>Security <span class="bk-role">checks for security problems before the push<\/span>/)
  assert.doesNotMatch(html, /bk-role">(planner|security|producer|qa|coordinator)</, 'never the raw role names')
  assert.match(html, /No specification or rules\./)
  assert.match(html, /href="#\/bank\/o00000002\/use">Use on this project/)
})

test('an opened style that equals the one in use offers no Use', () => {
  const html = P.entryHtml({ entry: ENTRIES[0], view: VIEW, changes: [], same: true, inUse: true, noSession: [], current: {} })
  assert.doesNotMatch(html, /\/use"/)
  assert.match(html, /This is the orchestration in use on this project now\./)
})

test('the Use confirmation: the route, exactly what differs, the save first, the agents with no session', () => {
  const html = P.confirmHtml({ entry: ENTRIES[0], view: VIEW, changes: CHANGES, same: false, noSession: ['Agent 2', 'QA'], current: { summary: 'Master hands to 3 agents, QA tests, 6 rules' }, project: { name: 'Flinki v2' } })
  assert.match(html, /Use Careful &lt;two&gt; on Flinki v2\?/)
  assert.match(html, /What changes from the orchestration in use now:/)
  assert.match(html, /<li>Planner is added: plans the work and hands it out\.<\/li><li>Agent 1: 2 rules added\.<\/li><li>Agent 2 runs on Haiku 5\.5 at low effort instead of Opus 5\.5 at high effort\.<\/li>/)
  assert.match(html, /The route: Master hands each request to Planner, who plans it and hands it to Agent 1 and Agent 2; QA tests every code change, then Security checks it/)
  assert.match(html, /The orchestration in use now \(Master hands to 3 agents, QA tests, 6 rules\) is saved to the bank first, under a dated name, so you can switch back\./)
  assert.match(html, /Agent 2 and QA have no session in Flinki v2 yet\. They are set up all the same and wait for sessions with those names\./)
  assert.match(html, /The dashboard restarts to load it/)
  assert.match(html, /data-bk-use-yes="o00000002">Use Careful &lt;two&gt;/)
  assert.match(html, /href="#\/bank\/o00000002">Cancel/)
  const one = P.confirmHtml({ entry: ENTRIES[0], view: VIEW, changes: [], same: false, noSession: ['QA'], current: {}, project: { name: 'X' } })
  assert.match(one, /QA has no session in X yet\. It is set up all the same and waits for a session with that name\./)
  assert.match(one, /Only details this list does not name differ, such as the session names behind the agents\./)
  assert.match(P.confirmHtml({ entry: ENTRIES[0], view: VIEW, changes: CHANGES, noSession: [], current: {}, project: {}, using: true }), /disabled>Saving…/)
})

test('the confirmation for the style already in use asks nothing: there is nothing to change', () => {
  const html = P.confirmHtml({ entry: ENTRIES[0], view: VIEW, changes: [], same: true, noSession: [], current: {}, project: { name: 'Flinki v2' } })
  assert.match(html, /Careful &lt;two&gt; is already the orchestration in use on Flinki v2\. There is nothing to change\./)
  assert.doesNotMatch(html, /data-bk-use-yes/)
  assert.match(html, /href="#\/bank">Back to the bank/)
})

test('after a successful Use the page lands on the bank list, not back on the question', () => {
  const src = read('bank-page.js')
  assert.match(src, /landAt: '#\/bank'/)
  const menu = read('project-menu.js')
  assert.match(menu, /landAt/)
})

test('times read short and local; nonsense reads as nothing', () => {
  const d = new Date(2026, 10, 25, 9, 5)
  assert.equal(P.whenText(d.toISOString()), '25 Nov 2026, 09:05')
  assert.equal(P.whenText('nope'), '')
  assert.equal(P.whenText(null), '')
})
