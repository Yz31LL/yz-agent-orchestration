// Who is signed in on a phone: the phone PIN, the five-try lock, the sessions and their CSRF tokens.
//
// THE PIN is 8 to 12 digits, set by the person in a terminal (`node tools/factory.mjs phone-pin`,
// tools/phone-cli.mjs) and kept only as its salted scrypt hash in config.json (remote.pinHash). It is checked
// with send-pin.mjs verifyPin: scrypt, then a constant-time compare. The PIN itself is never stored, logged or
// returned. It is a different secret from the send PIN on purpose: a phone PIN typed on a phone in a café is
// not the secret that pushes code.
//
// THE LOCK: 5 wrong PINs lock phone sign-in for 15 minutes, for EVERY address (an attacker can change address;
// the user can wait or sign in at the PC). While locked, even the right PIN is refused without being checked.
// The count and the lock are kept ON DISK, so restarting the dashboard does not reset them, and IN MEMORY too: a
// write that fails never loses a wrong try, and a lock this process has seen holds whatever the file says. A file
// that is there but does not parse is kept beside it and LOCKS sign-in for the lock time, so damaging the file is
// never a way to wipe a lock. Each lockout writes one line to the console and one event the Log shows.
// ESCALATION: 3 lockouts within 24 hours turn phone access OFF (the wiring writes remote.enabled false), so the
// guess budget is about 15 tries a day, not 480. A correct sign-in resets the wrong tries, NOT the lockouts.
// ⚠️ Safety over convenience: anyone on the network can lock the user out by guessing badly, and three rounds of
// that turn phone access off until the user turns it on again at the PC. That is the price of a lock that holds.
//
// A SESSION is a random 256-bit token (32 bytes, base64url) in an HttpOnly, SameSite=Strict cookie scoped to
// /phone. Only its SHA-256 is kept, so the auth file alone signs no one in. A session lasts `sessionHours` from
// sign-in (absolute, never extended by use); a lower setting shortens sessions already open. Sign out everywhere
// (the desktop Settings page) drops them all.
//
// ⚠️ The cookie has no Secure flag: phone access is plain HTTP on a private network (README, Phone access), and
// a browser drops a Secure cookie over HTTP. Tailscale encrypts the link; home Wi-Fi with WPA2 or better
// encrypts the air. Anyone who can read the traffic on the network itself can read the cookie.
//
// THE PAGE'S ONE OPTION (Open pull requests: here | on GitHub, public/phone-pr.js) is kept ON THE SESSION's record
// (prLinks), because the phone page stores nothing itself (phone-app.js). It is set through POST /phone/api/prefs
// (phone-server.mjs), which accepts ONLY { prLinks: 'here' | 'github' } (prefsProblem) and writes nothing but that
// one field of that one session; a new sign-in starts at 'here', and the field goes with the session.
//
// THE CSRF TOKEN is an HMAC of the session token (csrfOf): a page on another site can neither read the cookie
// nor compute it, and nothing extra is stored. Every write on the phone API sends it in a header.
//
//   phonePinProblem(pin)          why a new phone PIN is refused, or null
//   makeAuthStore({ file, now, log })   { login, session, logout, signOutEverywhere, lockedFor, events, logEvents, read }
//   prefsProblem(body) / PREFS   why a setting is refused, or null; the one key and its two values
//   csrfOf(token) / csrfOk(token, header)
//   sessionCookie(token, hours) / clearCookie() / tokenFromCookie(header)

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_ROOT } from './project-store.mjs'
import { validPinHash, verifyPin } from './send-pin.mjs'

