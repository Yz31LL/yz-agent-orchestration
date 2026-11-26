// The digest's data, gathered from a set of PROVIDERS: the running server hands in its in-memory stores
// (insight-wiring.mjs), the CLI with no dashboard running hands in the files (insight-files.mjs). Either way the same
// six parts come out, and the same words (insight-digest.mjs).
//
//   gatherDigest(providers, { now, only })   { at, inbox, sections: { name: { ok: true, data } | { ok: false, why } } }
//
// A provider is a function; one that is missing, throws or rejects leaves its part (or its piece of a part) OUT,
// with the reason, never a guess. Providers (every one optional):
//   graph()        the orchestration graph (pipeline.mjs pipelineGraph)          REQUIRED for pipeline, work, numbers
//   status()       the dashboard's last /api/status snapshot (agents and sessions), or null
//   settings()     the agents' model and effort store (agent-settings.mjs)
//   flows()        every flow, archived ones too
//   prs()          the Pull requests list's items, or null
//   tokens()       { files, building, prices, names, labelOf } from the token index, or null
//   alerts()       what GET /api/alerts answers (its body), or null;  group: public/predict-group.js's object
//   misses(flows, graph, now)   estimate misses of the last 7 days (predict-estimate.mjs misses)
//   lessons() runs() verdicts() outcomes()   the Lessons, Learn runs, verdict entries, routing outcome lines
//   health()       the watchdog's view (heal-runner.mjs), or null
//   suggestions()  { list, broken } (insight-suggestions.mjs readSuggestions)
//   inbox()        { items, readAt } (insight-inbox.mjs unread)
// Nothing here reads a file, runs git or gh, or reads a transcript: it only calls what it is given. Fast by design.

import { DAY, numbersData, pipelineData, signalsData, suggestionsData, workData } from './insight-sections.mjs'
import { SECTION_NAMES } from './insight-digest.mjs'

const why = err => String(err?.message || err || 'it could not be read').replace(/\s+/g, ' ').slice(0, 200)

/** A provider's answer, or `fallback` when there is none or it fails; failures are collected in `errors`. */
async function ask(fn, fallback, errors, name) {
  if (typeof fn !== 'function') return fallback
  try {
    const v = await fn()
    return v === undefined ? fallback : v
  } catch (err) {
    errors.push(`${name}: ${why(err)}`)
    return fallback
  }
}

export async function gatherDigest(p = {}, { now = Date.now(), only = null } = {}) {
  const want = name => !only || only === name
  const sections = {}
  const part = async (name, build) => {
    if (!want(name)) return
    try {
      sections[name] = { ok: true, data: await build() }
    } catch (err) {
      sections[name] = { ok: false, why: why(err) }
    }
  }
  const errors = []
  const graph = await ask(p.graph, null, errors, 'the orchestration graph')
  const needGraph = () => {
    if (!graph) throw new Error('the orchestration graph could not be read from config.json')
    return graph
  }
  const flows = want('work') || want('numbers') || want('signals') ? await ask(p.flows, null, errors, 'the flows') : null
  const needFlows = () => {
    if (!Array.isArray(flows)) throw new Error('the flow files could not be read')
    return flows
  }

  await part('pipeline', async () => pipelineData({ graph: needGraph(), status: await ask(p.status, null, [], 'status'), settings: await ask(p.settings, { agents: {} }, [], 'settings') }))
  await part('work', async () => workData({ graph: needGraph(), flows: needFlows(), now, prs: await ask(p.prs, null, [], 'prs') }))
  await part('numbers', async () => numbersData({ graph: needGraph(), flows: needFlows(), now, tokens: await ask(p.tokens, null, [], 'tokens') }))
  await part('signals', async () => {
    const left = []
    const g = needGraph()
    const fl = needFlows()
    const got = async (fn, name, fallback) => {
      const e = []
      const v = await ask(fn, fallback, e, name)
      if (e.length) left.push(`${name}: ${e[0].split(': ').slice(1).join(': ')}`)
      return v
    }
    const data = signalsData({
      now,
      alerts: await got(p.alerts, 'the alerts', null),
      group: p.group || null,
      misses: await got(p.misses ? () => p.misses(fl, g, now - 7 * DAY) : null, 'the estimate misses', []),
      lessons: await got(p.lessons, 'the lessons', []),
      runs: await got(p.runs, 'the Learn runs', []),
      verdicts: await got(p.verdicts, 'the rule change verdicts', []),
      outcomes: await got(p.outcomes, 'the routing outcomes', []),
    })
    data.left.push(...left)
    return data
  })
  await part('health', async () => {
    const view = await ask(p.health, null, [], 'health')
    if (!view) throw new Error('the watchdog has not looked yet, and no earlier look is saved')
    return view
  })
  await part('suggestions', async () => {
    const inbox = await ask(p.inbox, null, [], 'inbox')
    const s = await ask(p.suggestions, null, [], 'suggestions')
    if (!s) throw new Error('data/suggestions.json could not be read')
    return suggestionsData({ list: s.list, broken: s.broken, readAt: inbox?.readAt ?? null })
  })
  const inbox = only ? null : await ask(p.inbox, null, [], 'inbox')
  return { at: new Date(now).toISOString(), inbox, sections, order: SECTION_NAMES.filter(want) }
}
