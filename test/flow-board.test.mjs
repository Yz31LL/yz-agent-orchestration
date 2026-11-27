// Tests for public/flow-board.js, the pure pieces of the Flows board (flows.js
// draws them): a card shows only the title, one line of story, a thin progress
// bar, one state chip and the agent; and the ask controls the Human review box uses, without the
// rows of the flow that is open. Browser script, run in a vm with a bare window.
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
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-board-test-'))
const { derive, DATA_DIR } = await import('../flows.mjs')
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))

const window = {}
for (const f of ['shell.js', 'terms.js', 'flow-route.js', 'flow-board.js']) vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), { window })
const B = window.FlowBoard
const { pipelineGraph } = await import('../pipeline.mjs')
const { withRoute } = await import('../flow-route.mjs')
const GRAPH = pipelineGraph({ coordinatorLabel: 'Master', codingAgents: { a: 'Agent 3' }, pipeline: { qa: 'QA' } })

const DARK = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))
const NOVIS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'no-visual.json'), 'utf8'))
const fx = (base, edit = () => {}) => {
  const f = structuredClone(base)
  edit(f)
  f.derived = derive(f)
  return f
}
const answered = f => { for (const n of f.nodes) if (n.type === 'ask') Object.assign(n, { answer: 'yes', answeredAt: '2026-11-12T10:00:00Z' }) }
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
const MERGE = { head: 'feature/dark-mode', base: 'dev', title: 'Add a dark mode', body: 'x', at: '2026-11-12T10:00:00Z' }
const PR = { url: 'https://example.com/acme/app/pull/12', number: 12, state: 'open', openedAt: '2026-11-12T11:00:00Z', checks: 'pending', checkedAt: null, error: null }

// ═══ the card ═══

test('a card is the title, one story line, the progress bar with done/total, one state chip, the agent, then Archive and Delete; nothing else', () => {
  const f = fx(DARK)
  const h = B.card(f)
  const { done, total } = f.derived.progress
  assert.equal(text(h), `${f.title} waiting on you ${text(B.storyLine(f))} ${f.agent} ${done}/${total} Archive Delete`)
  assert.match(h, /<div class="fl-bar"><i style="width:\d+%"><\/i><\/div>/)
  assert.doesNotMatch(h, /ABC-101|data-ticket|fl-env|fl-ago|ago|updated/, 'no tickets, env or updated on the card')
  assert.match(h, /data-open="dark-mode"/)
})

test('a card shows its route as a compact strip: the type, where it is now, every step from Request to Output, between the story and the bar', () => {
  const f = fx(DARK, x => { x.route = { type: 'build', steps: ['request', 'master', 'agent-3', 'qa', 'push', 'outcome'], at: '2026-11-12T08:00:00Z', by: 'Agent 3' } })
  Object.assign(f, withRoute(f, GRAPH))
  const h = B.card(f)
  assert.match(text(h), /build · at Agent 3 Request Master Agent 3 QA Push Output Agent 3 \d+\/\d+ Archive Delete$/)
  assert.ok(h.indexOf('rt-strip') > h.indexOf('fl-card-story') && h.indexOf('rt-strip') < h.indexOf('fl-prog'))
  assert.doesNotMatch(h, /route not set/)
  const legacy = fx(DARK)
  Object.assign(legacy, withRoute(legacy, GRAPH))
  assert.match(B.card(legacy), /route not set/, 'an open flow on a guessed route says so, quietly')
})

// ═══ which group a flow is in: by its route, not its status (QA attempt 2, 2026-11-24) ═══

const BUILD = { type: 'build', steps: ['request', 'master', 'agent-3', 'qa', 'push', 'outcome'], at: '2026-11-12T08:00:00Z', by: 'Agent 3' }
const QA = (more = {}) => ({ status: 'passed', attempt: 1, by: 'QA', at: '2026-11-12T11:00:00Z', commit: 'ab12cd3', ...more })
/** A flow as /api/flows sends it, with its route and progress. */
const routed = (edit = () => {}) => {
  const f = fx(DARK, x => { x.route = structuredClone(BUILD); answered(x); edit(x) })
  return Object.assign(f, withRoute(f, GRAPH))
}

