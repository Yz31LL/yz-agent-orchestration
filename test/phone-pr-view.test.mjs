// Tests for the phone's pull request sheet and its Options sheet (public/phone-pr.js), run in a vm like the other
// browser files, and for the two ways the Agents tab opens a pull request (public/phone-agents.js): here, or on
// GitHub. Every field of a pull request comes from GitHub, so it is HOSTILE: each one is tried with markup that would
// run if it were not escaped, and the description and comments must go through the chat's own safe renderer.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')
const ctx = vm.createContext({ window: {} })
for (const f of ['phone-state.js', 'phone-text.js', 'phone-chat.js', 'phone-view.js', 'phone-pr.js', 'phone-agents.js']) vm.runInContext(read(f), ctx)
const P = ctx.window.PhonePr
const A = ctx.window.PhoneAgents
const X = ctx.window.PhoneText
const text = h => h.replace(/<wbr>/g, '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
const plain = v => JSON.parse(JSON.stringify(v))
/** A real handler attribute: quoted values are emptied first (a raw quote never survives esc). */
const handlerIn = h => /<[^>]*\son[a-z]+\s*=/i.test(h.replace(/"[^"]*"/g, '""'))
const NOW = Date.parse('2026-11-26T12:00:00Z')

const PR = (over = {}) => ({
  url: 'https://github.com/acme/shop/pull/12', label: 'acme/shop #12', flow: { id: 'login-page', title: 'Login page' },
  title: 'Add the login page', state: 'open', author: 'alice', createdAt: '2026-11-26T09:00:00Z', updatedAt: '2026-11-26T11:00:00Z',
  base: 'dev', head: 'feat/login',
  checks: { word: 'failing', counts: { passed: 22, failing: 1, running: 1, skipped: 0 }, summary: '22 passed, 1 failing, 1 running', list: [{ name: 'flutter test', state: 'failing' }, { name: 'lint', state: 'running' }], more: 0 },
  review: { decision: 'required', requested: ['bob'], approvedBy: ['dave'], changesBy: [] },
  body: { text: 'It adds **the login page**.\n\n- one\n- two', cut: false },
  files: {
    count: 2, additions: 340, deletions: 58, cut: false, linesCut: false,
    list: [
      { path: 'src/login.js', additions: 30, deletions: 2, patch: ['@@ -1,2 +1,3 @@', ' keep', '-old line', '+new line'], cut: false, why: null },
      { path: 'logo.png', additions: 0, deletions: 0, patch: null, cut: false, why: 'binary' },
    ],
  },
  conversation: { items: [{ kind: 'comment', author: 'carol', at: '2026-11-26T10:00:00Z', state: null, text: 'Looks **close**.', cut: false }, { kind: 'review', author: 'dave', at: '2026-11-26T11:00:00Z', state: 'approved', text: '', cut: false }], total: 2, cut: false },
  checkedAt: '2026-11-26T11:59:00Z', stale: false, problem: null, ...over,
})
const sheet = (data, ui = {}) => P.sheet({ flow: 'login-page', data }, ui, NOW)

// ═══ the top of the sheet ═══

test('the sheet: the title as its heading, repo and number, Open or Draft, the branch into the base, the author and age', () => {
  const h = sheet(PR())
  assert.match(h, /role="dialog" aria-modal="true" aria-labelledby="phSheetTitle"/)
  assert.match(h, /<h2 id="phSheetTitle" class="ph-sheet-title" tabindex="-1">Add the login page<\/h2>/)
  const t = text(h)
  assert.match(t, /acme\/shop #12/)
  assert.match(t, /Open feat\/login into dev/)
  const S = ctx.window.PhoneState
  assert.ok(t.includes(`By alice · opened ${S.when('2026-11-26T09:00:00Z', NOW)}`), t)
  assert.match(t, /Read from GitHub at \d\d:\d\d/)
  assert.match(h, /<button type="button" class="link ph-pr-refresh" data-ph-pr-refresh>Refresh<\/button>/)
  assert.match(text(sheet(PR({ state: 'draft' }))), /Draft feat\/login into dev/)
  assert.match(text(sheet(PR({ state: 'merged' }))), /Merged/)
})

test('when it was opened is said as the phone says every time: a clock time today, a date before; none when unknown', () => {
  const S = ctx.window.PhoneState
  assert.ok(text(sheet(PR({ createdAt: '2026-11-20T09:00:00Z' }))).includes(`opened ${S.when('2026-11-20T09:00:00Z', NOW)}`))
  assert.doesNotMatch(text(sheet(PR({ createdAt: null }))), /opened/)
  assert.equal('ago' in P, false, 'no relative-time helper of its own (test/copy.test.mjs)')
})

test('a stale copy or a problem says so in one line above the rest', () => {
  const h = sheet(PR({ stale: true, problem: 'Could not read GitHub just now: this is the copy read before.' }))
  assert.match(h, /<p class="ph-note ph-pr-problem" role="status">Could not read GitHub just now: this is the copy read before\.<\/p>/)
  assert.doesNotMatch(sheet(PR()), /ph-pr-problem/)
})

// ═══ checks and review ═══

test('Checks: the plain summary with its word, then each failing or running check by name', () => {
  const t = text(sheet(PR()))
  assert.match(t, /Checks Failing: 22 passed, 1 failing, 1 running flutter test Failing lint Running/)
  assert.match(text(sheet(PR({ checks: { word: 'passing', counts: { passed: 3 }, summary: '3 passed', list: [], more: 0 } }))), /Checks Passing: 3 passed/)
  assert.match(text(sheet(PR({ checks: { word: 'none', counts: {}, summary: 'No checks.', list: [], more: 0 } }))), /Checks No checks\./)
  assert.match(text(sheet(PR({ checks: { ...PR().checks, more: 4 } }))), /4 more at GitHub\./)
})

test('Review: requested of whom, approved by whom, changes asked for by whom; nothing yet said plainly', () => {
  assert.match(text(sheet(PR())), /Review Review requested from bob\. Approved by dave\./)
  assert.match(text(sheet(PR({ review: { decision: 'changes', requested: [], approvedBy: [], changesBy: ['carol', 'erin'] } }))), /Changes asked for by carol and erin\./)
  assert.match(text(sheet(PR({ review: { decision: 'required', requested: [], approvedBy: [], changesBy: [] } }))), /A review is needed before it can merge\./)
  assert.match(text(sheet(PR({ review: { decision: 'none', requested: [], approvedBy: [], changesBy: [] } }))), /No review yet\./)
  assert.equal(P.names(['a', 'b', 'c']), 'a, b and c')
})

// ═══ the description: the chat's own safe renderer, folded ═══

test('the description is rendered with the SAME safe renderer as the chat (PhoneText.render)', () => {
  const body = 'Read **this**. See https://github.com/acme/shop/issues/3 and [bad](javascript:alert(1)) and ![img](https://evil.example/x.png) <img src=x onerror=alert(1)>'
  const h = sheet(PR({ body: { text: body, cut: false } }))
  assert.ok(h.includes(X.render(body)), 'exactly what the chat would draw')
  assert.match(h, /<a href="https:\/\/github\.com\/acme\/shop\/issues\/3" target="_blank" rel="noopener noreferrer">/)
  assert.doesNotMatch(h, /href="javascript/)
  assert.doesNotMatch(h, /<img/)
  assert.equal(handlerIn(h), false)
})

test('a long description folds after 40 lines with Show more; open, it shows all with Show less', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n')
  const folded = sheet(PR({ body: { text: lines, cut: false } }))
  assert.match(text(folded), /line 40/)
  assert.doesNotMatch(text(folded), /line 41\b/)
  assert.match(folded, /<button type="button" class="ph-more" data-ph-pr-body aria-expanded="false" aria-controls="phPrDesc">Show more<\/button>/)
  const open = sheet(PR({ body: { text: lines, cut: false } }), { bodyOpen: true })
  assert.match(text(open), /line 100/)
  assert.match(open, /aria-expanded="true" aria-controls="phPrDesc">Show less<\/button>/)
  assert.doesNotMatch(sheet(PR()), /data-ph-pr-body/, 'a short one has no button')
})

test('the fold never leaves a code block open: a fence cut in half is closed', () => {
  const body = ['Intro', '```', ...Array.from({ length: 60 }, (_, i) => `code ${i}`), '```', 'After'].join('\n')
  const f = P.fold(body, 40)
  assert.equal(f.folded, true)
  assert.equal(f.text.split('\n').length, 41)
  assert.match(f.text, /```$/)
  assert.match(X.render(f.text), /<pre><code>/)
  assert.deepEqual(plain(P.fold('a\nb', 40)), { text: 'a\nb', folded: false })
})

test('an empty description says so; a cut one says the rest is on GitHub', () => {
  assert.match(text(sheet(PR({ body: { text: '', cut: false } }))), /Description No description\./)
  assert.match(text(sheet(PR({ body: { text: 'x', cut: true } }))), /The description is longer than 20,000 characters: the rest is on GitHub\./)
})

// ═══ files changed ═══

test('Files changed: the totals, and each file a button with its counts that unfolds its patch', () => {
  const h = sheet(PR())
  assert.match(text(h), /Files changed 2 files, \+340 −58/)
  assert.match(h, /<button type="button" class="ph-pr-file" data-ph-pr-file="0" aria-expanded="false" aria-controls="phPatch0">/)
  assert.match(text(h), /src\/login\.js \+30 −2/)
  assert.match(h, /<span class="ph-pr-path">src\/<wbr>login\.js<\/span>/, 'a long path breaks after a slash')
  assert.doesNotMatch(h, /ph-patch/, 'folded until tapped')
  const open = sheet(PR(), { files: [0] })
  assert.match(open, /aria-expanded="true" aria-controls="phPatch0"/)
  assert.match(open, /<div class="ph-patch" id="phPatch0" data-ph-patch="0" role="region" aria-label="Changes in src\/login\.js" tabindex="0"><pre><code>/)
  // the + and − characters stay in the text: colour is not the only cue
  assert.match(open, /<span class="ph-ln is-hunk">@@ -1,2 \+1,3 @@<\/span>/)
  assert.match(open, /<span class="ph-ln">\s?keep<\/span>/)
  assert.match(open, /<span class="ph-ln is-del">-old line<\/span>/)
  assert.match(open, /<span class="ph-ln is-add">\+new line<\/span>/)
})

test('a file with no lines says why when unfolded', () => {
  const why = w => text(sheet(PR({ files: { ...PR().files, list: [{ path: 'x', additions: 0, deletions: 0, patch: null, cut: false, why: w }] } }), { files: [0] }))
  assert.match(why('binary'), /A binary file: nothing to show as text\./)
  assert.match(why('empty'), /No lines changed: it was renamed or its mode changed\./)
  assert.match(why('later'), /Not shown here: the changes above already run to 1,500 lines\. Open on GitHub to read this one\./)
  assert.match(why('missing'), /Its changes could not be read here\. Open on GitHub to see them\./)
})

test('every cut is said: 100 files of many, 300 lines of a file, the conversation', () => {
  const files = { ...PR().files, count: 240, cut: true, list: [{ ...PR().files.list[0], cut: true }] }
  const t = text(sheet(PR({ files }), { files: [0] }))
  assert.match(t, /240 files, \+340 −58/)
  assert.match(t, /Showing the first 1 of 240 files\. The rest are on GitHub\./)
  assert.match(t, /Cut at 300 lines: the rest of this file is on GitHub\./)
  assert.doesNotMatch(t, /stop at 1,500 lines/)
  assert.match(text(sheet(PR({ files: { ...files, linesCut: true } }))), /The changes shown here stop at 1,500 lines in all: the rest are on GitHub\./)
  const convo = { items: PR().conversation.items.map(i => ({ ...i, cut: true })), total: 45, cut: true }
  const c = text(sheet(PR({ conversation: convo })))
  assert.match(c, /The 2 latest of 45 shown\. The rest are on GitHub\./)
  assert.match(c, /Cut at 2,000 characters\./)
})

// ═══ conversation and the way out ═══

test('Conversation: newest last, who and when and what they did, each comment rendered safely', () => {
  const h = sheet(PR())
  const t = text(h)
  const S = ctx.window.PhoneState // the times are the phone's own clock
  assert.ok(t.includes(`Conversation carol · ${S.clock('2026-11-26T10:00:00Z')} · commented Looks close . dave · ${S.clock('2026-11-26T11:00:00Z')} · approved`), t)
  assert.ok(h.includes(X.render('Looks **close**.')))
  assert.match(text(sheet(PR({ conversation: { items: [], total: 0, cut: false } }))), /Conversation No comments yet\./)
  const changes = { items: [{ kind: 'review', author: '', at: null, state: 'changes', text: 'Fix it', cut: false }], total: 1, cut: false }
  assert.match(text(sheet(PR({ conversation: changes }))), /Someone · asked for changes Fix it/)
})

test('at the bottom: Open on GitHub in a new tab with no opener or referrer, and Open the flow', () => {
  const h = sheet(PR())
  assert.match(h, /<a class="ph-btn primary" href="https:\/\/github\.com\/acme\/shop\/pull\/12" target="_blank" rel="noopener noreferrer">Open on GitHub<\/a>/)
  assert.match(h, /<button type="button" class="ph-btn" data-ph-pr-flow="login-page">Open the flow<\/button>/)
  // a link the data merely claims is never drawn
  const odd = sheet(PR({ url: 'javascript:alert(1)//https://github.com/a/b/pull/1' }))
  assert.doesNotMatch(odd, /href="javascript/)
  assert.doesNotMatch(odd, /Open on GitHub<\/a>/)
})

test('loading, an error with the link GitHub gave, and the closed states', () => {
  assert.match(text(P.sheet({ flow: 'login-page', loading: true }, {}, NOW)), /Pull request Close Loading…/)
  const err = P.sheet({ flow: 'login-page', error: 'Could not read this pull request from GitHub just now.', url: 'https://github.com/acme/shop/pull/12' }, {}, NOW)
  assert.match(text(err), /Could not read this pull request from GitHub just now\./)
  assert.match(err, /href="https:\/\/github\.com\/acme\/shop\/pull\/12"/)
  assert.match(err, /data-ph-pr-flow="login-page"/)
  assert.match(text(P.sheet({ flow: 'x', data: PR(), loading: true }, {}, NOW)), /Reading…/)
})

// ═══ hostile text, every field ═══

test('markup in EVERY field is escaped: title, author, branches, check, reviewer, file name, patch, comment, description', () => {
  const x = '<img src=x onerror=alert(1)>'
  const q = '"><script>alert(1)</script>'
  const data = PR({
    title: x, author: x, base: q, head: x, label: x, state: 'toString',
    checks: { word: 'constructor', counts: { failing: 1 }, summary: x, list: [{ name: x, state: 'failing' }], more: 0 },
    review: { decision: x, requested: [x], approvedBy: [q], changesBy: [x] },
    body: { text: x + q, cut: false },
    files: { count: 1, additions: 1, deletions: 0, cut: false, linesCut: false, list: [{ path: x + q, additions: x, deletions: q, why: 'toString', patch: ['@@ x @@', `+${x}`, `-${q}`, ' </code></pre><script>alert(1)</script>'], cut: false, why: null }] },
    conversation: { items: [{ kind: x, author: x, at: x, state: x, text: x + q, cut: false }, { kind: 'review', author: 'a', at: null, state: 'valueOf', text: '', cut: false }], total: 1, cut: false },
    flow: { id: q, title: x }, checkedAt: x, problem: x, stale: true,
  })
  for (const h of [sheet(data, { files: [0], bodyOpen: true }), sheet(data)]) {
    assert.doesNotMatch(h, /<img|<script/i)
    assert.equal(handlerIn(h), false)
    assert.doesNotMatch(h, /\sstyle=/i)
    assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/)
    assert.doesNotMatch(h, /native code|function /, 'a word map never answers with an inherited key')
  }
  // an unfolded file whose why is not a known word says the plain missing line
  assert.match(text(sheet({ ...data, files: { ...data.files, list: [{ ...data.files.list[0], patch: null }] } }, { files: [0] })), /Its changes could not be read here/)
  // the flow id from the data is not a slug: no Open the flow button is drawn for it
  assert.doesNotMatch(sheet(data), /data-ph-pr-flow=/)
})

test('patch text goes in as text only: a line is never markup, whatever it holds', () => {
  const html = P.patch(['+<b>bold</b>', '-&amp;', ' plain'])
  assert.equal(html, '<span class="ph-ln is-add">+&lt;b&gt;bold&lt;/b&gt;</span><span class="ph-ln is-del">-&amp;amp;</span><span class="ph-ln"> plain</span>')
})

// ═══ the Options sheet ═══

test('Options: Open pull requests, here or on GitHub, as two radio buttons; the current one checked; kept per sign-in', () => {
  const h = P.options('here', {})
  assert.match(h, /role="dialog" aria-modal="true" aria-labelledby="phSheetTitle"/)
  assert.match(h, /<h2 id="phSheetTitle" class="ph-sheet-title" tabindex="-1">Options<\/h2>/)
  assert.match(h, /<fieldset class="ph-opt"><legend class="ph-h">Open pull requests<\/legend>/)
  assert.match(h, /<input type="radio" id="phPrefHere" name="phPrLinks" value="here" data-ph-pref checked>/)
  assert.match(h, /<input type="radio" id="phPrefGithub" name="phPrLinks" value="github" data-ph-pref>/)
  assert.match(text(h), /Here Read it on this page: checks, review, files and comments\. On GitHub Leave for GitHub in a new tab, as before\./)
  assert.match(text(h), /Kept until you sign out: the phone stores nothing itself\./)
  assert.match(P.options('github', {}), /value="github" data-ph-pref checked>/)
  assert.match(P.options('github', { busy: true, status: 'Saving…' }), /value="here" data-ph-pref disabled>/)
  assert.match(text(P.options('here', { status: 'Saved.' })), /Saved\./)
  assert.match(P.options('here', {}), /data-ph-options-close/)
})

test('the gear in the header opens Options and names itself for a screen reader', () => {
  const g = P.gear()
  assert.match(g, /^<button type="button" class="link ph-gear" data-ph-options aria-label="Options" aria-haspopup="dialog">/)
  assert.match(g, /<svg[^>]*aria-hidden="true"/)
})

test('the address can open a pull request sheet or Options, so a reload or a screenshot lands there', () => {
  assert.deepEqual(plain(P.routeOf('#pr=login-page')), { pr: 'login-page', options: false })
  assert.deepEqual(plain(P.routeOf('#options')), { pr: null, options: true })
  for (const bad of ['', '#pr=', '#pr=../x', '#pr=A B', '#pr=<img>', null, `#pr=${'a'.repeat(81)}`, '#talk']) assert.deepEqual(plain(P.routeOf(bad)), { pr: null, options: false }, String(bad))
  assert.equal(P.hashOf('login-page'), '#pr=login-page')
})

// ═══ where a pull request opens: here (a button) or on GitHub (a link), the user's choice ═══

const ORCH = {
  builtAt: '2026-11-26T10:00:00.000Z', agentsKnown: true, boxes: [], others: [], alerts: null,
  prs: [{ title: 'Add the login page', url: 'https://github.com/o/r/pull/12', number: 12, flow: 'login-page' }, { title: 'No flow', url: 'https://github.com/o/r/pull/13', number: 13, flow: null }],
}

test('the Agents tab: here (the default), a pull request is a button that opens the sheet; on GitHub, the link as before', () => {
  const here = A.view(ORCH, null, NOW, {})
  assert.match(here, /<button type="button" class="ph-pr-open" data-ph-pr="login-page"><span class="ph-pr-open-title">Add the login page<\/span><span class="ph-pr-open-n">#12<\/span><\/button>/)
  assert.match(here, /<a class="ph-pr-link" href="https:\/\/github\.com\/o\/r\/pull\/13" target="_blank" rel="noopener noreferrer">No flow<\/a>/, 'no flow: GitHub')
  const away = A.view(ORCH, null, NOW, { prLinks: 'github' })
  assert.doesNotMatch(away, /data-ph-pr=/)
  assert.ok(away.includes('<a class="ph-pr-link" href="https://github.com/o/r/pull/12" target="_blank" rel="noopener noreferrer">Add the login page</a>'))
})

test('the flow sheet: its pull request opens the sheet here, or GitHub when that is the choice', () => {
  const f = { id: 'login-page', title: 'Login page', tickets: [], where: 'Working at Agent 1', type: 'build', route: [], story: [], qa: null, asks: [], pr: { url: 'https://github.com/o/r/pull/12', number: 12, state: 'open' } }
  assert.match(A.sheet({ data: f }, {}), /<button type="button" class="ph-pr-open is-inline" data-ph-pr="login-page"><span class="ph-pr-open-title">Pull request #12<\/span><\/button>/)
  assert.match(A.sheet({ data: f }, { prLinks: 'github' }), /<a class="ph-pr-link" href="https:\/\/github\.com\/o\/r\/pull\/12"/)
  assert.match(A.sheet({ data: { ...f, pr: { ...f.pr, state: 'draft' } } }, {}), /Pull request #12, a draft/)
})

// ═══ the live half (public/phone-pr-live.js): state and network, with a stub page ═══

function live({ answers = {}, sheet = null } = {}) {
  const calls = []
  const hashes = []
  const win = { PhonePr: P, history: { replaceState: (_s, _t, h) => hashes.push(h) }, location: { hash: '' } }
  const c = vm.createContext({ window: win })
  vm.runInContext(read('phone-pr-live.js'), c)
  const st = { tab: 'agents', sheet, pr: null, options: null, ui: { prLinks: 'here' } }
  const drawn = []
  const opened = []
  const root = { querySelector: () => null, querySelectorAll: () => [] }
  const call = async (method, url, body) => (calls.push([method, url, body]), answers[`${method} ${url}`] || { status: 200, json: { title: 'x' } })
  const L = win.PhonePrLive.make({ root, st, call, draw: () => drawn.push(1), offline: 'Offline.', openFlow: id => opened.push(id), hashOfTab: () => '#agents' })
  return { L, st, calls, hashes, opened, win }
}
const el = attrs => ({ closest: sel => (Object.keys(attrs).some(k => sel === `[${k}]`) ? { getAttribute: k => attrs[k] } : null) })

test('live: a pull request is read by its flow id only, with a GET; the address names the sheet', async () => {
  const { L, st, calls, hashes } = live()
  await L.open('login-page')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'GET')
  assert.equal(calls[0][1], '/phone/api/pr?flow=login-page')
  assert.equal(calls[0][2], undefined, 'no body: nothing the page holds is sent')
  assert.equal(hashes.at(-1), '#pr=login-page')
  assert.deepEqual(plain(st.pr.data), { title: 'x' })
  assert.equal(st.pr.loading, false)
})

test('live: opened from a flow sheet, Close goes back to that sheet as it was; from the list, back to the tab', async () => {
  const flowSheet = { id: 'login-page', data: { id: 'login-page', title: 'Login page' } }
  const a = live({ sheet: flowSheet })
  await a.L.open('login-page')
  assert.equal(a.st.sheet, null, 'one sheet at a time')
  a.L.close()
  assert.equal(a.st.pr, null)
  assert.equal(a.st.sheet, flowSheet)
  assert.equal(a.hashes.at(-1), '#flow=login-page')
  const b = live()
  await b.L.open('login-page')
  b.L.close()
  assert.equal(b.st.sheet, null)
  assert.equal(b.hashes.at(-1), '#agents')
})

test('live: a failed Refresh keeps the copy on screen with the reason; a first failure shows the reason and the link', async () => {
  const a = live()
  await a.L.open('login-page')
  a.calls.length = 0
  const fail = live({ answers: { 'GET /phone/api/pr?flow=login-page': { status: 502, json: { error: 'Could not read this pull request from GitHub just now.', url: 'https://github.com/o/r/pull/1' } } } })
  await fail.L.open('login-page')
  assert.equal(fail.st.pr.data, null)
  assert.match(fail.st.pr.error, /Could not read/)
  assert.equal(fail.st.pr.url, 'https://github.com/o/r/pull/1')
  // a copy, then a failure: the copy stays
  fail.st.pr.data = { title: 'kept' }
  fail.st.pr.error = ''
  await fail.L.refresh()
  assert.deepEqual(plain(fail.st.pr.data), { title: 'kept' })
  assert.match(fail.st.pr.note, /Could not read/)
})

test('live: taps on a file and Show more fold and unfold; Open the flow goes to the flow sheet', async () => {
  const { L, st, opened } = live()
  await L.open('login-page')
  assert.equal(L.onClick(el({ 'data-ph-pr-file': '2' })), true)
  assert.deepEqual(plain(st.pr.files), [2])
  L.onClick(el({ 'data-ph-pr-file': '2' }))
  assert.deepEqual(plain(st.pr.files), [])
  L.onClick(el({ 'data-ph-pr-body': '' }))
  assert.equal(st.pr.bodyOpen, true)
  L.onClick(el({ 'data-ph-pr-flow': 'login-page' }))
  assert.equal(st.pr, null)
  assert.deepEqual(opened, ['login-page'])
  assert.equal(L.onClick(el({ 'data-ph-other': 'x' })), false)
})

test('live: the option is sent as { prLinks } alone, kept only once the PC says Saved, and Escape closes Options first', async () => {
  const { L, st, calls } = live({ answers: { 'POST /phone/api/prefs': { status: 200, json: { ok: true, prLinks: 'github' } } } })
  L.onClick(el({ 'data-ph-options': '' }))
  assert.ok(st.options)
  await L.onChange({ matches: () => true, value: 'github' })
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(plain(calls.at(-1)), ['POST', '/phone/api/prefs', { prLinks: 'github' }])
  assert.equal(st.ui.prLinks, 'github')
  assert.equal(st.options.status, 'Saved.')
  const refused = live({ answers: { 'POST /phone/api/prefs': { status: 400, json: { error: 'Only the pull request setting can be changed here.' } } } })
  refused.L.onClick(el({ 'data-ph-options': '' }))
  refused.L.onChange({ matches: () => true, value: 'github' })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(refused.st.ui.prLinks, 'here', 'unchanged when the PC refused')
  assert.match(refused.st.options.status, /Only/)
  assert.equal(L.onEscape(), true)
  assert.equal(st.options, null)
  assert.equal(L.onEscape(), false)
})

test('live: the address opens Options or a pull request sheet', async () => {
  const a = live()
  a.win.location.hash = '#options'
  a.L.fromAddress()
  assert.ok(a.st.options)
  const b = live()
  b.win.location.hash = '#pr=login-page'
  await b.L.fromAddress()
  assert.equal(b.st.pr.flow, 'login-page')
  const c = live()
  c.win.location.hash = '#pr=../x'
  c.L.fromAddress()
  assert.equal(c.st.pr, null)
})

test('the live files store nothing in the browser and send only GET reads and the one prefs write', () => {
  const src = read('phone-pr-live.js')
  for (const s of ['localStorage', 'sessionStorage', 'indexedDB', 'serviceWorker', 'caches.', 'document.cookie', 'fetch(']) assert.equal(src.includes(s), false, s)
  assert.deepEqual([...src.matchAll(/call\('(GET|POST)', [`']([^`']+)/g)].map(m => `${m[1]} ${m[2]}`), ['GET /phone/api/pr?flow=${encodeURIComponent(id)}', 'POST /phone/api/prefs'])
  const app = read('phone-app.js')
  assert.match(app, /pr\.onClick\(t\)/)
  assert.match(app, /window\.PhonePr\.gear\(\)/)
  assert.match(src, /focus\('#phSheetTitle'\)/, 'the heading takes the focus')
  assert.match(src, /prButton\(flow\)\?\.focus\(\)/, 'Close gives it back to what opened it')
})
