// Predict and warn's routes (server.mjs mounts them with makePredictRoute, beside Pipeline tokens, and shares its
// running token index). NO model runs here: every figure is arithmetic on the flow files and the token index.
//
//   GET  /api/alerts                    { enabled, alerts, hidden, snoozed, counts: { shown, hidden, snoozed, onYou,
//                                       stuck, spike, context, daily }, building, builtAt }: predict-alerts.mjs over
//                                       the flows and the index, the ones the user dismissed today or snoozed hidden
//                                       (predict-state.mjs); each alert raised is logged once a day for the signals
//   POST /api/alerts/dismiss { key } | { keys: [...] }   dismisses that alert, or a whole group (at most 100 keys),
//                                       for the day. The page's OWN Origin is required; the measure each comes back
//                                       against is the server's own, never the page's. Keys that no longer stand are
//                                       skipped; 404 when none stands. { ok, keys }
//   POST /api/alerts/snooze { key }     snoozes a FLOW alert (stuck:<flow>:<step>) for a week; the same Origin rule.
//                                       400 for any other kind, 404 when it no longer stands. { ok, key, until }
//   GET  /api/predict/flow?id=<flow>    { id, tokens: { tokens, usd, unpriced }, estimate, stored, actual, similar,
//                                       building }: what the flow cost (predict-flow-tokens.mjs), its estimate (the
//                                       stored one, else worked out now from the flows finished before it started),
//                                       and, once it finished, the actual
//   GET  /api/predict/ticket?id=<id>    { id, estimate, similar, flow, flowDone }: for a ticket not yet started,
//                                       computed on the fly; `flow` names a flow that already carries it (done or not)
//   GET  /api/predict/accuracy?days=    predict-estimate.mjs accuracyOf over Pipeline time's window (7, 30, all)
//   route.alerts()                      { status, body }: what GET /api/alerts answers, for the phone's Agents tab
//                                       (phone-orchestration.mjs shows the count and the first two, read only)
//   route.placed({ from, now })         { placed, unplaced }: the period's tokens placed on flows, and not, for the
//                                       one line Pipeline tokens gains (token-routes.mjs)
//   route.sweep()                       places the tokens on the flows again (what flowTokens answers from), then
//                                       stores an estimate ONCE on each open flow that has none (writeFlow with
//                                       stamp false, so the scorecard does not move); the count written
//   route.ready()                       true once a placement was made: flowTokens has something to answer from
//   route.placedThrough()               when the transcripts behind the last placement were read (the index's
//                                       builtAt, in ms), or null: Routing waits for a flow's finishing hour to
//                                       close in that data before it writes the flow's one outcome line
//   route.start()                       the sweep now and every minute, in the background
//   ⚠️ The sweep places EVERY minute once the index is built, even with nothing to estimate: Routing writes each
//   finished flow's outcome line once, with flowTokens (smart-wiring.mjs), so a placement left from hours before, or
//   none at all, would be written into it for good.
//
// Rules this file keeps:
// - Answers are sent with cache-control no-store; errors are { error: one plain sentence } with 400, 403, 404 or 405.
// - It never waits on the transcripts: it answers from the index snapshot. While the first build runs, the token
//   alerts wait (`building` says so) and the sweep waits too, so no estimate is stored without its costs.
// - The alerts are worked out at most every 15 seconds (every open page polls); a dismiss works them out afresh.
// - The placement is cached for a minute and while nothing it depends on changed: every flow's updatedAt and the
//   index's build time.
// - riskOf is feat/smart-quality's provider (a flow's risk level); none by default, and the estimates still work.

