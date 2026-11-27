// Tests for the review's UI fixes on the Flows page: the open flow's decision is
// answered on its Story line (U1; the Waiting on you strip of U2 is gone, its asks are
// in Human review on the Agents page), Status rows say verified once (U3), a card shows what most needs you (U4),
// the Picture is just the picture (U7), chart labels get a third line and diamonds
// more room (U8), and the send chip is neutral (S9). Browser scripts in a vm.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE flows.mjs is imported.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flows-ui-test-'))
const { derive, DATA_DIR } = await import('../flows.mjs')
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))

const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const SCRIPTS = ['shell.js', 'terms.js', 'flow-chart.js', 'diagram-fit.js', 'diagram-route.js', 'diagram.js', 'flow-picture.js', 'flow-drawer.js',
  'lightbox.js', 'flow-tabs.js', 'flow-status.js', 'flow-story.js', 'flow-compare.js', 'flow-visual.js', 'flow-steps.js', 'flow-send.js', 'flow-output.js', 'flow-board.js']
const memory = new Map()
const window = {}
const ctx = { window, localStorage: { getItem: k => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, String(v)) }, URL }
for (const f of SCRIPTS) vm.runInNewContext(read(f), ctx)

const DARK = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))
const NOVIS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'no-visual.json'), 'utf8'))
const fx = (base, edit = () => {}) => {
  const f = structuredClone(base)
  edit(f)
  f.derived = derive(f)
  return f
}
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
const block = (h, name) => {
  const at = h.indexOf(`aria-label="${name}"`)
  const next = h.slice(at + 1).search(/<(section|details) class="ob /)
  return next < 0 ? h.slice(at) : h.slice(at, at + 1 + next)
}
const answerAll = f => { for (const n of f.nodes) if (n.type === 'ask') Object.assign(n, { answer: 'yes', answeredAt: '2026-11-12T10:00:00Z' }) }

// ═══ U1: the open flow's decision is answered on its Story line ═══

test('U1: an open yes/no ask is a You · To decide line in the Story with its two choices named and your own words, even when the agent wrote the story', () => {
  const s = block(window.FlowOutput.html(fx(DARK)), 'Story')
  assert.match(s, /<li class="st-line st-ask"[^>]*><span class="st-who st-you">You<\/span><div class="st-text"><p class="st-did">To decide: Ship dark mode to dev now\?<\/p>/)
  assert.match(s, /<button type="button" class="fl-yes" data-answer="yes" data-node="n3"[^>]*>Turn it on for everyone on dev\.<\/button>/)
  assert.match(s, /<button type="button" class="fl-no" data-answer="no" data-node="n3"[^>]*>Keep it behind the toggle one more week\.<\/button>/)
  assert.match(s, /<form class="fl-text fl-other" data-text="n3">/)
})

test('U1: a text ask gets the text field and Save; a derived story has ONE decision line, the answerable one', () => {
  const t = block(window.FlowOutput.html(fx(DARK, f => { Object.assign(f.nodes.find(n => n.id === 'n3'), { kind: 'text' }) })), 'Story')
  assert.match(t, /<form class="fl-text" data-text="n3"><input name="answer" data-key="story:dark-mode:n3"[^>]*><button type="submit" class="primary">Save<\/button><\/form>/)
  const d = block(window.FlowOutput.html(fx(NOVIS)), 'Story')
  assert.equal((d.match(/To decide:/g) || []).length, 1)
  assert.match(d, /st-ask[\s\S]*data-answer="yes"/)
  assert.doesNotMatch(block(window.FlowOutput.html(fx(DARK, answerAll)), 'Story'), /st-ask|data-answer/, 'nothing to decide: no controls')
})

test('U1: Output answers through the same path as the Human review box (flows.js answer, which FlowsView exposes)', () => {
  const src = read('flows.js')
  assert.match(src, /:is\(\.fl-drawer, \.fl-stat, \.fl-out\) :is\(\[data-answer\]/)
  assert.match(src, /answer: \(flowId, nodeId, value\) => answer\(flowId, nodeId, value\)/)
  assert.doesNotMatch(src, /stripRows|stripHead/, 'the strip and its Also waiting head are gone')
})

// ═══ U3: Status says verified once ═══

test('U3: a Built row has the tick alone with an aria-label; Built says tick = you verified it once; zero counts leave the summary', () => {
  const h = window.FlowStatus.html(fx(DARK))
  assert.match(h, /<input type="checkbox" class="sv-verify" data-verify="n1" aria-label="Verified: Add the theme tokens">/)
  assert.doesNotMatch(h, /> verified<\/label>/)
  assert.match(h, /<h3 class="sv-h">Built <span class="faint">· 2<\/span> <span class="sv-hint">tick = you verified it<\/span><\/h3>/)
  assert.match(h, /<p class="sv-summary">2\/3 done · 1 waiting · 1 verified<\/p>/)
  const none = window.FlowStatus.html(fx(DARK, f => { answerAll(f); for (const n of f.nodes) if (n.verified !== undefined) n.verified = null }))
  assert.match(none, /<p class="sv-summary">2\/3 done<\/p>/)
  assert.match(read('flows.css'), /\.sv-ev \.fl-ev-kind dfn \{[^}]*border-bottom: 0[^}]*text-decoration: none/)
  assert.match(read('flows.css'), /\.sv-row-head > \.sv-verify \{ margin-left: auto; \}/, 'the tick stays at the row end, over the global checkbox margin')
})

// ═══ U4: a card says what most needs you ═══

test('U4: the card line is the open ask, else the blocker, else the newest story line, else the step count', () => {
  const B = window.FlowBoard
  assert.equal(text(B.storyLine(fx(DARK))), 'To decide: Ship dark mode to dev now?')
  const blocked = fx(NOVIS, f => { answerAll(f) })
  assert.match(text(B.storyLine(blocked)), /^Blocked: Mail the report from the new job$/)
  const told = fx(DARK, answerAll)
  assert.equal(text(B.storyLine(told)), text(window.Terms.html(told.output.story.at(-1).did)).replace(/\.$/, ''))
  const plain = fx(NOVIS, f => { answerAll(f); for (const n of f.nodes) if (n.status === 'blocked') n.status = 'todo' })
  assert.match(text(B.storyLine(plain)), /^Finished 7 steps/)
})

test('U4: a cut never ends on a short function word', () => {
  const B = window.FlowBoard
  for (const max of [18, 22, 26, 30, 34]) {
    const t = B.clip('Moved the report job to the new scheduler and the old one', max)
    assert.doesNotMatch(t, /\b(a|an|the|of|to|in|on|at|for|with|and|or|but|by|from|as|into)…$/i, t)
    assert.ok(t.endsWith('…'))
  }
})

// ═══ U7: the Picture is just the picture ═══

test('U7: no PICTURE label and no auto chip: the picture, its switch when there are several views, and Request visuals as a link', () => {
  const O = window.FlowOutput
  const auto = block(O.html(fx(NOVIS)), 'Picture')
  assert.doesNotMatch(auto, /<h3|sb-tag|>auto</)
  assert.match(auto, /<span class="ob-corner"><button type="button" class="link sb-request"[^>]*>Request visuals<\/button><\/span>/)
  const several = block(O.html(fx(DARK)), 'Picture')
  assert.doesNotMatch(several, /<h3|>Picture</)
  assert.match(several, /<span class="ob-corner"><div class="ob-seg" role="group" aria-label="Show">/)
  const derived = block(O.html(fx(DARK, f => { delete f.output.result; delete f.output.diagram; delete f.output.change })), 'Picture')
  assert.doesNotMatch(derived, /sb-tag|<h3/)
})

// ═══ U8: chart labels ═══

test('U8: a box at least 170 px wide takes a third line before it cuts; a diamond keeps 8 px more inside', () => {
  const F = window.DiagramFit
  assert.equal(F.room({ kind: 'decision' }, 200), 200 * 0.6 - 16)
  assert.equal(F.room({ kind: 'box' }, 200), 180)
  const label = 'Compare the nightly reports from both schedulers line by line'
  const svg = window.Diagram.svg({ nodes: [{ id: 'a', label }, { id: 'b', label: 'Done' }], edges: [{ from: 'a', to: 'b' }] }, { dir: 'LR', maxWidth: 960 })
  const first = svg.slice(svg.indexOf('class="dg-label"'), svg.indexOf('</text>'))
  assert.equal((first.match(/<tspan /g) || []).length, 3, first)
  assert.doesNotMatch(first, /…/, 'the whole label fits on three lines')
})

// ═══ S9: the send chip ═══

test('S9: a recorded, unsent pull request is the neutral chip to send', () => {
  const h = window.FlowBoard.card(fx(NOVIS, f => { answerAll(f); f.status = 'open'; for (const n of f.nodes) if (n.status === 'blocked') n.status = 'todo'; f.output = { merge: { head: 'feature/x', base: 'dev', title: 'T', body: 'b', at: '2026-11-12T10:00:00Z' } } }))
  assert.match(h, /<span class="fl-chip neutral">to send<\/span>/)
})
