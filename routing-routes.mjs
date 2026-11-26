// The routing routes, behind the Routing page (#/routing, public/routing-page.js), the Tickets page's intake
// (public/routing-tickets.js) and a flow's task type; server.mjs mounts them with makeRoutingRoute.
//
//   GET  /api/routing                 { rules, defaults, custom, warning, intakeModel, types, sizes, risks, models,
//                                     efforts, agents, table: { rows, recorded, target }, flows }: the rules in force,
//                                     the outcome table (routing-outcomes.mjs) and the latest flows' routing records
//   PUT  /api/routing/rules           { rules }: checked (routing-rules.mjs checkRules), written to config.json's
//                                     routing.rules through config-write.mjs, every other byte kept; 400 with every
//                                     problem in plain lines. The page asks the user first (a plain confirm)
//   POST /api/routing/flows/<id>      { type | null }: the user's correction of a flow's task type (null takes it off);
//                                     the record is worked out again and written through writeFlow
//   GET  /api/routing/tickets         { tickets: { <ID>: { kind, reason, by, confidence, type, typeConfidence,
//                                     typeReason, typeBy, size, suggested, suggestion, duplicate? } }, counts,
//                                     model: { on, model, running, unsure } }: intake for every ticket the
//                                     collections show
//   POST /api/routing/tickets/<ID>    { kind?: code | no-code | needs-a-person | null, type?: <task type> | null,
//                                     notDuplicateOf?: <ID> }: the user's corrections, kept in factory-state.json
//   POST /api/routing/intake/run      the ONE cheap model run over the unsure open tickets (routing-intake-run.mjs);
//                                     400 when the model sort is off (config routing.intakeModel), { busy } while one runs
//
// Rules this file keeps:
// - ⚠️ Every write needs the page's OWN Origin, never a missing one (local-origin.mjs): rules steer every agent's
//   hand-out, so only the dashboard page may write them. 403 before anything is read.
// - Ids are checked before any path or key is built: a flow id against /^[a-z0-9-]+$/, a ticket id /^[A-Z]+-\d+$/.
// - Outcomes are recorded from the stored flows on every GET /api/routing and once a minute (start()): a flow that
//   finished since gets its one line (routing-outcomes.mjs recordOutcomes), never twice.
// - Everything that touches files is injected, so tests never touch data/ or config.json.

import { EFFORTS, MODELS } from './agent-settings.mjs'
import { CONFIG, CONFIG_FILE } from './config.mjs'
import { beat, registerLoop } from './heal-beats.mjs'
import { listFlows, readFlow, writeFlow } from './flows.mjs'
import { originAllowed } from './local-origin.mjs'
import { pipelineGraph } from './pipeline.mjs'
import { routingNow, writeRoutingRules } from './routing-config.mjs'
import { correctType } from './routing-flow.mjs'
import { duplicates, sortTickets, unsureIds } from './routing-intake.mjs'
import { makeIntakeRunner } from './routing-intake-run.mjs'
import { intakeState, intakeTickets, setKind, setNotDuplicate, setTicketType } from './routing-intake-store.mjs'
import { listOutcomes, OUTCOMES_FILE, outcomeTable, recordOutcomes } from './routing-outcomes.mjs'
import { routingProviders } from './routing-providers.mjs'
import { checkRules, DEFAULT_RULES, RISKS, suggest, suggestionLine } from './routing-rules.mjs'
import { SIZES, sizeOf, TASK_TYPES, taskTypeOf, withCorrection } from './routing-type.mjs'

const FLOW = /^\/api\/routing\/flows\/([^/]+)$/
const TICKET_PATH = /^\/api\/routing\/tickets\/([^/]+)$/
const SLUG = /^[a-z0-9-]+$/
const TICKET = /^[A-Z]+-\d+$/
const BODY_MAX = 64_000
const FLOWS_SHOWN = 25
const SWEEP_MS = 60_000

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
    return raw ? JSON.parse(raw) : {}
  } catch {
    throw Object.assign(new Error('The request was not valid JSON.'), { status: 400 })
  }
}

const decode = s => {
  try {
    return decodeURIComponent(s)
  } catch {
    return ''
  }
}

