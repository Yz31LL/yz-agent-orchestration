// Tests for the phone page (public/phone.html): its pure words (phone-state.js) and markup (phone-view.js), run in a
// vm like the other browser files, plus what the live half (phone-app.js), the stylesheet and the manifest must hold:
// the desktop's colour tokens in light and dark, no stored data, the CSRF header on every write, the chat's poll.
// The chat itself (phone-chat.js, phone-text.js) has its own tests: test/phone-chat.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
// ⚠️ Line endings normalised: a Windows checkout (core.autocrlf true) writes the CSS with CRLF, and the token test
// looks for a block head with a newline in it. It passed where the files were written by hand with LF only.
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n')
const ctx = vm.createContext({ window: {} })
for (const f of ['phone-state.js', 'phone-text.js', 'phone-chat.js', 'phone-view.js']) vm.runInContext(read(f), ctx)
const S = ctx.window.PhoneState
const V = ctx.window.PhoneView
const plain = v => JSON.parse(JSON.stringify(v))
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const SUMMARY = {
  builtAt: '2026-11-25T10:42:00.000Z', coordinator: 'Master',
  needs: { total: 4, asks: 2, hands: 1, outputs: 1 },
  agents: [{ label: 'Agent 1', busy: true, flow: 'Login page <beta>' }, { label: 'QA', busy: false, flow: '' }],
  finishedToday: 3,
  asks: [
    { flowId: 'login', nodeId: 'a1', flowTitle: 'Login page', agent: 'Agent 1', question: 'Ship it?', why: 'It passed QA.', kind: 'yesno', yes: 'it goes to dev', no: 'it waits' },
    { flowId: 'login', nodeId: 'a2', flowTitle: 'Login page', agent: 'Agent 1', question: 'Which colour?', why: '', kind: 'text', yes: '', no: '' },
  ],
  hands: [{ flowId: 'ci', title: 'Deploy pipeline', agent: 'Agent 2', reason: '0 of 1 done.', steps: [{ id: 'h1', do: 'Add the secret', where: 'GitHub › Settings', expect: 'It is listed', copy: 'TOKEN', done: false }], progress: { done: 0, total: 1 } }],
  outputs: [{ flowId: 'shipped', title: 'Search box', agent: 'Agent 1', finishedAt: '2026-11-24T10:00:00.000Z', overdue: true, story: [{ who: 'Agent 1', did: 'Built the box.', why: 'You asked.' }] }],
  costNote: 'Your answer reaches the agent through a short paid turn on your PC: a few cents each.',
}

// ═══ the words ═══

test('needsLine and the three counts, singular and plural', () => {
  assert.equal(S.needsLine(0), 'Nothing needs you')
  assert.equal(S.needsLine(1), '1 thing needs you')
  assert.equal(S.needsLine(5), '5 things need you')
  assert.equal(S.needsLine(undefined), 'Nothing needs you')
  assert.deepEqual(plain(S.countParts({ asks: 1, hands: 2, outputs: 0 })).map(p => `${p.n} ${p.label}`), ['1 question', '2 by hand', '0 outputs to sign off'])
  assert.deepEqual(plain(S.countParts(null)).map(p => p.n), [0, 0, 0])
})

test('when: a clock time today, a day and month before today; a bad time is empty', () => {
  const now = new Date(2026, 10, 25, 15, 0).getTime() // local time, as the phone shows it
  assert.equal(S.when(new Date(2026, 10, 25, 9, 5).toISOString(), now), '09:05')
  assert.equal(S.when(new Date(2026, 10, 24, 23, 0).toISOString(), now), '24 Nov')
  assert.equal(S.when('nope', now), '')
})

test('the PIN must be 8 to 12 digits before it is sent', () => {
  assert.equal(S.pinProblem('12345678'), null)
  assert.equal(S.pinProblem('1234567'), 'At least 8 digits.')
  assert.equal(S.pinProblem('12a456'), 'Only digits.')
  assert.equal(S.pinProblem('1'.repeat(13)), 'At most 12 digits.')
  assert.equal(S.failureOf(401), 'signedOut')
  assert.equal(S.failureOf(0), 'offline')
  assert.equal(S.failureOf(500), 'error')
})

