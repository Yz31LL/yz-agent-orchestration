// The routes of Master's insight (server.mjs mounts them with one line, through insight-wiring.mjs):
//
//   GET  /api/insight/digest[?section=<name>]   { at, inbox, sections }: the digest as data, from this server's own
//                                               in-memory stores (the CLI prints it: tools/insight-cli.mjs). Read only:
//                                               the CLI moves the inbox's read marker itself.
//   GET  /api/insight/summary                   { suggestions: { open }, health: { worst, failing, degraded, repairs } }
//                                               for the rail count, Home's line and the Agents page's lines
//   GET  /api/insight/suggestions               { list (open first, then newest), counts, broken, agents }
//   POST /api/insight/suggestions/<id>          { do: accept | reject | rule | done, reason? }: the user decides.
//                                               `rule` = Accept and add the rule: a `rule` suggestion with a target
//                                               agent is saved through the SAME rules path the user's own edit uses
//                                               (agent-rules-routes.mjs rulesPut, marked `master`), which also records
//                                               its Learn verdict baseline. Every decision goes in Master's inbox.
//   GET  /api/heal                              the watchdog's view: every check, its state, last repair, the log
//   POST /api/heal/switch   { check, on }       a check on or off (heal-state.json)
//   POST /api/heal/resume   { collection }      Resume a paused ticket refresh (in memory; the paid turns before it are
//                                               not held against it again: heal-state.json `resumed`)
//   POST /api/heal/release  { agent }           Release held deliveries: one turn for everything kept
//   POST /api/heal/stop     { pid, startedAt }  Stop a stray dashboard copy: heal-procs.mjs checks it again first
//   POST /api/heal/run                          look now, then the view
//
// Each press answers with the watchdog's view AFTER it looked again at what the press changed (runOnce(ids): the
// refresh after Resume, the deliveries after Release, the copies after Stop, the check switched on, every check for
// Look now), so the page shows the new state and the button goes at once, not a minute later.
//
// ⚠️ Every POST needs the page's OWN Origin, present (local-origin.mjs): only the dashboard page decides, resumes,
// releases or stops. Errors are { error: one plain sentence } with 400, 403, 404, 405, 409 or 413. Nothing here
// writes config.json, runs a model or pushes; Release is the one press that may start a paid turn (the user's own).

import { readRules, rulesOf } from './agent-rules.mjs'
import { rulesPut as rulesPutReal } from './agent-rules-routes.mjs'
import { CONFIG } from './config.mjs'
import { updateHealState } from './heal-store.mjs'
import { gatherDigest } from './insight-gather.mjs'
import { appendInbox } from './insight-inbox.mjs'
import { decide, isSuggestionId, readSuggestions, SUGGESTIONS_FILE } from './insight-suggestions.mjs'
import { originAllowed } from './local-origin.mjs'
import { SECTION_NAMES } from './insight-digest.mjs'

const BODY_MAX = 16 * 1024
const DAY = 86_400_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = ms => {
  const d = new Date(ms)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}
const short = (s, n = 120) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
/** A sentence that ends once: `It is.` stays, `It is` gets its full stop. */
const sentence = t => (/[.!?]$/.test(t) ? t : `${t}.`)

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  let raw = ''
  for await (const c of req) {
    raw += c
    if (raw.length > BODY_MAX) throw Object.assign(new Error('That is too long to send.'), { status: 413 })
  }
  try {
    const b = raw ? JSON.parse(raw) : {}
    return b && typeof b === 'object' && !Array.isArray(b) ? b : {}
  } catch {
    throw Object.assign(new Error('The request was not valid JSON.'), { status: 400 })
  }
}

/**
 * `deps`: { port, providers (insight-gather.mjs), runner (heal-runner.mjs), relay, sources ({ resume, collections }),
 * procs (heal-procs.mjs), agents() (the graph's agent labels), learnDays (the verdict wait), stateFile, file, now,
 * rulesPut, readRulesFn, inbox(item) }.
 */
