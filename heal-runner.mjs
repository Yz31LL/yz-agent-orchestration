// The watchdog: runs the checks (heal-checks.mjs, heal-reports.mjs) every minute inside the server, does the ONE safe
// repair a check asks for (from the fixed list, heal-checks.mjs REPAIRS), records every repair, and tells Master what
// changed through the inbox (insight-inbox.mjs).
//
//   makeHealRunner({ settings, facts, actions, inbox, now, stateFile, logFile, ... })
//     -> { runOnce(force?), start(), view(), setSwitch(id, on), record(line), noteWork(what, ms) }
//
// THE CHECKS (CHECKS): each has an id, a plain name, what it looks at, how often it runs (most every minute; the
// process list every 10 minutes, the disk every 30) and at most one repair.
//
// Rules this file keeps:
// - ⚠️ NEVER BLOCKING A ROUTE: it runs on its own timer, one pass at a time (a pass still running is not started
//   again), and every fact it reads is async. A check whose facts fail is `degraded` with the reason, never a throw.
// - `healing.enabled` false: no check runs and the page says the watchdog is off. `healing.repairs` false: the checks
//   run and report, and each repair is written to the log ONCE as `would` (what it would have done), never done.
// - A check switched off on the Health page (heal-state.json `off`) is not run and repairs nothing.
// - Every repair is one line of data/heal-log.jsonl (at, check, what it saw, what it did, the result), and one inbox
//   item. A state change is one inbox item; a change TO failing also goes to the urgent path (insight.notifyMaster).
// - After a repair the check looks again at once, so the page and the digest show the state it left.
// - A PRESS on the Health page looks again at once at what it changed: runOnce(['deliveries']) after Release,
//   runOnce(['refresh']) after Resume, runOnce('all') for Look now. A forced check runs even within its interval, and
//   a press during a running pass waits for that pass and then looks again, so the answer is never the old state
//   (QA, 2026-11-27: after Release the page showed the held deliveries and their button for up to a minute).
// - New alerts and flows a gate stopped are put in the inbox too, each once (insight-inbox.mjs noteNew); the very first
//   pass on a machine only remembers what is there, so the inbox does not start with every old alert, and the urgent
//   path sends none of them. "First" is the inbox's own marker (firstTime() until seed(), at the end of that pass),
//   never whether a file exists (insight-inbox.mjs says why).
// - The server's own delay (the Server check) is measured here with monitorEventLoopDelay: each minute's 99th
//   percentile and the slowest request or job of that minute (noteWork, which the server calls for each request).

import { monitorEventLoopDelay } from 'node:perf_hooks'

import { deliveriesCheck, loopsCheck, refreshCheck, REPAIRS, storesCheck } from './heal-checks.mjs'
import { agentsCheck, configCheck, diskCheck, serverCheck, straysCheck } from './heal-reports.mjs'
import { appendHealLog, HEAL_LOG_FILE, HEAL_STATE_FILE, readHealLog, readHealState, updateHealState } from './heal-store.mjs'

const MIN = 60_000
const DAY = 86_400_000

export const CHECKS = Object.freeze([
  { id: 'refresh', name: 'Paid ticket refresh', looksAt: 'Whether the timed ticket refresh still works, and what it has cost since it last did.', check: refreshCheck, repair: 'pause-refresh' },
  { id: 'deliveries', name: 'Deliveries to agents', looksAt: 'Answers and messages waiting for an agent with no session open, or failing to go.', check: deliveriesCheck, repair: 'hold-deliveries' },
  { id: 'stores', name: 'Indexes and stores', looksAt: 'The token index, the stand-up index, the lessons, the suggestions and the alerts state: does each one read?', check: storesCheck, repair: 'copy-rebuild' },
  { id: 'loops', name: 'Background loops', looksAt: 'Predict and warn, Routing, the Pull requests list, the quality watch and the QA rework watch: does each still run?', check: loopsCheck, repair: 'restart-loop' },
  { id: 'strays', name: 'Stray dashboard copies', looksAt: 'Other copies of this dashboard left running for more than 6 hours.', check: straysCheck, everyMs: 10 * MIN },
  { id: 'disk', name: 'Disk and data growth', looksAt: 'spend.jsonl, the logs, the evidence folder and the token index.', check: diskCheck, everyMs: 30 * MIN },
  { id: 'config', name: 'Config problems', looksAt: 'config.json: does it read, and was any setting in it ignored?', check: configCheck },
  // steady: a new state shows (and goes in the inbox) only once it held for that many looks in a row: the server's
  // delay swings minute to minute, and every swing would be one more inbox item (seen on a busy machine, 2026-11-26)
  { id: 'server', name: 'The dashboard server', looksAt: 'How long the server is held up at a time: the page feels frozen when it is.', check: serverCheck, steady: 3 },
  { id: 'agents', name: 'Agents', looksAt: 'A busy session with no output for 30 minutes, and the coordinator with no session open.', check: agentsCheck },
])
export const CHECK_IDS = Object.freeze(CHECKS.map(c => c.id))
const RANK = { ok: 0, off: 0, degraded: 1, failing: 2 }

