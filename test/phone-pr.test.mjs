// Tests for phone-pr.mjs, the pull request reader behind GET /phone/api/pr: ONLY a pull request the desktop's Pull
// requests list holds (prlist-store.mjs, given as the `prs` provider) can be read, by its flow id or its number; the
// repository and the number handed to gh come from that list, never from the request. gh is a stub (no network, no
// real pull request): the two read-only commands, the caps and the cut notes, the 60 s cache, at most two gh calls
// at once, and a gh failure that keeps the last copy.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const R = await import('../phone-pr.mjs')
const { checksOf } = await import('../pr-check.mjs')

const URL12 = 'https://github.com/acme/shop/pull/12'
const URL14 = 'https://github.com/acme/shop/pull/14'
const item = (n, over = {}) => ({
  key: `https://github.com/acme/shop/pull/${n}`, url: `https://github.com/acme/shop/pull/${n}`, repo: 'acme/shop', number: n, label: `acme/shop #${n}`,
  title: `Pull ${n}`, flow: { id: `flow-${n}`, title: `Flow ${n}` }, agent: 'Agent 1', openedAt: '2026-11-26T08:00:00Z', draft: false, checks: 'passing', needs: null, stale: false, ...over,
})

const VIEW = (over = {}) => ({
  title: 'Add the login page', body: 'It adds **the login page**.', author: { login: 'alice' }, state: 'OPEN', isDraft: false,
  createdAt: '2026-11-26T08:00:00Z', updatedAt: '2026-11-26T09:30:00Z', baseRefName: 'dev', headRefName: 'feat/login',
  additions: 340, deletions: 58, changedFiles: 2,
  files: [{ path: 'src/login.js', additions: 30, deletions: 2 }, { path: 'README.md', additions: 1, deletions: 0 }],
  reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [{ login: 'bob' }, { name: 'web-team' }],
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'flutter test', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
  ],
  comments: [{ author: { login: 'carol' }, body: 'Looks close.', createdAt: '2026-11-26T09:00:00Z' }],
  reviews: [{ author: { login: 'dave' }, state: 'APPROVED', body: '', submittedAt: '2026-11-26T09:10:00Z' }],
  mergeable: 'MERGEABLE', url: 'https://evil.example/not-this', ...over,
})
const DIFF = [
  'diff --git a/README.md b/README.md', 'index 1..2 100644', '--- a/README.md', '+++ b/README.md', '@@ -1 +1,2 @@', ' # Shop', '+Sign in with Google.',
  'diff --git a/src/login.js b/src/login.js', 'new file mode 100644', '--- /dev/null', '+++ b/src/login.js', '@@ -0,0 +1,3 @@', '+export function login() {', '+  return true', '+}',
].join('\n')

/** A gh stub: answers view and diff per pull request number, records every call, can be slowed or made to fail. */
function fakeGh({ view = () => VIEW(), diff = () => DIFF, delay = 0 } = {}) {
  const calls = []
  let active = 0
  let peak = 0
  const gh = async (args, timeoutMs) => {
    calls.push({ args, timeoutMs })
    active++
    peak = Math.max(peak, active)
    try {
      if (delay) await new Promise(r => setTimeout(r, delay))
      const n = Number(args[2])
      if (args[1] === 'view') {
        const j = view(n)
        return j ? { ok: true, out: JSON.stringify(j) } : { ok: false, out: '', err: 'gh: could not resolve' }
      }
      if (args[1] === 'diff') {
        const d = diff(n)
        return d === null ? { ok: false, out: '', err: 'diff too large' } : { ok: true, out: d }
      }
      return { ok: false, out: '' }
    } finally {
      active--
    }
  }
  return { gh, calls, peak: () => peak }
}

const make = (over = {}) => {
  const clock = { t: Date.parse('2026-11-26T10:00:00Z') }
  const g = over.fake || fakeGh()
  const reader = R.makePrReader({ gh: g.gh, prs: () => [item(14), item(12)], now: () => clock.t, ...over })
  return { reader, clock, g }
}

// ═══ which pull request: only one the list holds ═══