test('groups: a done flow whose route is still on its way (QA passed, Push waiting) stays on the board; only a flow at the Output goes to Done', () => {
  const waiting = routed(x => { x.id = 'waiting'; x.status = 'done'; x.qa = QA() })
  const shipped = routed(x => { x.id = 'shipped'; x.status = 'done'; x.qa = QA({ pushedAt: '2026-11-12T11:05:00Z' }) })
  const open = routed(x => { x.id = 'open' })
  const blocked = routed(x => { x.id = 'blocked'; x.status = 'blocked' })
  const dropped = routed(x => { x.id = 'dropped'; x.status = 'dropped' })
  const bare = fx(DARK, x => { x.id = 'bare'; x.status = 'done' }) // no progress at all: its status decides
  const g = B.groups([waiting, shipped, open, blocked, dropped, bare])
  assert.deepEqual(g.live.map(f => f.id), ['waiting', 'open', 'blocked'])
  assert.deepEqual(g.done.map(f => f.id), ['shipped', 'bare'])
  assert.deepEqual(g.dropped.map(f => f.id), ['dropped'])
  assert.match(text(B.card(waiting)), /build · at Push Request Master Agent 3 QA Push Output/, 'its card says where it is: at Push')
  assert.match(B.card(waiting), /rt-s s-current[^"]*">Push</)
})

test('a small Done or Dropped card carries a compact strip with its type too, so no flow card lacks its path', () => {
  const shipped = routed(x => { x.status = 'done'; x.qa = QA({ pushedAt: '2026-11-12T11:05:00Z' }) })
  const h = B.small(shipped)
  assert.match(h, /<ol class="rt-strip rt-mini"/)
  assert.match(h, /<span class="rt-type">build<\/span>/)
  assert.equal((h.match(/rt-s s-done/g) || []).length, 6)
  assert.match(text(h), /^Add a dark mode toggle build Request Master Agent 3 QA Push Output Agent 3 · /)
  const dropped = routed(x => { x.status = 'dropped' })
  assert.match(B.small(dropped), /rt-s s-skipped/)
  assert.doesNotMatch(B.small(fx(DARK)), /rt-strip/, 'nothing without progress')
})

test('the board and its count group by FlowBoard.groups, never by status alone', () => {
  const flows = fs.readFileSync(path.join(PUBLIC, 'flows.js'), 'utf8')
  assert.match(flows, /const \{ live, done, dropped \} = window\.FlowBoard\.groups\(/)
  assert.doesNotMatch(flows, /const live = flows\.filter\(f => f\.status === 'open' \|\| f\.status === 'blocked'\)/)
  const page = fs.readFileSync(path.join(PUBLIC, 'flows-page.js'), 'utf8')
  assert.match(page, /window\.FlowBoard\.groups\(/, 'Flows · N counts the cards on the board')
  assert.match(fs.readFileSync(path.join(PUBLIC, 'flow-route.css'), 'utf8'), /\.rt-mini/)
})

test('with nothing to decide or blocked, the story line is the latest line the agent wrote, with its marked words as chips', () => {
  const f = fx(DARK, answered)
  const last = f.output.story.at(-1).did
  assert.equal(text(B.storyLine(f)), text(window.Terms.html(last)))
  assert.match(B.card(fx(DARK, g => { answered(g); g.output.story.push({ id: 's9', who: 'Agent 3', did: 'Ran the [smoke test] on dev' }) })), /Ran the <dfn[^>]*>smoke test<\/dfn> on dev/)
})

test('no story written, nothing to decide or blocked: the first line the dashboard made from the steps', () => {
  const f = fx(NOVIS, g => { answered(g); for (const n of g.nodes) if (n.status === 'blocked') n.status = 'todo' })
  assert.ok(f.derived.story.length && f.derived.story.every(l => l.derived))
  assert.equal(text(B.storyLine(f)), text(window.Terms.html(f.derived.story[0].did)))
})

test('a long story line is cut at a word boundary with an ellipsis, never inside a marked word', () => {
  const long = 'Moved every colour of the settings page into the [theme token] list so that one switch changes the whole page at once'
  const h = B.storyLine(fx(DARK, g => { answered(g); g.output.story = [{ id: 's1', who: 'Agent 3', did: long }] }))
  const t = text(h)
  assert.ok(t.endsWith('…'), t)
  assert.ok(t.length <= 81, t)
  const kept = t.slice(0, -1).trim()
  const plain = long.replace(/[[\]]/g, '')
  assert.ok(plain.startsWith(kept), kept)
  assert.equal(plain[kept.length], ' ', 'cut between two words')
  assert.doesNotMatch(kept, /\s(the|a|of|to|and|so|that)$/i, 'never after a short function word')
  assert.doesNotMatch(h, /\[|\]/, 'no half marked word left over')
})

test('the one state chip: waiting on you, blocked, merged, PR open, to send, done, or none', () => {
  const chip = edit => {
    const m = /<span class="fl-chip ([a-z-]+)">([^<]+)<\/span>/.exec(B.card(fx(NOVIS, edit)))
    return m ? `${m[2]}|${m[1]}` : null
  }
  assert.equal(chip(() => {}), 'waiting on you|warn')
  assert.equal(chip(f => { answered(f); f.status = 'blocked' }), 'blocked|bad')
  assert.equal(chip(f => { answered(f); f.output = { merge: { ...MERGE } } }), 'to send|neutral')
  assert.equal(chip(f => { answered(f); f.output = { merge: { ...MERGE }, pr: { ...PR } } }), 'PR open|accent')
  assert.equal(chip(f => { answered(f); f.status = 'done'; f.output = { merge: { ...MERGE }, pr: { ...PR, state: 'merged' } } }), 'merged|ok')
  assert.equal(chip(f => { answered(f); f.status = 'done' }), 'done|ok')
  assert.equal(chip(f => { answered(f) }), null)
  assert.equal((B.card(fx(NOVIS)).match(/fl-chip /g) || []).length, 1, 'only one chip')
})

test('the card escapes its title, story and agent', () => {
  const h = B.card(fx(DARK, f => { f.title = '<img src=x onerror=alert(1)>'; f.output.story.at(-1).did = '<script>x</script>' }))
  assert.doesNotMatch(h, /<img src=x|<script>/)
})

test('a live flow with by-hand steps not all ticked says yours by hand, after waiting on you; ticked or finished, it does not', () => {
  const steps = [{ id: 'h1', do: 'x', expect: 'y', done: null }]
  assert.deepEqual(JSON.parse(JSON.stringify(B.state({ status: 'open', hand: { steps } }))), { word: 'yours by hand', cls: 'warn' })
  assert.equal(B.state({ status: 'open', hand: { steps: [{ ...steps[0], done: { by: 'you', at: 'x' } }] } }), null)
  assert.equal(B.state({ status: 'done', hand: { steps } }).word, 'done')
  assert.equal(B.state({ status: 'open', derived: { waiting: ['n1'] }, hand: { steps } }).word, 'waiting on you')
})

// ═══ the ask controls (the Human review box) ═══

test('askControls: buttons named by what yes and no mean on a yes or no ask, a text field with a kept value on a text one; no strip rows any more', () => {
  const f = { id: 'dark-mode' }
  assert.match(B.askControls(f, { id: 'n3', kind: 'yesno', yes: 'Ship <it>', no: 'Wait' }), /<button type="button" class="fl-yes" data-answer="yes" data-node="n3" title="Yes: Ship &lt;it&gt;">Ship &lt;it&gt;<\/button>/)
  assert.match(B.askControls(f, { id: 'n4', kind: 'text' }, 'hr'), /<form class="fl-text" data-text="n4"><input name="answer" data-key="hr:dark-mode:n4"/)
  assert.equal(B.stripRows, undefined)
  assert.equal(B.stripRow, undefined)
})

test('fit cuts a story line again, a word at a time, until it fits its card, never inside a word', () => {
  const line = 'Checked the toggle in the browser with screenshots of every step'
  const el = { dataset: { line }, innerHTML: B.clip(line), clientWidth: 200, get scrollWidth() { return this.innerHTML.replace(/<[^>]*>/g, '').length * 7 } }
  B.fit({ querySelectorAll: () => [el] })
  const t = el.innerHTML.replace(/<[^>]*>/g, '')
  assert.ok(t.length * 7 <= 201, t)
  assert.ok(t.endsWith('…'))
  assert.equal(line[t.length - 1], ' ', `cut between words: ${t}`)
})
