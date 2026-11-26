// Tests for heal-procs.mjs with an INJECTED process list and an injected kill that only records: no test looks at,
// or stops, a process it did not start. The list finds the node processes that run a server.mjs; the user's Stop
// stops only a copy of THIS repo or one of its worktrees, started when the page showed it, never this server.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dashboardServers, mainRoot, makeProcs, parseListing, serverScript } from '../heal-procs.mjs'

const HERE = 'C:\\Users\\me\\agent-dashboard\\.worktrees\\insight'
const listing = (procs, ports = []) => JSON.stringify({ procs, ports })
const P = (pid, CommandLine, Start = '2026-11-26T01:00:00.0000000Z') => ({ ProcessId: pid, CommandLine, Start })
const LISTING = listing([
  P(100, '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\agent-dashboard\\server.mjs'),
  P(101, 'node "C:\\Users\\me\\agent-dashboard\\.worktrees\\phone pr\\server.mjs"', '2026-11-25T20:00:00.0000000Z'),
  P(102, 'node server.mjs'),
  P(103, 'node C:\\Users\\me\\other-app\\server.mjs'),
  P(104, 'node C:\\Users\\me\\agent-dashboard\\phone-server.mjs'),
  P(105, 'node --test test/server.test.mjs'),
  P(106, 'node C:\\Users\\me\\agent-dashboard\\.worktrees\\a\\nested\\server.mjs'),
  P(107, null),
], [{ LocalPort: 4317, OwningProcess: 100 }, { LocalPort: 4318, OwningProcess: 100 }, { LocalPort: 4497, OwningProcess: 101 }])

test('the listing: PowerShell JSON read, a single object as a list, the ports per process', () => {
  const { procs, ports } = parseListing(LISTING)
  assert.equal(procs.length, 8)
  assert.deepEqual(ports.get(100), [4317, 4318])
  const one = parseListing(JSON.stringify({ procs: P(5, 'node x'), ports: { LocalPort: 1, OwningProcess: 5 } }))
  assert.equal(one.procs.length, 1)
  assert.throws(() => parseListing('not json'), /did not come back as JSON/)
})

test('which processes are dashboard servers, with their folder, and which may be stopped from here', () => {
  assert.equal(serverScript('node server.mjs'), 'server.mjs')
  assert.equal(serverScript('node C:\\x\\phone-server.mjs'), null)
  assert.equal(serverScript('node --test test/server.test.mjs'), null)
  assert.equal(mainRoot(HERE), 'C:/Users/me/agent-dashboard')
  assert.equal(mainRoot('C:\\Users\\me\\agent-dashboard'), 'C:/Users/me/agent-dashboard')
  const s = dashboardServers({ ...parseListing(LISTING), here: HERE })
  assert.deepEqual(s.map(x => [x.pid, x.port, x.folder, x.canStop]), [
    [100, 4317, 'C:/Users/me/agent-dashboard', true],
    [101, 4497, 'C:/Users/me/agent-dashboard/.worktrees/phone pr', true],
    [102, null, '', false], // relative: its folder is not in its command line
    [103, null, 'C:/Users/me/other-app', false], // another app's server.mjs
    [106, null, 'C:/Users/me/agent-dashboard/.worktrees/a/nested', false], // not a worktree's own folder
  ])
})

test('stop: only on a fresh listing, only a copy of this repo or a worktree, the same start time, never this server', async () => {
  const killed = []
  const procs = makeProcs({ exec: async () => ({ ok: true, out: LISTING }), kill: pid => killed.push(pid), here: HERE, selfPid: 100 })
  assert.match((await procs.stop(100)).error, /That is this dashboard/)
  assert.match((await procs.stop(103)).error, /not a copy of this dashboard/)
  assert.match((await procs.stop(102)).error, /not a copy of this dashboard/)
  assert.match((await procs.stop(999)).error, /not running any more/)
  assert.match((await procs.stop('x')).error, /Say which copy/)
  assert.match((await procs.stop(101, '2026-11-26T09:00:00.0000000Z')).error, /now belongs to another process/)
  assert.deepEqual(killed, [], 'nothing stopped so far')
  const ok = await procs.stop(101, '2026-11-25T20:00:00.0000000Z')
  assert.equal(ok.ok, true)
  assert.equal(ok.port, 4497)
  assert.deepEqual(killed, [101])
  // a kill that fails says so in plain words
  const denied = makeProcs({ exec: async () => ({ ok: true, out: LISTING }), kill: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }) }, here: HERE, selfPid: 1 })
  assert.match((await denied.stop(101)).error, /Windows did not allow it/)
})

test('servers(): a failed or missing listing is no list with the reason; off Windows it is not read', async () => {
  const bad = makeProcs({ exec: async () => ({ ok: false, out: '', err: 'Access denied\nmore' }), here: HERE })
  assert.deepEqual(await bad.servers(), { procs: null, error: 'Access denied' })
  const linux = makeProcs({ here: HERE, platform: 'linux' })
  assert.deepEqual(await linux.servers(), { procs: null, error: 'the process list is only read on Windows' })
  const killed = []
  const off = makeProcs({ exec: async () => ({ ok: false, err: 'x' }), kill: p => killed.push(p), here: HERE })
  assert.match((await off.stop(101)).error, /could not be listed, so nothing was stopped/)
  assert.deepEqual(killed, [])
})
