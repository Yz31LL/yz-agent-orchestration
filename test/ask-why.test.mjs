// Tests for two things about asks (`flow ask`):
//   the bug  Yes and No "did nothing" on an opened flow's Output: the answer was saved and relayed,
//            but the Story kept drawing the answered ask with its buttons, on every poll, because
//            the Output view's redraw signature left the open asks out. Pressing again answered
//            again (and relayed again). Also the chart drew Yes and No on a TEXT ask.
//   the why  every place that shows an ask shows WHY it is asked, under the question: the agent's
//            --why, else a short fallback (the flow and the step the ask follows), never a bare
//            question. The CLI warns an agent that asks with no --why.
// Browser scripts run in a vm with a bare window. FACTORY_DATA_DIR points at a fresh temp folder
// BEFORE flows.mjs is imported, so no test touches data/.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const PUBLIC = path.join(ROOT, 'public')
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-why-test-'))
const F = await import('../flows.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
const { pulse } = await import('../orchestration.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-why-files-'))
after(() => {
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
})

const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const SCRIPTS = ['shell.js', 'terms.js', 'flow-chart.js', 'diagram-fit.js', 'diagram-route.js', 'diagram.js', 'flow-picture.js', 'flow-drawer.js',
  'lightbox.js', 'flow-tabs.js', 'flow-status.js', 'flow-story.js', 'flow-compare.js', 'flow-visual.js', 'flow-steps.js', 'flow-send.js', 'flow-output.js', 'flow-board.js']
const memory = new Map()
const window = {}
const ctx = { window, localStorage: { getItem: k => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, String(v)) }, URL }
for (const f of SCRIPTS) vm.runInNewContext(read(f), ctx)

const notifyWindow = {}
vm.runInNewContext(read('notify.js'), { window: notifyWindow })

const T = '2026-11-16T05:30:00.000Z'
const WHY = 'The test passes on the branch and nothing else changed.'
let made = 0
/**
 * A flow like prod-deliver-1: an agent-written story and a diagram (so nothing on Output is drawn
 * from the asks but the Story), a done step, a yes/no ask WITH a why after it, a text ask with
 * none (it follows the first ask by position), and a step after both.
 */
function flow({ id = `ship-${++made}` } = {}) {
  const f = F.createFlow({ id, title: 'Ship the login fix', agent: 'Master', env: 'dev' })
  F.addNode(f, { type: 'step', id: 'n1', title: 'Write the failing test', status: 'done' })
  F.addNode(f, { type: 'ask', id: 'q1', title: 'Deploy the fix to dev?', why: WHY, after: ['n1'], yes: 'Deploy it', no: 'Leave it' })
  F.addNode(f, { type: 'ask', id: 'q2', title: 'Who signs it off?', kind: 'text' })
  F.addNode(f, { type: 'step', id: 'n2', title: 'Deploy', after: ['q1'] })
  f.output = {
    story: [{ id: 's1', who: 'Master', did: 'Fixed the redirect', why: '', at: T }],
    diagram: { nodes: [{ id: 'a', label: 'Browser', kind: 'actor' }, { id: 'b', label: 'Sign-in page', kind: 'box' }], edges: [{ from: 'a', to: 'b', label: 'opens' }] },
  }
  f.derived = F.derive(f)
  return f
}
const answer = (f, nodeId, value) => {
  F.applyAnswer(f, nodeId, value)
  f.derived = F.derive(f)
  return f
}
/** Objects made inside the vm have its prototypes, so strict deepEqual needs plain copies. */
const plain = v => JSON.parse(JSON.stringify(v))
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * A root for FlowOutput.fill with no DOM: what fill wrote last is what the page would show.
 * fill builds the new markup in a fresh div from ownerDocument.createElement, so `html()` is
 * the markup of its last real redraw; a fill that returns early leaves it unchanged.
 */
function fakeRoot() {
  let last = ''
  const empty = () => []
  const doc = {
    activeElement: null,
    defaultView: null,
    createElement: () => ({
      set innerHTML(v) { last = v },
      get innerHTML() { return last },
      childNodes: [],
      querySelectorAll: empty,
    }),
  }
  return { ownerDocument: doc, contains: () => false, addEventListener() {}, querySelectorAll: empty, querySelector: () => null, replaceChildren() {}, html: () => last }
}

// ═══ the bug: an answered ask stays answerable on Output ═══

