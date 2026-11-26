// The watchdog's REPORT-ONLY checks, PURE like heal-checks.mjs: same answer shape ({ state, text, saw, extra? }), and
// never a repair. What each one would need to repair is not safe, local and reversible, so it is the user's:
//
//   straysCheck   dashboard copies (this repo's server.mjs, or a worktree's) left running for more than 6 hours.
//                 NO automatic stop: a copy may be a preview someone is looking at. The page lists each with its port,
//                 age and folder, and a Stop button the USER presses (heal-procs.mjs stops it by its pid, after
//                 checking its command line again). A copy whose folder cannot be read gets no button.
//   diskCheck     spend.jsonl, the logs, the evidence folder and the token index past sensible sizes, with the
//                 biggest items. Nothing is deleted: what to keep is the user's call.
//   configCheck   config.json that does not parse, and every setting that was ignored with a warning at start (until
//                 now only the console said so).
//   serverCheck   the server's event loop held up (the page feels frozen) for minutes on end, with the work that
//                 was running: report only.
//   agentsCheck   a session marked busy with no transcript activity for 30 minutes (hung), and a coordinator with no
//                 session. Copy a nudge copies a sentence for the user to paste; nothing is sent.

export const STRAY_AGE_MS = 6 * 3_600_000
export const HUNG_MS = 30 * 60_000
export const DELAY = Object.freeze({ degraded: 200, failing: 1000, minutes: 3 })
/** Sensible sizes, in bytes: past one is degraded, past three times it failing. */
export const DISK_LIMITS = Object.freeze({ spend: 5e6, logs: 50e6, evidence: 2e9, tokens: 300e6, data: 5e9 })

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const worst = states => (states.includes('failing') ? 'failing' : states.includes('degraded') ? 'degraded' : 'ok')
const timeOf = v => {
  const t = typeof v === 'string' ? Date.parse(v) : Number.isFinite(v) ? v : NaN
  return Number.isNaN(t) ? null : t
}
export function sizeText(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`
  return `${bytes} bytes`
}
const ago = ms => {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${Math.max(m, 1)} min`
  const h = Math.round(m / 60)
  return h >= 48 ? `${Math.round(h / 24)} days` : `${h} h`
}

// ═══ 5. Stray preview servers ═══

/**
 * `procs`: the dashboard servers running on this computer (heal-procs.mjs), [{ pid, port, startedAt, folder, canStop }],
 * or null with `error` when the list could not be read. This server (`selfPid`) is never a stray.
 */
export function straysCheck({ procs = null, error = '', selfPid, now }) {
  if (!Array.isArray(procs)) return { state: 'ok', text: `The list of running dashboards could not be read this time${error ? `: ${error}` : ''}.`, saw: 'no process list', extra: { strays: [] } }
  const strays = procs.filter(p => p.pid !== selfPid && timeOf(p.startedAt) !== null && now - timeOf(p.startedAt) > STRAY_AGE_MS)
    .map(p => ({ pid: p.pid, port: p.port ?? null, startedAt: p.startedAt, ageMs: now - timeOf(p.startedAt), folder: p.folder || '', canStop: !!p.canStop }))
    .sort((a, b) => b.ageMs - a.ageMs)
  const where = s => `${s.port ? `port ${s.port}` : 'no port'}, ${ago(s.ageMs)}${s.folder ? `, in ${s.folder}` : ''}`
  return {
    state: strays.length ? 'degraded' : 'ok',
    text: strays.length
      ? `${plural(strays.length, 'other dashboard copy', 'other dashboard copies')} ${strays.length === 1 ? 'has' : 'have'} run for more than 6 hours: ${strays.map(where).join('; ')}. Nothing stops ${strays.length === 1 ? 'it' : 'them'} by itself: press Stop if you no longer use ${strays.length === 1 ? 'it' : 'them'}.`
      : `No other dashboard copy has run for more than 6 hours (${plural(procs.filter(p => p.pid !== selfPid).length, 'other copy', 'other copies')} running).`,
    saw: `${plural(procs.length, 'dashboard server')} running`,
    extra: { strays },
  }
}

// ═══ 6. Disk and data growth ═══

/** `items`: [{ key (a DISK_LIMITS key), label, bytes }]; `biggest`: the largest evidence folders and files [{ name, bytes }]. */
export function diskCheck({ items = [], biggest = [], limits = DISK_LIMITS }) {
  const over = items.filter(i => Number.isFinite(i.bytes) && limits[i.key] && i.bytes > limits[i.key])
  const state = worst(over.map(i => (i.bytes > 3 * limits[i.key] ? 'failing' : 'degraded')))
  const big = biggest.slice(0, 5).map(b => `${b.name} ${sizeText(b.bytes)}`).join(', ')
  return {
    state,
    text: over.length
      ? `${over.map(i => `${i.label} is ${sizeText(i.bytes)} (past ${sizeText(limits[i.key])})`).join('; ')}.${big ? ` The biggest: ${big}.` : ''} Nothing is deleted by itself.`
      : `Sizes are sensible: ${items.map(i => `${i.label.replace(/^The /, 'the ')} ${sizeText(i.bytes)}`).join(', ') || 'nothing written yet'}.`,
    saw: items.map(i => `${i.key} ${sizeText(i.bytes)}`).join(', '),
    extra: { items, biggest: biggest.slice(0, 5) },
  }
}