/** Machine-wide, never per project: the lock and the sessions belong to the PC, whichever project is open. */
export const AUTH_FILE = path.join(DATA_ROOT, 'phone-auth.json')
export const LOCK = Object.freeze({ tries: 5, ms: 15 * 60_000 })
/** ESCALATION: this many lockouts within `withinMs` turn phone access OFF (phone-wiring.mjs), so only the PC can turn it back on. */
export const ESCALATE = Object.freeze({ lockouts: 3, withinMs: 24 * 3600_000 })
export const EVENTS_MAX = 50
const SESSIONS_MAX = 20
const COOKIE = 'phone_session'
const TOKEN = /^[A-Za-z0-9_-]{43}$/
export const EVENT_KINDS = Object.freeze(['login', 'wrong', 'lockout', 'escalate', 'damaged', 'signout', 'signout-all', 'pin', 'config'])

/** The shortest phone PIN: 8 digits, so the guess budget (ESCALATE) covers a tiny share of the 100 million choices. */
export const PIN_MIN = 8

/** The page's one option and its values, the first the default: MUST CHANGE IN LOCKSTEP with public/phone-pr.js. */
export const PREFS = Object.freeze({ prLinks: Object.freeze(['here', 'github']) })

/** Why a setting is refused, or null: exactly the one key, with one of its two values. */
export function prefsProblem(b) {
  const keys = b && typeof b === 'object' && !Array.isArray(b) ? Object.keys(b) : []
  return keys.length === 1 && keys[0] === 'prLinks' && PREFS.prLinks.includes(b.prLinks) ? null : 'Only the pull request setting can be changed here: here or github.'
}

export function phonePinProblem(pin) {
  if (typeof pin !== 'string') return 'The phone PIN must be typed as digits.'
  if (!/^[0-9]*$/.test(pin)) return 'The phone PIN is only digits (0 to 9).'
  if (pin.length < PIN_MIN) return `The phone PIN needs at least ${PIN_MIN} digits.`
  if (pin.length > 12) return 'The phone PIN has at most 12 digits.'
  return null
}

const sha = s => createHash('sha256').update(s).digest('hex')
const same = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

export const csrfOf = token => createHmac('sha256', String(token)).update('phone-csrf').digest('base64url')
export const csrfOk = (token, header) => typeof header === 'string' && !!header && same(csrfOf(token), header)

export const sessionCookie = (token, hours) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/phone; Max-Age=${Math.round(hours * 3600)}`
export const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/phone; Max-Age=0`

/**
 * Every well-formed phone_session value in a Cookie header, in order. Cookies are not kept apart by port, so another
 * service on the same address can set its own phone_session (cookie tossing): the server tries each value, never only
 * the first. At most 5 are taken, so a header stuffed with them costs little.
 */
export function tokensFromCookie(header) {
  const out = []
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at < 0 || part.slice(0, at).trim() !== COOKIE) continue
    const v = part.slice(at + 1).trim()
    if (TOKEN.test(v) && !out.includes(v)) out.push(v)
    if (out.length >= 5) break
  }
  return out
}

/** The first well-formed phone_session value, or ''. */
export const tokenFromCookie = header => tokensFromCookie(header)[0] || ''

const isTime = v => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const EMPTY = () => ({ fails: 0, lockedUntil: null, lockouts: [], seen: null, pinMark: null, sessions: [], events: [] })