test('regression: answering an ask redraws the Output Story, so its Yes and No go away (nothing else on Output changed)', () => {
  const root = fakeRoot()
  const f = flow()
  window.FlowOutput.fill(root, f)
  assert.match(root.html(), /data-answer="yes" data-node="q1"/, 'the open ask is answerable first')
  window.FlowOutput.fill(root, answer(f, 'q1', 'yes'))
  assert.doesNotMatch(root.html(), /data-node="q1"/, 'the answered ask left the Story')
  assert.match(root.html(), /data-text="q2"/, 'the other open ask is still there')
  window.FlowOutput.fill(root, answer(f, 'q2', 'Dana from QA'))
  assert.doesNotMatch(root.html(), /data-text="q2"/, 'a text answer clears its field too')
})

test('regression: an ask reopened (Change) comes back on the Story', () => {
  const root = fakeRoot()
  const f = answer(flow(), 'q1', 'no')
  window.FlowOutput.fill(root, f)
  assert.doesNotMatch(root.html(), /data-node="q1"/)
  window.FlowOutput.fill(root, answer(f, 'q1', null))
  assert.match(root.html(), /data-answer="yes" data-node="q1"/)
})

test('regression: the chart draws no Yes and No on an open TEXT ask (a Yes there would save the text "yes")', () => {
  const f = flow()
  const svg = window.FlowChart.svg(f, window.FlowChart.layout(f))
  assert.doesNotMatch(svg, /data-answer="(yes|no)" data-node="q2"/)
  assert.match(svg, /data-answer="yes" data-node="q1"/, 'a yes/no ask keeps its buttons')
  assert.match(svg, /class="fc-type"[^>]*>[\s\S]*?Answer…/, 'the text ask says to open it and type')
})

// ═══ the reason: derive ═══

test('derive gives every ask a reason: the agent why, else the flow and the step it follows (by after, or by position)', () => {
  const f = flow()
  assert.deepEqual(f.derived.reasons.q1, { text: WHY, auto: false })
  assert.deepEqual(f.derived.reasons.q2, { text: 'Part of Ship the login fix, after: Deploy the fix to dev?', auto: true })
  assert.equal(f.derived.reasons.n1, undefined, 'steps have none')
  const first = F.createFlow({ id: 'first-ask', title: 'Pick a colour', agent: 'Master' })
  F.addNode(first, { type: 'ask', id: 'q1', title: 'Blue or green?', why: '   ' })
  assert.deepEqual(F.derive(first).reasons.q1, { text: 'Part of Pick a colour', auto: true }, 'a blank why is no why; nothing before it')
  const long = F.createFlow({ id: 'long-step', title: 'T', agent: 'Master' })
  F.addNode(long, { type: 'step', id: 'n1', title: 'x'.repeat(200) })
  F.addNode(long, { type: 'ask', id: 'q1', title: 'Go?' })
  assert.ok(F.derive(long).reasons.q1.text.length <= 'Part of T, after: '.length + 80, 'a long step title is cut')
})

// ═══ the reason: everywhere an ask shows ═══

test('the Story shows the why under the question, and the fallback (marked auto) when the agent gave none', () => {
  const html = window.FlowOutput.html(flow())
  const q1 = html.slice(html.indexOf('data-ask="q1"'), html.indexOf('data-ask="q2"'))
  assert.match(q1, /To decide: Deploy the fix to dev\?<\/p><p class="st-why fl-ask-why"><span class="st-why-k">Why\?<\/span> The test passes/)
  const q2 = html.slice(html.indexOf('data-ask="q2"'))
  assert.match(q2, /<p class="st-why fl-ask-why is-auto"><span class="st-why-k">Why\?<\/span> Part of Ship the login fix, after: Deploy the fix to dev\?<\/p>/)
})

test('the Waiting on you strip (Home and Flows) shows the why under the question in each row, not only on hover', () => {
  const f = flow()
  const rows = window.FlowBoard.stripRows([f], new Set()).map(r => window.FlowBoard.stripRow(r))
  const q1 = rows.find(r => r.includes('data-node="q1"'))
  const q2 = rows.find(r => r.includes('data-text="q2"'))
  assert.match(q1, /<div class="fl-wait-q">[\s\S]*Deploy the fix to dev\?[\s\S]*<\/div>\s*<p class="fl-wait-why fl-ask-why"><span class="st-why-k">Why\?<\/span> The test passes/)
  assert.match(q2, /<p class="fl-wait-why fl-ask-why is-auto"><span class="st-why-k">Why\?<\/span> Part of Ship the login fix/)
  assert.match(read('flows.js'), /window\.FlowBoard\.stripRow\b/, 'flows.js draws its rows with FlowBoard.stripRow')
})