test('a flow id the list knows reads ITS pull request: gh pr view and gh pr diff, the repo and number from the list', async () => {
  const { reader, g } = make()
  const r = await reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.equal(r.status, 200)
  assert.equal(r.body.url, URL12, 'the list link, never what gh put in its own url field')
  assert.equal(r.body.label, 'acme/shop #12')
  assert.deepEqual(r.body.flow, { id: 'flow-12', title: 'Flow 12' })
  assert.deepEqual(g.calls.map(c => c.args), [
    ['pr', 'view', '12', '--repo=acme/shop', `--json=${R.PR_VIEW_JSON}`],
    ['pr', 'diff', '12', '--repo=acme/shop', '--color=never'],
  ])
  for (const c of g.calls) assert.ok(c.timeoutMs > 0, 'every call has its own timeout')
  // read only: nothing but view and diff, ever
  assert.ok(g.calls.every(c => c.args[0] === 'pr' && ['view', 'diff'].includes(c.args[1])))
})

test('a number the list knows reads that one too', async () => {
  const { reader, g } = make()
  const r = await reader.read({ n: '14', keys: ['n'] })
  assert.equal(r.status, 200)
  assert.equal(r.body.url, URL14)
  assert.equal(g.calls[0].args[2], '14')
})

test('anything the list does not hold is a 404, and gh is never asked', async () => {
  const { reader, g } = make()
  const asks = [
    { flow: 'flow-99', keys: ['flow'] }, { n: '99', keys: ['n'] }, { flow: 'Flow-12', keys: ['flow'] }, { flow: '../flow-12', keys: ['flow'] },
    { flow: URL12, keys: ['flow'] }, { flow: 'https://github.com/evil/x/pull/12', keys: ['flow'] }, { n: '12abc', keys: ['n'] }, { n: '-12', keys: ['n'] },
    { n: '0x0c', keys: ['n'] }, { n: '1e1', keys: ['n'] }, { n: '', keys: ['n'] }, { flow: null, n: null, keys: [] },
    // a repo, a link or any other key in the address: refused whole, even beside a flow the list knows
    { flow: 'flow-12', keys: ['flow', 'repo'] }, { n: '12', keys: ['n', 'url'] }, { flow: 'flow-12', n: '12', keys: ['flow', 'n'] },
    {}, null, 'flow-12', { flow: ['flow-12'], keys: ['flow'] }, { flow: 'flow-12' },
  ]
  for (const b of asks) {
    const r = await reader.read(b)
    assert.equal(r.status, 404, JSON.stringify(b))
    assert.match(r.body.error, /not on the list/)
  }
  assert.equal(g.calls.length, 0)
})

test('a list item whose link is not a github.com pull request link is never read', async () => {
  const bad = [item(12, { url: 'https://gitlab.example/acme/shop/pull/12' }), item(13, { url: 'javascript:alert(1)//github.com/a/b/pull/13' }), item(15, { url: 'https://github.com/acme/shop/pull/15/../../evil' }), item(16, { flow: { id: '../x' } })]
  const { reader, g } = make({ prs: () => bad })
  for (const b of [{ flow: 'flow-12', keys: ['flow'] }, { n: '13', keys: ['n'] }, { n: '15', keys: ['n'] }, { n: '16', keys: ['n'] }]) assert.equal((await reader.read(b)).status, 404)
  assert.equal(g.calls.length, 0)
})

test('two pull requests on the list with one number: the number alone is refused, the flow id still works', async () => {
  const { reader } = make({ prs: () => [item(12), item(12, { url: 'https://github.com/acme/api/pull/12', flow: { id: 'api-12', title: 'x' } })] })
  assert.equal((await reader.read({ n: '12', keys: ['n'] })).status, 404)
  const r = await reader.read({ flow: 'api-12', keys: ['flow'] })
  assert.equal(r.status, 200)
  assert.equal(r.body.label, 'acme/api #12')
})

test('a list provider that throws, hangs or answers junk is an empty list: 404, never a crash', async () => {
  for (const prs of [() => { throw new Error('x') }, async () => { throw new Error('y') }, () => null, () => 'junk', () => [null, 7]]) {
    assert.equal((await make({ prs }).reader.read({ flow: 'flow-12', keys: ['flow'] })).status, 404)
  }
  assert.equal((await make({ prs: () => new Promise(() => {}), listWaitMs: 20 }).reader.read({ flow: 'flow-12', keys: ['flow'] })).status, 404)
})

