// Telling Master what changed WITHOUT paying per message. The dashboard never starts a paid turn for this by default:
// it keeps an inbox, and the digest's first lines say `N new since you last read` with the items. Reading the digest
// as the coordinator marks them read.
//
//   data/master-inbox.jsonl         APPEND-ONLY, one JSON line per item: { id, at, kind, text, key? }
//                                   kind: health (a check changed state), repair (the watchdog repaired something),
//                                   suggestion (the user decided on one), alert (an alert was raised), gate (a flow a
//                                   gate stopped). The newest KEEP lines are kept (rewritten whole, atomically, when
//                                   the file passes KEEP + TRIM_AT).
//   data/master-inbox-state.json    { readAt, sentAt, seeded, seen: { alerts: [keys], stops: [flow ids] } }: the read
//                                   marker, when the last urgent message went, when the FIRST pass on this machine
//                                   ended (seeded), and what was already put in the inbox, so a restart never puts the
//                                   same alert or stop in twice
//
//   appendInbox({ kind, text, key? }, opts)     one item; an item with a `key` already in the inbox is not added again
//   unread(opts)                                { items, readAt }: the items after the read marker, oldest first
//   markRead(at, opts)                          moves the marker to `at` (the digest's build time): an item added
//                                               after that stays new
//   noteNew(kind, keys, opts)                   which of `keys` are new for `kind` (alerts, stops), remembering them
//   markSeeded(at, opts)                        the first pass is over: from now on new alerts and stops go in
//   makeNotifier({ settings, send, present, now, file })   the URGENT path (config insight.notifyMaster urgent)
//   makeInbox({ file, stateFile, notify, events })   what the watchdog (heal-runner.mjs) is handed: all of the above
//                                               on one pair of files
//
// THE FIRST PASS on a machine only REMEMBERS the alerts and gate stops already there (the inbox would otherwise start
// with every old alert, and the urgent path would send old stops). It is decided by its OWN marker, `seeded`, written
// when that pass ends, NEVER by whether the state file exists: the urgent message of a failing check writes `sentAt`
// to that file earlier in the same pass (QA, 2026-11-27: on an empty data folder with urgent on, that made the first
// pass look like a later one, and the inbox filled with old alerts). A state file from before this marker has no
// `seeded`, so its next pass is quiet once, which only remembers.
//
// THE URGENT PATH: with insight.notifyMaster "urgent", a FAILING health check or a flow a gate stopped is also sent to
// Master through the answer relay's turn (relay.mjs messagePrompt and claudeRun): ONE message, never more than one per
// URGENT_EVERY_MS (30 minutes, kept in the state file so a restart does not reset it), and only while Master has a
// session open (the relay's no-session rule: no paid turn for nobody). Its cost is recorded as `insight` spend.
// Everything else, and everything when it is off, waits in the inbox for the next read.
// Rules: a torn line is skipped on read; every write goes through atomic-write.mjs or one appended line; nothing here
// ever throws into a caller: a failure is logged and the caller carries on.

import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR } from './factory-state.mjs'

export const INBOX_FILE = path.join(DATA_DIR, 'master-inbox.jsonl')
export const INBOX_STATE_FILE = path.join(DATA_DIR, 'master-inbox-state.json')
export const INBOX_KINDS = Object.freeze(['health', 'repair', 'suggestion', 'alert', 'gate'])
export const KEEP = 500
const TRIM_AT = 100
const SEEN_KEEP = 300
export const URGENT_EVERY_MS = 30 * 60_000
const TEXT_MAX = 400

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isTime = v => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim()

function parseLine(text) {
  try {
    const l = JSON.parse(text)
    if (!isObj(l) || !INBOX_KINDS.includes(l.kind) || !isTime(l.at) || typeof l.text !== 'string') return null
    return { id: String(l.id || ''), at: l.at, kind: l.kind, text: l.text, ...(typeof l.key === 'string' ? { key: l.key } : {}) }
  } catch {
    return null
  }
}

/** Every item, oldest first; a torn or hand-made line is skipped. */
export function readInbox(file = INBOX_FILE) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return text.split(/\r?\n/).filter(Boolean).map(parseLine).filter(Boolean)
}

export function readInboxState(file = INBOX_STATE_FILE) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    return {
      readAt: isTime(j?.readAt) ? j.readAt : null,
      sentAt: isTime(j?.sentAt) ? j.sentAt : null,
      seeded: isTime(j?.seeded) ? j.seeded : null,
      seen: { alerts: Array.isArray(j?.seen?.alerts) ? j.seen.alerts.filter(k => typeof k === 'string') : [], stops: Array.isArray(j?.seen?.stops) ? j.seen.stops.filter(k => typeof k === 'string') : [] },
    }
  } catch {
    return { readAt: null, sentAt: null, seeded: null, seen: { alerts: [], stops: [] } }
  }
}
const writeState = (s, file) => writeAtomic(file, JSON.stringify(s, null, 1))

/**
 * Append one item; returns it, or null when it was not added (an unknown kind, no text, a `key` already in the inbox,
 * or a failed write, which is logged).
 */
