// Tests for phone-server.mjs, the phone listener: it serves ONLY the phone page and its assets, sign-in and
// sign-out, and the /phone/api allowlist; everything else is a 404 there, the desktop routes, files and config
// above all. Sign-in, the cookie, the CSRF token, the Origin, the rate limits, expiry, Sign out everywhere and the
// security headers are checked on a real http server on 127.0.0.1 port 0 (the handler takes its own address as
// given: which addresses may be listened on is phone-bind.mjs, tested on its own). The actions are recorded stubs.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-server-test-'))
const HERE = path.dirname(fileURLToPath(import.meta.url))
const P = await import('../phone-server.mjs')
const { makeAuthStore } = await import('../phone-auth.mjs')
const { PHONE_LIMITS } = await import('../phone-limits.mjs')
const { hashPin } = await import('../send-pin.mjs')

const PIN = '5038172946'
const HASH = hashPin(PIN, { N: 1024 })
const dir = process.env.FACTORY_DATA_DIR
const clock = { t: Date.parse('2026-11-25T09:00:00Z') }
const logged = []
let authFile
let auth
let calls
let settings
let server
let own
let base

const recorder = name => async b => (calls.push([name, b]), { status: 200, body: { ok: true, action: name } })
const actions = { summary: recorder('summary'), orchestration: recorder('orchestration'), flow: recorder('flow'), answer: recorder('answer'), tick: recorder('tick'), complete: recorder('complete'), talk: recorder('talk'), talkSend: recorder('talkSend'), pr: recorder('pr') }
const LIMITS = { session: { max: 40, ms: 60_000 }, address: { max: 400, ms: 60_000 }, login: { max: 30, ms: 60_000 } }

function handler(extra = {}) {
  return P.makePhoneHandler({ settings: () => settings, own: () => own, auth, actions, limits: LIMITS, now: () => clock.t, ...extra })
}