export function makeRoutingRoute({
  port = CONFIG.port, config = CONFIG, configFile = CONFIG_FILE, reader = routingNow, runner = makeIntakeRunner(),
  flows = () => listFlows({ archived: 'any' }).flows, tickets = () => intakeTickets(), outcomesFile = OUTCOMES_FILE,
  providers = routingProviders, now = () => Date.now(), write = writeRoutingRules,
} = {}) {
  const graph = () => pipelineGraph(config)

  function sweep() {
    try {
      // each line is written once, so a flow waits until its tokens are final (routing-providers.mjs tokensReady)
      const p = providers()
      return recordOutcomes({ flows: flows(), graph: graph(), now: now(), file: outcomesFile, flowTokens: p.flowTokens, readyFor: at => p.tokensReady?.(at) !== false })
    } catch {
      return 0
    }
  }

  function view() {
    sweep()
    const s = reader()
    const g = graph()
    const recent = flows().filter(f => f?.routing).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, FLOWS_SHOWN)
    return {
      rules: s.rules, defaults: DEFAULT_RULES, custom: s.custom, warning: s.warning, intakeModel: s.intakeModel,
      types: TASK_TYPES, sizes: SIZES, risks: RISKS, models: MODELS, efforts: EFFORTS,
      agents: g.nodes.filter(n => n.kind === 'agent').map(n => ({ label: n.label, role: n.role })),
      table: outcomeTable(listOutcomes({}, outcomesFile)),
      flows: recent.map(f => ({ id: f.id, title: f.title, agent: f.agent, status: f.status, routing: f.routing })),
    }
  }

  /** Intake for every ticket the collections show. */
  function ticketView() {
    const list = tickets()
    const st = intakeState()
    const sorted = sortTickets(list, st.intake)
    const dups = duplicates(list, st.notDuplicate)
    const rules = reader().rules
    const out = {}
    const counts = { code: 0, 'no-code': 0, 'needs-a-person': 0, unsure: 0 }
    for (const t of list) {
      const k = sorted[t.id]
      if (k.confidence === 'unsure') counts.unsure++
      else counts[k.kind]++
      const tt = withCorrection(taskTypeOf({ title: t.title, labels: t.labels, storyType: t.type }), st.taskTypes[t.id] ?? null)
      const size = sizeOf({ text: t.title, type: tt.type })
      const s = suggest({ type: tt.confidence === 'unsure' ? null : tt.type, size, risk: null }, rules, {})
      out[t.id] = {
        kind: k.kind, reason: k.reason, by: k.by, confidence: k.confidence,
        type: tt.type, typeConfidence: tt.confidence, typeReason: tt.reason, typeBy: tt.by, size,
        suggested: s, suggestion: suggestionLine(s), ...(dups[t.id] ? { duplicate: dups[t.id] } : {}),
      }
    }
    const model = reader().intakeModel
    return { tickets: out, counts, model: { on: !!model, model, running: runner.running(), unsure: unsureIds(list, sorted).length } }
  }

  async function runIntake() {
    const model = reader().intakeModel
    if (!model) return [400, { error: 'The model sort is off. Set routing.intakeModel in config.json to a model id, such as claude-haiku-5-5, to turn it on.' }]
    const list = tickets()
    const ids = new Set(unsureIds(list, sortTickets(list, intakeState().intake)))
    const r = await runner.run(list.filter(t => ids.has(t.id)), model)
    if (r.busy) return [409, { busy: true, error: 'A sorting run is already going.' }]
    if (r.error) return [502, r]
    return [200, r]
  }

  function ticketChange(id, b) {
    if (!TICKET.test(id)) return [400, { error: 'A ticket id looks like FLA-815.' }]
    if (!b || typeof b !== 'object') return [400, { error: 'Send a kind, a type or notDuplicateOf.' }]
    let did = false
    if (b.kind !== undefined) setKind(id, b.kind), (did = true)
    if (b.type !== undefined) setTicketType(id, b.type), (did = true)
    if (b.notDuplicateOf !== undefined) setNotDuplicate(id, b.notDuplicateOf), (did = true)
    if (!did) return [400, { error: 'Send a kind, a type or notDuplicateOf.' }]
    return [200, { ok: true, ticket: ticketView().tickets[id] ?? null }]
  }

  function flowChange(id, b) {
    if (!SLUG.test(id)) return [400, { error: 'Flow id must match /^[a-z0-9-]+$/.' }]
    const flow = readFlow(id)
    if (!flow) return [404, { error: `No flow ${id}.` }]
    if (!b || !('type' in b)) return [400, { error: 'Send the task type, or null to take your correction off.' }]
    flow.routing = correctType(flow, b.type, { rules: reader().rules, graph: graph(), riskOf: providers().riskOf })
    writeFlow(flow)
    return [200, { ok: true, routing: flow.routing }]
  }

  function rulesPut(b) {
    const { rules, problems } = checkRules(b?.rules)
    if (problems.length) return [400, { error: problems.join('\n'), problems }]
    write(configFile, rules)
    reader.invalidate?.()
    return [200, { ok: true, ...view() }]
  }

  async function route(req, res, url) {
    const p = url.pathname
    if (p !== '/api/routing' && !p.startsWith('/api/routing/')) return false
    const writes = req.method === 'POST' || req.method === 'PUT'
    if (writes && !originAllowed(req.headers.origin, port)) return json(res, 403, { error: 'Routing is changed only from the dashboard page.' }), true
    try {
      if (p === '/api/routing' && req.method === 'GET') return json(res, 200, view()), true
      if (p === '/api/routing/tickets' && req.method === 'GET') return json(res, 200, ticketView()), true
      if (p === '/api/routing/rules' && req.method === 'PUT') return json(res, ...rulesPut(await readBody(req))), true
      if (p === '/api/routing/intake/run' && req.method === 'POST') return json(res, ...(await runIntake())), true
      const flow = FLOW.exec(p)
      if (flow && req.method === 'POST') return json(res, ...flowChange(decode(flow[1]), await readBody(req))), true
      const ticket = TICKET_PATH.exec(p)
      if (ticket && req.method === 'POST') return json(res, ...ticketChange(decode(ticket[1]), await readBody(req))), true
      return json(res, 405, { error: 'That is not something the routing page does.' }), true
    } catch (e) {
      return json(res, e.status || 400, { error: e.message }), true
    }
  }

  /** One pass with a heartbeat when it ends (heal-beats.mjs); also the watchdog's one restart. */
  route.restart = () => {
    const t = Date.now()
    sweep()
    beat('routing', Date.now() - t)
  }
  /** The once-a-minute outcome sweep; unref'd, so it never keeps the process alive. */
  route.start = () => {
    registerLoop('routing', { label: 'Routing outcomes', everyMs: SWEEP_MS, restart: route.restart })
    return setInterval(route.restart, SWEEP_MS).unref()
  }
  route.sweep = sweep
  return route
}
