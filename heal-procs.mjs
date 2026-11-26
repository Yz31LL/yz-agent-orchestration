// The dashboard servers running on this computer, for the watchdog's Stray servers check (heal-reports.mjs
// straysCheck), and the user's Stop for one of them.
//
//   parseListing(text)                          PowerShell's JSON (below) as { procs: [{ pid, command, startedAt }],
//                                               ports: Map(pid -> [port]) }
//   dashboardServers({ procs, ports, here })    the node processes whose script is a server.mjs: [{ pid, port, ports,
//                                               startedAt, folder, canStop }]
//   makeProcs({ exec, kill, here, selfPid })    -> { servers(), stop(pid, startedAt) }
//
// ═══ SAFETY: NOTHING IS EVER STOPPED BY ITSELF ═══
// - The check only LISTS. The one stop is the USER's press of Stop on the Health page (insight-routes.mjs), and stop()
//   lists the processes AGAIN first and stops the pid only when, at that moment, (1) it is still a node process whose
//   command line names THIS repo's server.mjs or one of its worktrees' (`canStop`: an absolute path under the main
//   checkout or its .worktrees folder), (2) it started at the same time the page showed (a pid the system gave to
//   another process since is refused), and (3) it is not this server. Anything else is refused with a plain sentence.
// - A copy started with a relative path (`node server.mjs`) cannot show its folder in its command line, so it is
//   listed with no folder and no Stop button: stop it in its own terminal.
// - The listing is read only: PowerShell's Get-CimInstance Win32_Process (as restart.mjs reads its parent) and
//   Get-NetTCPConnection for the listening ports. Off Windows the list is not read and the check says so.
// - `exec` and `kill` are injected: the tests and a preview (FACTORY_TEST_PROCS, insight-wiring.mjs) hand in a seeded
//   listing and a kill that only records, so no test ever looks at, or stops, a process it did not start.

import { execFile } from 'node:child_process'
import path from 'node:path'

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

/** The node processes that run a server.mjs, with their folder and whether the user may stop them from here. */
export function dashboardServers({ procs = [], ports = new Map(), here }) {
  const root = lower(mainRoot(here))
  const out = []
  for (const p of procs) {
    const script = serverScript(p.command)
    if (!script) continue
    const absolute = /^([A-Za-z]:[\\/]|\/|\\\\)/.test(script)
    const folder = absolute ? slash(path.win32.dirname(script)) : ''
    const f = lower(folder)
    const trees = `${root}/.worktrees/`
    const canStop = !!folder && (f === root || (f.startsWith(trees) && f.length > trees.length && !f.slice(trees.length).includes('/')))
    const list = ports.get(p.pid) || []
    out.push({ pid: p.pid, port: list[0] ?? null, ports: list, startedAt: p.startedAt, folder, canStop })
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
export function makeProcs({ exec = null, kill = pid => process.kill(pid), here, selfPid = process.pid, platform = process.platform } = {}) {
  const run = exec || (platform === 'win32' ? () => powershell(LIST_SCRIPT) : null)

  async function servers() {
    if (!run) return { procs: null, error: 'the process list is only read on Windows' }
    const r = await run()
    if (!r.ok) return { procs: null, error: (r.err || 'PowerShell failed').split(/\r?\n/)[0].slice(0, 160) }
    try {
      return { procs: dashboardServers({ ...parseListing(r.out), here }), error: '' }
    } catch (err) {
      return { procs: null, error: err.message }
    }
  }

  /** The user's Stop: listed again, checked again (see the header), then stopped. { ok, error? } in plain words. */
  async function stop(pid, startedAt) {
    const n = Number(pid)
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'Say which copy to stop.' }
    if (n === selfPid) return { ok: false, error: 'That is this dashboard: it is never stopped from here.' }
    const { procs, error } = await servers()
    if (!procs) return { ok: false, error: `The running copies could not be listed, so nothing was stopped: ${error}.` }
    const p = procs.find(x => x.pid === n)
    if (!p) return { ok: false, error: 'That copy is not running any more.' }
    if (!p.canStop) return { ok: false, error: 'That process is not a copy of this dashboard in its own folder or a worktree, so it is not stopped from here.' }
    if (startedAt && p.startedAt !== startedAt) return { ok: false, error: 'That process number now belongs to another process, so nothing was stopped.' }
    try {
      kill(n)
      return { ok: true, pid: n, port: p.port, folder: p.folder }
    } catch (err) {
      return { ok: false, error: `It could not be stopped: ${err?.code === 'EPERM' ? 'Windows did not allow it' : err?.message || err}.` }
    }
  }

  return { servers, stop }
}
