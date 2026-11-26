// Tests for heal-store.mjs: the watchdog's switches and last look (data/heal-state.json) and its repair log
// (data/heal-log.jsonl), and the Health part the digest shows when the dashboard is not running. Temp folders only.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-store-test-'))
process.env.FACTORY_DATA_DIR = TMP
const H = await import('../heal-store.mjs')
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

let k = 0
const dir = () => fs.mkdtempSync(path.join(TMP, `d${k++}-`))
const NOW = Date.parse('2026-11-26T12:00:00.000Z')

test('a missing or torn state file reads as empty; only well-formed entries are kept', () => {
  const d = dir()
  const file = path.join(d, 'heal-state.json')
  assert.deepEqual(H.readHealState(file), { off: {}, seen: null, resumed: {}, copied: {} })
  fs.writeFileSync(file, '{ torn')
  assert.deepEqual(H.readHealState(file), { off: {}, seen: null, resumed: {}, copied: {} })
  fs.writeFileSync(file, JSON.stringify({ off: { strays: true, disk: false, '../x': true }, resumed: { prod: '2026-11-26T10:00:00.000Z', 'a b': 'x' }, seen: { at: 'nope', checks: [] } }))
  assert.deepEqual(H.readHealState(file), { off: { strays: true }, seen: null, resumed: { prod: '2026-11-26T10:00:00.000Z' }, copied: {} })
  H.updateHealState(s => ({ ...s, off: { ...s.off, disk: true } }), file)
  assert.deepEqual(H.readHealState(file).off, { strays: true, disk: true })
})

test('the repair log: one line per repair, torn lines skipped, the newest kept', () => {
  const d = dir()
  const file = path.join(d, 'heal-log.jsonl')
  assert.deepEqual(H.readHealLog(file), [])
  H.appendHealLog({ at: new Date(NOW).toISOString(), check: 'refresh', name: 'Paid ticket refresh', saw: '3 failures', did: 'Paused the timer.', result: 'done' }, { file })
  fs.appendFileSync(file, '{"at": torn\n')
  H.appendHealLog({ check: 'loops', saw: 'silent', did: 'Restarted it.', result: 'failed' }, { file })
  const all = H.readHealLog(file)
  assert.equal(all.length, 2)
  assert.equal(all[0].name, 'Paid ticket refresh')
  assert.equal(all[1].name, 'loops')
  for (let i = 0; i < H.LOG_KEEP + 201; i++) H.appendHealLog({ at: new Date(NOW + i).toISOString(), check: 'x', did: `${i}` }, { file })
  const kept = H.readHealLog(file)
  assert.ok(kept.length <= H.LOG_KEEP + 200)
  assert.equal(kept.at(-1).did, String(H.LOG_KEEP + 200))
})

test('healthFromFiles: the last look marked stale, the repairs of the last 24 hours newest first, none when it never looked', () => {
  const d = dir()
  const file = path.join(d, 'heal-state.json')
  const logFile = path.join(d, 'heal-log.jsonl')
  assert.equal(H.healthFromFiles({ now: NOW, file, logFile }), null)
  H.updateHealState(s => ({ ...s, seen: { at: new Date(NOW - 600_000).toISOString(), checks: [{ id: 'refresh', name: 'Paid ticket refresh', state: 'failing', text: 'Paused.' }] } }), file)
  H.appendHealLog({ at: new Date(NOW - 2 * 86_400_000).toISOString(), check: 'refresh', did: 'old' }, { file: logFile })
  H.appendHealLog({ at: new Date(NOW - 3_600_000).toISOString(), check: 'refresh', did: 'would pause', result: 'would' }, { file: logFile })
  H.appendHealLog({ at: new Date(NOW - 60_000).toISOString(), check: 'refresh', did: 'Paused the timer.' }, { file: logFile })
  const v = H.healthFromFiles({ now: NOW, file, logFile, settings: { enabled: true, repairs: false } })
  assert.equal(v.stale, true)
  assert.equal(v.repairs, false)
  assert.equal(v.checks[0].state, 'failing')
  assert.deepEqual(v.repairs24h.map(r => r.did), ['Paused the timer.'])
})