test('Status shows the reason on every decision row, the fallback too', () => {
  const html = window.FlowStatus.html(flow())
  assert.match(html, /The test passes on the branch/)
  assert.match(html, /class="fl-why sv-md fl-ask-why is-auto"[^>]*><span class="st-why-k">Why\?<\/span> Part of Ship the login fix/)
})

test('the node drawer shows the reason for an ask with no why', () => {
  const f = flow()
  const html = window.FlowDrawer.html(f, f.nodes.find(n => n.id === 'q2'), '')
  assert.match(text(html), /Why\? Part of Ship the login fix, after: Deploy the fix to dev\?/)
})

test('the chart puts the reason in the ask tooltip', () => {
  const f = flow()
  const svg = window.FlowChart.svg(f, window.FlowChart.layout(f))
  assert.match(svg, /<g class="[^"]*" data-node="q1"[^>]*>\s*<title>Deploy the fix to dev\?\nWhy\? The test passes/)
})

test('the pulse carries each waiting ask reason, and the alert (toast and desktop notification) says it', async () => {
  const f = flow({ id: 'pulse-why' })
  F.writeFlow(f)
  const p = await pulse({ getStatus: async () => ({ agents: [] }), chatStatus: () => ({}) })
  const q2 = p.waiting.find(a => a.flowId === 'pulse-why' && a.nodeId === 'q2')
  assert.equal(q2.why, 'Part of Ship the login fix, after: Deploy the fix to dev?')
  const r = plain(notifyWindow.NotifyRules.alerts(new Map(), { waiting: [q2], flows: [] }, { seen: [], first: false, onFlows: false }))
  assert.equal(r.alerts[0].why, q2.why)
  assert.match(read('notify.js'), /Why\? \$\{esc\(a\.why\)\}/, 'the toast prints it under the question')
})

// ═══ the CLI nudges agents to say why ═══

test('flow ask without --why still asks, and warns on stderr; with --why it says nothing more', () => {
  F.writeFlow(flow({ id: 'cli-why' }))
  const bare = runFlow(['ask', 'cli-why', 'Merge it?'], { by: 'Master', cwd: TMP })
  assert.equal(bare.code, 0, bare.out)
  assert.match(bare.err, /no --why/)
  assert.match(bare.err, /--why "/)
  const told = runFlow(['ask', 'cli-why', 'Merge it now?', '--why', 'Review passed.'], { by: 'Master', cwd: TMP })
  assert.equal(told.code, 0)
  assert.equal(told.err, undefined)
  assert.equal(F.readFlow('cli-why').nodes.at(-1).why, 'Review passed.')
})

test('flow write warns about each ask with no why, by id', () => {
  const f = flow({ id: 'write-why' })
  delete f.derived
  const file = path.join(TMP, 'write-why.json')
  fs.writeFileSync(file, JSON.stringify(f))
  const r = runFlow(['write', file], { by: 'Master', cwd: TMP })
  assert.equal(r.code, 0, r.out)
  assert.match(r.err, /q2/)
  assert.doesNotMatch(r.err, /q1/)
})

test('decide passes --why through to the ask', () => {
  const r = spawnSync(process.execPath, ['tools/factory.mjs', 'decide', '--question', 'Go?', '--why', 'Because the build is green.', '--by', 'Agent 2'], {
    cwd: ROOT,
    env: { ...process.env, FACTORY_DATA_DIR: F.DATA_DIR },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  const asked = F.listFlows({ waiting: true }).flows.find(fl => fl.title === 'Go?')
  assert.equal(asked.nodes[0].why, 'Because the build is green.')
  assert.doesNotMatch(r.stderr, /no --why/)
})

test('the agent brief and the README tell every agent to pass --why on flow ask', () => {
  const brief = fs.readFileSync(path.join(ROOT, 'docs', 'agent-brief.md'), 'utf8')
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  for (const doc of [brief, readme]) {
    assert.match(doc, /flow ask[^\n]*--why/, 'the example ask passes --why')
    assert.match(doc, /Always pass `--why`/)
  }
})
