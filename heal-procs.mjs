// The dashboard servers running on this computer, for the watchdog's Stray servers check (heal-reports.mjs
// straysCheck), and the user's Stop for one of them.
//
//   parseListing(text)                          PowerShell's JSON (below) as { procs: [{ pid, command, startedAt }],
//                                               ports: Map(pid -> [port]) }
//   dashboardServers({ procs, ports, here })    the DASHBOARD COPIES: node processes running the server.mjs of one of
//                                               this repo's worktrees: [{ pid, port, ports, startedAt, folder }]
//   makeProcs({ exec, kill, here, selfPid, now })   -> { servers(), stop(pid, startedAt) }
//   seededProcs(file, { here, say, ... })       a preview's stand-in (FACTORY_TEST_PROCS): the listing read from a
//                                               file, and a Stop that only says what it would have stopped
//
// ═══ WHAT A DASHBOARD COPY IS (QA, 2026-11-27: a preview offered to stop the LIVE dashboard) ═══
// ONLY `<repo>/.worktrees/<name>/server.mjs`, named by its absolute path. Never listed, never stoppable from any copy:
// - the MAIN CHECKOUT's server.mjs: that is the live dashboard (the one on the configured port), even when this server
//   is a worktree preview and it looks like just another copy from here;
// - a server.mjs started with a relative path (`node server.mjs`): its folder is not in its command line, so it may
//   well be the live one;
// - a server.mjs in any other folder, or in a folder below a worktree: not a copy of this dashboard.
//
// ═══ SAFETY: NOTHING IS EVER STOPPED BY ITSELF ═══
// - The check only LISTS. The one stop is the USER's press of Stop on the Health page (insight-routes.mjs), and stop()
//   lists the processes AGAIN first and stops the pid only when, at that moment, (1) it is still a dashboard copy as
//   above, (2) it started at the same time the page showed (REQUIRED: a pid the system gave to another process since
//   is refused), (3) it has run for more than 6 hours (STRAY_AGE_MS: a younger one is a preview in use), and (4) it is
//   not this server. Anything else is refused with a plain sentence.
// - The listing is read only: PowerShell's Get-CimInstance Win32_Process (as restart.mjs reads its parent) and
//   Get-NetTCPConnection for the listening ports. Off Windows the list is not read and the check says so.
// - `exec` and `kill` are injected: the tests and a preview (FACTORY_TEST_PROCS, insight-wiring.mjs) hand in a seeded
//   listing and a kill that only records, so no test ever looks at, or stops, a process it did not start.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { STRAY_AGE_MS } from './heal-reports.mjs'

const LIST_SCRIPT = [
  "$p = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { [pscustomobject]@{ ProcessId = $_.ProcessId; CommandLine = $_.CommandLine; Start = $_.CreationDate.ToUniversalTime().ToString('o') } })",
  '$l = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort, OwningProcess)',
  '[pscustomobject]@{ procs = $p; ports = $l } | ConvertTo-Json -Compress -Depth 3',
].join('; ')

const slash = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
const lower = p => slash(p).toLowerCase()
const arr = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [])

/** PowerShell's JSON as { procs, ports }; throws a plain error when it is not that. */
export function parseListing(text) {
  let j
  try {
    j = JSON.parse(String(text || '').trim())
  } catch {
    throw new Error('the process list did not come back as JSON')
  }
  const procs = arr(j?.procs).map(p => ({ pid: Number(p.ProcessId), command: String(p.CommandLine || ''), startedAt: String(p.Start || '') }))
    .filter(p => Number.isInteger(p.pid) && p.pid > 0)
  const ports = new Map()
  for (const l of arr(j?.ports)) {
    const pid = Number(l.OwningProcess)
    const port = Number(l.LocalPort)
    if (!Number.isInteger(pid) || !Number.isInteger(port)) continue
    ports.set(pid, [...new Set([...(ports.get(pid) || []), port])].sort((a, b) => a - b))
  }
  return { procs, ports }
}

/** The script a node command line runs when it is a `server.mjs` (quoted or not), or null. */
export function serverScript(command) {
  const re = /"([^"]+)"|(\S+)/g
  for (let m = re.exec(command); m; m = re.exec(command)) {
    const token = m[1] ?? m[2]
    if (path.posix.basename(slash(token)).toLowerCase() === 'server.mjs') return token
  }
  return null
}

/** The main checkout of the repo `here` belongs to: `here` itself, or the folder above its .worktrees. */
export function mainRoot(here) {
  const h = slash(here)
  const m = /^(.*)\/\.worktrees\/[^/]+$/i.exec(h)
  return m ? m[1] : h
}

