// The Factory page's data: a ticket collection in board order, with each
// ticket's state from its source, the plan's verdict and the review mark.
//
// Sources, merged per ticket:
//   data/sources/<id>.json   the collection's tickets in one normalised shape
//                            (spec 7.6, see sources/switchboard.mjs)
//   the collection's plan    an optional markdown plan with ticket tables
//   data/factory-state.json  review marks (factory-state.mjs)
//
// The server cannot call a tracker itself: the MCP tools live in a Claude
// session. refreshSource(id) runs one short headless Claude turn, by `kind`:
//   switchboard  the turn calls the collection's one MCP tool and replies with
//                the path of the saved dump; convert() builds the source. The
//                model never writes ticket data. Safe on a timer.
//   agent        the turn gets the collection's `ask` and its `tools` plus Write,
//                and writes sources/<id>.json itself. It runs with cwd = the
//                sources folder and `--permission-mode acceptEdits`. The file is
//                checked after the turn; a bad one is rolled back.
//
// ⚠️ A collection whose tools can act (anything not list_/get_/search_/read_)
// refreshes by button only: a timer on it is refused at load (validateCollection).
// ⚠️ Built-in tools must be NAMED in --tools to exist at all (Write); MCP tools
// only need --allowedTools. See sourceArgs.
// ⚠️ Why acceptEdits and not a `Write(<path>)` allow rule: tested live, an
// allow rule never grants a Write in a headless turn (absolute, `//` and
// relative forms, with or without --add-dir: all denied). acceptEdits does,
// and only inside the working directory, so the agent turn's cwd IS the
// sources folder: that folder is the only place it can write. The cost: a
// project-scoped MCP server (configured in the repo) does not load there, so
// agent collections are for user-level tools such as Playwright or a
// tracker MCP installed for the user. Switchboard turns keep cwd = the repo.
// Both kinds answer in json (`--output-format json`): the model's reply (the
// dump path, or the ticket count) is in `.result` and the turn cost in
// `.total_cost_usd`, recorded as `refresh` spend (spend.mjs). replyOf unwraps
// it; a plain-text reply is read as is and records no cost. Each refresh spend line names its collection, so the
// watchdog can tell which refresh a cost belongs to (heal-checks.mjs refreshCheck).
// The WATCHDOG can pause a collection's timer (pause/resume, IN MEMORY only, config.json is never written): after 3
// failed refreshes in a row it stops the spending until the user presses Resume on the Health page. A paused timer
// skips its turn; the user's own Refresh button still runs. `historyOf(id)` is the last 20 outcomes, in memory.

import { execFile } from 'node:child_process'
import { mkdirSync, promises as fs, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { claudeBin } from './claude-cli.mjs'
import { CONFIG } from './config.mjs'
import { readState } from './factory-state.mjs'
import { DATA_DIR } from './flows.mjs'
import { recordSource } from './since-store.mjs'
import { convert } from './sources/switchboard.mjs'
import { parseTurn, recordCost } from './spend.mjs'

const SOURCES_DIR = path.join(DATA_DIR, 'sources')
const sourceFile = id => path.join(SOURCES_DIR, `${id}.json`)
/** The source file's absolute path with forward slashes: for the agent prompt and messages. */
const slashPath = id => sourceFile(id).replace(/\\/g, '/')
/** A tool that only reads. Anything else can act, so its collection gets no timer. */
const READ_ONLY_TOOL = /^(mcp__[a-z0-9_-]+__)?(list|get|search|read)_/i
const RUN_TIMEOUT_MS = 180_000
/** A ticket id; a source key or `id` that is not one is dropped (cleanTickets). */
const TICKET_ID = /^[A-Z]+-\d+$/
/** Board columns in Switchboard order; any other column comes after them. */
const COLUMN_ORDER = ['CurrentSprint', 'Backlog', 'Icebox']
/** How many refresh outcomes are kept per collection, in memory. */
const HISTORY_KEEP = 20

// ═══ the plan: markdown tables whose first cell starts with a ticket id ═══

/**
 * Rows of every `| Ticket | Verdict | What is left | Must | Wave |` table, keyed by id.
 * The nearest `###` heading above a table names its section.
 */
export function parsePlan(md, prefix) {
  const rows = {}
  let section = ''
  let cols = null
  const idRe = new RegExp(`^(${prefix}-\\d+)\\b\\s*(.*)$`)
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    const h = /^#{2,4}\s+(.*)$/.exec(line)
    if (h) {
      section = h[1].trim()
      cols = null
      continue
    }
    if (!line.startsWith('|')) {
      cols = null
      continue
    }
    const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map(c => c.trim())
    if (/^-+$/.test(cells[0].replace(/:/g, ''))) continue
    if (!cols) {
      cols = cells.map(c => c.toLowerCase())
      continue
    }
    const m = idRe.exec(cells[0])
    if (!m) continue
    const get = name => {
      const i = cols.findIndex(c => c.startsWith(name))
      return i >= 0 ? cells[i] ?? '' : ''
    }
    rows[m[1]] = { section, name: m[2], verdict: get('verdict'), left: get('what is left'), must: get('must'), wave: get('wave') }
  }
  return rows
}

