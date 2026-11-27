// The phone listener: a SECOND http server, on the one private address the remote block names (phone-bind.mjs),
// that serves the phone page and nothing else. The desktop dashboard keeps its own listener on 127.0.0.1 and is
// never reachable from here: no desktop route, no evidence file, no config, no other file of public/.
//
// WHAT IT SERVES (every other method and path is a 404, before any session is even looked at):
//   GET  /phone, /phone/          the phone page (public/phone.html)
//   GET  /phone/<asset>           its own assets, from a FIXED map (ASSETS): never a path built from the request
//   POST /phone/login             { pin }: sign in (phone-auth.mjs), sets the session cookie, answers { csrf, expiresAt }
//   POST /phone/logout            sign this phone out
//   GET  /phone/api/me            { csrf, expiresAt, prLinks }: a reloaded page gets its CSRF token and its option back
//   POST /phone/api/prefs         { prLinks: 'here' | 'github' } and NOTHING else (phone-auth.mjs prefsProblem): the page's
//                                 one option, on this session's own record; no action, nothing outside that record
//   GET  /phone/api/summary       \
//   GET  /phone/api/orchestration  |  (read only: the Agents tab, phone-orchestration.mjs)
//   GET  /phone/api/flow?id=       |  (read only: one flow's sheet; only the first id in the address is passed on)
//   GET  /phone/api/pr?flow= | ?n= |  (read only: one pull request the Pull requests list holds, phone-pr.mjs; only
//                                  |  the first flow and n are passed on, with which keys the address had)
//   GET  /phone/api/talk           |  the allowlist (phone-actions.mjs): each a named action, never a forwarded path
//   POST /phone/api/answer         |
//   POST /phone/api/tick           |
//   POST /phone/api/complete       |
//   POST /phone/api/talk          /
//
// THE CHECKS, in this order, each answered with one plain sentence:
//   1. Phone access is still on, for THIS address and port (the block is re-read when config.json changes), else
//      a 503 to that request and the listener closes (onOff): turning it off shuts the door without a restart.
//   2. The Host is exactly <bind>:<port> (a website that rebinds its name to this address is refused), else 403.
//   3. A GET of one of the page's own files whose If-None-Match names its ETag now is a 304 here, counted only
//      against the revalidate ceiling (phone-limits.mjs), NOT the address limit: a reload costs nothing
//      (phone-assets.mjs says why). Past that ceiling it goes on to 4 like any request.
//   4. The address has not passed its rate limit (phone-limits.mjs), else 429.
//   5. The path and method are on the list above, else 404.
//   6. /phone/api/* and logout: a live session cookie (else 401, and the cookie is cleared), then the session's
//      rate limit (429): its reads (GET) and its writes (POST) each have their own (phone-limits.mjs read, session).
//   7. Every POST: an Origin equal to http://<bind>:<port> and, when the browser says, Sec-Fetch-Site same-origin
//      (403); every POST but sign-in: the session's CSRF token in X-Phone-CSRF (403); a JSON content type (415); a
//      body of at most BODY_MAX bytes (413) that is a JSON object (400).
// Every answer, a 404 and a 304 included, carries a self-only Content-Security-Policy with no inline script or
// style, nosniff, no referrer and no framing (SECURITY_HEADERS), and no-store, with ONE exception: the page's own
// files (ASSETS) carry an ETag and either a year-long immutable cache (asked for with their current ?v= version)
// or no-cache (kept, but asked again first). The API and every error stay no-store.
//
// ⚠️ Plain HTTP on a private network, on purpose (README, Phone access): no TLS, no tunnel, nothing public. The
// PIN, the cookie and the pages cross the network as they are; Tailscale encrypts that link, and home Wi-Fi with
// WPA2 or better encrypts the air. Never forward this port on a router.
//
//   makePhoneHandler({ settings, own, auth, actions, limits?, now?, publicDir? })   (req, res) => void
//   startPhoneListener({ settings, handler, createServer?, log? })   the server, or null when nothing should listen

import { createServer as httpCreateServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { cachePolicy, etagMatches, makePhoneAssets } from './phone-assets.mjs'
import { clearCookie, csrfOk, prefsProblem, sessionCookie, tokensFromCookie } from './phone-auth.mjs'
import { makeLimiter, PHONE_LIMITS } from './phone-limits.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, 'public')
export const BODY_MAX = 8 * 1024
export const CSRF_HEADER = 'x-phone-csrf'

export const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
})

