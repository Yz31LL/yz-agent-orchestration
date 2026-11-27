// Tests for spend.mjs (spec F4): what the dashboard's own headless turns cost,
// one line per turn in data/spend.jsonl, summed per LOCAL calendar day.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the import, so no test
// ever touches the real data/ folder. Each test starts from an empty file.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-test-'))
const { KINDS, SPEND_FILE, parseTurn, readSpend, recordCost, spendBetween } = await import('../spend.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))
beforeEach(() => fs.rmSync(SPEND_FILE, { force: true }))

/** A fixed local time: 13 Nov 2026 at `h`:`m`, whatever the machine's zone. */
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m)
const line = (when, kind, usd) => JSON.stringify({ at: when.toISOString(), kind, usd })
const write = lines => fs.writeFileSync(SPEND_FILE, lines.join('\n') + '\n')
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`)

test('the file lives under FACTORY_DATA_DIR', () => {
  assert.ok(SPEND_FILE.startsWith(process.env.FACTORY_DATA_DIR), SPEND_FILE)
  assert.equal(path.basename(SPEND_FILE), 'spend.jsonl')
})

test('recordCost appends one JSON line per turn with at, kind and usd', () => {
  assert.equal(recordCost('explain', 0.0012, at(13, 9)), true)
  assert.equal(recordCost('chat', 0.44, at(13, 10)), true)
  const lines = fs.readFileSync(SPEND_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(lines, [
    { at: at(13, 9).toISOString(), kind: 'explain', usd: 0.0012 },
    { at: at(13, 10).toISOString(), kind: 'chat', usd: 0.44 },
  ])
})

test('recordCost writes nothing for a missing, zero, negative or non-number cost', () => {
  for (const usd of [null, undefined, 0, -1, NaN, Infinity, '0.5']) assert.equal(recordCost('relay', usd), false)
  assert.equal(fs.existsSync(SPEND_FILE), false)
})

test('recordCost refuses an unknown kind, and never throws', () => {
  assert.equal(recordCost('lunch', 1), false)
  assert.equal(fs.existsSync(SPEND_FILE), false)
  assert.deepEqual([...KINDS], ['chat', 'relay', 'explain', 'refresh', 'script', 'standup', 'lesson', 'critic', 'intake', 'retro', 'learn', 'phone', 'insight'])
  assert.equal(recordCost('script', 0.2, at(13, 11)), true, 'a Prompt generator run is a kind of its own')
  assert.equal(recordCost('standup', 0.07, at(13, 11)), true, 'and so is a Standup creator run')
  fs.rmSync(SPEND_FILE, { force: true })
})

test('recordCost never throws when the file cannot be written: it logs and returns false', () => {
  fs.mkdirSync(SPEND_FILE) // a folder where the file should be: appendFileSync fails with EISDIR
  const errors = []
  const was = console.error
  console.error = (...a) => errors.push(a.join(' '))
  try {
    assert.equal(recordCost('chat', 0.5), false)
  } finally {
    console.error = was
    fs.rmSync(SPEND_FILE, { recursive: true, force: true })
  }
  assert.equal(errors.length, 1)
  assert.match(errors[0], /spend/)
})

test('readSpend sums only the lines of the local day of now, by kind', () => {
  write([
    line(at(12, 15), 'chat', 9), // yesterday: not today
    line(at(13, 9), 'chat', 0.44),
    line(at(13, 9, 5), 'explain', 0.001),
    line(at(13, 11), 'chat', 0.5),
    line(at(13, 12), 'refresh', 0.2),
  ])
  const s = readSpend(at(13, 18))
  near(s.today, 1.141)
  near(s.byKind.chat, 0.94)
  near(s.byKind.explain, 0.001)
  near(s.byKind.refresh, 0.2)
  assert.equal(s.byKind.relay, 0)
})

test('a malformed line is skipped: not JSON, a bad time, an unknown kind, a cost that is not a positive number', () => {
  write([
    '{ not json',
    JSON.stringify({ at: 'yesterday-ish', kind: 'chat', usd: 5 }),
    JSON.stringify({ at: at(13, 9).toISOString(), kind: 'lunch', usd: 5 }),
    JSON.stringify({ at: at(13, 9).toISOString(), kind: 'chat', usd: '5' }),
    JSON.stringify({ at: at(13, 9).toISOString(), kind: 'chat', usd: -5 }),
    'null',
    '',
    line(at(13, 10), 'relay', 0.03),
  ])
  const s = readSpend(at(13, 18))
  near(s.today, 0.03)
  assert.equal(s.recent.length, 1)
})

test('the midnight boundary is the LOCAL one: 23:59 yesterday is out, 00:00 today is in', () => {
  write([line(new Date(2026, 10, 12, 23, 59, 59), 'chat', 7), line(new Date(2026, 10, 13, 0, 0, 0), 'explain', 0.25), line(at(14, 0), 'chat', 3)])
  near(readSpend(new Date(2026, 10, 13, 0, 5)).today, 0.25)
  near(readSpend(new Date(2026, 10, 12, 23, 59, 59, 999)).today, 7)
  near(readSpend(at(14, 0, 1)).today, 3)
})

test('recent is the last 20 lines, newest first, whatever their day', () => {
  const lines = []
  for (let i = 0; i < 25; i++) lines.push(line(new Date(2026, 10, 12, 20, i), i % 2 ? 'chat' : 'relay', i / 100))
  write(lines)
  const s = readSpend(at(13, 9))
  assert.equal(s.today, 0)
  assert.equal(s.recent.length, 20)
  assert.equal(s.recent[0].usd, 0.24)
  assert.equal(s.recent.at(-1).usd, 0.05)
  assert.deepEqual(Object.keys(s.recent[0]).sort(), ['at', 'kind', 'usd'])
})

test('no file yet is zero, every kind at zero, nothing recent', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(readSpend(at(13, 9)))), { today: 0, byKind: { chat: 0, relay: 0, explain: 0, refresh: 0, script: 0, standup: 0, lesson: 0, critic: 0, intake: 0, retro: 0, learn: 0, phone: 0, insight: 0 }, recent: [] })
})

// ═══ parseTurn: a `-p --output-format json` reply ═══

test('parseTurn reads the reply text, the cost and the error flag from a json result', () => {
  const out = JSON.stringify({ type: 'result', is_error: false, result: 'SENT', total_cost_usd: 0.031 })
  assert.deepEqual({ ...parseTurn(out) }, { text: 'SENT', cost: 0.031, isError: false })
  assert.equal(parseTurn(JSON.stringify({ result: 'boom', is_error: true })).isError, true)
})

test('parseTurn keeps a reply that is not JSON as plain text with no cost', () => {
  assert.deepEqual({ ...parseTurn('SENT') }, { text: 'SENT', cost: null, isError: false })
  assert.deepEqual({ ...parseTurn('') }, { text: '', cost: null, isError: false })
  assert.deepEqual({ ...parseTurn(undefined) }, { text: '', cost: null, isError: false })
  // JSON that is not a result object stays text too
  assert.deepEqual({ ...parseTurn('42') }, { text: '42', cost: null, isError: false })
})

test('parseTurn gives no cost when total_cost_usd is not a number', () => {
  assert.equal(parseTurn(JSON.stringify({ result: 'ok', total_cost_usd: '0.1' })).cost, null)
})

test('parseTurn reads the json result on the last line when something printed before it (an update notice)', () => {
  const out = 'A new version of Claude Code is available.\n\n' + JSON.stringify({ type: 'result', is_error: false, result: 'SENT', total_cost_usd: 0.02 }) + '\n'
  assert.deepEqual({ ...parseTurn(out) }, { text: 'SENT', cost: 0.02, isError: false })
})

test('parseTurn takes the last result element of an array (verbose output)', () => {
  const out = JSON.stringify([
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'assistant', message: { content: [] } },
    { type: 'result', is_error: false, result: 'first', total_cost_usd: 0.01 },
    { type: 'result', is_error: true, result: 'FAILED: gone', total_cost_usd: 0.03 },
  ])
  assert.deepEqual({ ...parseTurn(out) }, { text: 'FAILED: gone', cost: 0.03, isError: true })
  // an array with no result element is text, as before
  assert.equal(parseTurn('[1,2]').cost, null)
})

test('spendBetween sums the turns from a start (local midnight, as Pipeline tokens asks) to now, by kind', () => {
  write([line(at(12, 23, 59), 'chat', 9), line(at(13, 0, 0), 'chat', 0.5), line(at(14, 9), 'standup', 0.25), 'not json', line(at(15, 9), 'relay', 1)])
  const s = spendBetween(at(13, 0).getTime(), at(14, 23).getTime())
  near(s.usd, 0.75)
  assert.equal(s.turns, 2)
  near(s.byKind.chat, 0.5)
  near(s.byKind.standup, 0.25)
  assert.equal(s.byKind.relay, 0)
  // no start: every turn up to now
  near(spendBetween(null, at(20, 0).getTime()).usd, 10.75)
  fs.rmSync(SPEND_FILE)
  assert.deepEqual(spendBetween(null, Date.now()), { usd: 0, turns: 0, byKind: Object.fromEntries(KINDS.map(k => [k, 0])) })
})