// ═══ collections ═══

/**
 * One collection from config.json, checked. Returns it with `name` and
 * `refreshMinutes` filled in (a missing timer is 0: button only); throws
 * `Collection <id>: <what is wrong>` otherwise.
 */
export function validateCollection(c) {
  const id = c?.id
  const fail = msg => {
    throw new Error(`Collection ${id || '(no id)'}: ${msg}`)
  }
  if (!c || typeof c !== 'object') fail('must be an object')
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) fail('needs an id of letters, digits, - or _')
  if (c.kind !== 'switchboard' && c.kind !== 'agent') fail('kind must be switchboard or agent')
  const tools = c.tools
  if (!Array.isArray(tools) || tools.some(t => typeof t !== 'string' || !t)) fail('tools must be a list of tool names')
  if (c.kind === 'switchboard') {
    if (!c.project || typeof c.project !== 'string') fail('a switchboard collection needs a project')
    if (tools.length !== 1) fail('a switchboard collection needs exactly one tool')
  } else {
    if (!c.ask || typeof c.ask !== 'string') fail('an agent collection needs an ask')
    if (!tools.length) fail('an agent collection needs at least one tool')
  }
  const refreshMinutes = c.refreshMinutes ?? 0
  if (typeof refreshMinutes !== 'number' || !(refreshMinutes >= 0)) fail('refreshMinutes must be 0 or more')
  const acting = refreshMinutes > 0 && tools.find(t => !READ_ONLY_TOOL.test(t))
  if (acting) throw new Error(`Collection ${id}: refreshMinutes must be 0 because its tools can act: ${acting}`)
  if (c.filter != null) {
    const f = c.filter
    if (!f.prefix || typeof f.prefix !== 'string') fail('filter needs a prefix')
    if (!Array.isArray(f.range) || f.range.length !== 2 || !f.range.every(Number.isInteger) || f.range[0] > f.range[1]) fail('filter range must be [first, last]')
    if (f.extras != null && (!Array.isArray(f.extras) || !f.extras.every(Number.isInteger))) fail('filter extras must be a list of numbers')
  }
  return { ...c, name: c.name || id, refreshMinutes }
}

// ═══ the refresh turn ═══

/** The refresh turn's argv for a collection (see the header for why the tool flags differ by kind). */
export function sourceArgs(col, prompt, model) {
  const tools =
    col.kind === 'switchboard'
      ? ['--tools', '', '--allowedTools', col.tools[0]]
      : ['--tools', ['Write', ...col.tools].join(','), '--allowedTools', ...col.tools, '--permission-mode', 'acceptEdits']
  return ['-p', '--model', model, ...tools, '--no-session-persistence', '--output-format', 'json', prompt]
}