/** A small event-loop delay meter: sample() gives the minute's { p99Ms, maxMs } and starts the next minute. */
export function makeDelayMeter() {
  const h = monitorEventLoopDelay({ resolution: 20 })
  h.enable()
  return {
    sample() {
      const out = { p99Ms: h.percentile(99) / 1e6, maxMs: h.max / 1e6 }
      h.reset()
      return out
    },
  }
}

/**
 * `facts` maps a check id to an async function giving that check its facts (heal-checks.mjs says what each needs).
 * `actions` maps a repair id to async (target, result) => { ok, did?, error? }. `inbox` is { append({ kind, text }),
 * notify({ text, urgent }), events(), noteNew(kind, keys), firstTime(), seed() } (insight-inbox.mjs makeInbox); any
 * part may be left out.
 */
export function makeHealRunner({
  settings = () => ({ enabled: true, repairs: true }), facts = {}, actions = {}, inbox = {}, now = () => Date.now(),
  stateFile = HEAL_STATE_FILE, logFile = HEAL_LOG_FILE, delay = null, everyMs = MIN, log = console.error,
} = {}) {
  const results = new Map() // id -> { state, text, saw, extra, at, would? }
  const ranAt = new Map() // id -> ms of its last run
  const streak = new Map() // id -> { state, n }: how many looks in a row gave that state (a `steady` check)
  const wouldSaid = new Set() // `${check}|${target}`: a repair written once as `would` while repairs are off
  const failedAt = new Map() // `${check}|${target}` -> ms: a repair that failed is tried again at most once an hour
  const minutes = [] // the Server check's last few minutes
  let work = null // the slowest request or job of this minute
  let running = null
  let forced = new Set() // check ids the next pass runs even within their interval ('all': every check)
  let lastAt = null
  const iso = () => new Date(now()).toISOString()

  function record(line) {
    return appendHealLog({ at: iso(), ...line }, { file: logFile, log })
  }
  /** The server tells the watchdog what it worked on and how long it took (the slowest of each minute is kept). */
  function noteWork(what, ms) {
    if (Number.isFinite(ms) && (!work || ms > work.ms)) work = { what: String(what).slice(0, 80), ms }
  }

  async function look(c, state) {
    if (c.id === 'server') {
      if (delay) {
        minutes.push({ ...delay.sample(), slowest: work })
        work = null
        while (minutes.length > 5) minutes.shift()
      }
      return c.check({ minutes })
    }
    const get = facts[c.id]
    if (typeof get !== 'function') return { state: 'ok', text: 'Not looked at here.', saw: 'no facts' }
    try {
      return c.check({ ...(await get()), now: now(), copied: state.copied })
    } catch (err) {
      return { state: 'degraded', text: `The check could not look: ${String(err?.message || err).slice(0, 160)}.`, saw: 'the facts could not be read' }
    }
  }

  async function repairStep(c, res, s, state) {
    const { id, target, what } = res.repair
    if (!s.repairs) {
      const key = `${c.id}|${target}`
      if (!wouldSaid.has(key)) {
        wouldSaid.add(key)
        record({ check: c.id, name: c.name, saw: res.saw, did: `Would have done: ${what} Repairs are off (healing.repairs), so nothing was done.`, result: 'would' })
      }
      return { ...res, would: REPAIRS[id] }
    }
    const key = `${c.id}|${target}`
    if (failedAt.has(key) && now() - failedAt.get(key) < 60 * MIN) return { ...res, repair: undefined }
    let r
    try {
      r = (await actions[id]?.(target, res)) || { ok: false, error: 'this repair is not available here' }
    } catch (err) {
      r = { ok: false, error: String(err?.message || err) }
    }
    if (r.ok) failedAt.delete(key)
    else failedAt.set(key, now())
    const did = r.ok ? r.did || what : `Tried to: ${what} It failed: ${r.error || 'no reason given'}.`
    record({ check: c.id, name: c.name, saw: res.saw, did, result: r.ok ? 'done' : 'failed' })
    inbox.append?.({ kind: 'repair', text: `${c.name}: ${did}` })
    const after = await look(c, readHealState(stateFile))
    return after.repair && after.repair.id === id && after.repair.target === target ? { ...after, repair: undefined } : after
  }

  function noteChange(c, res, before) {
    if (before === res.state || (before === undefined && res.state === 'ok')) return
    const text = res.state === 'ok' ? `${c.name} is ok again.` : `${c.name} is ${res.state}: ${res.text}`
    inbox.append?.({ kind: 'health', text })
    if (res.state === 'failing') void Promise.resolve(inbox.notify?.({ text: `Health: ${text}`, urgent: true })).catch(() => {})
  }

  /** New alerts and gate stops into the inbox, each once; a stop also goes to the urgent path. The first pass only remembers. */
  async function events() {
    if (typeof inbox.events !== 'function' || typeof inbox.noteNew !== 'function') return
    let ev
    try {
      ev = await inbox.events()
    } catch {
      return
    }
    const silent = inbox.firstTime?.() === true
    const alerts = Array.isArray(ev?.alerts) ? ev.alerts : []
    const fresh = new Set(inbox.noteNew('alerts', alerts.map(a => a.key)))
    if (!silent) for (const a of alerts) if (fresh.has(a.key)) inbox.append?.({ kind: 'alert', text: a.text })
    const stops = Array.isArray(ev?.stops) ? ev.stops : []
    const freshStops = new Set(inbox.noteNew('stops', stops.map(s => s.id)))
    if (silent) return void inbox.seed?.()
    for (const s of stops) {
      if (!freshStops.has(s.id)) continue
      inbox.append?.({ kind: 'gate', text: s.text })
      void Promise.resolve(inbox.notify?.({ text: `Gate stop: ${s.text}`, urgent: true })).catch(() => {})
    }
  }

  async function pass() {
    const force = forced
    forced = new Set()
    const s = settings()
    if (!s.enabled) return
    const state = readHealState(stateFile)
    const seen = new Map((state.seen?.checks || []).map(c => [c.id, c.state]))
    for (const c of CHECKS) {
      if (state.off[c.id]) {
        results.set(c.id, { state: 'off', text: 'Switched off on this page: not checked, nothing repaired.', saw: '', at: iso() })
        continue
      }
      const every = c.everyMs || everyMs
      const due = force.has('all') || force.has(c.id) || !ranAt.has(c.id) || now() - ranAt.get(c.id) >= every - 1000
      if (!due) continue
      ranAt.set(c.id, now())
      let res = await look(c, state)
      if (res.repair) res = await repairStep(c, res, s, state)
      if (c.steady) {
        const run = streak.get(c.id)
        streak.set(c.id, run?.state === res.state ? { state: res.state, n: run.n + 1 } : { state: res.state, n: 1 })
        const shown = results.get(c.id)
        if (shown && shown.state !== res.state && streak.get(c.id).n < c.steady) continue // not steady yet: the last state stays
      }
      const before = results.has(c.id) ? results.get(c.id).state : seen.get(c.id)
      noteChange(c, res, before === 'off' ? undefined : before)
      results.set(c.id, { ...res, at: iso() })
    }
    await events()
    lastAt = iso()
    try {
      updateHealState(st => ({ ...st, seen: { at: lastAt, checks: CHECKS.map(c => ({ id: c.id, name: c.name, state: results.get(c.id)?.state || 'ok', text: results.get(c.id)?.text || '' })) } }), stateFile)
    } catch (err) {
      log(`heal: could not save the last look: ${err?.message || err}`)
    }
  }

  /**
   * One pass now; a pass already running is shared, never doubled. `force` ('all' or check ids): those checks look
   * again now even within their interval; a pass already running read its facts before the press, so the forced look
   * waits for it and runs as the next pass.
   */
  function runOnce(force = null) {
    const ids = force === 'all' ? ['all'] : Array.isArray(force) ? force : []
    for (const id of ids) forced.add(id)
    if (running && ids.length) return running.then(() => runOnce())
    if (!running) running = pass().catch(err => log(`heal: a pass failed: ${err?.message || err}`)).finally(() => { running = null })
    return running
  }

  /** The page's switch for one check; true when it changed. */
  function setSwitch(id, on) {
    if (!CHECK_IDS.includes(id)) return false
    updateHealState(st => {
      const off = { ...st.off }
      if (on) delete off[id]
      else off[id] = true
      return { ...st, off }
    }, stateFile)
    ranAt.delete(id)
    if (on) results.delete(id)
    return true
  }

  /** The Health page and the digest: every check with its state, its last repair, and the repairs of the last 24 hours. */
  function view() {
    const s = settings()
    const state = readHealState(stateFile)
    const lines = readHealLog(logFile)
    const lastOf = id => [...lines].reverse().find(l => l.check === id && l.result !== 'would') || null
    const checks = CHECKS.map(c => {
      const r = results.get(c.id)
      const st = !s.enabled ? 'off' : state.off[c.id] ? 'off' : r?.state || 'ok'
      return {
        id: c.id, name: c.name, looksAt: c.looksAt, on: !state.off[c.id], state: st,
        text: !s.enabled ? 'The watchdog is off (healing.enabled in config.json).' : r?.text || (state.off[c.id] ? 'Switched off on this page: not checked, nothing repaired.' : 'Not looked at yet.'),
        repair: c.repair ? REPAIRS[c.repair] : null, would: r?.would || null, extra: r?.extra || null, at: r?.at || null, lastRepair: lastOf(c.id),
      }
    })
    const worst = checks.reduce((w, c) => (RANK[c.state] > RANK[w] ? c.state : w), 'ok')
    return {
      enabled: s.enabled, repairs: s.repairs, seenAt: lastAt, stale: false, worst, checks,
      repairs24h: lines.filter(l => Date.parse(l.at) >= now() - DAY && l.result !== 'would').reverse(),
      log: lines.slice(-50).reverse(),
    }
  }

  function start() {
    void runOnce()
    return setInterval(() => void runOnce(), everyMs).unref()
  }

  return { runOnce, start, view, setSwitch, record, noteWork }
}