before(async () => {
  server = http.createServer((req, res) => current(req, res))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  own = { bind: '127.0.0.1', port: server.address().port }
  base = `http://127.0.0.1:${own.port}`
})
after(() => {
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
let current
beforeEach(() => {
  calls = []
  logged.length = 0
  clock.t = Date.parse('2026-11-25T09:00:00Z')
  authFile = path.join(dir, `auth-${Math.random().toString(36).slice(2)}.json`)
  auth = makeAuthStore({ file: authFile, now: () => clock.t, log: l => logged.push(l) })
  settings = { enabled: true, bind: '127.0.0.1', port: own.port, pinHash: HASH, sessionHours: 12 }
  current = handler()
})

const ORIGIN = () => `http://127.0.0.1:${own.port}`
/** A raw request, so the test controls every header (fetch would set Origin and Host itself). */
function request(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    const noHost = headers.host === null // no Host header at all
    const all = { host: `127.0.0.1:${own.port}`, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers }
    if (noHost) delete all.host
    const req = http.request({ host: '127.0.0.1', port: own.port, method, path: p, setHost: !noHost, headers: all }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', c => (text += c))
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { json = null }
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}
const write = (p, body = {}, headers = {}) => request('POST', p, { body, headers: { 'content-type': 'application/json', origin: ORIGIN(), ...headers } })
async function signIn(pin = PIN) {
  const r = await write('/phone/login', { pin })
  const cookie = (r.headers['set-cookie'] || [])[0]?.split(';')[0] || ''
  return { r, cookie, csrf: r.json?.csrf }
}
const asUser = ({ cookie, csrf }) => ({ cookie, 'x-phone-csrf': csrf })

// ═══ the allowlist ═══

const DESKTOP = [
  '/', '/index.html', '/app.js', '/styles.css', '/shell.js', '/settings-page.js', '/fonts/inter-latin-wght-normal.woff2', '/glossary.json',
  '/api/status', '/api/flows', '/api/flows/x', '/api/settings', '/api/human', '/api/outputs', '/api/spend', '/api/chat', '/api/pulse',
  '/api/orchestration', '/api/agent?session=x', '/api/diff?worktree=main', '/api/phone', '/evidence/x/a.png', '/config.json', '/data/phone-auth.json',
  '/phone.html', '/phone/phone.html', '/phone/../config.json', '/phone/%2e%2e/config.json', '/phone/..%2fconfig.json', '/phone/app.js',
  '/phone/api/../../api/status', '/phone/api/delete', '/phone/api/archive', '/phone/api/settings', '/phone/api/config', '/phone/api/flows',
  '/phone/api/summary/../answer', '//api/status', '/PHONE', '/phone/API/summary', '/phonex', '/phone/manifest.webmanifest/x',
]

test('a dozen-plus desktop routes and files are 404 on the phone listener, signed in or not', async () => {
  const user = await signIn()
  for (const p of DESKTOP) {
    for (const headers of [{}, asUser(user)]) {
      const r = await request('GET', p, { headers })
      assert.equal(r.status, 404, `GET ${p}`)
    }
  }
  for (const p of ['/api/flows/x/answer', '/api/flows/x/delete', '/api/settings/pin', '/api/settings/send', '/api/chat/send', '/api/flows/x/pr', '/phone/api/delete', '/phone/api/archive', '/phone/api/status', '/phone/api/summary', '/phone', '/phone/api/orchestration', '/phone/api/flow', '/phone/api/flow?id=x']) {
    const r = await write(p, {}, asUser(user))
    assert.equal(r.status, 404, `POST ${p}`)
  }
  assert.deepEqual(calls, [])
})

test('only GET and POST, each on its own paths: any other method is 404', async () => {
  const user = await signIn()
  for (const m of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    for (const p of ['/phone', '/phone/login', '/phone/api/answer', '/phone/api/summary']) assert.equal((await request(m, p, { headers: asUser(user) })).status, 404, `${m} ${p}`)
  }
  assert.equal((await request('GET', '/phone/api/answer', { headers: asUser(user) })).status, 404)
  assert.equal((await request('GET', '/phone/login')).status, 404)
})

test('the phone page and its own assets are served, each with its type', async () => {
  for (const [p, type] of Object.entries({
    '/phone': 'text/html', '/phone/': 'text/html', '/phone/phone.css': 'text/css', '/phone/phone-state.js': 'text/javascript', '/phone/phone-view.js': 'text/javascript',
    '/phone/phone-app.js': 'text/javascript', '/phone/phone-text.js': 'text/javascript', '/phone/phone-chat.js': 'text/javascript', '/phone/phone-composer.js': 'text/javascript', '/phone/phone-agents.js': 'text/javascript', '/phone/phone-chat-live.js': 'text/javascript', '/phone/manifest.webmanifest': 'application/manifest+json', '/phone/icon.svg': 'image/svg+xml', '/phone/icon-180.png': 'image/png', '/phone/inter.woff2': 'font/woff2',
  })) {
    const r = await request('GET', p)
    assert.equal(r.status, 200, p)
    assert.ok(r.headers['content-type'].startsWith(type), `${p}: ${r.headers['content-type']}`)
  }
})

test('every answer carries the security headers: no-store (the page files: revalidated), a self-only CSP with no inline script, nosniff, no referrer, no frames', async () => {
  const user = await signIn()
  const files = [await request('GET', '/phone'), await request('GET', '/phone/phone-app.js')]
  const answers = [
    ...files, await request('GET', '/nope'), await request('GET', '/phone/api/summary'),
    await request('GET', '/phone/api/summary', { headers: asUser(user) }), await write('/phone/api/answer', {}, { cookie: user.cookie }),
    await write('/phone/login', { pin: '000000' }), await request('GET', '/phone', { headers: { host: 'evil.example' } }),
  ]
  for (const r of answers) {
    // the page's own files are cacheable on purpose (phone-assets.mjs, tested in phone-assets.test.mjs); nothing else
    assert.equal(r.headers['cache-control'], files.includes(r) ? 'no-cache' : 'no-store')
    const csp = r.headers['content-security-policy']
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /script-src 'self'(;|$)/)
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/)
    assert.match(csp, /frame-ancestors 'none'/)
    assert.equal(r.headers['x-content-type-options'], 'nosniff')
    assert.equal(r.headers['referrer-policy'], 'no-referrer')
    assert.equal(r.headers['x-frame-options'], 'DENY')
  }
})

test('the phone page holds no inline script or style, so the CSP needs none', () => {
  const page = fs.readFileSync(path.join(HERE, '..', 'public', 'phone.html'), 'utf8')
  assert.doesNotMatch(page, /<script(?![^>]*\ssrc=)[^>]*>/, 'every script has a src')
  assert.doesNotMatch(page, /\son[a-z]+=/i, 'no inline event handler')
  assert.doesNotMatch(page, /<style|\sstyle=/i)
})

test('every script and stylesheet the phone page loads is in the fixed asset map, and no other script is served', () => {
  const page = fs.readFileSync(path.join(HERE, '..', 'public', 'phone.html'), 'utf8')
  const loaded = [...page.matchAll(/(?:src|href)="(\/phone\/[^"]+)"/g)].map(m => m[1])
  for (const p of loaded) assert.ok(P.ASSETS[p], `${p} is served`)
  const scripts = Object.keys(P.ASSETS).filter(p => p.endsWith('.js'))
  assert.deepEqual(scripts.sort(), loaded.filter(p => p.endsWith('.js')).sort())
})

test('a request addressed to any other host is refused (DNS rebinding)', async () => {
  for (const host of ['evil.example', `evil.example:${own.port}`, `localhost:${own.port}`, `127.0.0.1:${own.port + 1}`, `127.0.0.1:${own.port}.evil.example`, `192.168.1.36:${own.port}`]) {
    assert.equal((await request('GET', '/phone', { headers: { host } })).status, 403, host)
  }
})

test('a request with no Host header at all is refused', async () => {
  assert.ok((await request('GET', '/phone', { headers: { host: null } })).status >= 400)
})

test('when phone access is turned off in config.json the listener answers nothing but that it is off', async () => {
  const user = await signIn()
  settings = { ...settings, enabled: false }
  for (const p of ['/phone', '/phone/api/summary']) {
    const r = await request('GET', p, { headers: asUser(user) })
    assert.equal(r.status, 503)
    assert.match(r.text, /Phone access is off/)
  }
  settings = { ...settings, enabled: true, bind: '10.9.9.9' } // the block now names another address: this listener is stale
  assert.equal((await request('GET', '/phone')).status, 503)
  assert.deepEqual(calls, [])
})

test('turned off, the listener asks once to be closed (the wiring closes the server)', async () => {
  let offs = 0
  current = handler({ onOff: () => offs++ })
  assert.equal((await request('GET', '/phone')).status, 200)
  assert.equal(offs, 0)
  settings = { ...settings, enabled: false }
  await request('GET', '/phone')
  await request('GET', '/phone/api/summary')
  assert.equal(offs, 1)
})

// ═══ sign-in ═══

test('the right PIN signs in: an HttpOnly SameSite=Strict cookie on /phone, the CSRF token, and never the PIN', async () => {
  const { r, cookie, csrf } = await signIn()
  assert.equal(r.status, 200)
  const set = r.headers['set-cookie'][0]
  assert.match(set, /HttpOnly/)
  assert.match(set, /SameSite=Strict/)
  assert.match(set, /Path=\/phone/)
  assert.match(cookie, /^phone_session=[A-Za-z0-9_-]{43}$/)
  assert.match(csrf, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(r.text.includes(PIN), false)
  assert.equal(JSON.stringify(r.headers).includes(PIN), false)
  const me = await request('GET', '/phone/api/me', { headers: { cookie } })
  assert.equal(me.status, 200)
  assert.equal(me.json.csrf, csrf, 'a reload of the page gets the same CSRF token back')
})

test('a wrong PIN is 401; five lock sign-in, and the lock holds across a restart of the listener', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await signIn('111111')).r.status, 401)
  assert.equal((await signIn('111111')).r.status, 429)
  assert.equal((await signIn()).r.status, 429, 'even the right PIN')
  auth = makeAuthStore({ file: authFile, now: () => clock.t, log: () => {} }) // a restart: a new store on the same file
  current = handler()
  const after = await signIn()
  assert.equal(after.r.status, 429)
  assert.match(after.r.json.error, /locked/)
  assert.equal(after.cookie, '')
  clock.t += 15 * 60_000 + 1
  assert.equal((await signIn()).r.status, 200)
})

