// Tests for what the watchdog needs from the ticket refresh (factory.mjs) and the spend log (spend.mjs): each refresh
// keeps its last outcomes in memory, a paused collection's timer skips its turn (config.json is never written) until
// Resume, and each refresh cost names its collection. `run` is injected (no Claude), FACTORY_DATA_DIR is a temp folder.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-refresh-test-'))
const { DATA_DIR } = await import('../flows.mjs')
const { makeSources } = await import('../factory.mjs')
const { recordCost, spendLines, readSpend, KINDS } = await import('../spend.mjs')
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))

const CONFIG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json')
const configBefore = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null
const SB = { id: 'prod', name: 'Production checklist', kind: 'switchboard', project: 'p1', tools: ['mcp__switchboard-claude__list_stories'], refreshMinutes: 20 }
const failing = async () => ({ ok: false, out: JSON.stringify({ result: 'I could not call the tool.', total_cost_usd: 0.031, is_error: true }), err: 'exited with code 1' })

test('every refresh outcome is kept in memory (the last 20), with the real error, and its cost names the collection', async () => {
  const S = makeSources({ collections: [SB], run: failing })
  for (let i = 0; i < 22; i++) await S.refreshSource('prod')
  const h = S.historyOf('prod')
  assert.equal(h.length, 20)
  assert.equal(h.every(x => x.ok === false), true)
  assert.match(h.at(-1).message, /No dump file came back\. I could not call the tool\./)
  const lines = spendLines('refresh')
  assert.equal(lines.length, 22)
  assert.deepEqual(Object.keys(lines[0]).sort(), ['at', 'collection', 'kind', 'usd'])
  assert.equal(lines[0].collection, 'prod')
  assert.deepEqual(S.historyOf('nope'), [])
})

test('pause: the timer skips its turn while paused, the button still runs, Resume starts the timer again; config.json is untouched', async () => {
  const calls = []
  const S = makeSources({ collections: [SB], run: async () => (calls.push(1), failing()) })
  // the timer's callback, as setInterval would call it
  const realSet = globalThis.setInterval
  const timers = []
  globalThis.setInterval = (fn, ms) => (timers.push({ fn, ms }), { unref: () => {} })
  try {
    S.startAutoRefresh()
  } finally {
    globalThis.setInterval = realSet
  }
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 20 * 60_000)
  assert.equal(S.pause('prod'), true)
  assert.equal(S.pause('prod'), false, 'already paused')
  assert.equal(S.pause('nope'), false)
  assert.equal(S.refreshStatus('prod').paused, true)
  await timers[0].fn()
  assert.equal(calls.length, 0, 'a paused timer runs no paid turn')
  await S.refreshSource('prod')
  assert.equal(calls.length, 1, 'the user pressed Refresh: that runs')
  assert.equal(S.resume('prod'), true)
  assert.equal(S.resume('prod'), false)
  await timers[0].fn()
  await new Promise(r => setTimeout(r, 10))
  assert.equal(calls.length, 2)
  assert.equal(fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null, configBefore)
})

test('spend: the insight kind is known, a bad collection name is not written, spendLines skips torn lines', () => {
  assert.ok(KINDS.includes('insight'))
  assert.equal(recordCost('insight', 0.02), true)
  assert.equal(readSpend().byKind.insight > 0, true)
  recordCost('refresh', 0.01, new Date(), { collection: '../../etc' })
  fs.appendFileSync(path.join(DATA_DIR, 'spend.jsonl'), '{"at": torn\n')
  const last = spendLines('refresh').at(-1)
  assert.equal(last.usd, 0.01)
  assert.equal('collection' in last, false)
  assert.deepEqual(spendLines('nothing-of-this-kind'), [])
})
