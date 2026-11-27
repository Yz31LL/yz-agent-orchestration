// An ask the user answered in the chat instead of on the dashboard: `flow answered` (flows.mjs applyChatAnswer)
// records it so Human review drops it, the relay never sends it back, and the page says where it was answered.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports, so no test touches the real data/ folder.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-answer-test-'))
const F = await import('../flows.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
const { storyOf } = await import('../flow-story.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const HERE = path.dirname(fileURLToPath(import.meta.url))
const run = (...argv) => runFlow(argv, { by: 'Agent 3' })
const ask = (flowId, node) => F.readFlow(flowId).nodes.find(n => n.id === node)

/** A new flow with one yes/no ask (n1) and one text ask (n2). */
function flowWithAsks(id) {
  assert.equal(run('new', id, 'Questions', '--type', 'ask').code, 0)
  assert.equal(run('ask', id, 'Ship it?', '--why', 'Unblocks the release', '--yes', 'Ship', '--no', 'Wait').code, 0)
  assert.equal(run('ask', id, 'Which colour?', '--why', 'Picks the theme', '--text').code, 0)
}

test('flow answered records a chat answer: no longer waiting, marked as from the chat, never sent back', () => {
  flowWithAsks('q1')
  const r = run('answered', 'q1', 'n1', '--answer', 'yes', '--note', 'Yes, ship it')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /q1 n1: answered in the chat/)
  const n = ask('q1', 'n1')
  assert.equal(n.answer, 'yes')
  assert.equal(n.answeredIn, 'chat')
  assert.equal(n.note, 'Yes, ship it')
  assert.ok(n.answeredAt && n.sentAt, 'stamped as delivered, so the relay never pushes it to the agent')
  assert.deepEqual(F.derive(F.readFlow('q1')).waiting, ['n2'])
})

test('a text ask takes the answer as text; a yes/no ask refuses anything but yes or no', () => {
  flowWithAsks('q2')
  assert.equal(run('answered', 'q2', 'n2', '--answer', 'Dark green').code, 0)
  assert.equal(ask('q2', 'n2').answer, 'Dark green')
  const bad = run('answered', 'q2', 'n1', '--answer', 'maybe')
  assert.equal(bad.code, 1)
  assert.match(bad.out, /yes, no/)
  assert.equal(ask('q2', 'n1').answer, null)
})

// an agent must never overwrite what the user chose on the dashboard
test('an ask already answered (on the dashboard or in the chat) is refused, and its answer kept', () => {
  flowWithAsks('q3')
  const f = F.readFlow('q3')
  F.applyAnswer(f, 'n1', 'no')
  F.writeFlow(f)
  const r = run('answered', 'q3', 'n1', '--answer', 'yes')
  assert.equal(r.code, 1)
  assert.match(r.out, /already answered/)
  assert.equal(ask('q3', 'n1').answer, 'no')
  assert.equal(ask('q3', 'n1').answeredIn ?? null, null)
})

test('flow answered needs --answer and an ask node', () => {
  flowWithAsks('q4')
  assert.match(run('answered', 'q4', 'n1').out, /--answer/)
  assert.equal(run('answered', 'q4', 'n1').code, 1)
  assert.equal(run('step', 'q4', 'Build it').code, 0)
  assert.match(run('answered', 'q4', 'n3', '--answer', 'yes').out, /not an ask/)
})

test('a dashboard answer or a reopen clears the chat mark', () => {
  flowWithAsks('q5')
  run('answered', 'q5', 'n1', '--answer', 'yes')
  const f = F.readFlow('q5')
  F.applyAnswer(f, 'n1', null)
  assert.equal(f.nodes[0].answeredIn ?? null, null)
  F.applyAnswer(f, 'n1', 'no')
  assert.equal(f.nodes[0].answeredIn ?? null, null)
})

test('flow write keeps the chat mark with the answer while the question is unchanged', () => {
  flowWithAsks('q6')
  run('answered', 'q6', 'n1', '--answer', 'yes')
  const incoming = structuredClone(F.readFlow('q6'))
  for (const n of incoming.nodes) delete n.answeredIn
  F.mergeKeepingAnswers(incoming, F.readFlow('q6'))
  assert.equal(incoming.nodes[0].answeredIn, 'chat')
  const changed = structuredClone(F.readFlow('q6'))
  changed.nodes[0].title = 'Ship it today?'
  F.mergeKeepingAnswers(changed, F.readFlow('q6'))
  assert.equal(changed.nodes[0].answeredIn ?? null, null, 'a new question waits again')
})

test('the story says it was answered in the chat', () => {
  flowWithAsks('q7')
  run('answered', 'q7', 'n1', '--answer', 'yes')
  run('answered', 'q7', 'n2', '--answer', 'Green')
  const lines = storyOf(F.readFlow('q7')).map(l => `${l.who}: ${l.did}`)
  assert.ok(lines.some(l => /^You: Answered in the chat: (Ship it\?|Which colour\?)/.test(l)), lines.join(' | '))
})

test('the drawer and the chart show "answered in chat" instead of a delivery state', () => {
  const window = { Shell: { ago: () => '2m' } }
  vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'flow-drawer.js'), 'utf8'), { window })
  const D = window.FlowDrawer
  assert.equal(D.deliveryState({ answer: 'yes', answeredIn: 'chat', sentAt: 'x' }), 'chat')
  assert.equal(D.deliveryState({ answer: 'yes', sentAt: 'x' }), 'sent')
  assert.match(fs.readFileSync(path.join(HERE, '..', 'public', 'flows.js'), 'utf8'), /case 'chat': return `<text class="fc-sent" \$\{at\}>answered in chat<\/text>`/)
})