/** The dashboard copies: the node processes running a worktree's own server.mjs (see the header), with their folder. */
export function dashboardServers({ procs = [], ports = new Map(), here }) {
  const trees = `${lower(mainRoot(here))}/.worktrees/`
  const out = []
  for (const p of procs) {
    const script = serverScript(p.command)
    if (!script || !/^([A-Za-z]:[\\/]|\/|\\\\)/.test(script)) continue // relative: its folder is not known
    // Resolve . and .. FIRST: <repo>/.worktrees/../server.mjs is the main checkout, never a copy.
    const folder = slash(path.win32.dirname(path.win32.normalize(script)))
    const f = lower(folder)
    if (!f.startsWith(trees) || f.length === trees.length || f.slice(trees.length).includes('/')) continue
    const list = ports.get(p.pid) || []
    out.push({ pid: p.pid, port: list[0] ?? null, ports: list, startedAt: p.startedAt, folder })
  }
  return out
}

/** PowerShell, read only, with its own timeout. Resolves { ok, out, err }. */
function powershell(script, timeout = 20_000) {
  return new Promise(done => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, out, stderr) => done({ ok: !err, out: String(out || ''), err: String(stderr || err?.message || '').trim() }))
  })
}

/**
 * `exec()` resolves { ok, out, err } with the listing's JSON (PowerShell by default; Windows only); `kill(pid)` stops
 * a process (process.kill by default). `here` is this server's folder, `selfPid` its pid.
 */
export function makeProcs({ exec = null, kill = pid => process.kill(pid), here, selfPid = process.pid, platform = process.platform, now = () => Date.now() } = {}) {
  const run = exec || (platform === 'win32' ? () => powershell(LIST_SCRIPT) : null)

  /** Every node process as listed ({ listing }), or { error }. */
  async function listing() {
    if (!run) return { error: 'the process list is only read on Windows' }
    const r = await run()
    if (!r.ok) return { error: (r.err || 'PowerShell failed').split(/\r?\n/)[0].slice(0, 160) }
    try {
      return { listing: parseListing(r.out) }
    } catch (err) {
      return { error: err.message }
    }
  }

  async function servers() {
    const l = await listing()
    return l.error ? { procs: null, error: l.error } : { procs: dashboardServers({ ...l.listing, here }), error: '' }
  }

  /**
   * The user's Stop: listed again, checked again (see the header), then stopped. { ok, error? } in plain words.
   * `startedAt` (the start time the page showed) is REQUIRED: without it a pid the system gave to another process
   * since could not be told apart (QA, 2026-11-27: a Stop sent with no start time skipped that check).
   */
  async function stop(pid, startedAt) {
    const n = Number(pid)
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'Say which copy to stop.' }
    if (typeof startedAt !== 'string' || !startedAt.trim()) return { ok: false, error: 'Say when it started, as the page showed it, so no other process is stopped by mistake.' }
    if (n === selfPid) return { ok: false, error: 'That is this dashboard: it is never stopped from here.' }
    const l = await listing()
    if (l.error) return { ok: false, error: `The running copies could not be listed, so nothing was stopped: ${l.error}.` }
    const p = dashboardServers({ ...l.listing, here }).find(x => x.pid === n)
    if (!p && l.listing.procs.some(x => x.pid === n)) return { ok: false, error: 'That process is not a copy of this dashboard in a worktree (the main checkout is the live dashboard), so it is not stopped from here.' }
    if (!p) return { ok: false, error: 'That copy is not running any more.' }
    if (p.startedAt !== startedAt) return { ok: false, error: 'That process number now belongs to another process, so nothing was stopped.' }
    const started = Date.parse(p.startedAt)
    if (!Number.isFinite(started) || now() - started <= STRAY_AGE_MS) return { ok: false, error: 'That copy has run for less than 6 hours: someone may be looking at it, so it is not stopped from here.' }
    try {
      kill(n)
      return { ok: true, pid: n, port: p.port, folder: p.folder }
    } catch (err) {
      return { ok: false, error: `It could not be stopped: ${err?.code === 'EPERM' ? 'Windows did not allow it' : err?.message || err}.` }
    }
  }

  return { servers, stop }
}

/**
 * FACTORY_TEST_PROCS (insight-wiring.mjs): a preview or an end-to-end check reads the listing from `file` instead of
 * the real one, and its Stop only says what it would have stopped. No real process is looked at or stopped.
 */
export function seededProcs(file, { here, say = console.log, ...rest } = {}) {
  return makeProcs({ ...rest, here, platform: 'win32', exec: async () => ({ ok: true, out: readFileSync(file, 'utf8') }), kill: pid => say(`heal: FACTORY_TEST_PROCS is set, so process ${pid} was NOT stopped`) })
}