import { CONFIG } from './config.mjs'
import { beat, registerLoop } from './heal-beats.mjs'
import { listFlowIds, readFlow, validateFlow, writeFlow } from './flows.mjs'
import { originAllowed } from './local-origin.mjs'
import { pipelineGraph } from './pipeline.mjs'
import { contextAlerts, dailyAlerts, spikeAlerts, stuckAlerts } from './predict-alerts.mjs'
import { accuracyOf, estimateFor, rankSimilar, targetOf } from './predict-estimate.mjs'
import { placeTokens, setFlowTokenSource } from './predict-flow-tokens.mjs'
import { alertSettings, estimateSettings } from './predict-settings.mjs'
import { ALERT_STATE_FILE, applyDismissals, dismissAlert, noteRaised, readAlertState, snoozeAlert } from './predict-state.mjs'
import { cellOf } from './score.mjs'
import { SCORE_WINDOWS } from './score-routes.mjs'
import { periodOf } from './time-stats.mjs'
import { priceTable, sessionLabels } from './token-usage.mjs'

const SLUG = /^[a-z0-9-]+$/
const TICKET = /^[A-Z]+-\d+$/
const KEY = /^(stuck|spike|context|daily):[A-Za-z0-9:._-]{1,240}$/
const BODY_MAX = 32_768
const KEYS_MAX = 100
const MIN = 60_000
const CACHE_MS = 60_000
const SWEEP_MS = 60_000
const REFRESH_MS = 30_000
const ALERTS_MS = 15_000
const KINDS = ['stuck', 'spike', 'context', 'daily']

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
const no = (status, error) => ({ status, body: { error } })

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

/** Every ticket of the configured collections: Map(id -> { title, labels, type }), from data/sources (factory.mjs). */
async function sourceTickets(config) {
  const { readSource } = await import('./factory.mjs')
  const out = new Map()
  for (const c of Array.isArray(config?.factory?.collections) ? config.factory.collections : []) {
    const src = readSource(c?.id)
    for (const [id, t] of Object.entries(src?.tickets || {})) if (!out.has(id)) out.set(id, { title: String(t?.title || ''), labels: Array.isArray(t?.labels) ? t.labels : [], type: t?.type || null })
  }
  return out
}

/**
 * Every valid flow file, archived ones too, as stored: listFlows without its `derived` (which this feature never
 * reads, and which costs most of a listing). A file that fails to parse or validate is left out, as listFlows does.
 */
export function storedFlows() {
  const out = []
  for (const id of listFlowIds()) {
    try {
      const f = readFlow(id)
      if (f && !validateFlow(f).length) out.push(f)
    } catch {
      /* a broken file: the boards show it as such; it is no flow to count */
    }
  }
  return out
}

const safe = async fn => {
  try {
    return (await fn()) || new Map()
  } catch {
    return new Map()
  }
}

