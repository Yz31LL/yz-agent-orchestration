// A yes/no ask that is really a choice ("A: fresh conversation or B: soften the message?") showed bare Yes and No
// buttons in Human review, with what each meant hidden in a tooltip. Now the buttons carry what yes and no mean,
// and every yes/no ask also takes the user's own words, so a question no button fits can still be answered.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports, so no test touches the real data/ folder.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-choices-test-'))
const F = await import('../flows.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const window = { Shell: { ago: () => '2m' } }
for (const f of ['shell.js', 'terms.js', 'flow-route.js', 'flow-board.js', 'flow-drawer.js']) vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), { window })
const B = window.FlowBoard
const DARK = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))
const FLOW = { id: 'q' }
const CHOICE = { id: 'n3', kind: 'yesno', yes: 'A: fresh conversation', no: 'B: soften the message' }

test('the buttons say what each choice means, with the full meaning on hover', () => {
  const h = B.askControls(FLOW, CHOICE, 'hr')
  assert.match(h, /<button type="button" class="fl-yes" data-answer="yes" data-node="n3" title="Yes: A: fresh conversation">A: fresh conversation<\/button>/)
  assert.match(h, /<button type="button" class="fl-no" data-answer="no" data-node="n3" title="No: B: soften the message">B: soften the message<\/button>/)
  assert.doesNotMatch(h, />Yes<\/button>|>No<\/button>/)
})

test('with no meaning given, the buttons stay Yes and No', () => {
  const h = B.askControls(FLOW, { id: 'n3', kind: 'yesno', yes: '', no: '' }, 'hr')
  assert.match(h, /data-answer="yes" data-node="n3" title="Yes">Yes<\/button>/)
  assert.match(h, /data-answer="no" data-node="n3" title="No">No<\/button>/)
})

test('a long meaning is cut on the button and kept whole in its title', () => {
  const yes = 'Cancel at the end of the next day instead, so the reminder date is still true for the buyer'
  const h = B.askControls(FLOW, { ...CHOICE, yes }, 'hr')
  const label = h.match(/class="fl-yes"[^>]*>([^<]*)<\/button>/)[1]
  assert.ok(label.length <= 40 && label.endsWith('…'), label)
  assert.match(h, new RegExp(`title="Yes: ${yes}"`))
})

test('every yes/no ask also takes your own words, in a field kept across a redraw', () => {
  const h = B.askControls(FLOW, CHOICE, 'hr')
  assert.match(h, /<form class="fl-text fl-other" data-text="n3"><input name="answer" data-key="hr:q:n3:other" placeholder="Or write your own answer" required aria-label="Or write your own answer"><button type="submit">Save<\/button><\/form>/)
})

test("the flow drawer's yes/no buttons are named the same way and also take your own words", () => {
  const h = window.FlowDrawer.ask({ ...CHOICE, type: 'ask', title: 'Fresh conversation or soften it?', answer: null })
  assert.match(h, /class="fl-yes" data-answer="yes" data-node="n3"[^>]*>A: fresh conversation<\/button>/)
  assert.match(h, /class="fl-no" data-answer="no" data-node="n3"[^>]*>B: soften the message<\/button>/)
  assert.match(h, /<form class="fl-text fl-other" data-text="n3">/)
})

test('the store takes your own words as the answer to a yes/no ask, and refuses an empty one', () => {
  const f = structuredClone(DARK)
  const n = F.applyAnswer(f, 'n3', 'Neither: ask the team first')
  assert.equal(n.answer, 'Neither: ask the team first')
  assert.throws(() => F.applyAnswer(f, 'n3', '   '), /answer must be yes, no, your own words or null/)
})
