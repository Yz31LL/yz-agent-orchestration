// What the watchdog keeps on disk (heal-runner.mjs writes it, the Health page and the digest read it):
//
//   data/heal-state.json   { off: { <check id>: true }, seen: { at, checks: [{ id, name, state, text }] },
//                            resumed: { <collection id>: ISO }, copied: { <file name>: "<size>:<mtime>" } }
//     off        the per-check switch on the Health page: a check that is off is not run and repairs nothing
//     seen       the last look, so the digest can say how things stood when the dashboard is not running
//     resumed    when the user pressed Resume on a paused ticket refresh: the paid turns before it are not held
//                against the refresh again, even after a restart (heal-checks.mjs refreshCheck)
//     copied     which damaged file was already copied aside, so one bad file is copied once, not every minute
//   data/heal-log.jsonl    APPEND-ONLY, one line per repair: { at, check, saw, did, result } (result: done, failed,
//                          or `would` when repairs are off and the watchdog only reports). The newest KEEP are kept.
//
// Rules: reads never throw (a missing or torn file reads as empty); writes go through atomic-write.mjs or one appended
// line; `file` is passed by every caller, so tests never touch data/.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR } from './factory-state.mjs'

export const HEAL_STATE_FILE = path.join(DATA_DIR, 'heal-state.json')
export const HEAL_LOG_FILE = path.join(DATA_DIR, 'heal-log.jsonl')
export const LOG_KEEP = 1000
const TRIM_AT = 200
const DAY = 86_400_000

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isTime = v => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const ID = /^[a-z][a-z0-9-]{0,39}$/

export function readHealState(file = HEAL_STATE_FILE) {
  let j = null
  try {
    j = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    j = null
  }
  return {
    off: Object.fromEntries(Object.entries(isObj(j?.off) ? j.off : {}).filter(([k, v]) => ID.test(k) && v === true)),
    seen: isObj(j?.seen) && isTime(j.seen.at) && Array.isArray(j.seen.checks) ? { at: j.seen.at, checks: j.seen.checks.filter(c => isObj(c) && typeof c.id === 'string') } : null,
    resumed: Object.fromEntries(Object.entries(isObj(j?.resumed) ? j.resumed : {}).filter(([k, v]) => /^[A-Za-z0-9_-]+$/.test(k) && isTime(v))),
    copied: Object.fromEntries(Object.entries(isObj(j?.copied) ? j.copied : {}).filter(([, v]) => typeof v === 'string')),
  }
}

/** Read, change with `fn(state)` (which returns the new state), write; returns the new state. */
export function updateHealState(fn, file = HEAL_STATE_FILE) {
  const next = fn(readHealState(file))
  writeAtomic(file, JSON.stringify(next, null, 1))
  return next
}

function parseLine(text) {
  try {
    const l = JSON.parse(text)
    if (!isObj(l) || !isTime(l.at) || typeof l.check !== 'string') return null
    return { at: l.at, check: l.check, name: String(l.name || l.check), saw: String(l.saw ?? ''), did: String(l.did ?? ''), result: String(l.result ?? '') }
  } catch {
    return null
  }
}

export function readHealLog(file = HEAL_LOG_FILE) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return text.split(/\r?\n/).filter(Boolean).map(parseLine).filter(Boolean)
}

/** One repair line; never throws (a failed write is logged). */
export function appendHealLog(line, { file = HEAL_LOG_FILE, log = console.error } = {}) {
  const l = { at: line.at || new Date().toISOString(), check: line.check, name: line.name || line.check, saw: String(line.saw ?? '').slice(0, 600), did: String(line.did ?? '').slice(0, 600), result: line.result || 'done' }
  try {
    const all = readHealLog(file)
    if (all.length + 1 > LOG_KEEP + TRIM_AT) writeAtomic(file, [...all.slice(-(LOG_KEEP - 1)), l].map(x => JSON.stringify(x)).join('\n') + '\n')
    else {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, JSON.stringify(l) + '\n')
    }
    return l
  } catch (err) {
    log(`heal: could not write the repair log: ${err?.message || err}`)
    return null
  }
}

/**
 * The digest's Health part when the dashboard is NOT running: the watchdog's last look from heal-state.json, marked
 * stale, with the repairs of the 24 hours before now. Null when the watchdog never looked.
 */
export function healthFromFiles({ now = Date.now(), file = HEAL_STATE_FILE, logFile = HEAL_LOG_FILE, settings = { enabled: true, repairs: true } } = {}) {
  const s = readHealState(file)
  if (!s.seen) return null
  return {
    enabled: settings.enabled, repairs: settings.repairs, seenAt: s.seen.at, stale: true,
    checks: s.seen.checks.map(c => ({ id: c.id, name: String(c.name || c.id), state: String(c.state || 'ok'), text: String(c.text || '') })),
    repairs24h: readHealLog(logFile).filter(l => Date.parse(l.at) >= now - DAY && l.result !== 'would').reverse(),
  }
}
