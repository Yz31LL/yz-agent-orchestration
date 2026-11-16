// Tests for pulse() and the per-ticket flow lookup in orchestration.mjs.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports, so no test
// ever touches the real data/ folder.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-test-'))
const F = await import('../flows.mjs')
const { pulse, ticketFlows, chatState } = await import('../orchestration.mjs')
const { CONFIG } = await import('../config.mjs')
after(() => fs.rmSync(F.DATA_DIR, { recursive: true, force: true }))

// waiting: an open ask. delivered: an answered ask whose push failed, plus a
// step with two evidence entries. gone: dropped, with an open ask of its own.
const waiting = F.createFlow({ id: 'waiting', title: 'Ship dark mode', agent: 'Agent 1', tickets: ['ABC-1'] })
F.addNode(waiting, { type: 'step', id: 'n1', title: 'Write the tokens', status: 'doing' })
F.addNode(waiting, { type: 'ask', id: 'n2', title: 'Deploy to dev?' })
F.writeFlow(waiting)

const delivered = F.createFlow({ id: 'delivered', title: 'Fix the login', agent: 'Agent 2', tickets: ['ABC-1', 'ABC-2'] })
F.addNode(delivered, { type: 'step', id: 'n1', title: 'Patch it', status: 'done' })
F.addEvidence(delivered, 'n1', { kind: 'commit', ref: 'ab12cd3' })
F.addEvidence(delivered, 'n1', { kind: 'test', ref: 'ok 1 login' })
F.addNode(delivered, { type: 'ask', id: 'n2', title: 'Merge it?' })
F.applyAnswer(delivered, 'n2', 'yes')
delivered.nodes[1].deliveryError = 'Agent 2 is not running'
F.writeFlow(delivered)

const gone = F.createFlow({ id: 'gone', title: 'Old idea', agent: 'Agent 3', tickets: ['ABC-1'] })
F.addNode(gone, { type: 'ask', id: 'n1', title: 'Still want it?' })
gone.status = 'dropped'
F.writeFlow(gone)

const deps = { getStatus: async () => ({ agents: [] }), chatStatus: () => ({}) }

test('pulse lists the open asks of live flows', async () => {
  const p = await pulse(deps)
  assert.equal(p.waiting.length, 1)
  assert.deepEqual(p.waiting[0], {
    flowId: 'waiting', flowTitle: 'Ship dark mode', agent: 'Agent 1', nodeId: 'n2', question: 'Deploy to dev?',
    why: 'Part of Ship dark mode, after: Write the tokens', // no --why: where the ask sits (flows.mjs askReason)
    askedAt: F.readFlow('waiting').updatedAt,
  })
})

test('pulse lists every flow that is not dropped, with evidence and undelivered counts', async () => {
  const p = await pulse(deps)
  assert.equal(p.flows.length, 2)
  assert.deepEqual(p.flows.map(f => f.id), ['delivered', 'waiting'])
  const [second] = p.flows
  assert.equal(second.undelivered, 1)
  assert.equal(second.evidence, 2)
  assert.deepEqual(Object.keys(second).sort(), ['agent', 'evidence', 'id', 'status', 'title', 'undelivered', 'updatedAt'])
  assert.equal(p.flows.find(f => f.id === 'waiting').undelivered, 0)
  assert.ok(!p.flows.some(f => f.id === 'gone'))
  assert.ok(!p.waiting.some(w => w.flowId === 'gone'))
})

test('pulse no longer carries decisions and survives a status failure', async () => {
  const p = await pulse({ getStatus: async () => { throw new Error('down') }, chatStatus: () => ({ busy: false }) })
  assert.equal('decisions' in p, false)
  assert.deepEqual(p.agents, [])
  assert.deepEqual(p.chat, { busy: false, state: 'idle' })
})

test('pulse orders asks newest first by the time they were asked', async () => {
  const later = F.createFlow({ id: 'later', title: 'Later one', agent: 'Agent 1' })
  F.addNode(later, { type: 'ask', id: 'n1', title: 'Also this?' })
  F.writeFlow(later)
  later.nodes[0].at = '2000-01-01T00:00:00.000Z' // an ask stamped by the store wins over updatedAt
  fs.writeFileSync(path.join(F.FLOWS_DIR, 'later.json'), JSON.stringify(later))
  try {
    const p = await pulse(deps)
    assert.deepEqual(p.waiting.map(w => w.flowId), ['waiting', 'later'])
    assert.equal(p.waiting[1].askedAt, '2000-01-01T00:00:00.000Z')
  } finally {
    fs.rmSync(path.join(F.FLOWS_DIR, 'later.json'))
  }
})

test('pulse carries the validated reminders from the config, so the page needs no route of its own', async () => {
  const p = await pulse(deps)
  assert.ok(Array.isArray(p.reminders))
  assert.deepEqual(p.reminders, CONFIG.reminders)
  assert.deepEqual(Object.keys(p).sort(), ['agents', 'at', 'chat', 'flows', 'reminders', 'waiting'])
})

test('ticketFlows maps each ticket to its open flows with the current step and whether one waits', () => {
  const { flows } = F.listFlows({ open: true })
  const byTicket = ticketFlows(flows)
  assert.deepEqual(byTicket.get('ABC-2'), [{ id: 'delivered', title: 'Fix the login', agent: 'Agent 2', current: null, waiting: false }])
  assert.deepEqual(
    byTicket.get('ABC-1').sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'delivered', title: 'Fix the login', agent: 'Agent 2', current: null, waiting: false },
      { id: 'waiting', title: 'Ship dark mode', agent: 'Agent 1', current: 'Write the tokens', waiting: true },
    ]
  )
  assert.equal(byTicket.get('ABC-9'), undefined)
})

// ═══ the chat agent's state: working, waiting on the user, or idle ═══

test('chatState: busy is working, an open ask in its own flow or a closing question is waiting, else idle', () => {
  const flow = (agent, waiting, status = 'open') => ({ id: 'f', agent, status, derived: { waiting } })
  assert.equal(chatState({ busy: true, asked: true, name: 'Independent', flows: [flow('Independent', ['n1'])] }), 'working')
  assert.equal(chatState({ busy: false, asked: false, name: 'Independent', flows: [flow('Independent', ['n1'])] }), 'waiting')
  assert.equal(chatState({ busy: false, asked: true, name: 'Independent', flows: [] }), 'waiting')
  assert.equal(chatState({ busy: false, asked: false, name: 'Independent', flows: [flow('Agent 1', ['n1']), flow('Independent', [])] }), 'idle')
  assert.equal(chatState({ busy: false, asked: false, name: 'Independent', flows: [flow('Independent', ['n1'], 'dropped')] }), 'idle', 'a dropped flow waits on nobody')
  assert.equal(chatState({}), 'idle')
})

test('pulse gives the chat a state from its own open asks', async () => {
  const mine = F.createFlow({ id: 'mine', title: 'Check dark mode', agent: 'Independent' })
  F.addNode(mine, { type: 'ask', id: 'n1', title: 'Deploy?' })
  F.writeFlow(mine)
  try {
    const p = await pulse({ getStatus: async () => ({ agents: [] }), chatStatus: () => ({ busy: false, asked: false, name: 'Independent' }) })
    assert.equal(p.chat.state, 'waiting')
    assert.equal(p.chat.name, 'Independent')
    const busy = await pulse({ getStatus: async () => ({ agents: [] }), chatStatus: () => ({ busy: true, name: 'Independent' }) })
    assert.equal(busy.chat.state, 'working')
  } finally {
    fs.rmSync(path.join(F.FLOWS_DIR, 'mine.json'), { force: true })
  }
})