export function makeInsightRoute({
  port = CONFIG.port, providers = {}, runner = null, relay = null, sources = null, procs = null, agents = () => [], learnDays = 14,
  stateFile, file = SUGGESTIONS_FILE, now = () => Date.now(), rulesPut = rulesPutReal, readRulesFn = readRules, inbox = item => appendInbox(item),
} = {}) {
  // ═══ suggestions ═══

  function suggestionsGet() {
    const { list, broken } = readSuggestions(file)
    const order = { open: 0, accepted: 1, done: 2, rejected: 3 }
    const sorted = [...list].sort((a, b) => order[a.state] - order[b.state] || Date.parse(b.at) - Date.parse(a.at))
    const counts = { open: 0, accepted: 0, rejected: 0, done: 0 }
    for (const s of list) counts[s.state]++
    return [200, { list: sorted, counts, broken, agents: agents() }]
  }

  /** Accept and add the rule: the rule is saved through the user's own rules path first; only then is it accepted. */
  function addRule(s, headers) {
    if (s.kind !== 'rule' || !agents().includes(s.target)) return { error: 'Only a rule for an agent on the pipeline can be added as a rule. Accept it as a note instead.', status: 400 }
    const current = rulesOf(readRulesFn(), s.target).rules.map(r => r.text)
    if (current.includes(s.text)) return { outcome: `${s.target} already had this rule.` }
    const r = rulesPut(s.target, { rules: [...current, s.text] }, headers, { port, by: 'master' })
    if (r.status !== 200) return { error: r.body?.error || 'The rule could not be saved.', status: r.status }
    return { outcome: `Added as a rule of ${s.target}; its verdict is due on ${day(now() + learnDays * DAY)}.` }
  }

  function suggestionPost(id, b, headers) {
    if (!isSuggestionId(id)) return [404, { error: 'There is no such suggestion.' }]
    const what = b.do
    if (!['accept', 'reject', 'rule', 'done'].includes(what)) return [400, { error: 'Say what to do: accept, reject, rule or done.' }]
    const s = readSuggestions(file).list.find(x => x.id === id)
    if (!s) return [404, { error: 'That suggestion is gone.' }]
    if (s.state !== 'open' && what !== 'done') return [409, { error: `It is already ${s.state}.` }]
    let outcome = ''
    if (what === 'rule') {
      const added = addRule(s, headers)
      if (added.error) return [added.status || 400, { error: added.error }]
      outcome = added.outcome
    }
    const r = decide(id, { do: what === 'rule' ? 'accept' : what, reason: b.reason, outcome }, { now: now() }, file)
    if (r.error) return [r.status || 400, { error: r.error }]
    const t = short(r.suggestion.text)
    const said = what === 'reject' ? `The user rejected ${id} ("${t}")${r.suggestion.reason ? `: ${sentence(r.suggestion.reason)}` : ', with no reason given.'} Do not propose it again.`
      : what === 'done' ? `The user marked ${id} done ("${t}").`
        : `The user accepted ${id} ("${t}").${outcome ? ` ${outcome}` : ' Act on it, or tell the user who should.'}`
    inbox({ kind: 'suggestion', text: said })
    return [200, { ok: true, suggestion: r.suggestion }]
  }

  // ═══ the watchdog ═══

  function summary() {
    const open = readSuggestions(file).list.filter(s => s.state === 'open').length
    const v = runner?.view() || null
    const pick = st => (v ? v.checks.filter(c => c.state === st).map(c => ({ id: c.id, name: c.name, text: c.text })) : [])
    // a refresh the watchdog paused: the Agents page line offers its Resume (the notice the brief asks for)
    const paused = (v?.checks.find(c => c.id === 'refresh')?.extra?.collections || []).filter(c => c.paused).map(c => ({ id: c.id, name: c.name }))
    return [200, { suggestions: { open }, health: v ? { enabled: v.enabled, worst: v.worst, failing: pick('failing'), degraded: pick('degraded'), repairs: v.repairs24h.length, paused } : null }]
  }

  async function healPost(p, b) {
    if (!runner) return [404, { error: 'The watchdog is not running here.' }]
    if (p === '/api/heal/run') {
      await runner.runOnce('all')
      return [200, runner.view()]
    }
    if (p === '/api/heal/switch') {
      if (typeof b.on !== 'boolean' || !runner.setSwitch(String(b.check || ''), b.on)) return [400, { error: 'Say which check to switch, and on or off.' }]
      if (b.on) await runner.runOnce([String(b.check)])
      return [200, runner.view()]
    }
    if (p === '/api/heal/resume') {
      const id = String(b.collection || '')
      if (!/^[A-Za-z0-9_-]{1,60}$/.test(id) || !sources) return [400, { error: 'Say which ticket refresh to resume.' }]
      const was = sources.resume(id)
      updateHealState(s => ({ ...s, resumed: { ...s.resumed, [id]: new Date(now()).toISOString() } }), stateFile)
      runner.record({ check: 'refresh', name: 'Paid ticket refresh', saw: 'you pressed Resume', did: `Resumed the timer of ${id}${was ? '' : ' (it was not paused)'}.`, result: 'by you' })
      await runner.runOnce(['refresh'])
      return [200, runner.view()]
    }
    if (p === '/api/heal/release') {
      const agent = String(b.agent || '').trim()
      if (!agent || !relay) return [400, { error: 'Say whose deliveries to release.' }]
      const r = await relay.release(agent)
      if (!r.released) return [404, { error: `The deliveries to ${agent} are not held.` }]
      runner.record({ check: 'deliveries', name: 'Deliveries to agents', saw: 'you pressed Release', did: `Released ${r.items} held ${r.items === 1 ? 'delivery' : 'deliveries'} to ${agent}.`, result: 'by you' })
      await runner.runOnce(['deliveries'])
      return [200, runner.view()]
    }
    if (p === '/api/heal/stop') {
      if (!procs) return [404, { error: 'Stopping a copy is not possible here.' }]
      const r = await procs.stop(b.pid, typeof b.startedAt === 'string' ? b.startedAt : '')
      if (!r.ok) return [409, { error: r.error }]
      runner.record({ check: 'strays', name: 'Stray dashboard copies', saw: 'you pressed Stop', did: `Stopped the copy on ${r.port ? `port ${r.port}` : `process ${r.pid}`}${r.folder ? ` in ${r.folder}` : ''}.`, result: 'by you' })
      await runner.runOnce(['strays'])
      return [200, { ok: true, ...runner.view() }]
    }
    return [404, { error: 'There is no such page here.' }]
  }

  async function route(req, res, url) {
    const p = url.pathname
    if (!p.startsWith('/api/insight/') && p !== '/api/heal' && !p.startsWith('/api/heal/')) return false
    try {
      if (req.method === 'GET') {
        if (p === '/api/insight/digest') {
          const section = url.searchParams.get('section')
          if (section && !SECTION_NAMES.includes(section)) return json(res, 400, { error: `There is no part called ${section}.` }), true
          return json(res, 200, await gatherDigest(providers, { now: now(), only: section || null })), true
        }
        if (p === '/api/insight/summary') return json(res, ...summary()), true
        if (p === '/api/insight/suggestions') return json(res, ...suggestionsGet()), true
        if (p === '/api/heal') return json(res, ...(runner ? [200, runner.view()] : [404, { error: 'The watchdog is not running here.' }])), true
        return json(res, 404, { error: 'There is no such page here.' }), true
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'Use GET or POST here.' }), true
      if (!req.headers.origin || !originAllowed(req.headers.origin, port)) return json(res, 403, { error: 'This is done only from the dashboard page.' }), true
      const b = await readBody(req)
      const one = /^\/api\/insight\/suggestions\/([^/]+)$/.exec(p)
      if (one) return json(res, ...suggestionPost(decodeURIComponent(one[1]), b, req.headers)), true
      return json(res, ...(await healPost(p, b))), true
    } catch (err) {
      return json(res, err?.status || 500, { error: err?.status ? err.message : `Something went wrong: ${err?.message || err}` }), true
    }
  }
  return route
}