/** The phone page's files: request path -> [file under public/, content type]. Nothing else of public/ is served. */
export const ASSETS = Object.freeze({
  '/phone': ['phone.html', 'text/html; charset=utf-8'],
  '/phone/': ['phone.html', 'text/html; charset=utf-8'],
  '/phone/phone.css': ['phone.css', 'text/css; charset=utf-8'],
  '/phone/phone-state.js': ['phone-state.js', 'text/javascript; charset=utf-8'],
  '/phone/phone-view.js': ['phone-view.js', 'text/javascript; charset=utf-8'],
  '/phone/phone-text.js': ['phone-text.js', 'text/javascript; charset=utf-8'],
  '/phone/phone-chat.js': ['phone-chat.js', 'text/javascript; charset=utf-8'],
  '/phone/phone-composer.js': ['phone-composer.js', 'text/javascript; charset=utf-8'],
  '/phone/phone-agents.js': ['phone-agents.js', 'text/javascript; charset=utf-8'],
  '/phone/phone-chat-live.js': ['phone-chat-live.js', 'text/javascript; charset=utf-8'],
  '/phone/phone-pr.js': ['phone-pr.js', 'text/javascript; charset=utf-8'],
  '/phone/phone-pr-live.js': ['phone-pr-live.js', 'text/javascript; charset=utf-8'],
  '/phone/phone-app.js': ['phone-app.js', 'text/javascript; charset=utf-8'],
  '/phone/manifest.webmanifest': ['phone-manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/phone/icon.svg': ['phone-icon.svg', 'image/svg+xml'],
  '/phone/icon-180.png': ['phone-icon-180.png', 'image/png'],
  '/phone/inter.woff2': ['fonts/inter-latin-wght-normal.woff2', 'font/woff2'],
})

/** The API: 'METHOD path' -> the action's name in phone-actions.mjs. */
export const API = Object.freeze({
  'GET /phone/api/summary': 'summary',
  'GET /phone/api/orchestration': 'orchestration',
  'GET /phone/api/flow': 'flow',
  'GET /phone/api/pr': 'pr',
  'GET /phone/api/talk': 'talk',
  'POST /phone/api/answer': 'answer',
  'POST /phone/api/tick': 'tick',
  'POST /phone/api/complete': 'complete',
  'POST /phone/api/talk': 'talkSend',
  'POST /phone/api/prefs': 'prefs', // not an action: the session's own record (below)
})

const OFF = 'Phone access is off.'

function send(res, status, body, extra = {}) {
  const isText = typeof body === 'string'
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...extra })
  res.end(isText ? body : JSON.stringify(body))
}

/** The request body as a JSON object; throws { status, message } in plain words. */
async function jsonBody(req) {
  let size = 0
  const parts = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_MAX) throw Object.assign(new Error('That is too much to send at once.'), { status: 413 })
    parts.push(chunk)
  }
  let value
  try {
    value = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')
  } catch {
    throw Object.assign(new Error('That request could not be read.'), { status: 400 })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('That request could not be read.'), { status: 400 })
  return value
}

