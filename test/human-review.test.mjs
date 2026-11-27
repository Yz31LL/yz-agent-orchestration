// Tests for the Human review box (public/human-review.js): the split in its head, the filter chips, its rows, the
// one next step of a ticket with no flow, where the layout puts it in the Agents diagram (under every box, arrow and
// label: lined up with the outermost boxes left to right, the whole width top to bottom, with the real
// pipeline-layout.js and the Planner and Security boxes), the counts it hands the rail, the page head and Home, and
// the wiring. The pure parts run in a vm.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { pipelineGraph } from '../pipeline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

function load() {
  const window = { Shell: { ago: iso => (iso ? '3h' : '') }, FlowDrawer: { delivery: () => '' } }
  vm.runInNewContext(read('flow-board.js'), { window })
  for (const f of ['pipeline-labels.js', 'pipeline-layout.js']) vm.runInNewContext(read(f), { window })
  vm.runInNewContext(read('human-review.js'), { window })
  return window
}

const ASK = { key: 'ask:dark:n3', kind: 'ask', flowId: 'dark', nodeId: 'n3', title: 'Add a <dark> mode toggle', agent: 'Agent 3', since: '2026-11-24T08:00:00Z', reason: 'The test passes; dev is where QA can try it', ask: { title: 'Deploy the fix to dev?', kind: 'yesno', yes: 'Deploy it', no: 'Leave it' } }
const HAND = { key: 'hand:ci', kind: 'hand', flowId: 'ci', title: 'Production deploy needs its secrets', agent: 'Agent 2', since: '2026-11-24T07:00:00Z', reason: '1 of 4 done. Next: Add the deploy token', progress: { done: 1, total: 4 } }
const TICKET = { key: 'ticket:FLA-820', kind: 'ticket', ticketId: 'FLA-820', title: 'Cloud Hosting: Billing account linked', agent: '', since: '2026-11-10T00:00:00Z', reason: 'Marked not codebase work: a person, console or process task.' }
const BLOCKED = { key: 'blocked:b', kind: 'blocked', flowId: 'b', title: 'Deploy', agent: 'Agent 1', since: '2026-11-09T00:00:00Z', reason: 'Blocked at: Deploy to stage' }
const DATA = { items: [ASK, HAND, TICKET, BLOCKED], counts: { total: 4, ask: 1, hand: 1, blocked: 1, ticket: 1 } }

test('the head shows the split, never one mixed number; the chips carry the counts, All first, the one in effect pressed', () => {
  const H = load().HumanReview
  const h = H.html(DATA, 'all')
  assert.match(h, /<h3 class="hr-h" id="hrHead" tabindex="-1"><i class="hr-dot" aria-hidden="true"><\/i>Human review<\/h3><span class="hr-split">1 question · 1 by hand · 1 blocked · 1 ticket<\/span>/)
  assert.doesNotMatch(h, /hr-count/, 'no single mixed number')
  assert.equal(H.splitText({ ask: 13, hand: 2, blocked: 0, ticket: 60 }), '13 questions · 2 by hand · 60 tickets')
  assert.equal(H.splitText({ ask: 0 }), '')
  assert.match(h, /<div class="lg-chips hr-chips" role="group" aria-label="Show in Human review">/)
  assert.deepEqual([...h.matchAll(/data-hr-chip="(\w+)" aria-pressed="(\w+)">(\w[\w ]*) <span class="hr-chip-n">(\d+)<\/span>/g)].map(m => m.slice(1).join(' ')),
    ['all true All 4', 'ask false Questions 1', 'hand false By hand 1', 'blocked false Blocked 1', 'ticket false Tickets 1'])
})

