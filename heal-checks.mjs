// The watchdog's checks, PURE: each takes the facts heal-runner.mjs gathered and answers { state, text, saw,
// repair?, extra? }. No file, no clock, no process: tests seed the facts and read the answer.
//
//   state    ok | degraded | failing
//   text     one or two plain sentences for the user (the Health page) and for Master (the digest)
//   saw      what it looked at, one line, kept in the repair log
//   repair   { id, target, what }: the ONE repair this check may ask for, from REPAIRS; none when there is nothing to do
//   extra    what the page needs to draw the check's own buttons (Resume, Release, Stop, Copy a nudge)
//
// ═══ THE FIXED LIST OF SAFE REPAIRS (REPAIRS): nothing else is ever repaired automatically ═══
//   pause-refresh    a paid ticket refresh failed 3 times: its timer is paused IN MEMORY (config.json is never
//                    written), so it stops spending; Resume on the Health page starts it again
//   hold-deliveries  3 deliveries to one agent failed in a row: what is queued for it stays queued, with no paid
//                    turn, until the user presses Release (or Retry on the flow)
//   copy-rebuild     a store that does not parse: a copy is kept beside it, then it is rebuilt from its sources
//                    where the code already can (the token index, the stand-up index, the alerts state); otherwise
//                    the copy is kept and the user is told
//   restart-loop     a background loop silent for 5 times its interval: started once more, then only reported
// Each is local, reversible and costs nothing: no model, no push, no deleted data, no config.json, no repo.
// The report-only checks (stray servers, disk, config, the server's own delay, agents) are heal-reports.mjs.

