// The open-asks reminder (open-asks.mjs, run by tools/open-asks-hook.mjs on every message the user sends): it
// tells the session which of its asks still wait on the dashboard, so an answer typed in the chat gets recorded
// with `flow answered` and the ask leaves Human review. Pure: flows and registry folders in, text out.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openAsksNote, sessionName } from '../open-asks.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'open-asks-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const askNode = (id, title, extra = {}) => ({ id, type: 'ask', title, kind: 'yesno', yes: 'Go', no: 'Stop', answer: null, ...extra })
const FLOWS = [
  { id: 'ask-1', agent: 'Coordinator', status: 'open', nodes: [askNode('n1', 'Queue the old items?'), askNode('n2', 'Done already?', { answer: 'yes' })] },
  { id: 'work-2', agent: 'coordinator', status: 'open', nodes: [{ id: 'n1', type: 'step', title: 'Build' }, askNode('n2', 'Which colour?', { kind: 'text', yes: '', no: '' })] },
  { id: 'other', agent: 'Retesting', status: 'open', nodes: [askNode('n1', 'Not mine?')] },
  { id: 'closed', agent: 'Coordinator', status: 'done', nodes: [askNode('n1', 'Closed flow?')] },
]

test("lists only this session's OPEN asks on open flows, any case of its name, with the command to record a chat answer", () => {
  const note = openAsksNote(FLOWS, 'Coordinator', 'node C:/dash/tools/factory.mjs')
  assert.match(note, /- ask-1 n1: Queue the old items\? \(yes = Go; no = Stop\)/)
  assert.match(note, /- work-2 n2: Which colour\? \(a text answer\)/)
  assert.doesNotMatch(note, /Done already|Not mine|Closed flow/)
  assert.match(note, /node C:\/dash\/tools\/factory\.mjs flow answered <flow> <node> --answer yes\|no\|"<text>" --note "<the user's words>"/)
  assert.match(note, /Leave the others open/)
})

test('no name, or nothing open, gives no note at all (the hook then prints nothing)', () => {
  assert.equal(openAsksNote(FLOWS, '', 'x'), '')
  assert.equal(openAsksNote(FLOWS, 'Learning', 'x'), '')
  assert.equal(openAsksNote([], 'Coordinator', 'x'), '')
})

test('a long list is cut, saying how many more there are', () => {
  const many = [{ id: 'big', agent: 'A', status: 'open', nodes: Array.from({ length: 12 }, (_, i) => askNode(`n${i + 1}`, `Q${i + 1}?`)) }]
  const note = openAsksNote(many, 'A', 'x')
  assert.equal(note.match(/^- big /gm).length, 8)
  assert.match(note, /and 4 more/)
})

test("sessionName finds the session's name in the harness registry; a broken file or a missing folder is skipped", () => {
  const dir = path.join(TMP, 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ sessionId: 'aaa', name: 'Coordinator' }))
  fs.writeFileSync(path.join(dir, '2.json'), '{ broken')
  fs.writeFileSync(path.join(dir, '3.json.key'), 'nope')
  assert.equal(sessionName('aaa', [path.join(TMP, 'missing'), TMP]), 'Coordinator')
  assert.equal(sessionName('bbb', [TMP]), '')
})