/** The file, cleaned: anything malformed is dropped, so a hand edit can add nothing that signs anyone in. */
function clean(raw) {
  const s = EMPTY()
  if (!raw || typeof raw !== 'object') return s
  s.fails = Number.isInteger(raw.fails) && raw.fails >= 0 && raw.fails < LOCK.tries ? raw.fails : 0
  s.lockedUntil = isTime(raw.lockedUntil) ? raw.lockedUntil : null
  s.lockouts = (Array.isArray(raw.lockouts) ? raw.lockouts : []).filter(isTime).slice(-20)
  const fp = v => (typeof v === 'string' && /^[0-9a-f]{0,64}$/.test(v) ? v : '')
  s.seen = raw.seen && typeof raw.seen === 'object' ? { wanted: raw.seen.wanted === true, bind: String(raw.seen.bind || '').slice(0, 64), pin: fp(raw.seen.pin) } : null
  s.pinMark = raw.pinMark && typeof raw.pinMark === 'object' && isTime(raw.pinMark.at) ? { pin: fp(raw.pinMark.pin), at: raw.pinMark.at } : null
  s.sessions = (Array.isArray(raw.sessions) ? raw.sessions : [])
    .filter(x => x && /^[0-9a-f]{64}$/.test(x.id) && isTime(x.createdAt) && isTime(x.expiresAt))
    .map(x => ({ id: x.id, createdAt: x.createdAt, expiresAt: x.expiresAt, address: String(x.address || '').slice(0, 64), ...(PREFS.prLinks.includes(x.prLinks) ? { prLinks: x.prLinks } : {}) }))
  s.events = (Array.isArray(raw.events) ? raw.events : [])
    .filter(e => e && isTime(e.at) && EVENT_KINDS.includes(e.kind))
    .map(e => ({ at: e.at, kind: e.kind, address: String(e.address || '').slice(0, 64), ...(Number.isInteger(e.count) ? { count: e.count } : {}), ...(typeof e.text === 'string' ? { text: e.text.slice(0, 300) } : {}), ...(e.outside === true ? { outside: true } : {}) }))
    .slice(-EVENTS_MAX)
  return s
}

