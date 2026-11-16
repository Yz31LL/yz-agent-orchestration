// Tests for public/flow-status.js, the Status view of an opened flow: what got
// built, what is missing, the decisions, the notes and the screenshots, read
// from the flow and its derived state. The file is a browser script, so it runs
// here in a vm context with a stub window (model and html never touch the DOM).
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE flows.mjs is imported
// (for derive), so no test touches data/.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-status-test-'))
const { derive, DATA_DIR } = await import('../flows.mjs')
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))

/** setTimeout callbacks the scripts scheduled, run by hand */
const timers = []

/** The page scripts flow-status.js leans on, then flow-status.js itself, in one vm context. */
function load(window = {}) {
  const ctx = { window, setTimeout: fn => timers.push(fn) }
  for (const f of ['shell.js', 'flow-chart.js', 'flow-drawer.js', 'flow-status.js']) vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), ctx)
  return { window }
}
const { window } = load()
const FS = window.FlowStatus

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))
/** A fresh copy of the fixture, changed by `edit`, with its derived state attached. */
const fx = (edit = () => {}) => {
  const flow = structuredClone(FIXTURE)
  edit(flow)
  flow.derived = derive(flow)
  return flow
}
/** Objects made inside the vm have its prototypes, so strict deepEqual needs plain copies. */
const plain = v => JSON.parse(JSON.stringify(v))
const node = (flow, id) => flow.nodes.find(n => n.id === id)

test('model: built is the done steps and checks in flow order, with their proof and evidence', () => {
  const m = plain(FS.model(fx()))
  assert.deepEqual(m.built.map(b => b.id), ['n1', 'n2'])
  assert.deepEqual(m.built[0], {
    id: 'n1', title: 'Add the theme tokens', env: 'dev', proof: 'claimed',
    evidence: [{ kind: 'commit', ref: 'ab12cd3', label: 'web: theme tokens', at: '2026-11-12T08:10:00Z' }],
  })
  assert.equal(m.built[1].proof, 'verified')
  const unproven = plain(FS.model(fx(f => { node(f, 'n1').evidence = [] })))
  assert.equal(unproven.built[0].proof, 'unproven')
})

test('model: missing is todo, doing and blocked work; skipped is left out; a pending node says why', () => {
  const m = plain(FS.model(fx(f => {
    f.nodes.push({ id: 'n5', type: 'step', title: 'Skipped', status: 'skipped', after: ['n4'], evidence: [], verified: null })
    f.nodes.push({ id: 'n6', type: 'check', title: 'Blocked', status: 'blocked', env: 'stage', after: [], evidence: [], verified: null })
  })))
  assert.deepEqual(m.missing.map(x => x.id), ['n4', 'n6'])
  assert.deepEqual(m.missing[0], {
    id: 'n4', title: 'Make dark mode the default when the system asks for it', env: 'dev', status: 'todo',
    pending: true, reason: 'waiting on the answer',
  })
  // n6 follows n5 (an empty after), which follows n4: still downstream of the open ask
  assert.equal(m.missing[1].pending, true)
  assert.equal(m.missing[1].env, 'stage')

  const no = plain(FS.model(fx(f => { Object.assign(node(f, 'n3'), { answer: 'no', answeredAt: '2026-11-12T09:00:00Z' }) })))
  assert.equal(no.missing[0].reason, 'after a No; the agent decides what happens next')

  const yes = plain(FS.model(fx(f => { Object.assign(node(f, 'n3'), { answer: 'yes', answeredAt: '2026-11-12T09:00:00Z' }) })))
  assert.deepEqual([yes.missing[0].pending, yes.missing[0].reason], [false, ''])
})

test('model: decisions are the asks, an open one open, an answered one with its delivery', () => {
  const m = plain(FS.model(fx()))
  assert.deepEqual(m.decisions, [{
    id: 'n3', question: 'Ship dark mode to dev now?', kind: 'yesno',
    yes: 'Turn it on for everyone on dev.', no: 'Keep it behind the toggle one more week.',
    answer: null, answeredAt: null, note: '', open: true, delivery: '',
    why: { text: 'The team has used it for a day.', auto: false },
  }])
  const sent = plain(FS.model(fx(f => {
    Object.assign(node(f, 'n3'), { answer: 'yes', answeredAt: '2026-11-12T09:00:00Z', sentAt: '2026-11-12T09:00:20Z', note: 'go' })
  })))
  assert.equal(sent.decisions[0].open, false)
  assert.equal(sent.decisions[0].delivery, 'sent')
  assert.equal(sent.decisions[0].note, 'go')
})