test('sign-in needs the listener own Origin, JSON, and a small body', async () => {
  for (const origin of [undefined, 'http://evil.example', `http://localhost:${own.port}`, `https://127.0.0.1:${own.port}`, 'null']) {
    const r = await request('POST', '/phone/login', { body: { pin: PIN }, headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) } })
    assert.equal(r.status, 403, String(origin))
  }
  assert.equal((await write('/phone/login', { pin: PIN }, { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await write('/phone/login', { pin: PIN }, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await write('/phone/login', '{not json')).status, 400)
  assert.equal((await write('/phone/login', { pin: 'x'.repeat(20_000) })).status, 413)
  assert.equal(auth.read().sessions.length, 0)
})

test('sign-in is rate limited per address before the PIN is checked', async () => {
  current = handler({ limits: { ...LIMITS, login: { max: 3, ms: 60_000 } } })
  for (let i = 0; i < 3; i++) await signIn('222222')
  const r = await signIn()
  assert.equal(r.r.status, 429)
  assert.match(r.r.json.error, /Too many tries/)
})

// ═══ the API: cookie, CSRF, Origin ═══

const WRITES = [['/phone/api/answer', { flowId: 'f', nodeId: 'a1', answer: 'yes' }], ['/phone/api/tick', { flowId: 'f', step: 'h1', done: true }], ['/phone/api/complete', { flowId: 'f' }], ['/phone/api/talk', { text: 'hi' }], ['/phone/logout', {}]]

test('every write without a cookie, with a cookie and no CSRF token, with a wrong one, or from another Origin is refused', async () => {
  const user = await signIn()
  const other = await signIn()
  for (const [p, body] of WRITES) {
    assert.equal((await write(p, body)).status, 401, `${p} no cookie`)
    assert.equal((await write(p, body, { cookie: user.cookie })).status, 403, `${p} no CSRF`)
    assert.equal((await write(p, body, { cookie: user.cookie, 'x-phone-csrf': other.csrf })).status, 403, `${p} another session CSRF`)
    assert.equal((await write(p, body, { cookie: user.cookie, 'x-phone-csrf': 'x'.repeat(43) })).status, 403, `${p} made-up CSRF`)
    for (const origin of ['http://evil.example', `http://localhost:${own.port}`]) assert.equal((await write(p, body, { ...asUser(user), origin })).status, 403, `${p} from ${origin}`)
    const noOrigin = await request('POST', p, { body, headers: { 'content-type': 'application/json', ...asUser(user) } })
    assert.equal(noOrigin.status, 403, `${p} no Origin`)
    assert.equal((await write(p, body, { ...asUser(user), 'content-type': 'text/plain' })).status, 415, `${p} not JSON`)
  }
  assert.deepEqual(calls, [])
  assert.ok(auth.session(user.cookie.split('=')[1], 12), 'the refused logout did not sign out')
})

test('with the cookie, the CSRF token and the own Origin, each write reaches exactly its one action', async () => {
  const user = await signIn()
  for (const [p, body] of WRITES.slice(0, 4)) assert.equal((await write(p, body, asUser(user))).status, 200, p)
  assert.deepEqual(calls.map(c => c[0]), ['answer', 'tick', 'complete', 'talkSend'])
  assert.deepEqual(calls[0][1], WRITES[0][1])
  for (const p of ['/phone/api/summary', '/phone/api/talk']) assert.equal((await request('GET', p, { headers: { cookie: user.cookie } })).status, 200)
  assert.deepEqual(calls.slice(4).map(c => c[0]), ['summary', 'talk'])
})

test('a read without a session is 401 and clears the cookie; a made-up cookie is no session', async () => {
  for (const cookie of [undefined, 'phone_session=' + 'A'.repeat(43), 'phone_session=garbage']) {
    const r = await request('GET', '/phone/api/summary', { headers: cookie ? { cookie } : {} })
    assert.equal(r.status, 401)
    assert.equal(r.json.signedOut, true)
    assert.match(r.headers['set-cookie'][0], /Max-Age=0/)
  }
  assert.deepEqual(calls, [])
})

test('a session expires after sessionHours', async () => {
  const user = await signIn()
  clock.t += 12 * 3600_000 - 1000
  assert.equal((await request('GET', '/phone/api/summary', { headers: { cookie: user.cookie } })).status, 200)
  clock.t += 2000
  assert.equal((await request('GET', '/phone/api/summary', { headers: { cookie: user.cookie } })).status, 401)
})

test('sign out ends that session; Sign out everywhere (the desktop) ends every one', async () => {
  const a = await signIn()
  const b = await signIn()
  const out = await write('/phone/logout', {}, asUser(a))
  assert.equal(out.status, 200)
  assert.match(out.headers['set-cookie'][0], /Max-Age=0/)
  assert.equal((await request('GET', '/phone/api/summary', { headers: { cookie: a.cookie } })).status, 401)
  assert.equal((await request('GET', '/phone/api/summary', { headers: { cookie: b.cookie } })).status, 200)
  auth.signOutEverywhere()
  assert.equal((await request('GET', '/phone/api/summary', { headers: { cookie: b.cookie } })).status, 401)
})

test('the API is rate limited per session, and the listener per address', async () => {
  current = handler({ limits: { ...LIMITS, read: { max: 5, ms: 60_000 } } })
  const user = await signIn()
  for (let i = 0; i < 5; i++) assert.equal((await request('GET', '/phone/api/summary', { headers: { cookie: user.cookie } })).status, 200)
  const r = await request('GET', '/phone/api/summary', { headers: { cookie: user.cookie } })
  assert.equal(r.status, 429)
  assert.ok(Number(r.headers['retry-after']) > 0)
  current = handler({ limits: { ...LIMITS, address: { max: 4, ms: 60_000 } } })
  for (let i = 0; i < 4; i++) await request('GET', '/phone')
  assert.equal((await request('GET', '/phone')).status, 429)
})

test('a session may read 180 times a minute; its writes keep their own limit of 60, and neither uses up the other', async () => {
  current = handler({ limits: { ...PHONE_LIMITS, address: { max: 10_000, ms: 60_000 } } })
  assert.equal(PHONE_LIMITS.read.max, 180)
  assert.equal(PHONE_LIMITS.session.max, 60, 'writes stay as they were')
  const user = await signIn()
  for (let i = 0; i < 60; i++) assert.notEqual((await write('/phone/api/answer', {}, asUser(user))).status, 429, `write ${i + 1}`)
  assert.equal((await write('/phone/api/answer', {}, asUser(user))).status, 429, 'the 61st write')
  for (let i = 0; i < 180; i++) assert.equal((await request('GET', '/phone/api/summary', { headers: { cookie: user.cookie } })).status, 200, `read ${i + 1}`)
  const r = await request('GET', '/phone/api/summary', { headers: { cookie: user.cookie } })
  assert.equal(r.status, 429, 'the 181st read')
  assert.ok(Number(r.headers['retry-after']) > 0)
  clock.t += 60_000
  assert.equal((await request('GET', '/phone/api/me', { headers: { cookie: user.cookie } })).status, 200, 'a new minute')
})

test('the PIN never appears in config, the auth file, the console or any answer', async () => {
  const seen = []
  const user = await signIn()
  seen.push(JSON.stringify(user.r))
  for (let i = 0; i < 5; i++) seen.push(JSON.stringify((await signIn(`${PIN.slice(0, 9)}${i}`)).r))
  seen.push(JSON.stringify(await request('GET', '/phone/api/me', { headers: { cookie: user.cookie } })))
  seen.push(fs.readFileSync(authFile, 'utf8'), logged.join('\n'))
  for (const s of seen) assert.equal(s.includes(PIN), false)
})

test('a broken request body never reaches an action', async () => {
  const user = await signIn()
  for (const body of ['{', '[]', '"text"', 'null']) assert.equal((await write('/phone/api/answer', body, asUser(user))).status, 400, body)
  assert.deepEqual(calls, [])
})

// ═══ the orchestration: two more reads, nothing more ═══

test('the orchestration and a flow sheet are GET only, behind the session, and a flow id comes from the address alone', async () => {
  for (const p of ['/phone/api/orchestration', '/phone/api/flow?id=login']) {
    const r = await request('GET', p)
    assert.equal(r.status, 401, `${p} without a session`)
    assert.equal(r.headers['cache-control'], 'no-store')
  }
  const user = await signIn()
  for (const m of ['PUT', 'DELETE', 'PATCH']) assert.equal((await request(m, '/phone/api/flow?id=x', { headers: asUser(user) })).status, 404)
  assert.equal((await write('/phone/api/orchestration', {}, asUser(user))).status, 404, 'a POST to a read is 404, CSRF or not')
  assert.equal((await write('/phone/api/flow', { id: 'x' }, asUser(user))).status, 404)
  assert.deepEqual(calls, [])
  assert.equal((await request('GET', '/phone/api/orchestration', { headers: { cookie: user.cookie } })).status, 200)
  assert.equal((await request('GET', '/phone/api/flow?id=login-page&id=other&flowId=x', { headers: { cookie: user.cookie } })).status, 200)
  await request('GET', '/phone/api/flow', { headers: { cookie: user.cookie } })
  assert.deepEqual(calls, [['orchestration', {}], ['flow', { id: 'login-page' }], ['flow', { id: null }]], 'only the first id, as given: the action checks it')
})

test('the API table is exactly the nine actions (the pull request read among them) and the one setting', () => {
  assert.deepEqual(Object.keys(P.API).sort(), ['GET /phone/api/flow', 'GET /phone/api/orchestration', 'GET /phone/api/pr', 'GET /phone/api/summary', 'GET /phone/api/talk', 'POST /phone/api/answer', 'POST /phone/api/complete', 'POST /phone/api/prefs', 'POST /phone/api/talk', 'POST /phone/api/tick'])
})

// ═══ reading a pull request, and the one setting ═══

test('the pull request read is GET only, behind the session, and passes on only flow, n and which keys were given', async () => {
  for (const p of ['/phone/api/pr?flow=login', '/phone/api/pr?n=12']) {
    const r = await request('GET', p)
    assert.equal(r.status, 401, `${p} without a session`)
    assert.equal(r.headers['cache-control'], 'no-store')
  }
  const user = await signIn()
  assert.equal((await write('/phone/api/pr', { flow: 'login' }, asUser(user))).status, 404, 'a POST to it is 404, CSRF or not')
  for (const m of ['PUT', 'DELETE', 'PATCH']) assert.equal((await request(m, '/phone/api/pr?flow=x', { headers: asUser(user) })).status, 404)
  assert.deepEqual(calls, [])
  await request('GET', '/phone/api/pr?flow=login-page&flow=other', { headers: { cookie: user.cookie } })
  await request('GET', '/phone/api/pr?n=12&repo=evil/x', { headers: { cookie: user.cookie } })
  assert.deepEqual(calls, [['pr', { flow: 'login-page', n: null, keys: ['flow'] }], ['pr', { flow: null, n: '12', keys: ['n', 'repo'] }]])
})

test('end to end with the real reader: a repo, a link or a pull request the list does not hold is 404, and gh is never asked', async () => {
  const { makePrReader } = await import('../phone-pr.mjs')
  const asked = []
  const gh = async args => (asked.push(args), args[1] === 'view' ? { ok: true, out: JSON.stringify({ title: 'Login', state: 'OPEN' }) } : { ok: true, out: '' })
  const list = [{ url: 'https://github.com/acme/shop/pull/12', number: 12, title: 'Login', flow: { id: 'login-page', title: 'Login page' } }]
  const reader = makePrReader({ gh, prs: () => list })
  current = handler({ actions: { ...actions, pr: b => reader.read(b) } })
  const user = await signIn()
  const get = p => request('GET', p, { headers: { cookie: user.cookie } })
  for (const p of [
    '/phone/api/pr?flow=other', '/phone/api/pr?n=13', '/phone/api/pr', '/phone/api/pr?repo=acme/shop&n=12', '/phone/api/pr?n=12&url=https://github.com/evil/x/pull/12',
    '/phone/api/pr?flow=https%3A%2F%2Fgithub.com%2Facme%2Fshop%2Fpull%2F12', '/phone/api/pr?flow=login-page&repo=evil%2Fx', '/phone/api/pr?url=https://github.com/acme/shop/pull/12',
    '/phone/api/pr?flow=..%2Flogin-page', '/phone/api/pr?n=12%20--web', '/phone/api/pr?n=--web',
  ]) {
    const r = await get(p)
    assert.equal(r.status, 404, p)
    assert.match(r.json.error, /not on the list/, p)
  }
  assert.deepEqual(asked, [])
  const ok = await get('/phone/api/pr?flow=login-page')
  assert.equal(ok.status, 200)
  assert.equal(ok.json.url, 'https://github.com/acme/shop/pull/12')
  assert.deepEqual(asked.map(a => a.slice(0, 4)), [['pr', 'view', '12', '--repo=acme/shop'], ['pr', 'diff', '12', '--repo=acme/shop']])
})

test('the one setting: only { prLinks: here | github }, kept on THIS session alone, and /me gives it back', async () => {
  const user = await signIn()
  const other = await signIn()
  assert.equal((await request('GET', '/phone/api/me', { headers: { cookie: user.cookie } })).json.prLinks, 'here', 'here unless changed')
  for (const body of [{}, { prLinks: 'elsewhere' }, { prLinks: 'GITHUB' }, { prLinks: true }, { prLinks: ['github'] }, { prLinks: 'github', theme: 'dark' }, { theme: 'dark' }, { pinHash: 'x' }]) {
    const r = await write('/phone/api/prefs', body, asUser(user))
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.match(r.json.error, /Only/)
  }
  for (const raw of ['{"prLinks":"github","constructor":{"prototype":{"x":1}}}', '{"prLinks":"github","__proto__":{"x":1}}', '{"__proto__":{"prLinks":"github"}}']) {
    assert.equal((await write('/phone/api/prefs', raw, asUser(user))).status, 400, raw)
  }
  const r = await write('/phone/api/prefs', { prLinks: 'github' }, asUser(user))
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, prLinks: 'github' })
  assert.equal((await request('GET', '/phone/api/me', { headers: { cookie: user.cookie } })).json.prLinks, 'github')
  assert.equal((await request('GET', '/phone/api/me', { headers: { cookie: other.cookie } })).json.prLinks, 'here', 'another phone keeps its own')
  assert.equal((await request('GET', '/phone/api/prefs', { headers: { cookie: user.cookie } })).status, 404, 'no GET of it')
  assert.deepEqual(calls, [], 'no action is reached: the setting is the session record only')
  // what was written is the session's own record and nothing else; the file still reads back clean
  const file = JSON.parse(fs.readFileSync(authFile, 'utf8'))
  assert.deepEqual(file.sessions.map(x => x.prLinks || null).sort(), ['github', null].sort())
  assert.equal(JSON.stringify(file).includes('theme'), false)
  // a new sign-in starts at here again
  assert.equal((await request('GET', '/phone/api/me', { headers: { cookie: (await signIn()).cookie } })).json.prLinks, 'here')
})