export function appendInbox({ kind, text, key } = {}, { file = INBOX_FILE, now = Date.now(), log = console.error, keep = KEEP, trimAt = TRIM_AT } = {}) {
  const t = oneLine(text).slice(0, TEXT_MAX)
  if (!INBOX_KINDS.includes(kind) || !t) return null
  try {
    const all = readInbox(file)
    if (typeof key === 'string' && all.some(i => i.key === key)) return null
    const item = { id: `m${randomBytes(4).toString('hex')}`, at: new Date(now).toISOString(), kind, text: t, ...(typeof key === 'string' ? { key } : {}) }
    if (all.length + 1 > keep + trimAt) writeAtomic(file, [...all.slice(-(keep - 1)), item].map(i => JSON.stringify(i)).join('\n') + '\n')
    else {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, JSON.stringify(item) + '\n')
    }
    return item
  } catch (err) {
    log(`inbox: could not add a ${kind} item: ${err?.message || err}`)
    return null
  }
}

/** The items after the read marker, oldest first, and the marker itself. */
export function unread({ file = INBOX_FILE, stateFile = INBOX_STATE_FILE } = {}) {
  const { readAt } = readInboxState(stateFile)
  const from = readAt ? Date.parse(readAt) : -Infinity
  return { items: readInbox(file).filter(i => Date.parse(i.at) > from), readAt }
}

/** Moves the read marker to `at`, never back. Returns the marker; a failed write is logged, never thrown. */
export function markRead(at, { stateFile = INBOX_STATE_FILE, log = console.error } = {}) {
  const s = readInboxState(stateFile)
  const next = new Date(at).toISOString()
  if (s.readAt && Date.parse(s.readAt) >= Date.parse(next)) return s.readAt
  try {
    writeState({ ...s, readAt: next }, stateFile)
  } catch (err) {
    log(`inbox: could not mark the inbox read: ${err?.message || err}`)
  }
  return next
}

/** Which of `keys` were never put in the inbox for `kind` ('alerts' or 'stops'); they are remembered from now on. */
export function noteNew(kind, keys, { stateFile = INBOX_STATE_FILE, log = console.error } = {}) {
  const s = readInboxState(stateFile)
  const had = new Set(s.seen[kind] || [])
  const fresh = [...new Set((Array.isArray(keys) ? keys : []).filter(k => typeof k === 'string' && !had.has(k)))]
  if (!fresh.length) return []
  try {
    writeState({ ...s, seen: { ...s.seen, [kind]: [...(s.seen[kind] || []), ...fresh].slice(-SEEN_KEEP) } }, stateFile)
  } catch (err) {
    log(`inbox: could not remember the ${kind} seen: ${err?.message || err}`)
  }
  return fresh
}

/** The first pass on this machine is over (see the header). A failed write is logged; the next pass is quiet again. */
export function markSeeded(at = Date.now(), { stateFile = INBOX_STATE_FILE, log = console.error } = {}) {
  const s = readInboxState(stateFile)
  if (s.seeded) return
  try {
    writeState({ ...s, seeded: new Date(at).toISOString() }, stateFile)
  } catch (err) {
    log(`inbox: could not mark the first pass done: ${err?.message || err}`)
  }
}

/**
 * The urgent path. `settings()` gives { notifyMaster }; `present()` resolves whether Master has a session open;
 * `send(text)` runs the one relay turn and resolves { ok, error? } (its cost is recorded by the caller as `insight`).
 * notify({ text, urgent }) resolves what happened: 'off', 'not urgent', 'too soon', 'no session', 'sent', 'failed'.
 */
export function makeNotifier({ settings, send, present, now = () => Date.now(), stateFile = INBOX_STATE_FILE, log = console.error }) {
  let busy = false
  return async function notify({ text, urgent = false }) {
    if (settings().notifyMaster !== 'urgent') return 'off'
    if (!urgent) return 'not urgent'
    const s = readInboxState(stateFile)
    if (busy || (s.sentAt && now() - Date.parse(s.sentAt) < URGENT_EVERY_MS)) return 'too soon'
    busy = true
    try {
      let here = true
      try {
        here = (await present()) !== false
      } catch {
        here = true
      }
      if (!here) return 'no session' // no paid turn for nobody: it waits in the inbox for the next read
      // the slot is taken BEFORE the turn: a turn that fails still cost money, so the next one waits its 30 minutes
      writeState({ ...readInboxState(stateFile), sentAt: new Date(now()).toISOString() }, stateFile)
      const r = await send(oneLine(text))
      return r?.ok ? 'sent' : 'failed'
    } catch (err) {
      log(`inbox: the urgent message to the coordinator failed: ${err?.message || err}`)
      return 'failed'
    } finally {
      busy = false
    }
  }
}

/**
 * The inbox as the watchdog uses it (heal-runner.mjs `inbox`), on one pair of files: `notify` is makeNotifier's,
 * `events()` resolves { alerts: [{ key, text }], stops: [{ id, text }] }. firstTime() is true until markSeeded.
 */
export function makeInbox({ file = INBOX_FILE, stateFile = INBOX_STATE_FILE, notify = async () => 'off', events = async () => ({ alerts: [], stops: [] }), now = () => Date.now(), log = console.error } = {}) {
  return {
    append: item => appendInbox(item, { file, now: now(), log }),
    notify,
    events,
    noteNew: (kind, keys) => noteNew(kind, keys, { stateFile, log }),
    firstTime: () => !readInboxState(stateFile).seeded,
    seed: () => markSeeded(now(), { stateFile, log }),
  }
}