test('model: notes and every screenshot across the nodes', () => {
  const m = plain(FS.model(fx(f => {
    f.nodes.push({ id: 'n7', type: 'note', title: 'The toggle was fine', why: 'A day of reports, none blocked.', after: ['n2'] })
    node(f, 'n4').evidence.push({ kind: 'shot', ref: 'dark-mode/n4-before.png', at: '2026-11-12T08:50:00Z' })
  })))
  assert.deepEqual(m.notes, [{ id: 'n7', title: 'The toggle was fine', text: 'A day of reports, none blocked.' }])
  assert.deepEqual(m.shots, [
    { nodeId: 'n2', nodeTitle: 'The toggle remembers the choice', ref: 'dark-mode/toggle.png', caption: 'toggle ok' },
    { nodeId: 'n4', nodeTitle: 'Make dark mode the default when the system asks for it', ref: 'dark-mode/n4-before.png', caption: '' },
  ])
})

test('html: a summary line, then the sections in order with Name · N heads', () => {
  const h = FS.html(fx())
  assert.match(h, /2\/3 done · 1 waiting · 1 verified/)
  const heads = [...h.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map(m => m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim())
  assert.deepEqual(heads, ['Built · 2 tick = you verified it', 'Left · 1', 'Decisions · 1', 'Proof · 1'], 'Notes is hidden with no notes')
  assert.match(h, /data-goto="n1"/, 'a row title opens the node in the chart')
  assert.match(h, /data-verify="n1"/, 'each built row has the verified tick')
  assert.match(h, /data-verify="n2"[^>]*checked/)
  assert.match(h, /data-answer="yes" data-node="n3"/, 'an open yes/no ask has the same buttons the drawer uses')
  assert.doesNotMatch(h, /class="fl-env env-dev"/, 'the flow env is in the head, not on every row')
  assert.match(h, /<details[^>]*>[\s\S]*?ab12cd3/, 'a commit is collapsed')
  assert.match(h, /<details class="sv-fold" data-fold="dark-mode:n1">\s*<summary class="sv-row-head"[^>]*>[\s\S]*?data-goto="n1"[\s\S]*?<\/summary>\s*<ul class="sv-evlist">/, 'a built row is one line; its proof folds behind it')
  assert.doesNotMatch(h, /fl-proof|No evidence yet/, 'the mark says how proven; no extra pill or line')
  assert.match(h, /src="\/evidence\/dark-mode\/toggle\.png"/)
})

test('html: an empty Built, Left and Decisions say so in one line; an empty Proof is hidden', () => {
  const h = FS.html({ id: 'e', title: 'Empty', env: 'dev', nodes: [], derived: { progress: { done: 0, total: 0 }, pending: [], waiting: [], proof: {} } })
  for (const line of ['Nothing built yet.', 'Nothing left.', 'No decisions.']) assert.ok(h.includes(line), line)
  assert.doesNotMatch(h, /Proof ·|Notes ·/)
  assert.match(h, /<p class="sv-summary">0\/0 done<\/p>/)
})

test('html escapes every flow string: titles, answers, notes, captions and refs', () => {
  const flow = fx(f => {
    node(f, 'n1').title = '<img src=x onerror=alert(1)>'
    Object.assign(node(f, 'n3'), { kind: 'text', answer: '<script>alert(2)</script>', answeredAt: '2026-11-12T09:00:00Z', note: '<b>note</b>' })
    node(f, 'n2').evidence[0].label = '<svg onload=alert(3)>'
    node(f, 'n2').evidence[0].ref = 'dark-mode/a b?.png'
    f.nodes.push({ id: 'n8', type: 'note', title: '<i>t</i>', why: '<u>w</u>', after: ['n2'] })
  })
  const h = FS.html(flow)
  assert.doesNotMatch(h, /<img src=x/)
  assert.doesNotMatch(h, /<script>/)
  assert.doesNotMatch(h, /<svg onload/)
  assert.doesNotMatch(h, /<b>note<\/b>|<i>t<\/i>|<u>w<\/u>/)
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(h, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/)
  assert.match(h, /\/evidence\/dark-mode\/a%20b%3F\.png/, 'refs are encoded per segment')
})

test('the pending reason lives in flow-chart.js, shared by the chart, the drawer and the Status view', () => {
  const flow = fx()
  assert.equal(window.FlowChart.pendingReason(flow, 'n4'), 'waiting on the answer')
  assert.equal(window.FlowChart.pendingReason(flow, 'n1'), '')
  const flows = fs.readFileSync(path.join(PUBLIC, 'flows.js'), 'utf8')
  assert.doesNotMatch(flows, /function (?:pendingReasons|parentsOf)\b/, 'flows.js no longer has its own copy')
})

// ═══ fix round 1 ═══

/** A stub row and root: enough for reveal, which scrolls the row and toggles one class. */
function stubRoot(keys) {
  const rows = keys.map(k => {
    const cls = new Set()
    return {
      dataset: { sv: k }, scrolled: 0, flashes: 0,
      classList: { add(c) { cls.add(c); if (c === 'sv-flash') this.owner.flashes++ }, remove: c => cls.delete(c), has: c => cls.has(c) },
      scrollIntoView() { this.scrolled++ },
    }
  })
  for (const r of rows) r.classList.owner = r
  return { rows, querySelectorAll: s => (s === '[data-sv]' ? rows : []) }
}

test('a link to a node reveals its row ONCE per open: the polls after it never scroll again', () => {
  const root = stubRoot(['b:n1', 'e:n1:0', 'd:n3', 's:n3:0'])
  const ask = root.rows[2]
  const opened = { id: 'dark-mode', reveal: 'n3' }
  assert.equal(FS.revealOnce(root, opened), true)
  assert.deepEqual([ask.scrolled, ask.flashes], [1, 1])
  assert.equal(opened.reveal, null, 'the flag is spent')
  assert.equal(opened.revealed, true, 'open() then skips its own scroll to the board top')
  for (let poll = 0; poll < 3; poll++) assert.equal(FS.revealOnce(root, opened), false)
  assert.deepEqual([ask.scrolled, ask.flashes], [1, 1], 'three polls later, still once')
  timers.splice(0).forEach(fn => fn())
  assert.equal(ask.classList.has('sv-flash'), false, 'the flash class comes off again')
  assert.equal(root.rows[3].scrolled, 0, 'a Proof thumbnail of the same node is not the row')
})

test('reveal finds built, missing and note rows too, and says false for a node with no row', () => {
  for (const key of ['b:n1', 'm:n4', 'n:n7']) {
    const root = stubRoot([key])
    assert.equal(FS.reveal(root, key.slice(2)), true, key)
    assert.equal(root.rows[0].scrolled, 1)
  }
  const opened = { reveal: 'n9' } // a skipped step has no row on Status
  assert.equal(FS.revealOnce(stubRoot(['b:n1']), opened), false)
  assert.equal(opened.reveal, null, 'spent anyway: no later poll jumps to it')
  assert.equal(FS.revealOnce(stubRoot(['b:n1']), null), false)
})

test('a note row has a title that opens it in the chart, and why and note text go through the drawer md helper', () => {
  const md = load({ FactoryChat:{ md: s => `<p class="md">${String(s).replace(/</g, '&lt;')}</p>` } }).window.FlowStatus
  const h = md.html(fx(f => {
    f.nodes.push({ id: 'n7', type: 'note', title: 'Clean for a day', why: 'See **the reports**', after: ['n2'] })
  }))
  assert.match(h, /data-goto="n7"[^>]*>Clean for a day</)
  assert.match(h, /<p class="md">See \*\*the reports\*\*<\/p>/, 'the note text')
  assert.match(h, /<p class="md">The team has used it for a day\.<\/p>/, 'the ask why')
})

test('the inline Built thumbnail is small and Proof keeps the large one; a missing shot is caught; the flash calms down', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'flows.css'), 'utf8')
  assert.match(css, /\.sv-ev \.fl-shot \{[^}]*max-width: min\(120px/)
  assert.match(css, /\.sv-shot \.fl-shot \{[^}]*max-width: min\(220px/)
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.sv-row\.sv-flash \{ animation: none/)
  // The lightbox is shared with the Output storyboard (lightbox.js), and Status binds it to its root.
  assert.match(fs.readFileSync(path.join(PUBLIC, 'flow-status.js'), 'utf8'), /window\.Lightbox\.bind\(root\)/)
  const box = fs.readFileSync(path.join(PUBLIC, 'lightbox.js'), 'utf8')
  assert.match(box, /addEventListener\('error'[\s\S]*?The screenshot file is missing\.[\s\S]*?\}, true\)/, 'a capture error listener')
  assert.match(box, /Help\?\.close\?\.\(\)[\s\S]*Explain\?\.close\?\.\(\)/, 'the lightbox closes the popovers first')
})

test('the old status code lives only in flow-status.js: no lightbox, tabs or status rows left in flow-output.js', () => {
  const out = fs.readFileSync(path.join(PUBLIC, 'flow-output.js'), 'utf8')
  assert.doesNotMatch(out, /createElement\('div'\)[\s\S]*aria-modal|Nothing built yet|data-verify|role="tab"/)
  assert.doesNotMatch(fs.readFileSync(path.join(PUBLIC, 'flows.css'), 'utf8'), /\.fo-/, 'no style is left for the old class names')
})

test('keep-alive waits with ping, which works without a console', () => {
  const cmd = fs.readFileSync(path.join(HERE, '..', 'tools', 'keep-alive.cmd'), 'utf8')
  assert.match(cmd, /^ping -n 6 127\.0\.0\.1 >nul\r$/m)
  assert.doesNotMatch(cmd, /^timeout /m)
})