// ═══ the shape ═══

test('the answer is a small fixed shape: state, branches, author, checks, review, description, files, conversation', async () => {
  const { body } = await make().reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.equal(body.title, 'Add the login page')
  assert.equal(body.state, 'open')
  assert.equal(body.base, 'dev')
  assert.equal(body.head, 'feat/login')
  assert.equal(body.author, 'alice')
  assert.equal(body.createdAt, '2026-11-26T08:00:00Z')
  assert.equal(body.checkedAt, '2026-11-26T10:00:00.000Z')
  assert.equal(body.stale, false)
  assert.equal(body.problem, null)
  // checks: the counts, the word as the desktop says it, each failing or running check by name
  assert.deepEqual(body.checks.counts, { passed: 2, failing: 1, running: 1, skipped: 1 })
  assert.equal(body.checks.summary, '2 passed, 1 failing, 1 running, 1 skipped')
  assert.equal(body.checks.word, 'failing')
  assert.deepEqual(body.checks.list, [{ name: 'flutter test', state: 'failing' }, { name: 'lint', state: 'running' }])
  assert.deepEqual(body.review, { decision: 'required', requested: ['bob', 'web-team'], approvedBy: ['dave'], changesBy: [] })
  assert.deepEqual(body.body, { text: 'It adds **the login page**.', cut: false })
  assert.deepEqual({ ...body.files, list: undefined }, { count: 2, additions: 340, deletions: 58, list: undefined, cut: false, linesCut: false })
  assert.deepEqual(body.files.list[0], { path: 'src/login.js', additions: 30, deletions: 2, patch: ['@@ -0,0 +1,3 @@', '+export function login() {', '+  return true', '+}'], cut: false, why: null })
  assert.deepEqual(body.files.list[1].patch, ['@@ -1 +1,2 @@', ' # Shop', '+Sign in with Google.'])
  assert.deepEqual(body.conversation, {
    items: [
      { kind: 'comment', author: 'carol', at: '2026-11-26T09:00:00Z', state: null, text: 'Looks close.', cut: false },
      { kind: 'review', author: 'dave', at: '2026-11-26T09:10:00Z', state: 'approved', text: '', cut: false },
    ],
    total: 2, cut: false,
  })
})

test('the checks word is the desktop one (pr-check.mjs checksOf), and the summary is plain', async () => {
  const cases = [
    [[], 'none', 'No checks.'],
    [[{ __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }], 'passing', '1 passed'],
    [Array.from({ length: 22 }, (_, i) => ({ __typename: 'CheckRun', name: `c${i}`, status: 'COMPLETED', conclusion: 'SUCCESS' })).concat({ __typename: 'CheckRun', name: 'slow', status: 'QUEUED' }), 'running', '22 passed, 1 running'],
    [[{ __typename: 'StatusContext', context: 'old', state: 'ERROR' }], 'failing', '1 failing'],
    [[{ __typename: 'StatusContext', context: 'old', state: 'PENDING' }], 'running', '1 running'],
  ]
  for (const [rollup, word, summary] of cases) {
    const c = R.checksView(rollup)
    assert.equal(c.word, summary === 'No checks.' ? 'none' : word)
    assert.equal(c.summary, summary)
    const desk = checksOf(rollup)
    assert.equal(c.word, desk === 'pending' ? 'running' : desk, 'in lockstep with the desktop')
  }
})