// ═══ 7. Config problems ═══

/** { parses, error, warnings: [sentences] }: config.json read again now, every settings reader run with a collecting warn. */
export function configCheck({ parses = true, error = '', warnings = [] }) {
  if (!parses) return { state: 'failing', text: `config.json does not parse: ${error}. The dashboard keeps the settings it started with until it is fixed and restarted.`, saw: 'config.json unreadable', extra: { warnings: [] } }
  return {
    state: warnings.length ? 'degraded' : 'ok',
    text: warnings.length ? `${plural(warnings.length, 'setting')} in config.json ${warnings.length === 1 ? 'was' : 'were'} ignored: ${warnings.join(' ')}` : 'config.json reads, and every setting in it is used.',
    saw: `${plural(warnings.length, 'warning')}`,
    extra: { warnings },
  }
}

// ═══ 8. The server itself ═══

/** `minutes`: the last few minutes of the event loop, oldest first: [{ p99Ms, maxMs, slowest: { what, ms } | null }]. */
export function serverCheck({ minutes = [], delay = DELAY }) {
  const last = minutes.slice(-delay.minutes)
  const full = last.length >= delay.minutes
  const all = limit => full && last.every(m => m.p99Ms > limit)
  const state = all(delay.failing) ? 'failing' : all(delay.degraded) ? 'degraded' : 'ok'
  const slow = last.map(m => m.slowest).filter(Boolean).sort((a, b) => b.ms - a.ms)[0]
  const peak = Math.max(0, ...last.map(m => m.p99Ms))
  return {
    state,
    text: state === 'ok'
      ? `The server answers in time${minutes.length ? ` (in the last minute it was held up at most ${Math.round(minutes.at(-1).p99Ms)} ms, 99 times in 100)` : ''}.`
      : `The page may feel frozen: for ${delay.minutes} minutes the server was held up to ${Math.round(peak)} ms at a time.${slow ? ` The slowest work: ${slow.what} (${(slow.ms / 1000).toFixed(1)} s).` : ''} Nothing is repaired by itself; restart the dashboard if it goes on.`,
    saw: last.map(m => `${Math.round(m.p99Ms)} ms`).join(', ') || 'no minute measured yet',
  }
}

// ═══ 9. Agents ═══

/**
 * `status`: the dashboard's last /api/status (its agents: label, status, coordinator, transcriptAt), or null;
 * `coordinator` the coordinator's label; `cli` the factory command's path, for the coordinator's nudge.
 */
export function agentsCheck({ status = null, coordinator, cli = 'tools/factory.mjs', now }) {
  if (!status) return { state: 'ok', text: 'Not looked at yet: the agents are read with the first status.', saw: 'no status yet', extra: { nudges: [] } }
  const agents = Array.isArray(status.agents) ? status.agents : []
  const hung = agents.filter(a => a.status === 'busy' && timeOf(a.transcriptAt) !== null && now - timeOf(a.transcriptAt) > HUNG_MS)
  const hasCoordinator = agents.some(a => a.coordinator || a.label === coordinator)
  const parts = hung.map(a => `${a.label} is marked busy but has written nothing for ${ago(now - timeOf(a.transcriptAt))}: it may be stuck.`)
  const nudges = hung.map(a => ({ agent: a.label, text: `Are you still working? You have been busy for ${ago(now - timeOf(a.transcriptAt))} with no new output. If you are stuck, say what you are waiting on; if you are done, say so.` }))
  if (!hasCoordinator) {
    parts.push(`${coordinator} has no session open: deliveries to it wait, and it cannot read what changed.`)
    nudges.push({ agent: coordinator, text: `You are ${coordinator}, the coordinator. Start by reading the whole orchestration: node ${cli} orchestration --by "${coordinator}"` })
  }
  return {
    state: parts.length ? 'degraded' : 'ok',
    text: parts.length ? `${parts.join(' ')} Copy a nudge to paste into that session; nothing is sent from here.` : `Every busy agent is writing, and ${coordinator} has a session open.`,
    saw: `${plural(agents.length, 'session')}, ${hung.length} busy with no output for 30 minutes, coordinator ${hasCoordinator ? 'open' : 'missing'}`,
    extra: { nudges },
  }
}