test('the setting is refused without a session, a CSRF token or the page own Origin, before anything is written', async () => {
  const user = await signIn()
  const other = await signIn()
  const before = fs.readFileSync(authFile, 'utf8')
  assert.equal((await write('/phone/api/prefs', { prLinks: 'github' })).status, 401)
  assert.equal((await write('/phone/api/prefs', { prLinks: 'github' }, { cookie: user.cookie })).status, 403)
  assert.equal((await write('/phone/api/prefs', { prLinks: 'github' }, { cookie: user.cookie, 'x-phone-csrf': other.csrf })).status, 403, 'another session CSRF')
  assert.equal((await write('/phone/api/prefs', { prLinks: 'github' }, { cookie: user.cookie, 'x-phone-csrf': 'x'.repeat(43) })).status, 403)
  assert.equal((await request('POST', '/phone/api/prefs', { body: { prLinks: 'github' }, headers: { 'content-type': 'application/json', ...asUser(user) } })).status, 403, 'no Origin')
  assert.equal((await write('/phone/api/prefs', { prLinks: 'github' }, { ...asUser(user), origin: `http://localhost:${own.port}` })).status, 403)
  assert.equal((await write('/phone/api/prefs', { prLinks: 'github' }, { ...asUser(user), origin: 'http://evil.example' })).status, 403)
  assert.equal((await write('/phone/api/prefs', { prLinks: 'github' }, { ...asUser(user), 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await write('/phone/api/prefs', { prLinks: 'github' }, { ...asUser(user), 'content-type': 'text/plain' })).status, 415)
  assert.equal(fs.readFileSync(authFile, 'utf8'), before)
})

// ═══ the listener itself ═══

test('with no remote block, or one that is off, NOTHING new listens: the server is never even created', () => {
  for (const s of [{ enabled: false, configured: false }, { enabled: false, configured: true, off: 'Phone access is off.' }]) {
    let made = 0
    const r = P.startPhoneListener({ settings: s, createServer: () => { made++; return { listen() {} } }, handler: () => {}, log: () => {} })
    assert.equal(r, null)
    assert.equal(made, 0)
  }
})

test('an enabled block opens exactly one listener, on its one address and port', async () => {
  const listened = []
  const fake = { listen: (port, host, cb) => (listened.push([port, host]), cb?.()), on() {}, setTimeout() {}, headersTimeout: 0, requestTimeout: 0 }
  const r = P.startPhoneListener({ settings: { enabled: true, bind: '192.168.1.36', port: 4318, url: 'http://192.168.1.36:4318/phone' }, createServer: () => fake, handler: () => {}, log: () => {} })
  assert.equal(r, fake)
  assert.deepEqual(listened, [[4318, '192.168.1.36']])
  assert.ok(fake.requestTimeout > 0 && fake.headersTimeout > 0, 'a slow client cannot hold a connection open forever')
})

test('server.mjs keeps its one 127.0.0.1 listener and starts the phone through startPhone only', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'server.mjs'), 'utf8')
  assert.equal((src.match(/\.listen\(|listenWhenFree\(/g) || []).length, 1)
  assert.match(src, /listenWhenFree\(server, PORT, '127\.0\.0\.1'\)/)
  assert.match(src, /startPhone\(\{[^}]*alerts: \(\) => predictRoute\.alerts\(\)/, 'the Agents tab reads the same alerts as the desktop')
  assert.match(src, /startPhone\(\{[^}]*prs: \(\) => prListRoute\.list\.snapshot\(\)\.items/, 'and the same Pull requests list as the fog block')
  assert.equal((src.match(/startPhone\(/g) || []).length, 1)
  assert.doesNotMatch(src, /0\.0\.0\.0/)
})

test('13 sign-ins at once: exactly 5 PINs are checked, the rest are refused by the lock without a check', async () => {
  let checked = 0
  auth = makeAuthStore({ file: authFile, now: () => clock.t, log: () => {}, verify: () => (checked++, false) })
  current = handler()
  const all = await Promise.all(Array.from({ length: 13 }, () => signIn('11223344')))
  assert.equal(checked, 5)
  assert.deepEqual(all.map(a => a.r.status).sort(), [...Array(4).fill(401), ...Array(9).fill(429)].sort())
})

test('a third lockout within 24 hours turns phone access off through onEscalate, and says so', async () => {
  let escalations = 0
  current = handler({ onEscalate: () => escalations++ })
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 5; i++) await signIn('11223344')
    if (round < 2) clock.t += 15 * 60_000 + 1
  }
  assert.equal(escalations, 1)
  const last = await signIn('11223344')
  assert.equal(last.r.status, 429)
})

test('cookie tossing: another phone_session cookie set first by another service on this IP does not hide the real one', async () => {
  const user = await signIn()
  const real = user.cookie.split('=')[1]
  const tossed = `phone_session=${'B'.repeat(43)}; ${user.cookie}`
  assert.equal((await request('GET', '/phone/api/summary', { headers: { cookie: tossed } })).status, 200)
  assert.equal((await write('/phone/api/answer', {}, { cookie: tossed, 'x-phone-csrf': user.csrf })).status, 200, 'the CSRF token is checked against the cookie that matched')
  assert.equal((await write('/phone/api/answer', {}, { cookie: `phone_session=${'B'.repeat(43)}`, 'x-phone-csrf': user.csrf })).status, 401)
  assert.ok(real)
})

test('a request the phone gives up on mid-body is not logged as a server error', async () => {
  const net = await import('node:net')
  const errors = []
  const was = console.error
  console.error = (...a) => errors.push(a.join(' '))
  try {
    const user = await signIn()
    await new Promise(resolve => {
      const sock = net.connect(own.port, '127.0.0.1', () => {
        sock.write(`POST /phone/api/talk HTTP/1.1\r\nHost: 127.0.0.1:${own.port}\r\nOrigin: ${ORIGIN()}\r\nContent-Type: application/json\r\nCookie: ${user.cookie}\r\nX-Phone-CSRF: ${user.csrf}\r\nContent-Length: 500\r\n\r\n{"text":"hal`)
        setTimeout(() => { sock.destroy(); setTimeout(resolve, 100) }, 50)
      })
      sock.on('error', () => {})
    })
  } finally {
    console.error = was
  }
  assert.deepEqual(errors.filter(e => /phone:/.test(e)), [])
})

/** One raw request on a raw socket: the request line and headers exactly as given, nothing normalised by a client. */
async function raw(line, extra = '') {
  const net = await import('node:net')
  return new Promise(resolve => {
    let data = ''
    const sock = net.connect(own.port, '127.0.0.1', () => sock.write(`${line}\r\nHost: 127.0.0.1:${own.port}\r\n${extra}Connection: close\r\n\r\n`))
    sock.on('data', c => (data += c))
    sock.on('end', () => resolve({ status: Number((/^HTTP\/1\.1 (\d{3})/.exec(data) || [])[1] || 0), data }))
    sock.on('error', () => resolve({ status: 0, data }))
  })
}

test('raw requests: encoded dot-dot, backslashes, double slashes, ::$DATA, 8.3 names, absolute request lines and method tricks all get nothing', async () => {
  const user = await signIn()
  const auth$ = `Cookie: ${user.cookie}\r\n`
  const P = own.port
  const notFound = [
    'GET /phone/%2e%2e/config.json HTTP/1.1', 'GET /phone/%2E%2E/%2E%2E/config.json HTTP/1.1', 'GET /phone/..%2fconfig.json HTTP/1.1', 'GET /phone/..%5cconfig.json HTTP/1.1',
    'GET /phone/%5c..%5c..%5cconfig.json HTTP/1.1', 'GET //phone HTTP/1.1', 'GET /phone//phone.css HTTP/1.1', 'GET //api/status HTTP/1.1', 'GET ///phone/../../config.json HTTP/1.1',
    'GET /phone/phone.css::$DATA HTTP/1.1', 'GET /phone/phone.html::$DATA HTTP/1.1', 'GET /phone/PHONE~1.CSS HTTP/1.1', 'GET /PHONE~1.HTM HTTP/1.1', 'GET /CONFIG~1.JSO HTTP/1.1',
    'GET /phone/phone.css%00 HTTP/1.1', 'GET /phone/phone.css. HTTP/1.1', 'GET /phone/phone.css%20 HTTP/1.1', 'GET /Phone HTTP/1.1', 'GET /phone/Phone.css HTTP/1.1',
    `GET http://127.0.0.1:${P}/api/status HTTP/1.1`, `GET http://127.0.0.1:${P}/phone/../config.json HTTP/1.1`, `GET http://evil.example/api/status HTTP/1.1`,
    'POST /phone/phone.css HTTP/1.1', 'POST /phone HTTP/1.1', 'TRACE /phone HTTP/1.1', 'OPTIONS * HTTP/1.1', 'OPTIONS /phone/api/answer HTTP/1.1', 'HEAD /phone HTTP/1.1',
    'PROPFIND /phone HTTP/1.1', 'DELETE /phone/api/answer HTTP/1.1', 'PUT /phone/phone.css HTTP/1.1',
  ]
  for (const line of notFound) {
    const r = await raw(line, auth$)
    assert.equal(r.status, 404, line)
    assert.doesNotMatch(r.data, /"repo"|<!doctype|pinHash/i, line)
  }
  // the HTTP parser itself refuses these before any handler runs: never a 2xx, never a file
  for (const line of ['GET /phone\..\config.json HTTP/1.1', 'get /phone HTTP/1.1', 'CONNECT 127.0.0.1:80 HTTP/1.1', 'GET /phone HTTP/9.9']) {
    const r = await raw(line, auth$)
    assert.ok(r.status === 400 || r.status === 404 || r.status === 0 || r.status === 505, `${line}: ${r.status}`)
    assert.doesNotMatch(r.data, /"repo"|<!doctype|pinHash/i, line)
  }
  // two spaces: the parser reads it as GET /phone, so it is the phone page itself, nothing more
  assert.equal((await raw('GET  /phone HTTP/1.1')).status, 200)
  assert.equal((await raw('GET  /api/status HTTP/1.1', auth$)).status, 404)
  // a method override header changes nothing: a GET to a write route is still a 404
  assert.equal((await raw('GET /phone/api/answer HTTP/1.1', `${auth$}X-HTTP-Method-Override: POST\r\nX-Method-Override: POST\r\n`)).status, 404)
  assert.deepEqual(calls, [])
})