export const REPAIRS = Object.freeze({
  'pause-refresh': 'Pause the timer of a failing paid ticket refresh, in memory, until you press Resume.',
  'hold-deliveries': 'Keep deliveries to an agent queued with no paid turn after 3 failures in a row, until you press Release.',
  'copy-rebuild': 'Keep a copy of a damaged store beside it, then rebuild it from its sources where the dashboard can.',
  'restart-loop': 'Start a silent background loop once more; a second silence is only reported.',
})
export const FAIL_RUN = 3
export const WAIT_LIMIT_MS = 30 * 60_000
export const SILENT_TIMES = 5
export const TOKEN_BUILD_MS = 30 * 60_000

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const usd = n => `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`
const mins = ms => {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${Math.max(m, 1)} min`
  const h = Math.floor(m / 60)
  return h >= 48 ? `${Math.round(h / 24)} days` : `${h} h${m % 60 ? ` ${m % 60} min` : ''}`
}
const timeOf = v => {
  const t = typeof v === 'string' ? Date.parse(v) : Number.isFinite(v) ? v : NaN
  return Number.isNaN(t) ? null : t
}
const worst = states => (states.includes('failing') ? 'failing' : states.includes('degraded') ? 'degraded' : 'ok')
const cutText = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

// ═══ 1. Paid ticket refresh failing ═══

/**
 * One collection's refresh, from its facts: { id, name, everyMinutes, paused, history: [{ at, ok, message }] (in
 * memory, oldest first), fetchedAt (the source file's), resumedAt (the user's Resume, kept in heal-state.json) }, and
 * the refresh spend lines [{ at, usd, collection? }]. A line with no collection counts for every collection only when
 * there is ONE collection on a timer (lines from before the dashboard named the collection).
 */
function refreshOne(c, spend, alone) {
  const fetched = timeOf(c.fetchedAt)
  const resumed = timeOf(c.resumedAt)
  const from = Math.max(fetched ?? -Infinity, resumed ?? -Infinity)
  const mine = spend.filter(l => (l.collection ? l.collection === c.id : alone))
  const sinceWorked = mine.filter(l => fetched === null || timeOf(l.at) > fetched)
  const paid = mine.filter(l => timeOf(l.at) > from)
  const history = (c.history || []).filter(h => resumed === null || timeOf(h.at) > resumed)
  let streak = 0
  for (let i = history.length - 1; i >= 0 && !history[i].ok; i--) streak++
  const lastError = [...(c.history || [])].reverse().find(h => !h.ok)?.message || ''
  const failures = Math.max(streak, paid.length)
  const cost = sinceWorked.reduce((t, l) => t + (Number(l.usd) || 0), 0)
  const of = alone ? '' : ` of ${c.name}`
  const error = lastError ? ` The last error: ${cutText(lastError)}` : ' The last error is not known: the dashboard restarted since.'
  if (failures >= FAIL_RUN) {
    const text = c.paused
      ? `The ticket refresh${of} failed ${failures} times and is paused. It has cost ${usd(cost)} since it last worked.${error}`
      : `The ticket refresh${of} failed ${failures} times and is still running every ${plural(c.everyMinutes, 'minute')}. It has cost ${usd(cost)} since it last worked.${error}`
    return { state: 'failing', text, cost, failures, lastError, pause: !c.paused }
  }
  if (c.paused) return { state: 'degraded', text: `The ticket refresh${of} is paused. Press Resume to start it again.`, cost, failures, lastError, pause: false }
  if (failures > 0) return { state: 'degraded', text: `The ticket refresh${of} failed ${plural(failures, 'time')} in a row.${error}`, cost, failures, lastError, pause: false }
  return { state: 'ok', text: '', cost, failures, lastError, pause: false }
}

export function refreshCheck({ collections = [], spend = [] } = {}) {
  const timed = collections.filter(c => c.everyMinutes > 0 || c.paused)
  if (!timed.length) return { state: 'ok', text: 'No ticket refresh runs on a timer.', saw: 'no collection with refreshMinutes above 0', extra: { collections: [] } }
  const alone = timed.length === 1
  const rows = timed.map(c => ({ c, r: refreshOne(c, spend.filter(l => l.kind === undefined || l.kind === 'refresh'), alone) }))
  const state = worst(rows.map(x => x.r.state))
  const bad = rows.filter(x => x.r.state !== 'ok')
  const toPause = rows.find(x => x.r.pause)
  return {
    state,
    text: bad.length ? bad.map(x => x.r.text).join(' ') : `The ticket refresh works (${timed.map(c => `${c.name} every ${plural(c.everyMinutes, 'minute')}`).join(', ')}).`,
    saw: rows.map(({ c, r }) => `${c.id}: ${r.failures} failed, ${usd(r.cost)} since it last worked, ${c.paused ? 'paused' : 'running'}`).join('; '),
    ...(toPause ? { repair: { id: 'pause-refresh', target: toPause.c.id, what: `Paused the timer of ${toPause.c.name}. It cost ${usd(toPause.r.cost)} since it last worked.` } } : {}),
    extra: { collections: rows.map(({ c, r }) => ({ id: c.id, name: c.name, paused: !!c.paused, failures: r.failures, cost: r.cost, lastError: r.lastError, state: r.state })) },
  }
}

// ═══ 2. Deliveries stuck ═══

/**
 * The relay's queue (relay.mjs health()): { waiting: [{ agent, since, items }] (no session open), fails: [{ agent,
 * count, lastError, held, heldItems }] (paid turns that failed in a row) }.
 */
export function deliveriesCheck({ waiting = [], fails = [], now }) {
  const parts = []
  const states = []
  for (const w of waiting) {
    const long = now - timeOf(w.since) >= WAIT_LIMIT_MS
    states.push(long ? 'failing' : 'degraded')
    parts.push(`${plural(w.items, 'delivery', 'deliveries')} to ${w.agent} ${w.items === 1 ? 'waits' : 'wait'} (${mins(now - timeOf(w.since))}): ${w.agent} has no session open. Nothing is paid while ${w.items === 1 ? 'it waits' : 'they wait'}; ${w.items === 1 ? 'it goes' : 'they go'} when a session opens.`)
  }
  let repair = null
  for (const f of fails) {
    if (f.count >= FAIL_RUN) {
      states.push('failing')
      parts.push(f.held
        ? `${f.count} deliveries to ${f.agent} failed in a row and are held: no paid turn runs for ${f.agent} until you press Release.${f.lastError ? ` The last error: ${cutText(f.lastError, 160)}` : ''}`
        : `${f.count} deliveries to ${f.agent} failed in a row.${f.lastError ? ` The last error: ${cutText(f.lastError, 160)}` : ''}`)
      if (!f.held && !repair) repair = { id: 'hold-deliveries', target: f.agent, what: `Held the deliveries to ${f.agent} after ${f.count} failures in a row: no paid turn runs for it until you press Release.` }
    } else if (f.count > 0) {
      states.push('degraded')
      parts.push(`${plural(f.count, 'delivery', 'deliveries')} to ${f.agent} failed.${f.lastError ? ` The last error: ${cutText(f.lastError, 160)}` : ''}`)
    }
  }
  return {
    state: worst(states),
    text: parts.length ? parts.join(' ') : 'Every delivery went, or none is waiting.',
    saw: `${plural(waiting.length, 'agent')} with deliveries waiting for a session, ${plural(fails.filter(f => f.count > 0).length, 'agent')} with failed deliveries`,
    ...(repair ? { repair } : {}),
    extra: { waiting, held: fails.filter(f => f.held).map(f => ({ agent: f.agent, items: f.heldItems || 0 })) },
  }
}

// ═══ 3. An index or store not built, or damaged ═══

/**
 * The stores: [{ name, label, exists, parses, error?, sig, rebuild: 'token' | 'standup' | 'alerts' | null }] (`sig`
 * the file's size and time, so one damaged version is copied once: `copied` holds what was copied already), and
 * the token index build: { building, startedAt } or null.
 */
export function storesCheck({ files = [], copied = {}, tokenBuild = null, now }) {
  const bad = files.filter(f => f.exists && !f.parses)
  const states = bad.map(() => 'failing')
  const parts = bad.map(f => `${f.label} does not parse${f.error ? ` (${cutText(f.error, 80)})` : ''}. ${f.rebuild ? 'The dashboard rebuilds it from its sources and keeps a copy of the damaged file beside it.' : 'A copy of it is kept beside it; it cannot be rebuilt from other files, so check it by hand.'}`)
  if (tokenBuild?.building && Number.isFinite(timeOf(tokenBuild.startedAt)) && now - timeOf(tokenBuild.startedAt) > TOKEN_BUILD_MS) {
    states.push('degraded')
    parts.push(`The token index has been building for ${mins(now - timeOf(tokenBuild.startedAt))}: Pipeline tokens and the alerts wait for it.`)
  }
  const todo = bad.filter(f => copied[f.name] !== f.sig)
  return {
    state: worst(states),
    text: parts.length ? parts.join(' ') : `Every store reads: ${files.filter(f => f.exists).map(f => f.label).join(', ') || 'none written yet'}.`,
    saw: files.map(f => `${f.name}: ${!f.exists ? 'none yet' : f.parses ? 'reads' : 'damaged'}`).join(', '),
    ...(todo.length ? { repair: { id: 'copy-rebuild', target: todo.map(f => f.name).join(','), what: `Kept a copy of ${todo.map(f => f.label).join(', ')} and ${todo.some(f => f.rebuild) ? 'rebuilt what can be rebuilt' : 'reported it'}.` } } : {}),
    extra: { damaged: bad.map(f => ({ name: f.name, label: f.label, rebuild: !!f.rebuild })) },
  }
}

// ═══ 4. A background loop stopped ═══

/** The loops (heal-beats.mjs view): [{ name, label, everyMs, lastAt, startedAt, restartedAt }]. */
export function loopsCheck({ loops = [], now }) {
  const states = []
  const parts = []
  let repair = null
  for (const l of loops) {
    const last = timeOf(l.lastAt) ?? timeOf(l.startedAt)
    const restarted = timeOf(l.restartedAt)
    const limit = SILENT_TIMES * l.everyMs
    if (last === null || now - last <= limit) continue
    if (restarted !== null && restarted >= last) {
      if (now - restarted <= limit) {
        states.push('degraded')
        parts.push(`${l.label} was silent for ${mins(now - last)} and was started once more ${mins(now - restarted)} ago.`)
      } else {
        states.push('failing')
        parts.push(`${l.label} has been silent for ${mins(now - last)}, even after it was started once more. Restart the dashboard.`)
      }
      continue
    }
    states.push('degraded')
    parts.push(`${l.label} has been silent for ${mins(now - last)} (it runs every ${mins(l.everyMs)}).`)
    if (!repair) repair = { id: 'restart-loop', target: l.name, what: `Started ${l.label} once more after ${mins(now - last)} of silence.` }
  }
  return {
    state: worst(states),
    text: parts.length ? parts.join(' ') : loops.length ? `Every background loop ran in time (${loops.map(l => l.label).join(', ')}).` : 'No background loop has started yet.',
    saw: loops.map(l => `${l.name}: last ${l.lastAt || 'never'}`).join(', ') || 'no loops registered',
    ...(repair ? { repair } : {}),
  }
}
