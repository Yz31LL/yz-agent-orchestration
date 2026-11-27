// Tests for the phone's Agents tab (public/phone-agents.js): the pipeline as a vertical list of its boxes, each with
// the agent's state and the flows standing there as chips, the alerts and the open pull requests on top, and the
// read-only flow sheet. Run in a vm like the other browser files. Every field comes from agents, tickets or
// transcripts: HOSTILE, so every one is tried with markup that would run if it were not escaped.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')
const ctx = vm.createContext({ window: {} })
for (const f of ['phone-state.js', 'phone-text.js', 'phone-chat.js', 'phone-view.js', 'phone-agents.js']) vm.runInContext(read(f), ctx)
const A = ctx.window.PhoneAgents
const V = ctx.window.PhoneView
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
/** A real handler attribute: quoted values are emptied first (a raw quote never survives esc). */
const handlerIn = h => /<[^>]*\son[a-z]+\s*=/i.test(h.replace(/"[^"]*"/g, '""'))

const SUMMARY = { builtAt: '2026-11-26T10:00:00.000Z', coordinator: 'Master', needs: { total: 3, asks: 1, hands: 1, outputs: 1 }, finishedToday: 2 }
const box = (label, role, kind, state, flows = [], more = 0) => ({ id: label.toLowerCase().replace(/\W+/g, '-'), label, role, kind, state, flows, more })
const ORCH = {
  builtAt: '2026-11-26T10:00:00.000Z', agentsKnown: true,
  boxes: [
    box('Request', 'request', 'start', null), box('Master', 'coordinator', 'agent', 'busy'),
    box('Agent 1', 'producer', 'agent', 'busy', [{ id: 'login', title: 'Login page', word: 'Working', tone: '' }, { id: 'pay', title: 'Payments', word: 'Sent back', tone: 'bad' }], 2),
    box('Agent 2', 'producer', 'agent', 'none'), box('QA', 'qa', 'agent', 'idle', [{ id: 'search', title: 'Search box', word: 'Being tested', tone: '' }]),
    box('Human task', 'human', 'step', null), box('Push', 'push', 'step', null), box('Output', 'outcome', 'end', null),
  ],
  others: [{ label: 'Helper', state: 'idle' }],
  alerts: { count: 3, lines: ['Login page has stood at QA for 3 hours.', 'Agent 2 used tokens fast.'] },
  prs: [{ title: 'Add the login page', url: 'https://github.com/o/r/pull/12', number: 12 }],
}

test('the tab opens with what needs you, the alerts in one line each, and the open pull requests as links', () => {
  const h = A.view(ORCH, SUMMARY, Date.parse('2026-11-26T12:00:00Z'))
  assert.match(text(h), /^3 things need you/)
  assert.match(h, /data-ph-tab="needs"><span class="ph-count-n">1<\/span>/)
  assert.match(text(h), /3 alerts Login page has stood at QA for 3 hours\. Agent 2 used tokens fast\. 1 more at the PC\./)
  assert.ok(h.includes('<a class="ph-pr-link" href="https://github.com/o/r/pull/12" target="_blank" rel="noopener noreferrer">Add the login page</a>'))
  assert.match(text(h), /Finished today: 2/)
})

test('the pipeline: one row per box in the order given, each agent with a dot and a word, the fixed steps without', () => {
  const h = A.view(ORCH, SUMMARY)
  assert.deepEqual([...h.matchAll(/<span class="ph-box-name">([^<]*)<\/span>/g)].map(m => m[1]), ['Request', 'Master', 'Agent 1', 'Agent 2', 'QA', 'Human task', 'Push', 'Output'])
  assert.match(h, /Agent 1<\/span><span class="ph-state is-busy"><span class="ph-dot" aria-hidden="true"><\/span>Busy<\/span>/)
  assert.match(h, /Agent 2<\/span><span class="ph-state is-none"><span class="ph-dot" aria-hidden="true"><\/span>No session<\/span>/)
  assert.match(h, /QA<\/span><span class="ph-state is-idle"><span class="ph-dot" aria-hidden="true"><\/span>Idle<\/span>/)
  assert.doesNotMatch(h, /Request<\/span><span class="ph-state/)
  assert.match(text(h), /Other sessions Helper Idle/)
})

test('each flow standing at a box is a chip that opens its sheet; flows past what the phone was sent are said in words', () => {
  const h = A.view(ORCH, SUMMARY)
  assert.match(h, /<button type="button" class="ph-chip" data-ph-flow="login"><span class="ph-chip-title">Login page<\/span><span class="ph-chip-word">Working<\/span><\/button>/)
  assert.match(h, /class="ph-chip t-bad" data-ph-flow="pay"/)
  assert.match(text(h), /2 more at the PC/)
})

test('while the PC still gathers the agents, no state is guessed; with nothing loaded yet, Loading', () => {
  const h = A.view({ ...ORCH, agentsKnown: false, others: [], boxes: ORCH.boxes.map(b => ({ ...b, state: null })) }, SUMMARY)
  assert.doesNotMatch(h, /class="ph-state/)
  assert.match(text(h), /still gathering what the agents are doing/)
  assert.match(text(A.view(null, null)), /Loading/)
  assert.doesNotMatch(A.view({ ...ORCH, alerts: null, prs: [] }, SUMMARY), /ph-alerts|ph-prs/)
  assert.match(text(A.view({ ...ORCH, alerts: { count: 0, lines: [] } }, SUMMARY)), /No alerts/)
})

const SHEET = {
  id: 'pay', title: 'Payments', tickets: ['FLA-12', 'FLA-13'], where: 'Sent back at Agent 1', type: 'build',
  route: [{ label: 'Request', state: 'done' }, { label: 'Master', state: 'done' }, { label: 'Agent 1', state: 'current' }, { label: 'QA', state: 'upcoming' }, { label: 'Human task', state: 'skipped' }],
  story: [{ who: 'Agent 1', did: 'Built the form.', why: 'You asked.' }],
  qa: { word: 'Failed', attempt: 2, at: '2026-11-26T09:00:00.000Z', summary: 'The button does nothing.' },
  asks: [{ flowId: 'pay', nodeId: 'a1', flowTitle: 'Payments', agent: 'Agent 1', question: 'Use Stripe?', why: 'Cheaper.', kind: 'yesno', yes: 'Stripe', no: 'PayPal' }],
  pr: { url: 'https://github.com/o/r/pull/12', number: 12, state: 'open' },
}

test('the flow sheet: title, tickets, where it stands, the route line, its questions with the answer buttons, QA, story, pull request', () => {
  const h = A.sheet({ data: SHEET }, {})
  assert.match(h, /role="dialog" aria-modal="true" aria-labelledby="phSheetTitle"/)
  assert.match(text(h), /Payments/)
  assert.match(text(h), /FLA-12 · FLA-13 · Code change/, 'the kind in words, never the internal route type')
  assert.match(text(h), /Sent back at Agent 1/)
  assert.deepEqual([...h.matchAll(/<li class="ph-step-(\w+)"/g)].map(m => m[1]), ['done', 'done', 'current', 'upcoming', 'skipped'])
  assert.match(h, /data-ph-answer="yes" data-flow="pay" data-node="a1">Yes</, 'the same answer buttons as Needs you')
  assert.match(text(h), /Last QA Failed · attempt 2/)
  assert.match(text(h), /The button does nothing\./)
  assert.match(text(h), /Agent 1 Built the form\. You asked\./)
  assert.ok(h.includes('<button type="button" class="ph-pr-open is-inline" data-ph-pr="pay"><span class="ph-pr-open-title">Pull request #12</span></button>'), 'here by default: the pull request sheet')
  assert.ok(A.sheet({ data: SHEET }, { prLinks: 'github' }).includes('<a class="ph-pr-link" href="https://github.com/o/r/pull/12" target="_blank" rel="noopener noreferrer">Pull request #12</a>'), 'or GitHub, as chosen')
  assert.match(h, /data-ph-sheet-close/)
})

test('the sheet while loading, after a refusal, and with nothing optional', () => {
  assert.match(text(A.sheet({ loading: true }, {})), /Loading/)
  assert.match(text(A.sheet({ error: 'That flow is in the archive now: open it at the PC.' }, {})), /in the archive now/)
  const bare = A.sheet({ data: { ...SHEET, tickets: [], type: '', story: [], qa: null, asks: [], pr: null } }, {})
  assert.doesNotMatch(bare, /Last QA|ph-pr-link|data-ph-pr|data-ph-answer/)
})

test('a draft pull request on the sheet says so', () => {
  const h = A.sheet({ data: { ...SHEET, pr: { url: 'https://github.com/o/r/pull/31', number: 31, state: 'draft' } } }, {})
  assert.ok(h.includes('>Pull request #31, a draft</span></button>'))
  assert.ok(A.sheet({ data: { ...SHEET, pr: { url: 'https://github.com/o/r/pull/31', number: 31, state: 'draft' } } }, { prLinks: 'github' }).includes('>Pull request #31, a draft</a>'))
  assert.doesNotMatch(A.sheet({ data: SHEET }, {}), /a draft/)
})

test('the alerts head says the kinds in words, as the desktop line does', () => {
  const h = A.view({ ...ORCH, alerts: { count: 3, kinds: 'Master holds 8 flows longer than usual · 1 flow far past its usual time', lines: ['Master holds 8 flows longer than usual for their step.'] } }, SUMMARY)
  assert.match(text(h), /3 alerts · Master holds 8 flows longer than usual · 1 flow far past its usual time Master holds 8 flows/)
  assert.doesNotMatch(text(A.view(ORCH, SUMMARY)), /alerts ·/, 'no kinds, no dot')
})

test('hostile text in every field of the tab and the sheet is escaped; no inline style, handler or script', () => {
  const evil = '"><script>alert(1)</script><img src=x onerror=alert(1)>'
  const orch = {
    ...ORCH,
    boxes: ORCH.boxes.map(b => ({ ...b, id: evil, label: evil, flows: [{ id: evil, title: evil, word: evil, tone: evil }] })),
    others: [{ label: evil, state: evil }], alerts: { count: 1, kinds: evil, lines: [evil] },
    prs: [{ title: evil, url: 'javascript:alert(1)', number: 1 }, { title: evil, url: `https://github.com/o/r/pull/1"${evil}`, number: 1 }],
  }
  const sheet = { ...SHEET, id: evil, title: evil, tickets: [evil], where: evil, type: evil, route: [{ label: evil, state: evil }], story: [{ who: evil, did: evil, why: evil }], qa: { word: evil, attempt: evil, at: evil, summary: evil },
    asks: [{ ...SHEET.asks[0], question: evil, why: evil, yes: evil, no: evil, flowTitle: evil, agent: evil }], pr: { url: 'javascript:alert(1)', number: evil, state: evil } }
  for (const h of [A.view(orch, { ...SUMMARY, coordinator: evil }), A.sheet({ data: sheet }, {}), A.sheet({ error: evil }, {})]) {
    assert.doesNotMatch(h, /<script|<img|\sstyle=/i)
    assert.equal(handlerIn(h), false)
    assert.doesNotMatch(h, /href="javascript/i)
    assert.doesNotMatch(h, /href="[^"]*&quot;/, 'a link is only ever a plain github.com address')
  }
})

test('the bottom bar: Agents first (Now folded into it), then Needs you, Outputs and the coordinator', () => {
  const h = V.nav('agents', SUMMARY, 'Master')
  assert.deepEqual([...h.matchAll(/data-ph-tab="([^"]+)"/g)].map(m => m[1]), ['agents', 'needs', 'outputs', 'talk'])
  assert.match(text(h), /^Agents Needs you 2 Outputs 1 Master$/)
  assert.equal(V.tabTitle('agents', 'Master'), 'Agents')
  assert.deepEqual([...ctx.window.PhoneState.TABS], ['agents', 'needs', 'outputs', 'talk'])
})

// ═══ the nits QA found (2026-11-26) ═══

test('the sheet says what kind of request in words: Code change, Question, Review; an unknown type is left out', () => {
  const kick = type => text(A.sheet({ data: { ...SHEET, type } }, {}))
  assert.ok(kick('build').includes('FLA-12 · FLA-13 · Code change'))
  assert.ok(kick('ask').includes('FLA-12 · FLA-13 · Question'))
  assert.ok(kick('review').includes('FLA-12 · FLA-13 · Review'))
  assert.ok(kick('odd').includes('FLA-12 · FLA-13 Sent back'), 'an unknown type: nothing after the tickets')
  assert.doesNotMatch(text(A.sheet({ data: { ...SHEET, type: 'odd' } }, {})), /odd/)
  assert.doesNotMatch(text(A.sheet({ data: { ...SHEET, type: 'build' } }, {})), /· build/)
})

test('the sheet heading takes the focus: it can be focused by script, not by Tab', () => {
  assert.match(A.sheet({ data: SHEET }, {}), /<h2 id="phSheetTitle" class="ph-sheet-title" tabindex="-1">/)
  assert.match(A.sheet({ loading: true }, {}), /id="phSheetTitle"[^>]*tabindex="-1"/)
})

test('a box with more than six flows: six chips and a +N more button that shows the rest in the box, and back', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: 'f' + i, title: 'Flow ' + i, word: 'Working', tone: '' }))
  const orch = { ...ORCH, boxes: [box('Agent 1', 'producer', 'agent', 'busy', many, 0)] }
  const shut = A.view(orch, SUMMARY, Date.now(), {})
  assert.equal((shut.match(/data-ph-flow=/g) || []).length, 6)
  assert.ok(shut.includes('<button type="button" class="ph-more" data-ph-box-more="agent-1" aria-expanded="false">+3 more</button>'))
  const open = A.view(orch, SUMMARY, Date.now(), { openBoxes: ['agent-1'] })
  assert.equal((open.match(/data-ph-flow=/g) || []).length, 9)
  assert.ok(open.includes('data-ph-box-more="agent-1" aria-expanded="true">Show fewer</button>'))
  const beyond = A.view({ ...orch, boxes: [box('Agent 1', 'producer', 'agent', 'busy', many, 4)] }, SUMMARY, Date.now(), { openBoxes: ['agent-1'] })
  assert.match(text(beyond), /4 more at the PC/, 'past what the phone was sent: said in words')
  assert.doesNotMatch(A.view(ORCH, SUMMARY), /data-ph-box-more/, 'six or fewer: no button')
})
