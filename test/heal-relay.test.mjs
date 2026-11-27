// Tests for what the watchdog needs from the answer relay (relay.mjs): health() says who waits for a session and whose
// paid turns failed in a row; after hold(agent) NO paid turn runs for it (its items are kept and stamped with the
// reason) until release(agent) or the user's Retry; a success clears it all. `run` is injected: no Claude is spawned.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-relay-test-'))
const F = await import('../flows.mjs')
const { makeRelay, held } = await import('../relay.mjs')
after(() => fs.rmSync(F.DATA_DIR, { recursive: true, force: true }))

function askFlow(id, agent) {
  const flow = F.createFlow({ id, title: `Title of ${id}`, agent })
  F.addNode(flow, { type: 'ask', id: 'n1', title: `Ship ${id}?`, kind: 'yesno', yes: 'Go.', no: 'Hold.' })
  F.applyAnswer(flow, 'n1', 'yes')
  return F.writeFlow(flow)
}
const ask = id => F.readFlow(id).nodes.find(n => n.id === 'n1')
async function waitFor(cond) {
  for (let i = 0; i < 300; i++) {
    if (cond()) return
    await new Promise(r => setTimeout(r, 5))
  }
  assert.fail('timed out waiting')
}
const FAILED = { ok: true, out: JSON.stringify({ type: 'result', is_error: false, result: 'FAILED: no agent called Agent 1 is listed', total_cost_usd: 0.02 }), err: '' }
const SENT = { ok: true, out: JSON.stringify({ type: 'result', is_error: false, result: 'SENT', total_cost_usd: 0.02 }), err: '' }

test('three paid failures in a row are counted per agent with the last error; a success clears them', async () => {
  let reply = FAILED
  const prompts = []
  const relay = makeRelay({ run: async p => (prompts.push(p), reply), delayMs: 1 })
  for (const id of ['c1', 'c2', 'c3']) {
    askFlow(id, 'Agent 1')
    relay.queue(id, 'n1')
    await waitFor(() => ask(id).deliveryError)
  }
  assert.deepEqual(relay.health().fails, [{ agent: 'Agent 1', count: 3, lastError: 'FAILED: no agent called Agent 1 is listed', held: false, heldItems: 0 }])
  reply = SENT
  askFlow('c4', 'Agent 1')
  relay.queue('c4', 'n1')
  await waitFor(() => ask('c4').sentAt)
  assert.deepEqual(relay.health().fails, [])
})

test('held: no paid turn runs for that agent, each item is stamped with the reason and kept; Release sends them in one turn', async () => {
  const prompts = []
  const relay = makeRelay({ run: async p => (prompts.push(p), SENT), delayMs: 1 })
  assert.equal(relay.hold('Agent 2'), true)
  assert.equal(relay.hold('Agent 2'), false, 'already held')
  askFlow('h1', 'Agent 2')
  askFlow('h2', 'Agent 2')
  relay.queue('h1', 'n1')
  relay.queue('h2', 'n1')
  await waitFor(() => ask('h1').deliveryError && ask('h2').deliveryError)
  assert.equal(prompts.length, 0, 'no paid turn while held')
  assert.equal(ask('h1').deliveryError, held('Agent 2'))
  assert.deepEqual(relay.health().fails, [{ agent: 'Agent 2', count: 0, lastError: '', held: true, heldItems: 2 }])
  const r = await relay.release('Agent 2')
  assert.deepEqual(r, { released: true, items: 2 })
  assert.equal(prompts.length, 1, 'one turn for everything held')
  assert.ok(ask('h1').sentAt && ask('h2').sentAt)
  assert.deepEqual(relay.health().fails, [])
  assert.deepEqual(await relay.release('Agent 2'), { released: false, items: 0 })
})

test("the user's Retry always runs, even while held, and its success clears the hold", async () => {
  const prompts = []
  const relay = makeRelay({ run: async p => (prompts.push(p), SENT), delayMs: 1 })
  relay.hold('Agent 3')
  askFlow('r1', 'Agent 3')
  const out = await relay.deliverNow('r1', 'n1')
  assert.equal(out.ok, true)
  assert.equal(prompts.length, 1)
  assert.deepEqual(relay.health().fails, [])
})

test('no session: no turn at all, and health says who waits and since when; the wait ends when a session opens', async () => {
  const prompts = []
  let open = false
  const relay = makeRelay({ run: async p => (prompts.push(p), SENT), delayMs: 1, present: async () => open, waitMs: 10, now: () => '2026-11-26T12:00:00.000Z' })
  askFlow('w1', 'QA')
  relay.queue('w1', 'n1')
  await waitFor(() => relay.health().waiting.length)
  assert.deepEqual(relay.health().waiting, [{ agent: 'QA', since: '2026-11-26T12:00:00.000Z', items: 1 }])
  assert.equal(prompts.length, 0)
  assert.deepEqual(relay.health().fails, [], 'waiting for a session is not a failure: nothing was paid')
  open = true
  await waitFor(() => ask('w1').sentAt)
  assert.deepEqual(relay.health().waiting, [])
})