test('the address opens a tab, and a flow sheet by its id; anything else is the first tab', () => {
  assert.deepEqual(plain(S.routeOf('#talk')), { tab: 'talk', flow: null })
  assert.deepEqual(plain(S.routeOf('#needs')), { tab: 'needs', flow: null })
  assert.deepEqual(plain(S.routeOf('#flow=login-page')), { tab: S.TABS[0], flow: 'login-page' })
  for (const bad of ['', '#', '#nope', '#flow=../x', '#flow=A B', '#flow=<img>', null, '#talk?x', `#flow=${'a'.repeat(81)}`]) assert.deepEqual(plain(S.routeOf(bad)), { tab: S.TABS[0], flow: null }, String(bad))
  assert.equal(S.hashOf('talk'), '#talk')
})

// ═══ the markup ═══

const ALL = () => [V.signIn({ status: 'Wrong PIN. 4 tries left before a 15 minute lock.' }), V.nav('agents', SUMMARY, 'Master'),
  V.needs(SUMMARY, {}), V.outputs(SUMMARY, { confirm: 'shipped' }), V.outputs(SUMMARY, {}),
  V.talk({ label: 'Master', running: false, busy: false, messages: [{ id: 'm1', at: '2026-11-25T10:00:00Z', text: '<b>hi</b>', state: 'failed', error: 'x', replies: [{ at: '2026-11-25T10:01:00Z', text: 'ok "fine"' }] }] }, {})]

test('no markup holds an inline style or an inline handler (the CSP allows neither)', () => {
  for (const h of ALL()) {
    assert.doesNotMatch(h, /\sstyle=/i)
    assert.doesNotMatch(h, /\son[a-z]+=/i)
    assert.doesNotMatch(h, /<script/i)
  }
})