export function makePredictRoute({
  index,
  names = async () => new Map(),
  live = async () => new Map(),
  labelOf = n => n,
  config = CONFIG,
  port = CONFIG.port,
  stateFile = ALERT_STATE_FILE,
  flowsOf = storedFlows,
  ticketsOf = () => sourceTickets(config),
  riskOf = null,
  now = () => Date.now(),
  log = console.error,
} = {}) {
  const settings = alertSettings(config?.alerts, log)
  const est = estimateSettings(config?.estimates, log)
  const graph = () => pipelineGraph(config)
  const prices = () => priceTable(config?.tokens).prices
  let kickedAt = null
  const kick = () => {
    if (!index || (kickedAt !== null && now() - kickedAt < REFRESH_MS)) return
    kickedAt = now()
    index.refresh?.().catch(err => log(`predict: could not read the transcripts: ${err?.message || err}`))
  }
  const snapshot = () => index?.snapshot?.() || { files: [], building: false, builtAt: null }

  // ═══ the placement, cached ═══
  let cache = new Map() // `from` -> { key, at, value }
  async function placement(from = null) {
    const at = now()
    const snap = snapshot()
    const flows = flowsOf()
    const key = JSON.stringify([snap.builtAt, snap.files.length, flows.map(f => [f.id, f.updatedAt, f.status, f.archivedAt || ''])])
    const hit = cache.get(from)
    if (hit && hit.key === key && at - hit.at < CACHE_MS) return hit.value
    const labelFn = sessionLabels(snap.files, await safe(names), labelOf)
    const value = placeTokens({ files: snap.files, flows, graph: graph(), labelOf: labelFn, prices: prices(), now: at, from })
    value.dataAt = Date.parse(snap.builtAt) // what this placement knows of: the transcripts as read then
    if (cache.size > 8) cache = new Map()
    cache.set(from, { key, at, value })
    return value
  }
  let lastPlacement = null
  const tokensOf = id => lastPlacement?.flows.get(id) ?? null
  // THE CONTRACT flowTokens(flowId) (predict-flow-tokens.mjs) answers from the last placement this route made
  setFlowTokenSource(id => tokensOf(id))
  const placed = async () => (lastPlacement = await placement(null))
  const dataAtOf = p => (Number.isFinite(p?.dataAt) ? p.dataAt : null)

  let tickets = { at: 0, map: new Map() }
  async function ticketMap() {
    if (now() - tickets.at < CACHE_MS && tickets.at) return tickets.map
    try {
      tickets = { at: now(), map: (await ticketsOf()) || new Map() }
    } catch {
      tickets = { at: now(), map: new Map() }
    }
    return tickets.map
  }
  const estOpts = async at => ({ graph: graph(), tickets: await ticketMap(), now: at, tokensOf, riskOf, nearest: est.nearest })
  const similarOf = (ids, flows) => ids.map(id => flows.find(f => f.id === id)).filter(Boolean).map(f => ({ id: f.id, title: String(f.title || f.id) }))

  // ═══ alerts ═══
  async function allAlerts(at) {
    const snap = snapshot()
    const flows = flowsOf()
    const out = stuckAlerts({ flows, graph: graph(), now: at, settings })
    if (!snap.building) {
      const [nameMap, liveMap] = await Promise.all([safe(names), safe(live)])
      const labelFn = sessionLabels(snap.files, nameMap, labelOf)
      out.push(...spikeAlerts({ files: snap.files, labelOf: labelFn, names: nameMap, now: at, settings }))
      out.push(...contextAlerts({ files: snap.files, live: liveMap, labelOf: labelFn, prices: prices(), now: at, settings }))
      out.push(...dailyAlerts({ files: snap.files, prices: prices(), now: at, settings }))
    }
    return { alerts: out, building: !!snap.building, builtAt: snap.builtAt ?? null }
  }

  /**
   * The alerts worked out at most every ALERTS_MS: every open page polls, and Home and the Agents page share one answer.
   * A dismiss always works them out afresh, so the measure it remembers is the current one.
   */
  let recent = null
  async function recentAlerts(at) {
    if (recent && at - recent.at < ALERTS_MS && at >= recent.at) return recent.value
    const value = await allAlerts(at)
    recent = { at, value }
    return value
  }

  async function alertsGet() {
    kick()
    const at = now()
    if (!settings.enabled) return { status: 200, body: { enabled: false, alerts: [], hidden: 0, snoozed: 0, counts: countsOf([], 0, 0), building: false, builtAt: new Date(at).toISOString() } }
    const { alerts, building } = await recentAlerts(at)
    try {
      noteRaised(stateFile, alerts, at)
    } catch (err) {
      log(`predict: could not note the alerts raised: ${err?.message || err}`)
    }
    const { shown, hidden, snoozed } = applyDismissals(alerts, readAlertState(stateFile), at)
    return { status: 200, body: { enabled: true, alerts: shown, hidden, snoozed, counts: countsOf(shown, hidden, snoozed), building, builtAt: new Date(at).toISOString() } }
  }
  function countsOf(shown, hidden, snoozed) {
    const counts = { shown: shown.length, hidden, snoozed, onYou: shown.filter(a => a.onYou).length }
    for (const k of KINDS) counts[k] = shown.filter(a => a.kind === k).length
    return counts
  }

  async function dismissPost(req) {
    if (!originAllowed(req.headers.origin, port)) return no(403, 'Only the dashboard page itself may dismiss an alert.')
    const b = await readBody(req)
    const keys = b?.keys !== undefined ? b.keys : typeof b?.key === 'string' ? [b.key] : null
    if (!Array.isArray(keys) || !keys.length || !keys.every(k => typeof k === 'string' && KEY.test(k))) return no(400, 'Say which alert to dismiss.')
    if (keys.length > KEYS_MAX) return no(400, `At most ${KEYS_MAX} alerts can be dismissed at once.`)
    const at = now()
    const { alerts } = await allAlerts(at)
    const standing = [...new Set(keys)].map(k => alerts.find(a => a.key === k)).filter(Boolean)
    if (!standing.length) return no(404, 'That alert has gone: there is nothing to dismiss.')
    for (const alert of standing) dismissAlert(stateFile, { key: alert.key, measure: alert.measure, now: at })
    recent = { at, value: { alerts, building: !!snapshot().building } }
    return { status: 200, body: { ok: true, key: standing[0].key, keys: standing.map(a => a.key) } }
  }

  async function snoozePost(req) {
    if (!originAllowed(req.headers.origin, port)) return no(403, 'Only the dashboard page itself may snooze an alert.')
    const b = await readBody(req)
    if (typeof b?.key !== 'string' || !KEY.test(b.key)) return no(400, 'Say which alert to snooze.')
    if (!b.key.startsWith('stuck:')) return no(400, 'Only a flow alert can be snoozed for a week; dismiss this one for today.')
    const at = now()
    const { alerts } = await allAlerts(at)
    const alert = alerts.find(a => a.key === b.key)
    if (!alert) return no(404, 'That alert has gone: there is nothing to snooze.')
    const next = snoozeAlert(stateFile, { key: alert.key, now: at })
    recent = { at, value: { alerts, building: !!snapshot().building } }
    return { status: 200, body: { ok: true, key: alert.key, until: next.snoozed[alert.key].until } }
  }

  // ═══ estimates ═══
  async function flowGet(id) {
    if (typeof id !== 'string' || !SLUG.test(id)) return no(400, 'That is not a flow id.')
    const flows = flowsOf()
    const flow = flows.find(f => f.id === id)
    if (!flow) return no(404, `No flow ${id}.`)
    kick()
    const at = now()
    const p = await placed()
    const opts = await estOpts(at)
    const start = Date.parse(flow.createdAt)
    const stored = flow.estimate && typeof flow.estimate === 'object' ? flow.estimate : null
    const estimate = stored || (est.enabled ? estimateFor(targetOf({ flow }, riskOf), flows, { ...opts, now: Number.isFinite(start) ? Math.min(start, at) : at }) : null)
    let actual = null
    try {
      const c = cellOf(flow, opts.graph, at, Infinity)
      if (c.cell === 'delivered' && Number.isFinite(start) && c.time >= start) {
        const t = p.flows.get(id)
        actual = { minutes: (c.time - start) / MIN, usd: t?.usd ?? null, tokens: t?.tokens ?? null, at: new Date(c.time).toISOString() }
      }
    } catch {
      actual = null
    }
    return {
      status: 200,
      body: { id, tokens: p.flows.get(id) || { tokens: 0, usd: null, unpriced: false }, estimate, stored: !!stored, actual, similar: similarOf(estimate?.basedOn || [], flows), building: !!snapshot().building, enabled: est.enabled },
    }
  }

  async function ticketGet(id) {
    if (typeof id !== 'string' || !TICKET.test(id)) return no(400, 'That is not a ticket id.')
    const map = await ticketMap()
    const t = map.get(id)
    if (!t) return no(404, `No ticket ${id} in the ticket lists.`)
    const flows = flowsOf()
    const carrier = flows.find(f => (f.status === 'open' || f.status === 'blocked' || f.status === 'done') && Array.isArray(f.tickets) && f.tickets.includes(id))
    if (!est.enabled) return { status: 200, body: { id, estimate: null, similar: [], flow: carrier?.id ?? null, flowDone: carrier?.status === 'done', enabled: false } }
    const at = now()
    await placed()
    const estimate = estimateFor(targetOf({ ticket: { id, title: t.title }, now: at }), flows, await estOpts(at))
    return { status: 200, body: { id, estimate, similar: similarOf(estimate.basedOn, flows), flow: carrier?.id ?? null, flowDone: carrier?.status === 'done', enabled: true } }
  }

  async function accuracyGet(raw) {
    const key = raw == null || raw === '' ? '30' : String(raw)
    if (!Object.hasOwn(SCORE_WINDOWS, key)) return no(400, 'The window must be 7, 30 or all days.')
    const at = now()
    await placed()
    const days = SCORE_WINDOWS[key]
    const from = days === null ? null : periodOf(at, days, null).from
    return { status: 200, body: { ...accuracyOf(flowsOf(), { ...(await estOpts(at)), from }), days, enabled: est.enabled } }
  }

  // ═══ the sweep: an estimate stored once on each open flow ═══
  let sweeping = null
  async function sweepOnce() {
    kick() // a fresh read of the transcripts for the next sweep, even with no page open (at most every 30 s)
    if (snapshot().building) return 0
    await placed() // flowTokens answers from this: kept current every minute (see the header)
    if (!est.enabled) return 0
    const flows = flowsOf()
    const todo = flows.filter(f => (f.status === 'open' || f.status === 'blocked') && !f.archivedAt && !f.estimate)
    if (!todo.length) return 0
    let wrote = 0
    for (const f of todo) {
      try {
        const fresh = readFlow(f.id)
        if (!fresh || fresh.estimate || !(fresh.status === 'open' || fresh.status === 'blocked')) continue
        const opts = await estOpts(now())
        fresh.estimate = estimateFor(targetOf({ flow: fresh }, riskOf), flows, opts)
        writeFlow(fresh, { stamp: false })
        wrote++
      } catch (err) {
        log(`predict: could not store an estimate on ${f.id}: ${err?.message || err}`)
      }
    }
    return wrote
  }
  const sweep = () => (sweeping ||= sweepOnce().finally(() => (sweeping = null)))

  async function route(req, res, url) {
    const p = url.pathname
    if (p !== '/api/alerts' && p !== '/api/alerts/dismiss' && p !== '/api/alerts/snooze' && !p.startsWith('/api/predict/')) return false
    const post = p === '/api/alerts/dismiss' || p === '/api/alerts/snooze'
    if (req.method !== (post ? 'POST' : 'GET')) return json(res, 405, { error: `Only ${post ? 'POST' : 'GET'} is allowed here.` }), true
    try {
      const q = url.searchParams
      const answer =
        p === '/api/alerts' ? await alertsGet()
          : p === '/api/alerts/dismiss' ? await dismissPost(req)
            : p === '/api/alerts/snooze' ? await snoozePost(req)
            : p === '/api/predict/flow' ? await flowGet(q.get('id'))
              : p === '/api/predict/ticket' ? await ticketGet(q.get('id'))
                : p === '/api/predict/accuracy' ? await accuracyGet(q.get('days'))
                  : no(404, 'There is no such page here.')
      json(res, answer.status, answer.body)
    } catch (err) {
      json(res, err?.status || 500, { error: err?.status ? err.message : `Something went wrong: ${err?.message || err}` })
    }
    return true
  }

  route.placed = async ({ from = null } = {}) => {
    const p = await placement(from)
    return { placed: p.placed, unplaced: p.unplaced }
  }
  route.alerts = alertsGet
  route.sweep = sweep
  route.ready = () => lastPlacement !== null
  route.placedThrough = () => dataAtOf(lastPlacement)
  // one pass of the sweep, with a heartbeat when it ends (heal-beats.mjs: the watchdog notices a sweep that hangs)
  const pass = () => {
    const t = Date.now()
    return sweep().catch(err => log(`predict: ${err?.message || err}`)).finally(() => beat('predict', Date.now() - t))
  }
  /** The watchdog's one restart: a hung sweep's guard is dropped and a fresh pass runs. */
  route.restart = () => {
    sweeping = null
    return pass()
  }
  route.start = () => {
    registerLoop('predict', { label: 'Predict and warn (estimates and alerts)', everyMs: SWEEP_MS, restart: route.restart })
    pass()
    setInterval(pass, SWEEP_MS).unref()
  }
  return route
}