export function makePhoneHandler({ settings, own, auth, actions, limits = PHONE_LIMITS, now = Date.now, publicDir = PUBLIC, onOff = () => {}, onEscalate = () => {} }) {
  let closing = false
  const byAddress = makeLimiter({ ...limits.address, now })
  const byRevalidate = makeLimiter({ ...(limits.revalidate || PHONE_LIMITS.revalidate), now })
  const files = makePhoneAssets({ assets: ASSETS, publicDir })
  const bySession = makeLimiter({ ...limits.session, now }) // a session's writes
  const byRead = makeLimiter({ ...(limits.read || PHONE_LIMITS.read), now }) // a session's reads
  const byLogin = makeLimiter({ ...limits.login, now })
  const tooMany = (res, r, what = 'Too many requests') => send(res, 429, { error: `${what}. Wait ${r.retryAfter} seconds.` }, { 'retry-after': String(r.retryAfter) })

  /** A POST from the phone page itself: its own Origin, and not a cross-site fetch. */
  function sameSite(req, ownOrigin) {
    if (req.headers.origin !== ownOrigin) return false
    const site = req.headers['sec-fetch-site']
    return site === undefined || site === 'same-origin'
  }
  const isJson = req => /^application\/json(\s*;|$)/i.test(String(req.headers['content-type'] || ''))

  async function login(req, res, s, ownOrigin, address) {
    if (!sameSite(req, ownOrigin)) return send(res, 403, { error: 'Sign in from the phone page itself.' })
    if (!isJson(req)) return send(res, 415, { error: 'That request could not be read.' })
    const limited = byLogin.hit(address)
    if (!limited.ok) return tooMany(res, limited, 'Too many tries from this device')
    const b = await jsonBody(req)
    const r = auth.login({ pin: b.pin, pinHash: s.pinHash, address, sessionHours: s.sessionHours })
    if (r.escalated) onEscalate() // too many lockouts in a day: phone access goes OFF (phone-wiring.mjs)
    if (!r.ok) return send(res, r.status, { error: r.error })
    return send(res, 200, { ok: true, csrf: r.csrf, expiresAt: r.expiresAt }, { 'set-cookie': sessionCookie(r.token, s.sessionHours) })
  }

  return async function phoneHandler(req, res) {
    try {
      const s = settings()
      const me = own()
      if (!s?.enabled || s.bind !== me.bind || s.port !== me.port) {
        // off, or the block now names another address: say so to this request, then stop listening altogether
        if (!closing) { closing = true; onOff() }
        return send(res, 503, OFF, { connection: 'close' })
      }
      const ownHost = `${me.bind}:${me.port}`
      if (req.headers.host !== ownHost) return send(res, 403, 'Unknown host.')
      const address = String(req.socket?.remoteAddress || '')
      const [pathname, query = ''] = String(req.url || '').split('?')
      const isAsset = req.method === 'GET' && Object.hasOwn(ASSETS, pathname)
      // a file the browser already holds: a 304 that the address limit never sees (only its own ceiling)
      if (isAsset && req.headers['if-none-match']) {
        const file = await files.get(pathname)
        if (file && etagMatches(req.headers['if-none-match'], file.etag) && byRevalidate.hit(address).ok) {
          res.writeHead(304, { ...SECURITY_HEADERS, 'cache-control': cachePolicy(query, file.version), etag: file.etag })
          return res.end()
        }
      }
      const limited = byAddress.hit(address)
      if (!limited.ok) return tooMany(res, limited)

      const route = `${req.method} ${pathname}`
      if (isAsset) {
        const file = await files.get(pathname)
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': file.type, 'cache-control': cachePolicy(query, file.version), etag: file.etag })
        return res.end(file.body)
      }
      const ownOrigin = `http://${ownHost}`
      if (route === 'POST /phone/login') return await login(req, res, s, ownOrigin, address)
      const action = API[route]
      const isLogout = route === 'POST /phone/logout'
      if (!action && !isLogout && route !== 'GET /phone/api/me') return send(res, 404, 'Not found.')

      // the first cookie value that is a live session, so one tossed in by another service never hides the real one
      let token = ''
      let session = null
      for (const t of tokensFromCookie(req.headers.cookie)) {
        session = auth.session(t, s.sessionHours)
        if (session) { token = t; break }
      }
      if (!session) return send(res, 401, { error: 'Your phone session has ended. Sign in again.', signedOut: true }, { 'set-cookie': clearCookie() })
      const sessionLimit = (req.method === 'GET' ? byRead : bySession).hit(session.id)
      if (!sessionLimit.ok) return tooMany(res, sessionLimit)

      if (req.method === 'POST') {
        if (!sameSite(req, ownOrigin)) return send(res, 403, { error: 'This only works from the phone page itself.' })
        if (!csrfOk(token, req.headers[CSRF_HEADER])) return send(res, 403, { error: 'The page is out of date. Reload it and try again.' })
        if (!isJson(req)) return send(res, 415, { error: 'That request could not be read.' })
      }
      if (route === 'GET /phone/api/me') return send(res, 200, { ok: true, csrf: session.csrf, expiresAt: session.expiresAt, prLinks: session.prLinks })
      if (isLogout) {
        await jsonBody(req)
        auth.logout(token)
        return send(res, 200, { ok: true }, { 'set-cookie': clearCookie() })
      }
      if (action === 'prefs') {
        const b = await jsonBody(req)
        const problem = prefsProblem(b)
        if (problem) return send(res, 400, { error: problem })
        if (!auth.setPrefs(session.id, b)) return send(res, 503, { error: 'The PC could not save that. Try again in a moment.' })
        return send(res, 200, { ok: true, prLinks: b.prLinks })
      }
      // a GET carries no body; the flow sheet's id is the address's first id, as given (the action checks it); a pull
      // request's flow or number likewise, with the keys the address had, so the action refuses one that names more
      const q = new URLSearchParams(query)
      const body = req.method === 'POST' ? await jsonBody(req)
        : action === 'flow' ? { id: q.get('id') }
        : action === 'pr' ? { flow: q.get('flow'), n: q.get('n'), keys: [...new Set(q.keys())] }
        : {}
      const r = await actions[action](body, { session: session.id.slice(0, 32) })
      return send(res, r.status, r.body)
    } catch (err) {
      if (err?.status) return send(res, err.status, { error: err.message })
      // the phone gave up mid-request (the screen locked, the network went): nothing to answer and nothing to log
      if (err?.code === 'ECONNRESET' || err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || err?.message === 'aborted' || req.destroyed) return void res.destroy()
      console.error(`phone: ${err?.stack || err}`)
      return send(res, 500, { error: 'Something went wrong on the PC.' })
    }
  }
}

/**
 * Open the phone listener when, and only when, the remote block is on (phone-bind.mjs remoteSettings). Off or not
 * set up: no server is even created, and null comes back. `createServer` is injected for the tests.
 */
export function startPhoneListener({ settings, handler, createServer = httpCreateServer, log = m => console.log(m) }) {
  if (!settings?.enabled) return null
  const server = createServer(handler)
  // a slow client cannot hold a connection open: whole request in 20 s, headers in 10 s
  server.requestTimeout = 20_000
  server.headersTimeout = 10_000
  server.on?.('error', err => log(`phone: could not listen on ${settings.bind}:${settings.port} (${err?.code || err?.message || err}). It tries again within a few seconds.`))
  server.listen(settings.port, settings.bind, () => log(`Phone access on ${settings.url} (your private network only; see Settings, Phone)`))
  return server
}