export function makeAuthStore({ file = AUTH_FILE, now = Date.now, log = line => console.log(line), verify = verifyPin, write: writeFile = writeAtomic } = {}) {
  /** The latest lock this process has seen: a damaged or deleted file never lifts it early. */
  let knownLock = 0
  /** The wrong tries this process has counted: a write that failed never loses one (the larger of this and the file wins). */
  let knownFails = 0

  const iso = t => new Date(t).toISOString()
  const event = (s, kind, address = '', extra = {}) => s.events.push({ at: iso(now()), kind, address: String(address || '').slice(0, 64), ...extra })
  /** A write that fails is logged, never thrown: the memory above still holds what matters (the count and the lock). */
  function tryWrite(s) {
    try {
      write(s)
      return true
    } catch (err) {
      log(`phone: could not save ${path.basename(file)} (${err?.code || err?.message || err})`)
      return false
    }
  }

  /**
   * The file, cleaned. A MISSING file is a first start. A file that is there but does not parse is DAMAGE: it is
   * kept beside it (<file>.damaged-<time>), sign-in is locked for the lock time (a damaged file must never be a
   * way to wipe a lock), and a good file with that lock is written back.
   */
  function read() {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return EMPTY()
    }
    try {
      return clean(JSON.parse(text))
    } catch {
      const stamp = iso(now()).replace(/[:.]/g, '-')
      try { writeFile(`${file}.damaged-${stamp}`, text) } catch { /* the lock below still holds */ }
      knownLock = Math.max(knownLock, now() + LOCK.ms)
      const s = { ...EMPTY(), lockedUntil: iso(knownLock) }
      event(s, 'damaged')
      log(`phone: ${path.basename(file)} was damaged; a copy is kept beside it and phone sign-in is locked for ${LOCK.ms / 60_000} minutes.`)
      tryWrite(s)
      return s
    }
  }
  const write = s => writeFile(file, `${JSON.stringify({ ...s, events: s.events.slice(-EVENTS_MAX) }, null, 2)}\n`)
  const live = (x, hours) => {
    const end = Math.min(Date.parse(x.expiresAt), Date.parse(x.createdAt) + hours * 3600_000)
    return now() < end
  }

  function lockedFor(s = read()) {
    const until = Math.max(knownLock, s.lockedUntil ? Date.parse(s.lockedUntil) : 0)
    return Math.max(0, until - now())
  }
  const minutes = ms => Math.max(1, Math.ceil(ms / 60_000))
  const lockedAnswer = ms => ({ ok: false, status: 429, error: `Too many wrong PINs. Phone sign-in is locked for ${minutes(ms)} more minutes.`, lockedFor: ms })

  function login({ pin, pinHash, address, sessionHours }) {
    const s = read()
    const left = lockedFor(s)
    if (left > 0) return lockedAnswer(left)
    if (!validPinHash(pinHash)) return { ok: false, status: 503, error: 'Phone access has no PIN yet: set one at the PC with node tools/factory.mjs phone-pin.' }
    if (s.lockedUntil) s.lockedUntil = null // a lock that ran out: forget it
    if (typeof pin !== 'string' || !verify(pin, pinHash)) {
      s.fails = Math.max(s.fails, knownFails) + 1
      knownFails = s.fails
      event(s, 'wrong', address)
      if (s.fails >= LOCK.tries) {
        knownLock = now() + LOCK.ms
        s.lockedUntil = iso(knownLock)
        s.fails = 0
        knownFails = 0
        event(s, 'lockout', address)
        // the lockouts are NOT reset by a good sign-in: only time takes them away (ESCALATE)
        s.lockouts = [...s.lockouts.filter(t => now() - Date.parse(t) < ESCALATE.withinMs), iso(now())]
        const escalated = s.lockouts.length >= ESCALATE.lockouts
        if (escalated) {
          event(s, 'escalate', address)
          s.lockouts = []
        }
        tryWrite(s)
        log(`phone: ${LOCK.tries} wrong PINs, the last from ${address || 'an unknown address'}: phone sign-in is locked for ${LOCK.ms / 60_000} minutes.`)
        if (escalated) log(`phone: ${ESCALATE.lockouts} lockouts within 24 hours: phone access is turned off. Only the PC can turn it back on.`)
        return escalated ? { ...lockedAnswer(LOCK.ms), escalated: true, error: 'Too many wrong PINs. Phone access is now off: only the PC can turn it back on.' } : lockedAnswer(LOCK.ms)
      }
      tryWrite(s)
      const tries = LOCK.tries - s.fails
      return { ok: false, status: 401, error: `Wrong PIN. ${tries} ${tries === 1 ? 'try' : 'tries'} left before a 15 minute lock.` }
    }
    const token = randomBytes(32).toString('base64url')
    const at = now()
    s.fails = 0 // the wrong tries go; the lockouts stay (ESCALATE)
    knownFails = 0
    s.sessions = [...s.sessions.filter(x => live(x, sessionHours)), { id: sha(token), createdAt: iso(at), expiresAt: iso(at + sessionHours * 3600_000), address: String(address || '').slice(0, 64) }].slice(-SESSIONS_MAX)
    event(s, 'login', address)
    if (!tryWrite(s)) return { ok: false, status: 503, error: 'The PC could not save the sign-in. Try again in a moment.' }
    return { ok: true, token, csrf: csrfOf(token), expiresAt: iso(at + sessionHours * 3600_000) }
  }

  /** The session for a cookie token, or null: unknown, malformed or expired. */
  function session(token, sessionHours) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null
    const id = sha(token)
    const s = read()
    let found = null
    for (const x of s.sessions) if (same(x.id, id)) found = x // every entry is compared: the time says nothing about which
    if (!found || !live(found, sessionHours)) return null
    return { id, csrf: csrfOf(token), expiresAt: found.expiresAt, address: found.address, prLinks: found.prLinks || PREFS.prLinks[0] }
  }

  /** The page's option on ONE session's record (`id`, from session()): false when that session is gone or the write failed. */
  function setPrefs(id, prefs) {
    if (prefsProblem(prefs)) return false
    const s = read()
    const mine = s.sessions.find(x => same(x.id, id))
    if (!mine) return false
    mine.prLinks = prefs.prLinks
    return tryWrite(s)
  }

  function logout(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return false
    const id = sha(token)
    const s = read()
    const mine = s.sessions.find(x => same(x.id, id))
    if (!mine) return false
    s.sessions = s.sessions.filter(x => x !== mine)
    event(s, 'signout', mine.address)
    tryWrite(s)
    return true
  }

  /** Ends every session; the count is of the sessions still live under `sessionHours` (expired ones are not counted). */
  function signOutEverywhere(sessionHours = 168) {
    const s = read()
    const count = s.sessions.filter(x => live(x, sessionHours)).length
    s.sessions = []
    event(s, 'signout-all', '', { count })
    tryWrite(s)
    return count
  }

  /** Newest first. */
  const events = () => read().events.slice().reverse()

  /** The lockouts as orchestration Log events (score-routes.mjs `extra`): no flow, no agent, one plain line. */
  /**
   * What the watcher sees in config.json's remote block now ({ wanted, bind, pinHash }), compared with what it saw
   * last (`seen`, kept in this file): each change is an event with a plain sentence, and the new values are kept.
   * Nothing seen yet counts as nothing set up, so a block that appeared while nobody looked is said at once; with no
   * block and nothing seen, nothing is said and no file is written. The PIN is compared by a FINGERPRINT (SHA-256 of the hash), never the hash itself;
   * a new one that phone-pin did not mark (markPin) is called out as changed outside the setup command, which is
   * what an agent editing config.json by hand would look like. Returns the new events.
   */
  function noteRemote({ wanted, bind, pinHash }) {
    const s = read()
    const now$ = { wanted: wanted === true, bind: String(bind || ''), pin: pinHash ? sha(pinHash) : '' }
    const was = s.seen || { wanted: false, bind: '', pin: '' }
    s.seen = now$
    const added = []
    const say = (kind, text, extra = {}) => { event(s, kind, '', { text, ...extra }); added.push(s.events.at(-1)) }
    if (was.wanted !== now$.wanted) say('config', `Phone access was turned ${now$.wanted ? 'on' : 'off'} in config.json.`)
    if (now$.bind && was.bind !== now$.bind) say('config', `Phone access now listens on ${now$.bind}${was.bind ? ` (it was ${was.bind})` : ''}.`)
    if (was.pin !== now$.pin && now$.pin) {
      if (s.pinMark?.pin === now$.pin) say('pin', 'The phone PIN was changed with phone-pin.')
      else say('pin', 'The phone PIN was changed outside the setup command: phone-pin did not write it. If you did not change it, turn phone access off.', { outside: true })
    }
    if (was.wanted !== now$.wanted || was.bind !== now$.bind || was.pin !== now$.pin) tryWrite(s)
    return added
  }

  /** phone-pin, as it writes a new hash: the fingerprint and the time, so the watcher knows the setup command made it. */
  function markPin(pinHash) {
    const s = read()
    s.pinMark = { pin: sha(pinHash), at: iso(now()) }
    tryWrite(s)
  }

  /** Each event as a Log line (score-routes.mjs `extra`): kind phone, no flow, no agent, one plain sentence. */
  const LOGGED = { login: e => `A phone signed in${e.address ? ` from ${e.address}` : ''}.`,
    lockout: e => `Phone sign-in was locked for ${LOCK.ms / 60_000} minutes after ${LOCK.tries} wrong PINs${e.address ? ` (the last from ${e.address})` : ''}.`,
    escalate: () => `${ESCALATE.lockouts} lockouts within 24 hours: phone access was turned off.`,
    damaged: () => 'The phone sign-in file was damaged: a copy was kept and sign-in was locked for 15 minutes.',
    pin: e => e.text, config: e => e.text }
  const logEvents = () => read().events.filter(e => LOGGED[e.kind]).map(e => ({ at: e.at, kind: 'phone', flow: null, agent: null, cell: null, text: LOGGED[e.kind](e) || '' }))

  return { read, login, session, setPrefs, logout, signOutEverywhere, lockedFor: () => lockedFor(), events, logEvents, noteRemote, markPin }
}

/** The lockouts in the machine's auth file as Log events: what score-routes.mjs adds to the orchestration Log. */
export const phoneLockouts = () => makeAuthStore({ log: () => {} }).logEvents()
