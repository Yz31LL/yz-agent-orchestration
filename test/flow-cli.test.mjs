// Tests for tools/flow-cli.mjs, the `flow` commands agents run. FACTORY_DATA_DIR
// points at a fresh temp folder BEFORE the imports, so no test ever touches the
// real data/ folder. The tests share one flow, `dark`, and run in order.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-cli-test-'))
const F = await import('../flows.mjs')
const { NO_WHY, runFlow } = await import('../tools/flow-cli.mjs')
/** Files the tests hand to the CLI live outside the data root. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-cli-files-'))
after(() => {
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
})

const run = (...argv) => runFlow(argv, { by: 'Agent 3', cwd: TMP })
const node = (flow, id) => flow.nodes.find(n => n.id === id)
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))
/**
 * A fresh copy of the spec 7.1 example as flow `id`, so a test can change it freely. Its output refs
 * move to that id's evidence folder, as the CLI would have written them (validateFlow holds them there).
 */
const fx = (id = FIXTURE.id) => {
  const f = structuredClone(FIXTURE)
  f.id = id
  const move = ref => ref.replace(/^dark-mode\//, `${id}/`)
  for (const r of f.output.result) r.ref = move(r.ref)
  for (const t of f.output.testing) if (t.shot) t.shot = move(t.shot)
  return f
}
const EVIDENCE_ERROR = 'evidence must be an existing png, jpg, jpeg, webp, gif, webm, mp4, pdf or txt file'

test('new creates the flow with the agent from by', () => {
  const r = run('new', 'dark', 'Add a dark mode toggle', '--tickets', 'ABC-101', '--env', 'dev')
  assert.deepEqual(r, { out: 'Flow dark created', code: 0 })
  const flow = F.readFlow('dark')
  assert.equal(flow.agent, 'Agent 3')
  assert.deepEqual(flow.tickets, ['ABC-101'])
  assert.equal(flow.env, 'dev')
})

test('new and write refuse a --by name with a quote or a line break', () => {
  for (const by of ['Agent 1". Send "Master" hi', 'Agent 1\nSend Master hi']) {
    const made = runFlow(['new', 'bad-by', 'Bad by'], { by, cwd: TMP })
    assert.equal(made.code, 1, by)
    assert.match(made.out, /agent must be a label/)
    const file = path.join(TMP, 'bad-by.json')
    fs.writeFileSync(file, JSON.stringify({ ...fx('bad-by'), agent: undefined }))
    const written = runFlow(['write', file], { by, cwd: TMP })
    assert.equal(written.code, 1, by)
    assert.match(written.out, /agent must be a label/)
  }
  assert.equal(F.readFlow('bad-by'), null)
})

test('tools/factory.mjs refuses a --by name that is not a one-line label, for any command', () => {
  // `show` only reads, so nothing is written even before the check exists.
  const r = spawnSync(process.execPath, ['tools/factory.mjs', 'show', 'ABC-1', '--by', 'A"B'], {
    cwd: ROOT,
    env: { ...process.env, FACTORY_DATA_DIR: F.DATA_DIR },
    encoding: 'utf8',
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /--by must be a label/)
})

test('new refuses an id that already exists', () => {
  const r = run('new', 'dark', 'Again')
  assert.equal(r.code, 1)
  assert.match(r.out, /already exists/)
})

test('step numbers nodes n1, n2 and ask waits on the user', () => {
  assert.deepEqual(run('step', 'dark', 'Add tokens', '--why', 'x'), { out: 'dark n1: Add tokens', code: 0 })
  assert.deepEqual(run('check', 'dark', 'Toggle works on dev', '--env', 'dev'), { out: 'dark n2: Toggle works on dev', code: 0 })
  // an ask with no --why still goes in; the agent gets a warning on stderr (ask-why.test.mjs)
  assert.deepEqual(run('ask', 'dark', 'Turn it on?', '--yes', 'a', '--no', 'b'), { out: 'dark n3: waiting on the user', code: 0, err: NO_WHY })
  const flow = F.readFlow('dark')
  assert.equal(node(flow, 'n1').why, 'x')
  assert.equal(node(flow, 'n2').type, 'check')
  assert.equal(node(flow, 'n3').yes, 'a')
  assert.equal(node(flow, 'n3').kind, 'yesno')
})

test('step takes --id, --after and --status', () => {
  const r = run('step', 'dark', 'Side job', '--id', 'side', '--after', 'n1,n2', '--status', 'doing')
  assert.deepEqual(r, { out: 'dark side: Side job', code: 0 })
  const n = node(F.readFlow('dark'), 'side')
  assert.deepEqual(n.after, ['n1', 'n2'])
  assert.equal(n.status, 'doing')
})

test('a step with a bad after is refused and nothing is written', () => {
  const r = run('step', 'dark', 'Broken', '--after', 'n99')
  assert.equal(r.code, 1)
  assert.match(r.out, /after names unknown node n99/)
  assert.equal(F.readFlow('dark').nodes.length, 4)
})

test('note adds a note node', () => {
  const r = run('note', 'dark', 'The toggle was fine', '--after', 'n1')
  assert.deepEqual(r, { out: 'dark n4: The toggle was fine', code: 0 })
  assert.equal(node(F.readFlow('dark'), 'n4').type, 'note')
})

test('show prints the JSON with derived', () => {
  const r = run('show', 'dark')
  assert.equal(r.code, 0)
  const flow = JSON.parse(r.out) // the Output block goes to stderr (r.err)
  assert.deepEqual(flow.derived.waiting, ['n3'])
  assert.equal(flow.id, 'dark')
})

test('show of a missing flow is code 1', () => {
  const r = run('show', 'nope')
  assert.equal(r.code, 1)
  assert.match(r.out, /No flow nope/)
})

test('status sets a work node, and an ask has none', () => {
  assert.deepEqual(run('status', 'dark', 'n1', 'done'), { out: 'dark n1: done', code: 0 })
  assert.equal(node(F.readFlow('dark'), 'n1').status, 'done')
  const r = run('status', 'dark', 'n3', 'done')
  assert.equal(r.code, 1)
  assert.match(r.out, /ask nodes have no status/)
})

test('evidence --commit stores the sha and label', () => {
  const r = run('evidence', 'dark', 'n1', '--commit', 'ab12cd3', '--label', 'web: theme')
  assert.deepEqual(r, { out: 'dark n1: commit evidence added', code: 0 })
  const ev = node(F.readFlow('dark'), 'n1').evidence
  assert.equal(ev.length, 1)
  const { at, ...rest } = ev[0]
  assert.deepEqual(rest, { kind: 'commit', ref: 'ab12cd3', label: 'web: theme' })
  assert.ok(!Number.isNaN(Date.parse(at)))
})

test('evidence --shot copies the file into EVIDENCE_DIR/<flow>/', () => {
  const shot = path.join(TMP, 'shot.png')
  fs.writeFileSync(shot, 'x')
  const r = run('evidence', 'dark', 'n2', '--shot', shot)
  assert.deepEqual(r, { out: 'dark n2: shot evidence added', code: 0 })
  assert.equal(fs.readFileSync(path.join(F.EVIDENCE_DIR, 'dark', 'n2-shot.png'), 'utf8'), 'x')
  assert.equal(node(F.readFlow('dark'), 'n2').evidence.at(-1).ref, 'dark/n2-shot.png')
})

test('evidence --shot resolves a relative path against cwd and never overwrites an earlier shot', () => {
  fs.writeFileSync(path.join(TMP, 'shot.png'), 'y')
  const r = run('evidence', 'dark', 'n2', '--shot', 'shot.png')
  assert.equal(r.code, 0)
  assert.equal(fs.readFileSync(path.join(F.EVIDENCE_DIR, 'dark', 'n2-shot.png'), 'utf8'), 'x')
  assert.equal(fs.readFileSync(path.join(F.EVIDENCE_DIR, 'dark', 'n2-shot-2.png'), 'utf8'), 'y')
  assert.equal(node(F.readFlow('dark'), 'n2').evidence.at(-1).ref, 'dark/n2-shot-2.png')
})

test('two shots both named shot.png on two nodes are two files, each node pointing at its own', () => {
  run('new', 'shots', 'Two shots')
  run('step', 'shots', 'One')
  run('step', 'shots', 'Two')
  for (const [dir, body] of [['a', 'first'], ['b', 'second']]) {
    fs.mkdirSync(path.join(TMP, dir), { recursive: true })
    fs.writeFileSync(path.join(TMP, dir, 'shot.png'), body)
  }
  assert.equal(run('evidence', 'shots', 'n1', '--shot', path.join(TMP, 'a', 'shot.png')).code, 0)
  assert.equal(run('evidence', 'shots', 'n2', '--shot', path.join(TMP, 'b', 'shot.png')).code, 0)
  const flow = F.readFlow('shots')
  for (const [id, body] of [['n1', 'first'], ['n2', 'second']]) {
    const ref = node(flow, id).evidence[0].ref
    assert.equal(ref, `shots/${id}-shot.png`)
    assert.equal(fs.readFileSync(path.join(F.EVIDENCE_DIR, ...ref.split('/')), 'utf8'), body)
  }
})

test('evidence --shot refuses a missing file or a wrong extension', () => {
  const before = node(F.readFlow('dark'), 'n2').evidence.length
  assert.deepEqual(run('evidence', 'dark', 'n2', '--shot', path.join(TMP, '..', 'etc')), { out: EVIDENCE_ERROR, code: 1 })
  fs.writeFileSync(path.join(TMP, 'x.exe'), 'x')
  assert.deepEqual(run('evidence', 'dark', 'n2', '--shot', path.join(TMP, 'x.exe')), { out: EVIDENCE_ERROR, code: 1 })
  assert.ok(!fs.existsSync(path.join(F.EVIDENCE_DIR, 'dark', 'x.exe')))
  fs.mkdirSync(path.join(TMP, 'dir.png'))
  assert.deepEqual(run('evidence', 'dark', 'n2', '--shot', path.join(TMP, 'dir.png')), { out: EVIDENCE_ERROR, code: 1 })
  assert.equal(node(F.readFlow('dark'), 'n2').evidence.length, before)
})

test('evidence --test --file keeps the line as ref and the copy as file', () => {
  fs.writeFileSync(path.join(TMP, 'run.txt'), 'ok 1')
  const r = run('evidence', 'dark', 'n2', '--test', 'ok 12 passed', '--file', path.join(TMP, 'run.txt'))
  assert.deepEqual(r, { out: 'dark n2: test evidence added', code: 0 })
  const e = node(F.readFlow('dark'), 'n2').evidence.at(-1)
  assert.equal(e.ref, 'ok 12 passed')
  assert.equal(e.file, 'dark/n2-run.txt')
  assert.ok(fs.existsSync(path.join(F.EVIDENCE_DIR, 'dark', 'n2-run.txt')))
})

test('evidence needs exactly one kind, and a work node', () => {
  assert.equal(run('evidence', 'dark', 'n1').code, 1)
  assert.equal(run('evidence', 'dark', 'n1', '--url', 'https://a.example', '--note', 'b').code, 1)
  const r = run('evidence', 'dark', 'n3', '--note', 'hi')
  assert.equal(r.code, 1)
  assert.match(r.out, /ask nodes take no evidence/)
  assert.deepEqual(run('evidence', 'dark', 'n1', '--url', 'https://a.example'), { out: 'dark n1: url evidence added', code: 0 })
})

test('set changes the flow fields', () => {
  const r = run('set', 'dark', '--title', 'Add a theme toggle', '--tickets', 'ABC-101,abc-106', '--why', 'because')
  assert.equal(r.code, 0)
  const flow = F.readFlow('dark')
  assert.equal(flow.title, 'Add a theme toggle')
  assert.deepEqual(flow.tickets, ['ABC-101', 'ABC-106'])
  assert.equal(flow.why, 'because')
  assert.equal(run('set', 'dark', '--status', 'finished').code, 1)
  assert.equal(run('set', 'dark').code, 1)
})

test('write keeps the answer the user already gave', () => {
  const answered = fx()
  F.applyAnswer(answered, 'n3', 'yes')
  F.writeFlow(answered)
  const file = path.join(TMP, 'dark-mode.json')
  fs.writeFileSync(file, JSON.stringify(fx()))
  assert.deepEqual(run('write', file), { out: 'Flow dark-mode written', code: 0 })
  assert.equal(node(F.readFlow('dark-mode'), 'n3').answer, 'yes')
})

test('write fills agent from by when it is missing', () => {
  const f = fx('no-agent')
  delete f.agent
  fs.writeFileSync(path.join(TMP, 'no-agent.json'), JSON.stringify(f))
  assert.equal(run('write', 'no-agent.json').code, 0)
  assert.equal(F.readFlow('no-agent').agent, 'Agent 3')
})

test('write prints one line per problem and writes nothing', () => {
  const f = fx('bad-after')
  node(f, 'n4').after = ['n9']
  node(f, 'n2').after = ['n3']
  fs.writeFileSync(path.join(TMP, 'bad.json'), JSON.stringify(f))
  const r = run('write', path.join(TMP, 'bad.json'))
  assert.equal(r.code, 1)
  assert.deepEqual(r.out.split('\n').sort(), [
    'node n2: after must name an earlier node (n3)',
    'node n4: after names unknown node n9',
  ])
  assert.equal(F.readFlow('bad-after'), null)
})

test('write of a missing or broken file is code 1 and names the absolute path', () => {
  const r = run('write', 'missing.json')
  assert.equal(r.code, 1)
  assert.ok(r.out.includes(path.join(TMP, 'missing.json')))
  fs.writeFileSync(path.join(TMP, 'broken.json'), '{')
  assert.equal(run('write', 'broken.json').code, 1)
  fs.writeFileSync(path.join(TMP, 'null.json'), 'null')
  assert.deepEqual(run('write', 'null.json'), { out: 'flow must be a JSON object', code: 1 })
})

test('list --waiting shows dark as WAITING; list --agent Nobody prints nothing', () => {
  const r = run('list', '--waiting')
  assert.equal(r.code, 0)
  const line = r.out.split('\n').find(l => l.startsWith('dark '))
  assert.equal(line, 'dark  open  Agent 3  1/3  WAITING  Add a theme toggle')
  assert.ok(!r.out.split('\n').some(l => l.startsWith('dark-mode ')))
  assert.deepEqual(run('list', '--agent', 'Nobody'), { out: '', code: 0 })
})

test('an unknown command prints the usage, code 1', () => {
  const r = run('frobnicate')
  assert.equal(r.code, 1)
  assert.match(r.out, /usage/)
  assert.equal(run().code, 1)
})

test('decide through tools/factory.mjs asks on a new one-node flow', () => {
  const r = spawnSync(process.execPath, ['tools/factory.mjs', 'decide', '--question', 'Go?', '--ticket', 'ABC-1', '--yes', 'a', '--no', 'b', '--by', 'Agent 2'], {
    cwd: ROOT,
    env: { ...process.env, FACTORY_DATA_DIR: F.DATA_DIR },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  const flow = F.listFlows({ waiting: true }).flows[0]
  assert.equal(flow.agent, 'Agent 2')
  assert.match(flow.id, /^ask-\d{8}-[a-z0-9]{4}$/)
  assert.deepEqual(flow.tickets, ['ABC-1'])
  assert.equal(flow.title, 'Go?')
  assert.equal(flow.nodes.length, 1)
  assert.equal(flow.nodes[0].yes, 'a')
})

test('flow new, flow write and decide refuse to run with no agent name, and say how to give one', () => {
  const env = { ...process.env, FACTORY_DATA_DIR: F.DATA_DIR }
  delete env.FACTORY_BY
  const file = path.join(TMP, 'nameless.json')
  fs.writeFileSync(file, JSON.stringify({ ...fx('nameless'), agent: undefined }))
  for (const argv of [['flow', 'new', 'nameless', 'No name'], ['flow', 'write', file], ['decide', '--question', 'Who asks?']]) {
    const r = spawnSync(process.execPath, ['tools/factory.mjs', ...argv], { cwd: ROOT, env, encoding: 'utf8' })
    assert.notEqual(r.status, 0, argv.join(' '))
    assert.match(r.stderr, /say who you are with --by <your dashboard label>/, argv.join(' '))
  }
  assert.equal(F.readFlow('nameless'), null)
  // A file that names its agent needs no --by.
  fs.writeFileSync(file, JSON.stringify({ ...fx('nameless'), agent: 'Agent 3' }))
  const named = spawnSync(process.execPath, ['tools/factory.mjs', 'flow', 'write', file], { cwd: ROOT, env, encoding: 'utf8' })
  assert.equal(named.status, 0, named.stderr)
  assert.equal(F.readFlow('nameless').agent, 'Agent 3')
})

test('decide --flow asks on an existing flow', () => {
  const r = spawnSync(process.execPath, ['tools/factory.mjs', 'decide', '--question', 'Ship it?', '--flow', 'dark', '--text'], {
    cwd: ROOT,
    env: { ...process.env, FACTORY_DATA_DIR: F.DATA_DIR, FACTORY_BY: 'Master' },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  const ask = F.readFlow('dark').nodes.at(-1)
  assert.equal(ask.title, 'Ship it?')
  assert.equal(ask.kind, 'text')
})

// ═══ the storyboard commands: result, summary, test-step, test-clear ═══

const nameless = (...argv) => runFlow(argv, { by: '', cwd: TMP })
const output = id => F.readFlow(id).output

test('result copies the shot into the evidence folder as out-<name> and appends it with its caption', () => {
  assert.equal(run('new', 'story', 'A storyboard').code, 0)
  fs.writeFileSync(path.join(TMP, 'after.png'), 'after')
  const r = run('result', 'story', '--shot', 'after.png', '--caption', 'The page in dark mode')
  assert.deepEqual(r, { out: 'story: result shot 1 added', code: 0 })
  assert.equal(fs.readFileSync(path.join(F.EVIDENCE_DIR, 'story', 'out-after.png'), 'utf8'), 'after')
  const [shot] = output('story').result
  assert.deepEqual({ ...shot, at: undefined }, { ref: 'story/out-after.png', caption: 'The page in dark mode', at: undefined })
  assert.ok(!Number.isNaN(Date.parse(shot.at)))
  // a second shot of the same name never overwrites the first
  fs.writeFileSync(path.join(TMP, 'after.png'), 'again')
  assert.equal(run('result', 'story', '--shot', path.join(TMP, 'after.png')).code, 0)
  assert.deepEqual(output('story').result.map(s => s.ref), ['story/out-after.png', 'story/out-after-2.png'])
  assert.equal(output('story').result[1].caption, '')
})

test('result refuses a missing file, a type that is not an image or video, and a flow id that would leave the evidence folder', () => {
  const before = output('story').result.length
  const SHOT_ERROR = 'a shot must be an existing png, jpg, jpeg, webp, gif, webm or mp4 file'
  assert.deepEqual(run('result', 'story', '--shot', path.join(TMP, 'none.png')), { out: SHOT_ERROR, code: 1 })
  fs.writeFileSync(path.join(TMP, 'log.txt'), 'x')
  assert.deepEqual(run('result', 'story', '--shot', path.join(TMP, 'log.txt')), { out: SHOT_ERROR, code: 1 })
  assert.equal(run('result', 'story').code, 1, 'no --shot')
  const escape = run('result', '..', '--shot', path.join(TMP, 'after.png'))
  assert.equal(escape.code, 1)
  assert.match(escape.out, /No flow \.\./)
  assert.ok(!fs.existsSync(path.join(F.EVIDENCE_DIR, '..', 'out-after.png')), 'nothing copied beside the evidence folder')
  assert.equal(output('story').result.length, before)
})

test('summary sets the text and REPLACES the changes with the commits and diffs given, repeated or comma-separated', () => {
  const r = run('summary', 'story', 'Every colour is a **token**.', '--commit', 'ab12cd3', '--commit', 'ef45678,0011223', '--diff', 'agent-3')
  assert.deepEqual(r, { out: 'story: summary set with 4 changes', code: 0 })
  const out = output('story')
  assert.equal(out.summary, 'Every colour is a **token**.')
  assert.deepEqual(out.changes.map(c => [c.kind, c.ref]), [['commit', 'ab12cd3'], ['commit', 'ef45678'], ['commit', '0011223'], ['diff', 'agent-3']])
  assert.equal(run('summary', 'story', 'Shorter.', '--commit', 'ab12cd3').code, 0)
  assert.deepEqual(output('story').changes.map(c => c.ref), ['ab12cd3'], 'replaced, not appended')
  assert.equal(run('summary', 'story', 'No changes.').code, 0)
  assert.deepEqual(output('story').changes, [])
  assert.equal(output('story').result.length, 2, 'the result shots are untouched')
})

test('summary refuses an empty text, a sha that is not hex, and a text over 4000 characters', () => {
  assert.equal(run('summary', 'story', '  ').code, 1)
  const sha = run('summary', 'story', 'x', '--commit', 'not-a-sha')
  assert.equal(sha.code, 1)
  assert.match(sha.out, /not-a-sha/)
  const long = run('summary', 'story', 'x'.repeat(4001))
  assert.equal(long.code, 1)
  assert.match(long.out, /output\.summary must be text of at most 4000 characters/)
  assert.equal(output('story').summary, 'No changes.')
})

test('test-step appends t1, t2 with their shots; --id with --replace rewrites one; test-clear empties the list', () => {
  fs.writeFileSync(path.join(TMP, 'moon.png'), 'moon')
  assert.deepEqual(run('test-step', 'story', 'Open Settings and click the moon.', '--expect', 'The page turns dark at once.', '--shot', 'moon.png'),
    { out: 'story t1: test step added', code: 0 })
  assert.deepEqual(run('test-step', 'story', 'Reload the page.', '--expect', 'It is still dark.'), { out: 'story t2: test step added', code: 0 })
  let steps = output('story').testing
  assert.deepEqual(steps.map(t => [t.id, t.do, t.expect, t.shot]), [
    ['t1', 'Open Settings and click the moon.', 'The page turns dark at once.', 'story/out-t1-moon.png'],
    ['t2', 'Reload the page.', 'It is still dark.', undefined],
  ])
  assert.equal(fs.readFileSync(path.join(F.EVIDENCE_DIR, 'story', 'out-t1-moon.png'), 'utf8'), 'moon')

  assert.deepEqual(run('test-step', 'story', 'Reload with Ctrl+R.', '--expect', 'Still dark.', '--id', 't2', '--replace'),
    { out: 'story t2: test step replaced', code: 0 })
  steps = output('story').testing
  assert.deepEqual(steps.map(t => [t.id, t.do]), [['t1', 'Open Settings and click the moon.'], ['t2', 'Reload with Ctrl+R.']])
  assert.equal(run('test-step', 'story', 'Moon again.', '--expect', 'Dark.', '--id', 't1', '--replace').code, 0)
  assert.equal(output('story').testing[0].shot, 'story/out-t1-moon.png', 'a replace with no --shot keeps the old shot')
  assert.deepEqual(run('test-step', 'story', 'Again.', '--expect', 'x', '--id', 't9', '--replace'), { out: 'story has no test step t9 to replace', code: 1 })
  assert.deepEqual(run('test-step', 'story', 'Again.', '--expect', 'x', '--id', 't1'), { out: 'story already has a test step t1: add --replace to rewrite it', code: 1 })
  assert.deepEqual(run('test-step', 'story', 'Again.', '--expect', 'x', '--replace'), { out: '--replace needs --id <the step to rewrite>', code: 1 })
  assert.equal(run('test-step', 'story', 'No expect.').code, 1)
  assert.equal(run('test-step', 'story', 'Bad id.', '--expect', 'x', '--id', 'T 4').code, 1)
  assert.deepEqual(run('test-step', 'story', 'Third.', '--expect', 'x', '--id', 'check-3').out, 'story check-3: test step added')
  assert.deepEqual(run('test-step', 'story', 'Fourth.', '--expect', 'x').out, 'story t3: test step added', 'the next t-number')

  assert.deepEqual(run('test-clear', 'story'), { out: 'story: test steps cleared', code: 0 })
  assert.deepEqual(output('story').testing, [])
  assert.equal(output('story').summary, 'No changes.')
})

test('every storyboard writer refuses to run without a name and writes nothing', () => {
  const before = JSON.stringify(output('story'))
  fs.writeFileSync(path.join(TMP, 'after.png'), 'x')
  for (const argv of [
    ['result', 'story', '--shot', path.join(TMP, 'after.png')],
    ['summary', 'story', 'Nameless.'],
    ['test-step', 'story', 'Do.', '--expect', 'See.'],
    ['test-clear', 'story'],
  ]) assert.deepEqual(nameless(...argv), { out: 'say who you are with --by <your dashboard label> (or set FACTORY_BY)', code: 1 }, argv[0])
  assert.equal(JSON.stringify(output('story')), before)
})

test('show prints pure JSON on stdout and the Output block on stderr: the result count, the summary, the numbered test steps and the request', () => {
  run('test-step', 'story', 'Open Settings.', '--expect', 'The moon is there.')
  const r = run('show', 'story')
  assert.equal(r.code, 0)
  assert.equal(JSON.parse(r.out).derived.output.tests, 1, 'stdout is the JSON alone, so show > f.json then write f.json round-trips')
  assert.equal(r.err, [
    'Output',
    '  story: none yet (the page shows one made from the steps; add yours with flow say)',
    '  result: 2 shots',
    '  before: no shot (take one with result --before before you change anything visible)',
    '  change: none yet (say how it was and how it is now with flow change)',
    '  diagram: none yet',
    '  summary: yes, 0 changes',
    '  test steps: 1',
    '    1. [t1] Open Settings. -> The moon is there. (no shot)',
    '  send: none yet (when the work is ready for the base branch, record it with flow pr: the user sends it)',
  ].join('\n'))
  const flow = F.readFlow('story')
  flow.output.requestedAt = new Date(Date.now() + 60_000).toISOString() // asked after the last step
  F.writeFlow(flow)
  assert.match(run('show', 'story').err, /\n {2}the user asked for test steps at \S+: record them with test-step$/)
  // the relay could not deliver it: the page says not sent, and so does show
  flow.output.requestError = 'FAILED: no session named Agent 3'
  F.writeFlow(flow)
  assert.match(run('show', 'story').err, /\n {2}the request for test steps at \S+ was not sent \(FAILED: no session named Agent 3\)$/)
  assert.equal(run('show', 'dark').err, 'Output\n  story: none yet (the page shows one made from the steps; add yours with flow say)\n  result: none yet\n  before: no shot (take one with result --before before you change anything visible)\n  change: none yet (say how it was and how it is now with flow change)\n  diagram: none yet\n  summary: none yet\n  test steps: none yet\n  send: none yet (when the work is ready for the base branch, record it with flow pr: the user sends it)', 'a shot in its evidence is its visual')
})

test('tools/factory.mjs flow show writes the JSON to stdout and the Output block to stderr', () => {
  const r = spawnSync(process.execPath, ['tools/factory.mjs', 'flow', 'show', 'story'], {
    cwd: ROOT, env: { ...process.env, FACTORY_DATA_DIR: F.DATA_DIR }, encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).id, 'story')
  assert.match(r.stderr, /^Output\n {2}story: none yet .*\n {2}result: 2 shots/)
})

test('a repeated --commit collects into a list for summary only: evidence keeps the last one, as before', () => {
  assert.equal(run('evidence', 'dark', 'n1', '--commit', 'aaaaaaa', '--commit', 'bbbbbbb').code, 0)
  assert.equal(node(F.readFlow('dark'), 'n1').evidence.at(-1).ref, 'bbbbbbb')
})

test('the usage lists the storyboard commands and says the change flags repeat', () => {
  const { out } = run('frobnicate')
  assert.match(out, /result <flow> --shot <path> \[--caption "\.\.\."\]/)
  assert.match(out, /summary <flow> "<markdown>" \[--commit <sha>\]\.\.\. \[--diff <worktree>\]\.\.\./)
  assert.match(out, /test-step <flow> "<do this>" --expect "<you should see>" \[--shot <path>\] \[--id t3\] \[--replace\]/)
  assert.match(out, /test-clear <flow>/)
  assert.match(out, /repeat --commit and --diff, or comma-separate them/)
})

// ═══ flow diagram: how it works, drawn from one line of the arrow language (diagram-text.mjs) ═══

test('diagram writes the parsed boxes and arrows with a time, and each call REPLACES the diagram', () => {
  assert.equal(run('new', 'drawn', 'Move the report job').code, 0)
  const r = run('diagram', 'drawn', '[actor] Scheduler -> Report job: every night; Report job -> [store] Reports bucket: writes')
  assert.deepEqual(r, { out: 'drawn: diagram set, 3 boxes, 2 arrows', code: 0 })
  const d = F.readFlow('drawn').output.diagram
  assert.deepEqual(d.nodes.map(n => [n.id, n.kind]), [['scheduler', 'actor'], ['report-job', 'box'], ['reports-bucket', 'store']])
  assert.deepEqual(d.edges, [{ from: 'scheduler', to: 'report-job', label: 'every night' }, { from: 'report-job', to: 'reports-bucket', label: 'writes' }])
  assert.ok(Date.parse(d.at) > 0)
  assert.equal(run('diagram', 'drawn', 'A -> B').out, 'drawn: diagram set, 2 boxes, 1 arrow')
  assert.deepEqual(F.readFlow('drawn').output.diagram.nodes.map(n => n.id), ['a', 'b'], 'replaced, not merged')
  assert.equal(F.derive(F.readFlow('drawn')).output.visual, 'diagram')
})

test('diagram keeps the rest of the output, and --clear removes the diagram alone', () => {
  assert.equal(run('summary', 'drawn', 'Moved it.').code, 0)
  assert.equal(run('diagram', 'drawn', 'A -> B -> C').code, 0)
  assert.equal(F.readFlow('drawn').output.summary, 'Moved it.')
  assert.deepEqual(run('diagram', 'drawn', '--clear'), { out: 'drawn: diagram cleared', code: 0 })
  const out = F.readFlow('drawn').output
  assert.equal('diagram' in out, false)
  assert.equal(out.summary, 'Moved it.')
  assert.deepEqual(run('diagram', 'drawn', '--clear'), { out: 'drawn: diagram cleared', code: 0 }, 'clearing nothing is fine')
})

test('diagram refuses a diagram that is not high level, saying why', () => {
  const r = run('diagram', 'drawn', 'A -> B -> C -> D -> E -> F -> G -> H -> I')
  assert.deepEqual(r, { out: 'keep it high level: at most 8 boxes (this has 9)', code: 1 })
})

test('diagram prints every parse error, one per line, exits 1 and writes nothing', () => {
  assert.equal(run('diagram', 'drawn', 'A -> B').code, 0)
  const before = JSON.stringify(F.readFlow('drawn'))
  assert.deepEqual(run('diagram', 'drawn', 'A ->; [robot] B'), {
    out: 'statement 1: nothing after ->\nstatement 2: unknown kind [robot]: use box, actor, store or decision', code: 1,
  })
  assert.deepEqual(run('diagram', 'drawn'), { out: 'diagram needs the text: diagram <flow> "A -> B: label; B -> C", or --clear', code: 1 })
  assert.deepEqual(run('diagram', 'drawn', 'A -> B', '--clear'), { out: 'diagram takes the text or --clear, not both', code: 1 })
  assert.equal(run('diagram', 'nope', 'A -> B').code, 1)
  assert.equal(JSON.stringify(F.readFlow('drawn')), before)
})

test('diagram refuses to run without a name and writes nothing', () => {
  const before = JSON.stringify(F.readFlow('drawn'))
  const nameless = runFlow(['diagram', 'drawn', 'X -> Y'], { by: '', cwd: TMP })
  assert.deepEqual(nameless, { out: 'say who you are with --by <your dashboard label> (or set FACTORY_BY)', code: 1 })
  assert.deepEqual(runFlow(['diagram', 'drawn', '--clear'], { by: '', cwd: TMP }).code, 1)
  assert.equal(JSON.stringify(F.readFlow('drawn')), before)
})

test('show says what the diagram holds in one line, and asks for a visual when there is neither a shot nor a diagram', () => {
  assert.equal(run('diagram', 'drawn', 'A -> B -> C; C -> D; D -> E; E -> F').code, 0)
  assert.match(run('show', 'drawn').err, /\n {2}diagram: 6 boxes, 5 arrows\n/)
  assert.equal(run('diagram', 'drawn', '--clear').code, 0)
  assert.match(run('show', 'drawn').err, /\n {2}diagram: none yet \(and no result shot: a flow needs a visual, record flow result or draw flow diagram\)\n/)
})

test('the usage lists flow diagram with its arrow language and --clear, and says to keep it high level', () => {
  const { out } = run('frobnicate')
  assert.match(out, /Keep it high level[^]*at most 8 boxes and 10 arrows[^]*never file names or commit subjects/)
  assert.match(out, /Every flow needs a visual/)
  assert.match(out, /diagram <flow> "\[actor\] User -> Page: clicks; Page -> \[store\] Storage" \[--before\] \[--clear\]/)
})

test('tools/factory.mjs keeps the name after a boolean flag: --before --by X and --clear --by X', () => {
  F.writeFlow({ ...fx('by-after'), output: {} })
  const png = path.join(TMP, 'before.png')
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const cli = (...argv) => spawnSync(process.execPath, ['tools/factory.mjs', 'flow', ...argv], {
    cwd: ROOT, env: { ...process.env, FACTORY_DATA_DIR: F.DATA_DIR, FACTORY_BY: '' }, encoding: 'utf8',
  })
  const a = cli('result', 'by-after', '--shot', png, '--before', '--by', 'Agent 1')
  assert.equal(a.status, 0, a.stderr)
  assert.equal(F.readFlow('by-after').output.result[0].when, 'before')
  const b = cli('diagram', 'by-after', '--clear', '--by', 'Agent 1')
  assert.equal(b.status, 0, b.stderr)
})