/**
 * The turn's reply as { text, why }, with its cost recorded as refresh spend
 * (see the header). `why` is what a failure message says: for a turn marked
 * is_error the model's own text first (an API error, a refusal), since the
 * run's `err` is then only "exited with code 1"; otherwise the run's `err`
 * first, as before.
 */
function replyOf(r, collection) {
  const turn = parseTurn(r?.out)
  recordCost('refresh', turn.cost, new Date(), { collection })
  const why = turn.isError ? turn.text || r?.err : r?.err || turn.text
  return { text: turn.text, why: String(why || '') }
}

/** Where the turn runs: the repo for switchboard (its MCP server is configured there), the sources folder for agent (see the header). */
const turnCwd = col => (col.kind === 'switchboard' ? CONFIG.repo : SOURCES_DIR)

/** One headless turn in `cwd`. Resolves { ok, out, err }, never rejects. */
export async function claudeRun(args, { cwd }) {
  let bin
  try {
    bin = await claudeBin()
  } catch (err) {
    return { ok: false, out: '', err: `no claude binary: ${err.message}` }
  }
  return new Promise(resolve => {
    execFile(bin, args, { cwd, timeout: RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const why = !err ? '' : err.killed ? `timed out after ${RUN_TIMEOUT_MS / 1000} s` : typeof err.code === 'number' ? `exited with code ${err.code}` : String(err.code || 'failed to start')
      resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr).trim() || why })
    })
  })
}

const switchboardPrompt = col =>
  `Call ${col.tools[0]} with projectId ${col.project}. ` +
  'Its output is too big and will be saved to a file. Reply with ONLY the absolute path of that saved file, nothing else.'

const agentPrompt = (col, me) =>
  `${col.ask} Write the result to ${slashPath(col.id)} as JSON of exactly this shape: ` +
  `{ "fetchedAt": ISO, "me": "${me}", "tickets": { "<ID>": { "id", "title", "state", "column", "owner": "me|other|none", "order", "labels": [], "type", "url" } } }. ` +
  'Reply with only the number of tickets written.'

/** Where the harness saved the list_stories output, from the turn's reply. */
const DUMP_PATH = /[A-Za-z]:\\[^\r\n]*?list_stories[^\r\n]*?\.txt|\/[^\r\n]*?list_stories[^\r\n]*?\.txt/

const readText = file => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Text from an untrusted field: a string as is, a number or boolean spelled out, anything else ''. */
const asText = v => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')

/**
 * The tickets a source may show. ⚠️ An `agent` source is written by a model
 * reading a web page, and a collection with no filter takes its ids from
 * these keys, which the page renders: so a key (or an `id`) that is not a
 * ticket id like ABC-12 is DROPPED, never shown, and the text fields the page
 * calls string methods on are coerced to text.
 */
function cleanTickets(raw) {
  const out = {}
  for (const [key, t] of Object.entries(raw)) {
    if (!TICKET_ID.test(key) || !t || typeof t !== 'object' || Array.isArray(t)) continue
    if (t.id !== undefined && !(typeof t.id === 'string' && TICKET_ID.test(t.id))) continue
    out[key] = {
      ...t,
      id: key,
      title: asText(t.title),
      state: asText(t.state),
      column: asText(t.column),
      owner: asText(t.owner),
      labels: Array.isArray(t.labels) ? t.labels.map(asText) : [],
      type: asText(t.type),
    }
  }
  return out
}

/** `{ src }` for a valid source text (its tickets cleaned, see cleanTickets), else `{ problem }`. */
function parseSource(text) {
  let src
  try {
    src = JSON.parse(text)
  } catch (e) {
    return { problem: `the file is not JSON (${e.message})` }
  }
  if (!src || typeof src !== 'object' || !src.tickets || typeof src.tickets !== 'object' || Array.isArray(src.tickets)) {
    return { problem: 'the file has no tickets object' }
  }
  return { src: { ...src, tickets: cleanTickets(src.tickets) } }
}