test('everything from the server is escaped', () => {
  assert.match(V.needs({ ...SUMMARY, asks: [{ ...SUMMARY.asks[0], flowTitle: 'Login page <beta>' }] }, {}), /Login page &lt;beta&gt;/)
  const t = V.talk({ label: 'Master', messages: [{ id: 'm1', at: '2026-11-25T10:00:00Z', text: '<img src=x onerror=alert(1)>', state: 'sent', replies: [] }] }, {})
  assert.doesNotMatch(t, /<img/)
  assert.match(t, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('sign in: a PIN field for digits that is never shown, the number pad, and the status line', () => {
  const h = V.signIn({ status: 'Wrong PIN.' })
  assert.match(h, /<input id="phPin" class="ph-pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="12" data-ph-pin>/)
  assert.deepEqual([...h.matchAll(/data-ph-key="([^"]+)"/g)].map(m => m[1]), ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'])
  assert.match(text(h), /Wrong PIN\./)
  assert.match(V.signIn({ busy: true }), /disabled>Signing in…/)
})

test('Needs you: Yes and No with what each means, a text box for a text question, the cost said once, by-hand ticks', () => {
  const h = V.needs(SUMMARY, {})
  assert.equal((h.match(/a few cents/g) || []).length, 1)
  assert.match(h, /data-ph-answer="yes" data-flow="login" data-node="a1">Yes</)
  assert.match(h, /data-ph-answer="no" data-flow="login" data-node="a1">No</)
  assert.match(text(h), /Yes: it goes to dev · No: it waits/)
  assert.match(h, /<textarea class="ph-input" rows="3" maxlength="2000" id="phA-login-a2" data-draft="ask:login:a2"><\/textarea>/)
  assert.match(h, /<label class="ph-k" for="phA-login-a2">Your answer<\/label>/)
  assert.match(h, /<input type="checkbox" data-ph-tick data-flow="ci" data-step="h1">/)
  assert.match(text(h), /Where: GitHub › Settings/)
  assert.match(V.needs(SUMMARY, { busy: { 'ask:login:a1': true } }), /data-node="a1" disabled>Yes/)
  assert.match(text(V.needs({ ...SUMMARY, asks: [], hands: [] }, {})), /Nothing waits on you/)
})

test('Outputs: the story, Completed, and an inline confirm in its place', () => {
  const plainView = V.outputs(SUMMARY, {}, Date.parse('2026-11-26T10:00:00Z'))
  assert.match(text(plainView), /Agent 1 · finished 24 Nov · waiting a while/)
  assert.match(text(plainView), /Agent 1 Built the box\. You asked\./)
  assert.match(plainView, /data-ph-complete data-flow="shipped" aria-label="Completed: Search box">Completed</)
  const confirm = V.outputs(SUMMARY, { confirm: 'shipped' })
  assert.match(text(confirm), /Mark it completed\? It moves to the archive\. Yes Cancel/)
  assert.doesNotMatch(confirm, /data-ph-complete data-flow/)
  assert.match(text(V.outputs({ ...SUMMARY, outputs: [] }, {})), /No outputs to sign off/)
})

test('the chat tab: a reply shows its bold and code, escaped first; your own text is never marked up', () => {
  const h = V.talk({ label: 'Master', now: '2026-11-25T10:02:00Z', messages: [{ id: 'm1', at: '2026-11-25T10:00:00Z', text: '**mine**', state: 'sent', replies: [{ at: '2026-11-25T10:01:00Z', text: '**Done**: run `npm test` <b>x</b>' }] }] }, {})
  assert.ok(h.includes('<b>Done</b>: run <code>npm test</code> &lt;b&gt;x&lt;/b&gt;'))
  assert.ok(h.includes('**mine**'))
})

// ═══ backing off after a 429 ═══

test('after a 429 the poll waits twice as long each time, up to 60 s; any other answer resets it', () => {
  assert.equal(S.backoffMs(15_000, 0), 15_000)
  assert.equal(S.backoffMs(15_000, 1), 30_000)
  assert.equal(S.backoffMs(15_000, 2), 60_000)
  assert.equal(S.backoffMs(15_000, 3), 60_000, 'never past 60 s')
  assert.equal(S.backoffMs(5_000, 1), 10_000)
  assert.equal(S.backoffMs(5_000, 50), 60_000, 'a long run of refusals does not overflow')
  assert.equal(S.backoffMs(90_000, 0), 90_000, 'a base already over 60 s is left alone')
  for (const bad of [undefined, null, -1, NaN, 'x']) assert.equal(S.backoffMs(5_000, bad), 5_000, String(bad))
  assert.equal(S.limitedAfter(0, 429), 1)
  assert.equal(S.limitedAfter(2, 429), 3)
  assert.equal(S.limitedAfter(3, 200), 0)
  assert.equal(S.limitedAfter(3, 202), 0)
  assert.equal(S.limitedAfter(3, 0), 3, 'offline says nothing about the limit')
  assert.equal(S.limitedAfter(undefined, 429), 1)
})

test('both pollers wait S.backoffMs after a refusal: the summary and the chat', () => {
  const app = read('phone-app.js')
  const live = read('phone-chat-live.js')
  assert.match(app, /st\.limited = S\.limitedAfter\(st\.limited, r\.status\)/, 'every answer counts the refusals in a row')
  assert.match(app, /S\.backoffMs\(SUMMARY_MS, st\.limited\)/)
  assert.doesNotMatch(app, /setInterval/, 'no fixed interval that would keep hammering')
  assert.match(live, /S\.backoffMs\(ms, st\.limited\)/)
})

// ═══ the live half, the stylesheet, the manifest ═══

test('the live files store nothing in the browser, register no service worker, and send the CSRF header', () => {
  const app = read('phone-app.js')
  const live = ['phone-app.js', 'phone-chat-live.js', 'phone-composer.js'].map(read).join('\n')
  for (const s of ['localStorage', 'sessionStorage', 'indexedDB', 'serviceWorker', 'caches.', 'document.cookie', 'innerHTML +=', '.setAttribute(\'style\'']) assert.equal(live.includes(s), false, s)
  assert.match(app, /'x-phone-csrf': st\.csrf/)
  assert.match(read('phone-chat-live.js'), /C\.pollMs\(st\.thread/, 'the chat polls on PhoneChat.pollMs: 5 s while a message is in flight, else 15 s')
  assert.match(app, /visibilitychange/)
  assert.match(app, /if \(field\) field\.value = '' \/\/ read once, never kept/)
})

/** The custom properties of the first block that starts with `head` in `css`. */
function tokens(css, head) {
  const at = css.indexOf(head)
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
  return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]))
}

test('the colour tokens are the desktop ones, light and dark, value for value (MUST CHANGE IN LOCKSTEP)', () => {
  const desk = read('styles.css')
  const phone = read('phone.css')
  const light = tokens(phone, ':root {')
  const dark = tokens(phone, '@media (prefers-color-scheme: dark) {\n  :root {')
  const deskLight = tokens(desk, ':root {')
  const deskDark = tokens(desk, ':root[data-theme="dark"] {')
  assert.ok(Object.keys(light).length >= 20)
  for (const [k, v] of Object.entries(light)) if (k in deskLight) assert.equal(v, deskLight[k], `light ${k}`)
  for (const [k, v] of Object.entries(dark)) assert.equal(v, deskDark[k], `dark ${k}`)
  for (const k of ['--bg', '--surface', '--ink', '--muted', '--accent', '--line', '--ok', '--warn', '--bad']) assert.ok(k in dark, `dark ${k}`)
})

test('the manifest makes it a home-screen app on /phone with the drawn icons', () => {
  const m = JSON.parse(read('phone-manifest.webmanifest'))
  assert.equal(m.start_url, '/phone')
  assert.equal(m.scope, '/phone')
  assert.equal(m.display, 'standalone')
  assert.deepEqual(m.icons.map(i => i.src), ['/phone/icon.svg', '/phone/icon-180.png'])
  const page = read('phone.html')
  assert.match(page, /<link rel="manifest" href="\/phone\/manifest\.webmanifest">/)
  assert.match(page, /<link rel="apple-touch-icon" href="\/phone\/icon-180\.png">/)
  assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/)
})

test('a by-hand flow with no steps says where to ask for them: the PC, since the phone cannot', () => {
  assert.match(text(V.needs({ ...SUMMARY, asks: [], hands: [{ ...SUMMARY.hands[0], steps: [] }] }, {})), /No steps yet\. Asking the agent for them is done at the PC\./)
})

// QA 2026-11-26: story lines showed the glossary brackets ([quota project]) and repeated the agent (Master Master
// gave...); every Completed button read the same to a screen reader; the header said Agents on every tab.
test('Outputs: story lines lose the glossary brackets and never repeat the agent; Completed names its flow', () => {
  const sum = { ...SUMMARY, outputs: [{ flowId: 'quota', title: 'Quota fix', agent: 'Master', story: [{ who: 'Master', did: 'Master gave the [quota project] a new [billing account].', why: '' }] }] }
  const t = text(V.outputs(sum, {}))
  assert.match(t, /Master gave the quota project a new billing account\./)
  assert.doesNotMatch(t, /Master Master/)
  assert.doesNotMatch(t, /\[|\]/)
  assert.match(V.outputs(sum, {}), /aria-label="Completed: Quota fix"/)
})

test('the header names the tab: Agents, Needs you, Outputs, or the coordinator', () => {
  assert.equal(V.tabTitle('agents', 'Master'), 'Agents')
  assert.equal(V.tabTitle('needs', 'Master'), 'Needs you')
  assert.equal(V.tabTitle('outputs', 'Master'), 'Outputs')
  assert.equal(V.tabTitle('talk', 'Master'), 'Master')
  assert.equal(V.tabTitle('talk'), 'Master')
  assert.match(read('phone-app.js'), /V\.tabTitle\(st\.tab, label\)/)
})

test('opening a flow sheet puts the focus on its heading; Close gives it back to the chip; the sign-in screen is titled Sign in', () => {
  const app = read('phone-app.js')
  assert.ok(app.includes("root.querySelector('#phSheetTitle')?.focus()"), 'the heading takes the focus')
  assert.ok(app.includes('chipOf(id)?.focus()'), 'Close gives it back to the chip')
  assert.ok(app.includes("doc.title = st.signedIn ? V.tabTitle(st.tab, label) : 'Sign in'"))
  assert.ok(app.includes('data-ph-box-more'))
})

// QA 2026-11-26 (found while adding the pull request sheet): phone-app.js declared `function tick` twice, the poll and
// the by-hand checkbox. The second replaced the first, so start() called the checkbox one with no box, threw, and
// neither the 15 s summary poll nor the chat poll was ever scheduled.
test('no live file declares a function name twice: one would silently replace the other', () => {
  for (const f of ['phone-app.js', 'phone-chat-live.js', 'phone-pr-live.js', 'phone-composer.js']) {
    const names = [...read(f).matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map(m => m[1])
    const twice = names.filter((n, i) => names.indexOf(n) !== i)
    assert.deepEqual(twice, [], `${f}: ${twice.join(', ')}`)
  }
  assert.match(read('phone-app.js'), /\[data-ph-tick\]'\)\) tickStep\(e\.target\)/, 'a checkbox ticks a step; the poll keeps its own tick')
})