test('a chip shows only its kind; with none of it, one calm line; the default is Questions while there are any, else All; a stored choice wins', () => {
  const H = load().HumanReview
  const asks = H.html(DATA, 'ask')
  assert.match(asks, /data-hr-chip="ask" aria-pressed="true"/)
  assert.match(asks, /Deploy the fix to dev\?/)
  assert.doesNotMatch(asks, /Billing account linked|Production deploy/)
  assert.match(H.html({ items: [TICKET], counts: { total: 1, ask: 0, hand: 0, blocked: 0, ticket: 1 } }, 'ask'), /<p class="hr-empty">No questions wait on you\.<\/p>/)
  assert.equal(H.filterOf(null, { ask: 3 }), 'ask')
  assert.equal(H.filterOf(null, { ask: 0 }), 'all')
  assert.equal(H.filterOf('ticket', { ask: 3 }), 'ticket')
  assert.equal(H.filterOf('nonsense', { ask: 0 }), 'all')
  const src = read('human-review.js')
  assert.match(src, /try \{ return window\.localStorage\.getItem\(FILTER_KEY\) \} catch \{ return null \}/, 'remembered per browser, never a throw')
  assert.match(src, /const FILTER_KEY = 'human\.filter'/)
})

test('a row: its title, kind, agent, how long it has waited and one reason; a question answered right here with the usual controls', () => {
  const H = load().HumanReview
  const h = H.html(DATA, 'all')
  assert.match(text(h), /Add a &lt;dark&gt; mode toggle Question · Agent 3 · waiting 3h Deploy the fix to dev\? Yes No Why\? The test passes; dev is where QA can try it/)
  assert.match(text(h), /Production deploy needs its secrets By hand · 1 of 4 · Agent 2 · waiting 3h 1 of 4 done\. Next: Add the deploy token/)
  assert.match(text(h), /Deploy Blocked · Agent 1 · waiting 3h Blocked at: Deploy to stage/)
  assert.match(H.rowHtml(ASK), /<button type="button" class="fl-yes" data-answer="yes" data-node="n3" title="Deploy it">Yes<\/button>/)
  assert.match(H.rowHtml({ ...ASK, ask: { ...ASK.ask, kind: 'text' } }), /<form class="fl-text" data-text="n3"><input name="answer" data-key="hr:dark:n3"/)
  assert.match(read('human-review.js'), /window\.FlowsView\?\.answer\(/, 'the one answer path')
})

test('a ticket with no flow has one honest next step: Ask for steps, posted to the ticket route; no step is ever made up here', () => {
  const H = load().HumanReview
  const h = H.rowHtml(TICKET)
  assert.match(text(h), /Cloud Hosting: Billing account linked Ticket FLA-820 · waiting 3h Marked not codebase work: a person, console or process task\. No one has written the steps yet\. Ask for steps/)
  assert.match(h, /<button type="button" class="hr-steps" data-hr-steps="FLA-820">Ask for steps<\/button>/)
  assert.doesNotMatch(H.rowHtml(HAND), /data-hr-steps/)
  const src = read('human-review.js')
  assert.match(src, /fetch\(`\/api\/tickets\/\$\{enc\(btn\.dataset\.hrSteps\)\}\/request-hand`/)
  assert.doesNotMatch(src, /hand-step|do: '/, 'the page never invents a step')
})

test('a title opens the right place: the question at its node, the by-hand steps, the flow, or the ticket', () => {
  const H = load().HumanReview
  assert.match(H.rowHtml(ASK), /data-hr-open="dark" data-hr-kind="ask" data-hr-node="n3" title="Open the question in its flow"/)
  assert.match(H.rowHtml(HAND), /data-hr-open="ci" data-hr-kind="hand" title="Open the steps in its flow"/)
  assert.match(H.rowHtml(TICKET), /data-hr-ticket="FLA-820" title="Open the ticket"/)
  const src = read('human-review.js')
  assert.match(src, /kind === 'hand' \? window\.FlowsView\?\.gotoHand\(id\) : window\.FlowsView\?\.gotoFlow\(id, node \|\| undefined\)/)
  assert.match(src, /box\.addEventListener\('click', async e => \{\s*e\.stopPropagation\(\)/, 'a click in the box is never a click on a diagram node')
})

test('the rail and the page head count what keeps an agent waiting (questions and by-hand work), so they agree; the help says so', () => {
  const H = load().HumanReview
  assert.equal(H.waiting({ ask: 13, hand: 2, blocked: 1, ticket: 60 }), 15)
  assert.equal(H.waiting(undefined), 0)
  const src = read('human-review.js')
  assert.match(src, /const n = waiting\(data\?\.counts\)/)
  assert.match(src, /window\.Shell\?\.setWaiting\(n\)/)
  assert.doesNotMatch(read('notify.js'), /setWaiting\(/, 'one owner of the pill')
  assert.match(read('agents-page.js'), /questions and by-hand work/)
})

test('empty: one calm line; loading and a failure say so too', () => {
  const H = load().HumanReview
  const h = H.html({ items: [], counts: { total: 0, ask: 0, hand: 0, blocked: 0, ticket: 0 } })
  assert.match(h, /<p class="hr-empty">Nothing waits on you\. The agents can go on by themselves\.<\/p>/)
  assert.doesNotMatch(h, /hr-rows|hr-chips/)
  assert.match(H.html(null), /Loading…/)
  assert.match(H.html({ error: 'offline' }), /Could not load what waits on you: offline/)
})

/** Every box, arrow end and label of a real layout, as rectangles: nothing may reach into the Human review box. */
function occupied(lay) {
  const rects = lay.nodes.map(n => [n.x, n.y, n.x + n.w, n.y + n.h])
  for (const e of lay.edges) for (const m of `${e.d} ${e.head}`.matchAll(/(-?\d+(?:\.\d+)?)[ ,](-?\d+(?:\.\d+)?)/g)) rects.push([+m[1], +m[2], +m[1], +m[2]])
  for (const l of lay.labels) rects.push([l.x - 60, l.y - 12, l.x + 60, l.y + 4])
  return rects
}

test('placed by the layout under every box, arrow and label, lined up left to right and the whole width top to bottom, with Planner and Security too', () => {
  const w = load()
  const base = { coordinatorLabel: 'Master', codingAgents: { a: 'Master', b: 'Agent 1', c: 'Agent 2', d: 'Agent 3' }, factory: { chat: { name: 'Independent' } }, pipeline: { qa: 'QA' } }
  const more = { ...base, pipeline: { qa: 'QA', planner: 'Planner', security: 'Security' } }
  for (const config of [base, more]) {
    for (const width of [1440 - 120, 1024 - 120, 390 - 32]) {
      const lay = w.PipelineLayout.layout(pipelineGraph(config), { width, rows: 4 })
      const s = w.HumanReview.spot(lay)
      if (lay.dir === 'TB') assert.deepEqual([s.x, s.w], [0, Math.floor(lay.width)], `the whole width on a phone at ${width}`)
      else {
        assert.equal(s.x, Math.min(...lay.nodes.map(n => n.x)), `left edge on the boxes at ${width}`)
        assert.equal(s.x + s.w, Math.max(...lay.nodes.map(n => n.x + n.w)), `right edge on the boxes at ${width}`)
      }
      assert.ok(s.y >= lay.height, `below the whole layout at ${width}`)
      for (const [, , , y2] of occupied(lay)) assert.ok(y2 < s.y, `nothing drawn reaches into the box at ${width} (y ${y2} vs ${s.y})`)
    }
  }
  const phone = w.PipelineLayout.layout(pipelineGraph(base), { width: 358, rows: 4 })
  assert.equal(phone.dir, 'TB')
  assert.ok(w.HumanReview.spot(phone).w >= 350, 'never squeezed to the middle boxes on a phone (QA measured 244 px)')
})

test('Home says what needs you now, the tickets apart, and links to the box; or that nothing does', () => {
  const H = load().HumanReview
  const h = H.homeHtml({ counts: { total: 75, ask: 13, hand: 2, blocked: 0, ticket: 60 } })
  assert.match(text(h), /^15 things need you now 13 questions, 2 by-hand tasks 60 tickets only you can do Open Human review$/)
  assert.match(h, /<a class="link" href="#\/agents\?human" data-hr-show>Open Human review<\/a>/)
  assert.match(text(H.homeHtml({ counts: { total: 5, ask: 0, hand: 0, blocked: 0, ticket: 5 } })), /^Nothing blocks an agent 5 tickets only you can do/)
  assert.match(H.homeHtml({ counts: { total: 0 } }), /Nothing needs you right now\./)
  assert.equal(H.homeHtml(null), '')
})

test('wired: one line in pipeline-view.js, the box tall when the screen has room but never past it, loaded, checked', () => {
  const view = read('pipeline-view.js')
  assert.match(view, /window\.HumanReview\?\.place\(st\.canvas, lay\)/)
  // pipeline-view.js reads the box twice: it places it, and the Human task box shows its counts (pipeline-human.js)
  assert.equal(view.split('HumanReview').length - 1, 2)
  assert.match(view, /humanReview \? window\.HumanReview\?\.data\?\.counts \|\| null : undefined/)
  // the LIST is still no node and no step of any route: the graph's own Human task box (id human) points at it
  const graph = fs.readFileSync(path.join(HERE, '..', 'pipeline.mjs'), 'utf8')
  assert.doesNotMatch(graph, /Human review/, 'the list is not a node or an edge of any route')
  assert.match(graph, /\{ id: 'human', kind: 'step', label: 'Human task', role: 'human' \}/)
  const css = read('human.css')
  assert.match(css, /\.hr-box \{ position: absolute;/)
  assert.match(css, /border-left: 3px solid var\(--warn\)/)
  assert.match(css, /max-height: clamp\(340px, calc\(100vh - var\(--header-h\) - 56px\), 760px\)/, 'about five questions at 1440 by 900, the rows scroll inside')
  const html = read('index.html')
  assert.match(html, /<script src="human-review.js"><\/script>/)
  assert.ok(JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).checkList.includes('node --check public/human-review.js'))
})

// ═══ regression: the box must not shrink the diagram while the Agents page is hidden ═══

/** human-review.js with a tiny fake DOM: enough for place() and fit(), and a ResizeObserver the test fires. */
function loadDom() {
  const made = []
  const el = () => {
    const e = {
      style: {}, innerHTML: '', className: '', dataset: {}, offsetHeight: 0, parentNode: null, isConnected: true,
      setAttribute() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], contains: () => false,
      appendChild(c) { c.parentNode = this }, insertAdjacentHTML() {},
    }
    made.push(e)
    return e
  }
  const observers = []
  class ResizeObserver { constructor(fn) { observers.push(fn) } observe() {} }
  const document = { createElement: el, addEventListener() {}, getElementById: () => null, querySelector: () => null, activeElement: null, dispatchEvent() {} }
  const window = { document, ResizeObserver, Shell: { ago: () => '', onRoute() {}, setWaiting() {} }, FlowBoard: { askControls: () => '' }, localStorage: { getItem: () => null, setItem() {} } }
  vm.runInNewContext(read('human-review.js'), { window, document, fetch: () => new Promise(() => {}), setInterval: () => 1, CSS: { escape: s => s }, ResizeObserver, CustomEvent: class {} })
  return { H: window.HumanReview, box: made[0], fire: () => observers.forEach(fn => fn()) }
}

test('a hidden page (the box measures 0) leaves the diagram height alone, and the box fits again once it shows (Agents page clipped bug)', () => {
  const { H, box, fire } = loadDom()
  const canvas = { style: {}, appendChild(c) { c.parentNode = this } }
  const lay = { nodes: [{ x: 10, y: 0, w: 100, h: 50 }], width: 400, height: 300 }
  box.offsetHeight = 200
  H.place(canvas, lay)
  assert.equal(canvas.style.height, '516px', 'the layout (300) + gap (6) + the box (200) + bottom (10)')
  box.offsetHeight = 0 // the Agents page is hidden while a poll redraws the box
  H.place(canvas, lay)
  assert.equal(canvas.style.height, '516px', 'not shrunk to a strip')
  box.offsetHeight = 180 // back on the Agents page: the box has its size again
  fire()
  assert.equal(canvas.style.height, '496px')
})