/** `{ fetchedAt, me, tickets }` from data/sources/<id>.json, or null when there is none (or it is broken). */
export function readSource(id) {
  if (!id) return null
  const text = readText(sourceFile(id))
  return text == null ? null : parseSource(text).src || null
}

// ═══ the page's data and the refresh state, per set of collections ═══

/**
 * Everything that depends on the collection list and the turn runner. The
 * module exports one built from config.json (validated at import, so a bad
 * collection stops the server at startup); tests build their own.
 * `run(args, { cwd })` resolves { ok, out, err } like claudeRun.
 */
export function makeSources({ collections, run, me = CONFIG.factory.me, model = CONFIG.factory.chat.model }) {
  const cols = (collections || []).map(validateCollection)
  const seen = new Set()
  for (const c of cols) {
    if (seen.has(c.id)) throw new Error(`Collection ${c.id}: the id is used twice`)
    seen.add(c.id)
  }
  const find = id => cols.find(c => c.id === id)
  const inflight = new Map() // id -> the running refresh's promise
  const last = new Map() // id -> { at, ok, message }
  const history = new Map() // id -> the last HISTORY_KEEP outcomes, oldest first (the watchdog reads them)
  const paused = new Set() // ids whose timer the watchdog paused, in memory (see the header)
  const noteOutcome = (id, outcome) => {
    last.set(id, outcome)
    history.set(id, [...(history.get(id) || []), outcome].slice(-HISTORY_KEEP))
  }

  const refreshStatus = id => ({
    id,
    running: inflight.has(id),
    ...(last.get(id) || { at: null, ok: null, message: '' }),
    everyMinutes: find(id)?.refreshMinutes || 0,
    paused: paused.has(id),
  })

  async function fromSwitchboard(col) {
    const r = await run(sourceArgs(col, switchboardPrompt(col), model), { cwd: turnCwd(col) })
    const reply = replyOf(r, col.id)
    const file = reply.text.match(DUMP_PATH)?.[0]
    if (!file) throw new Error(`No dump file came back. ${reply.why.slice(0, 300)}`)
    try {
      const stories = JSON.parse(await fs.readFile(file, 'utf8'))
      if (!Array.isArray(stories)) throw new Error('The dump is not a list of stories.')
      const src = convert(stories, me)
      writeAtomic(sourceFile(col.id), JSON.stringify(src, null, 1))
      return `${Object.keys(src.tickets).length} tickets`
    } finally {
      await fs.unlink(file).catch(() => {}) // a 7 MB dump per refresh; the source has what we need
    }
  }

  async function fromAgent(col) {
    const file = sourceFile(col.id)
    const before = readText(file)
    mkdirSync(SOURCES_DIR, { recursive: true }) // the turn's cwd, so it must exist
    const r = await run(sourceArgs(col, agentPrompt(col, me), model), { cwd: turnCwd(col) })
    const reply = replyOf(r, col.id)
    const after = readText(file)
    if (after == null || after === before) {
      throw new Error(`The turn did not write ${slashPath(col.id)}. ${reply.why.slice(0, 300)}`.trim())
    }
    const { src, problem } = parseSource(after)
    if (problem) {
      // Keep the last good source rather than a broken one.
      if (before != null) writeAtomic(file, before)
      else unlinkSync(file)
      throw new Error(`The turn wrote a bad source: ${problem}.`)
    }
    return `${Object.keys(src.tickets).length} tickets`
  }

  /** Refresh one collection's source. Two calls while one runs share it. Never rejects. */
  function refreshSource(id) {
    const col = find(id)
    if (!col) {
      return Promise.resolve({ id, running: false, at: new Date().toISOString(), ok: false, message: `No collection ${id} in config.json`, everyMinutes: 0 })
    }
    if (inflight.has(id)) return inflight.get(id)
    // The source as it was, so a good refresh can note which tickets changed
    // state (since-store.mjs, sources/<id>.prev.json) for Home's Since card.
    const before = readSource(id)
    const p = (col.kind === 'switchboard' ? fromSwitchboard(col) : fromAgent(col))
      .then(message => {
        recordSource(id, before, readSource(id))
        noteOutcome(id, { at: new Date().toISOString(), ok: true, message })
      })
      .catch(e => noteOutcome(id, { at: new Date().toISOString(), ok: false, message: e.message }))
      .finally(() => inflight.delete(id))
      .then(() => refreshStatus(id))
    inflight.set(id, p)
    return p
  }

  /** One timer per collection with refreshMinutes > 0, returned; a paused one skips its turn. Unref'd: they never keep the process alive. */
  function startAutoRefresh() {
    return cols.filter(c => c.refreshMinutes > 0).map(c => setInterval(() => (paused.has(c.id) ? null : refreshSource(c.id)), c.refreshMinutes * 60_000).unref())
  }
  /** The watchdog's pause (heal-runner.mjs): true when a collection of that id was paused now. */
  const pause = id => (find(id) && !paused.has(id) ? (paused.add(id), true) : false)
  /** The user's Resume: true when it was paused. */
  const resume = id => paused.delete(id)
  /** The last outcomes of a collection's refresh, oldest first: [{ at, ok, message }]. */
  const historyOf = id => [...(history.get(id) || [])]

  async function buildFactory(collectionId) {
    const col = find(collectionId) || cols[0]
    if (!col) return { collection: null, collections: [], snapshotAt: null, tickets: [], refresh: refreshStatus('') }
    const src = readSource(col.id) || { fetchedAt: null, tickets: {} }
    const state = readState()
    const filter = col.filter || null

    let plan = {}
    if (col.plan) {
      try {
        plan = parsePlan(await fs.readFile(col.plan, 'utf8'), filter ? filter.prefix : '[A-Za-z]+')
      } catch {
        plan = {}
      }
    }

    // With a filter: its range, then its extras. Without: every ticket in the source, in board order.
    let ids
    const extras = new Set((filter?.extras || []).map(n => `${filter.prefix}-${n}`))
    if (filter) {
      ids = []
      for (let n = filter.range[0]; n <= filter.range[1]; n++) ids.push(`${filter.prefix}-${n}`)
      for (const id of extras) ids.push(id)
    } else {
      const rank = t => (COLUMN_ORDER.includes(t.column) ? COLUMN_ORDER.indexOf(t.column) : COLUMN_ORDER.length)
      const order = t => (typeof t.order === 'number' ? t.order : Infinity)
      ids = Object.keys(src.tickets).sort((a, b) => {
        const x = src.tickets[a]
        const y = src.tickets[b]
        return rank(x) - rank(y) || order(x) - order(y) || a.localeCompare(b, 'en', { numeric: true })
      })
    }

    const tickets = ids.map(id => {
      const s = src.tickets[id] || {}
      const p = plan[id] || null
      return {
        id,
        n: Number(id.split('-').at(-1)),
        title: s.title || p?.name || '(not in the ticket source)',
        state: !s.state || s.state === 'None' ? 'Unstarted' : s.state,
        column: s.column || '',
        phase: (s.labels && s.labels[0]) || '',
        owner: s.owner || 'none',
        order: s.order ?? null,
        type: s.type || '',
        extra: extras.has(id),
        plan: p,
        mark: state.marks[id] || null,
      }
    })

    return {
      collection: { id: col.id, name: col.name, kind: col.kind, prefix: filter?.prefix || '', range: filter?.range || null, planFile: col.plan || '' },
      collections: cols.map(c => ({ id: c.id, name: c.name })),
      snapshotAt: src.fetchedAt || null,
      tickets,
      refresh: refreshStatus(col.id),
    }
  }

  return { collections: () => cols, readSource, refreshSource, refreshStatus, startAutoRefresh, buildFactory, pause, resume, historyOf }
}

// ═══ the server's instance, from config.json ═══

export const { collections, refreshSource, refreshStatus, startAutoRefresh, buildFactory, pause, resume, historyOf } = makeSources({
  collections: CONFIG.factory.collections,
  run: claudeRun,
})