test('the review: approved, changes asked for, requested, by whom; a later review by the same person wins', () => {
  const r = R.reviewView({
    reviewDecision: 'CHANGES_REQUESTED', reviewRequests: [{ login: 'erin' }, { slug: 'core' }, null, 7],
    reviews: [
      { author: { login: 'bob' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-11-26T08:00:00Z' },
      { author: { login: 'bob' }, state: 'APPROVED', submittedAt: '2026-11-26T09:00:00Z' },
      { author: { login: 'carol' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-11-26T09:30:00Z' },
      { author: { login: 'dave' }, state: 'APPROVED', submittedAt: '2026-11-26T08:30:00Z' },
      { author: { login: 'dave' }, state: 'DISMISSED', submittedAt: '2026-11-26T09:40:00Z' },
      { author: { login: 'frank' }, state: 'COMMENTED', submittedAt: '2026-11-26T09:50:00Z' },
    ],
  })
  assert.deepEqual(r, { decision: 'changes', requested: ['erin', 'core'], approvedBy: ['bob'], changesBy: ['carol'] })
  assert.equal(R.reviewView({}).decision, 'none')
  assert.equal(R.reviewView({ reviewDecision: 'APPROVED' }).decision, 'approved')
})

test('a draft, a merged and a closed pull request say so', async () => {
  for (const [over, state] of [[{ isDraft: true }, 'draft'], [{ state: 'MERGED' }, 'merged'], [{ state: 'CLOSED' }, 'closed'], [{ state: 'WEIRD' }, 'open']]) {
    const { body } = await make({ fake: fakeGh({ view: () => VIEW(over) }) }).reader.read({ flow: 'flow-12', keys: ['flow'] })
    assert.equal(body.state, state, JSON.stringify(over))
  }
})

test('junk from gh is read safely: wrong types become empty, never a throw', async () => {
  const junk = { title: 7, body: { x: 1 }, author: 'mallory', files: 'x', comments: [null, 'x', { body: 5 }], reviews: {}, statusCheckRollup: 'x', additions: -4, deletions: 'many', changedFiles: 1.5, createdAt: 'yesterday', baseRefName: ['dev'] }
  const { body, status } = await make({ fake: fakeGh({ view: () => junk, diff: () => 'not a diff at all' }) }).reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.equal(status, 200)
  assert.equal(body.title, 'Pull 12', 'the list title when gh gives none')
  assert.equal(body.author, '')
  assert.equal(body.createdAt, null)
  assert.equal(body.base, '')
  assert.deepEqual(body.body, { text: '', cut: false })
  assert.equal(body.files.additions, 0)
  assert.equal(body.files.deletions, 0)
  assert.deepEqual(body.files.list, [])
  assert.equal(body.checks.word, 'none')
  assert.equal(body.conversation.items.length, 1)
})

// ═══ the caps, each said ═══

test('caps: the description at 20,000 characters, 100 files, 300 lines a file and 1,500 in all, 30 comments of 2,000', async () => {
  const files = Array.from({ length: 140 }, (_, i) => ({ path: `src/f${String(i).padStart(3, '0')}.js`, additions: 400, deletions: 0 }))
  const diff = files.map(f => [`diff --git a/${f.path} b/${f.path}`, `--- a/${f.path}`, `+++ b/${f.path}`, '@@ -1,400 +1,400 @@', ...Array.from({ length: 399 }, (_, k) => `+line ${k}`)].join('\n')).join('\n')
  const comments = Array.from({ length: 45 }, (_, i) => ({ author: { login: `u${i}` }, body: 'w'.repeat(2500), createdAt: new Date(Date.parse('2026-11-25T00:00:00Z') + i * 60_000).toISOString() }))
  const { body } = await make({ fake: fakeGh({ view: () => VIEW({ body: 'b'.repeat(25_000), files, changedFiles: 140, comments, reviews: [] }), diff: () => diff }) }).reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.equal(body.body.text.length, R.CAPS.body)
  assert.equal(body.body.cut, true)
  assert.equal(body.files.count, 140)
  assert.equal(body.files.list.length, 100)
  assert.equal(body.files.cut, true)
  const shown = body.files.list.filter(f => f.patch)
  assert.equal(shown[0].patch.length, 300)
  assert.equal(shown[0].cut, true)
  assert.equal(shown.reduce((n, f) => n + f.patch.length, 0), 1500)
  assert.equal(shown.length, 5)
  assert.equal(body.files.linesCut, true)
  assert.deepEqual(body.files.list.slice(5).map(f => f.why), Array(95).fill('later'))
  assert.equal(body.conversation.items.length, 30)
  assert.equal(body.conversation.total, 45)
  assert.equal(body.conversation.cut, true)
  assert.equal(body.conversation.items.at(-1).author, 'u44', 'the latest, newest last')
  assert.equal(body.conversation.items[0].text.length, R.CAPS.comment)
  assert.equal(body.conversation.items[0].cut, true)
})

test('one very long line of a patch is cut, so a minified file cannot flood the phone', async () => {
  const diff = ['diff --git a/app.min.js b/app.min.js', '--- a/app.min.js', '+++ b/app.min.js', '@@ -1 +1 @@', `+${'x'.repeat(50_000)}`].join('\n')
  const { body } = await make({ fake: fakeGh({ view: () => VIEW({ files: [{ path: 'app.min.js', additions: 1, deletions: 1 }] }), diff: () => diff }) }).reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.ok(body.files.list[0].patch[1].length <= R.CAPS.line + 1)
})

test('the diff: a binary file, a rename, a deleted file and a file missing from the diff each say why there are no lines', () => {
  const diff = [
    'diff --git a/logo.png b/logo.png', 'index 1..2 100644', 'Binary files a/logo.png and b/logo.png differ',
    'diff --git a/old.js b/new.js', 'similarity index 100%', 'rename from old.js', 'rename to new.js',
    'diff --git a/gone.js b/gone.js', 'deleted file mode 100644', '--- a/gone.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
    'diff --git a/has space.txt b/has space.txt', '--- a/has space.txt', '+++ b/has space.txt', '@@ -1 +1 @@', '-a', '+b', '\\ No newline at end of file',
  ].join('\n')
  const patches = R.patchesOf(diff)
  assert.equal(patches.get('logo.png').binary, true)
  assert.deepEqual(patches.get('new.js').lines, [])
  assert.deepEqual(patches.get('gone.js').lines, ['@@ -1 +0,0 @@', '-bye'])
  assert.deepEqual(patches.get('has space.txt').lines, ['@@ -1 +1 @@', '-a', '+b', '\\ No newline at end of file'])
  const files = R.filesView([{ path: 'logo.png' }, { path: 'new.js' }, { path: 'gone.js' }, { path: 'nowhere.js' }], patches)
  assert.deepEqual(files.list.map(f => f.why), ['binary', 'empty', null, 'missing'])
})

// ═══ hostile text: passed on as plain data, with the invisible tricks taken out ═══

test('names lose control and direction-override characters; patch lines show them as visible marks', async () => {
  const rlo = '‮'
  const view = VIEW({ title: `Fix ${rlo}gnp.exe`, author: { login: `ev${rlo}il\u0007` }, files: [{ path: `src/${rlo}txt.js`, additions: 1, deletions: 0 }], baseRefName: `dev\u0000` })
  const diff = [`diff --git a/src/${rlo}txt.js b/src/${rlo}txt.js`, `--- a/src/${rlo}txt.js`, `+++ b/src/${rlo}txt.js`, '@@ -0,0 +1 @@', `+if (isAdmin) { ${rlo} } // trojan source`].join('\n')
  const { body } = await make({ fake: fakeGh({ view: () => view, diff: () => diff }) }).reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.equal(body.title, 'Fix gnp.exe')
  assert.equal(body.author, 'evil')
  assert.equal(body.base, 'dev')
  assert.equal(body.files.list[0].path, 'src/txt.js')
  assert.equal(body.files.list[0].patch[1], '+if (isAdmin) { [U+202E] } // trojan source')
})

test('markup in every field is passed on as text, unchanged: the phone escapes it (test/phone-pr-view.test.mjs)', async () => {
  const x = '<img src=x onerror=alert(1)>'
  const view = VIEW({ title: x, body: x, author: { login: x }, files: [{ path: x, additions: 1, deletions: 0 }], comments: [{ author: { login: x }, body: x, createdAt: '2026-11-26T09:00:00Z' }] })
  const diff = [`diff --git a/${x} b/${x}`, `--- a/${x}`, `+++ b/${x}`, '@@ -0,0 +1 @@', `+${x}`].join('\n')
  const { body } = await make({ fake: fakeGh({ view: () => view, diff: () => diff }) }).reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.equal(body.title, x)
  assert.equal(body.body.text, x)
  assert.equal(body.files.list[0].path, x)
  assert.equal(body.files.list[0].patch[1], `+${x}`)
  assert.equal(body.conversation.items[0].text, x)
})

// ═══ the cache, the in-flight limit, a failure ═══

test('one read a minute per pull request: a second read within 60 s asks gh nothing; after it, gh is asked again', async () => {
  const { reader, clock, g } = make()
  await reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.equal(g.calls.length, 2)
  clock.t += 59_000
  const again = await reader.read({ n: '12', keys: ['n'] })
  assert.equal(again.status, 200)
  assert.equal(g.calls.length, 2, 'by number or by flow, the same pull request shares the copy')
  clock.t += 2_000
  await reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.equal(g.calls.length, 4)
})

test('reads of one pull request at the same moment share one gh read', async () => {
  const fake = fakeGh({ delay: 30 })
  const { reader } = make({ fake })
  const all = await Promise.all(Array.from({ length: 6 }, () => reader.read({ flow: 'flow-12', keys: ['flow'] })))
  assert.ok(all.every(r => r.status === 200))
  assert.equal(fake.calls.length, 2)
})

test('never more than two gh calls at once, however many pull requests are read together', async () => {
  const fake = fakeGh({ delay: 25 })
  const list = Array.from({ length: 6 }, (_, i) => item(20 + i))
  const { reader } = make({ fake, prs: () => list })
  const all = await Promise.all(list.map(p => reader.read({ flow: p.flow.id, keys: ['flow'] })))
  assert.ok(all.every(r => r.status === 200))
  assert.equal(fake.calls.length, 12)
  assert.equal(fake.peak(), 2)
})

test('gh fails with no copy yet: one plain line and the link; tried again only after a short wait', async () => {
  const fake = fakeGh({ view: () => null })
  const { reader, clock } = make({ fake })
  const r = await reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.equal(r.status, 502)
  assert.match(r.body.error, /^Could not read this pull request from GitHub just now\./)
  assert.equal(r.body.url, URL12)
  await reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.equal(fake.calls.length, 1, 'not hammered')
  clock.t += R.FAIL_MS
  await reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.equal(fake.calls.length, 2)
})

test('gh fails after a good read: the last copy stays, marked stale, with a plain line', async () => {
  let down = false
  const fake = fakeGh({ view: () => (down ? null : VIEW()) })
  const { reader, clock } = make({ fake })
  const first = await reader.read({ flow: 'flow-12', keys: ['flow'] })
  down = true
  clock.t += 61_000
  const r = await reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.equal(r.status, 200)
  assert.equal(r.body.stale, true)
  assert.match(r.body.problem, /Could not read GitHub just now/)
  assert.equal(r.body.title, first.body.title)
  assert.equal(r.body.checkedAt, first.body.checkedAt, 'the time of the copy, not of the failure')
  down = false
  clock.t += R.FAIL_MS
  const back = await reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.equal(back.body.stale, false)
  assert.equal(back.body.problem, null)
})

test('the diff alone fails: the files are listed without their changes, said plainly, and it is tried again soon', async () => {
  const fake = fakeGh({ diff: () => null })
  const { reader, clock } = make({ fake })
  const r = await reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.files.list.map(f => f.why), ['missing', 'missing'])
  assert.match(r.body.problem, /changes themselves could not be read/)
  clock.t += R.FAIL_MS
  await reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.equal(fake.calls.length, 4)
})

test('a gh call that hangs is given up after its timeout and frees its place', async () => {
  let hang = true
  const gh = async args => (hang ? new Promise(() => {}) : { ok: true, out: args[1] === 'view' ? JSON.stringify(VIEW()) : DIFF })
  const { reader, clock } = make({ fake: { gh, calls: [] }, timeoutMs: 20, graceMs: 10 })
  const r = await reader.read({ flow: 'flow-12', keys: ['flow'] })
  assert.equal(r.status, 502)
  hang = false
  clock.t += R.FAIL_MS
  assert.equal((await reader.read({ flow: 'flow-12', keys: ['flow'] })).status, 200)
})
