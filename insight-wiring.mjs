// Master's insight bound to this machine: server.mjs makes it with ONE call and mounts its route with one line.
//
//   makeInsightServer({ port, cachedStatus, getStatus, relay, tokenRoute, predictRoute, prListRoute, present, sessionNames, labelOf })
//     -> { route, start(), noteWork(what, ms) }
//     route       the routes (insight-routes.mjs): the digest, the suggestions, the watchdog
//     start()     the watchdog, now and every minute (heal-runner.mjs), once the server listens
//     noteWork    the server tells the watchdog what each request was and how long it took (the Server check)
//
// What it wires:
// - THE DIGEST'S PROVIDERS (insight-gather.mjs): the files (insight-files.mjs) with the server's own in-memory stores
//   on top: the last /api/status snapshot (never a fresh scan on the digest's path: it kicks one in the background
//   when there is none), the Pull requests list as last read, the token index snapshot, the alerts, the watchdog.
// - THE WATCHDOG'S FACTS for each check, and its four repairs (heal-repairs.mjs) on the real ticket sources
//   (factory.mjs pause), the relay (hold), the stores and the loops (heal-beats.mjs).
// - THE INBOX and its urgent path: with config insight.notifyMaster "urgent", one relay turn to the coordinator
//   (relay.mjs messagePrompt and claudeRun), only while it has a session open, at most one per 30 minutes, its cost
//   recorded as `insight` spend.
// - FACTORY_TEST_PROCS (an environment variable for a preview or an end-to-end check only, like FACTORY_TEST_GH):
//   names a JSON file that stands in for the process list, and a Stop then only records; no real process is looked
//   at or stopped. It is not a setting and is documented nowhere else.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeAtomic } from './atomic-write.mjs'
import { agentLabels } from './agent-rules.mjs'
import { outputSettings } from './completed.mjs'
import { CONFIG, CONFIG_FILE, coordinatorSettings, levelSettings, prSettings, reminderList, ticketPrefixList } from './config.mjs'
import { collections, historyOf, pause, readSource, refreshStatus, resume, validateCollection } from './factory.mjs'
import { DATA_DIR, listFlows, stoppedBy } from './flows.mjs'
import { loopsView, restartLoop } from './heal-beats.mjs'
import { configFacts, diskFacts, storeFacts } from './heal-facts.mjs'
import { makeProcs } from './heal-procs.mjs'
import { makeRepairs } from './heal-repairs.mjs'
import { makeDelayMeter, makeHealRunner } from './heal-runner.mjs'
import { HEAL_STATE_FILE, readHealState } from './heal-store.mjs'
import { fileProviders } from './insight-files.mjs'
import { appendInbox, INBOX_STATE_FILE, makeNotifier, noteNew } from './insight-inbox.mjs'
import { makeInsightRoute } from './insight-routes.mjs'
import { healingSettings, insightSettings } from './insight-settings.mjs'
import { learnSettings } from './learn-settings.mjs'
import { pipelineGraph, pipelineSettings } from './pipeline.mjs'
import { alertSettings, estimateSettings } from './predict-settings.mjs'
import { CURRENT_PROJECT, PROJECTS, projectRaw } from './project-store.mjs'
import { ALERT_STATE_FILE } from './predict-state.mjs'
import { qualitySettings } from './quality-config.mjs'
import { claudeRun, messagePrompt, relayOutcome } from './relay.mjs'
import { restartLogFile } from './restart.mjs'
import { spendLines } from './spend.mjs'
import { listDays } from './standup-archive.mjs'
import { priceTable } from './token-usage.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FACTORY_CLI = path.join(HERE, 'tools', 'factory.mjs').replace(/\\/g, '/')

/** The stores the Stores check reads, and how each is rebuilt (null: it cannot be, from other files). */
export const STORES = Object.freeze([
  { name: 'token-index.json', label: 'The token index', file: path.join(DATA_DIR, 'token-index.json'), rebuild: 'token' },
  { name: 'standup/index.json', label: 'The stand-up index', file: path.join(DATA_DIR, 'standup', 'index.json'), rebuild: 'standup' },
  { name: 'lessons.json', label: 'The lessons', file: path.join(DATA_DIR, 'lessons.json'), rebuild: null },
  { name: 'suggestions.json', label: 'The suggestions', file: path.join(DATA_DIR, 'suggestions.json'), rebuild: null },
  { name: 'alerts-state.json', label: 'The alerts state', file: ALERT_STATE_FILE, rebuild: 'alerts' },
])

/** Every settings reader of config.json, run on it again with a collecting warn (the Config check). */
const CONFIG_READERS = [
  (r, warn) => coordinatorSettings(r, warn), (r, warn) => reminderList(r.reminders, warn), (r, warn) => ticketPrefixList(r.ticketPrefixes, warn),
  (r, warn) => prSettings(r.pr, warn), (r, warn) => levelSettings(r.levels, warn), (r, warn) => pipelineSettings(r.pipeline, warn),
  (r, warn) => outputSettings(r.outputs, warn), (r, warn) => qualitySettings(r.quality, r.pipeline, warn), (r, warn) => learnSettings(r.learn, warn),
  (r, warn) => alertSettings(r.alerts, warn), (r, warn) => estimateSettings(r.estimates, warn), (r, warn) => healingSettings(r.healing, warn),
  (r, warn) => insightSettings(r.insight, warn),
  r => (Array.isArray(r.factory?.collections) ? r.factory.collections : []).forEach(validateCollection),
]

/** The process list: the real one, or FACTORY_TEST_PROCS's seeded one with a Stop that only records (see the header). */
function procsFor(here) {
  const seeded = process.env.FACTORY_TEST_PROCS
  if (!seeded) return makeProcs({ here })
  return makeProcs({ here, platform: 'win32', exec: async () => ({ ok: true, out: readFileSync(seeded, 'utf8') }), kill: pid => console.log(`heal: FACTORY_TEST_PROCS is set, so process ${pid} was NOT stopped`) })
}

export function makeInsightServer({ port, cachedStatus, getStatus, relay, tokenRoute, predictRoute, prListRoute, present, sessionNames = async () => new Map(), labelOf = n => n }) {
  const healing = healingSettings(CONFIG.healing, () => {})
  const insight = insightSettings(CONFIG.insight, () => {})
  const graph = () => pipelineGraph(CONFIG)
  // the server drops its status cache after each fetch of origin (every 5 minutes): the last one seen is kept, so the
  // digest and the Agents check do not flip to "not read" between two reads (it is at most a few minutes old)
  let lastStatus = null
  const status = () => {
    const s = cachedStatus()
    if (s) lastStatus = s
    else getStatus().catch(() => {}) // a fresh read, in the background: the digest never waits on a scan
    return s || lastStatus
  }
  const procs = procsFor(HERE)
  const storeCache = new Map()
  let buildSeenAt = null // when the token index was first seen building, for the Stores check

  // ═══ the inbox and the urgent path ═══
  const notify = makeNotifier({
    settings: () => insight,
    present: () => present(CONFIG.coordinator),
    send: async text => relayOutcome(await claudeRun(messagePrompt(CONFIG.coordinator, [`From the dashboard: ${text} Read the digest for the rest: node ${FACTORY_CLI} orchestration --by "${CONFIG.coordinatorLabel}"`])), 'insight'),
  })
  const inbox = {
    append: item => appendInbox(item),
    notify,
    noteNew: (kind, keys) => noteNew(kind, keys),
    firstTime: () => !existsSync(INBOX_STATE_FILE),
    async events() {
      const alerts = predictRoute ? (await predictRoute.alerts())?.body?.alerts || [] : []
      const stops = listFlows({ archived: 'any' }).flows.filter(f => stoppedBy(f) && !f.completedAt && !f.archivedAt)
      return {
        alerts: alerts.map(a => ({ key: a.key, text: a.text })),
        stops: stops.map(f => ({ id: f.id, text: `${f.title || f.id} (${f.id}) was stopped by ${stoppedBy(f)} after too many failures: only the user moves it on.` })),
      }
    },
  }

  // ═══ the watchdog ═══
  const facts = {
    refresh: async () => {
      const resumed = readHealState().resumed
      return {
        collections: collections().map(c => ({ id: c.id, name: c.name, everyMinutes: c.refreshMinutes, paused: refreshStatus(c.id).paused, history: historyOf(c.id), fetchedAt: readSource(c.id)?.fetchedAt || null, resumedAt: resumed[c.id] || null })),
        spend: spendLines('refresh'),
      }
    },
    deliveries: async () => relay.health(),
    stores: async () => {
      const snap = tokenRoute?.snapshot()
      if (snap?.building) buildSeenAt ??= new Date().toISOString()
      else buildSeenAt = null
      return { files: await storeFacts(STORES, storeCache), tokenBuild: snap ? { building: !!snap.building, startedAt: buildSeenAt } : null }
    },
    loops: async () => ({ loops: loopsView() }),
    strays: async () => ({ ...(await procs.servers()), selfPid: process.pid }),
    disk: async () => {
      let logs = []
      try {
        logs = readdirSync(DATA_DIR).filter(f => f.endsWith('.log')).map(f => path.join(DATA_DIR, f))
      } catch {}
      return diskFacts({ dataDir: DATA_DIR, logs: [...new Set([...logs, restartLogFile()])] })
    },
    config: async () => configFacts({ file: CONFIG_FILE, readers: CONFIG_READERS, unwrap: raw => projectRaw(raw, PROJECTS, CURRENT_PROJECT) }),
    agents: async () => ({ status: status(), coordinator: CONFIG.coordinatorLabel, cli: FACTORY_CLI }), // the first read kicked in the background
  }
  const actions = makeRepairs({
    sources: { pause }, relay, restartLoop, stores: STORES, stateFile: HEAL_STATE_FILE,
    rebuild: {
      token: async () => tokenRoute?.index.refresh(),
      standup: async () => listDays(),
      alerts: async () => writeAtomic(ALERT_STATE_FILE, JSON.stringify({ day: null, dismissed: {}, snoozed: {}, raised: [] }, null, 1)),
    },
  })
  const runner = makeHealRunner({ settings: () => healing, facts, actions, inbox, delay: makeDelayMeter() })

  // ═══ the digest ═══
  const files = fileProviders()
  const providers = {
    ...files,
    status,
    prs: () => prListRoute?.list.snapshot().items ?? null,
    tokens: async () => {
      const snap = tokenRoute?.snapshot()
      if (!snap) return null
      return { ...snap, prices: priceTable(CONFIG.tokens).prices, names: await sessionNames(), labelOf }
    },
    alerts: async () => (predictRoute ? (await predictRoute.alerts())?.body ?? null : null),
    health: () => runner.view(),
  }

  const route = makeInsightRoute({
    port, providers, runner, relay, procs, sources: { resume }, stateFile: HEAL_STATE_FILE,
    agents: () => agentLabels(graph()), learnDays: learnSettings(CONFIG.learn, () => {}).verdictAfterDays,
  })
  return { route, start: () => runner.start(), noteWork: (what, ms) => runner.noteWork(what, ms) }
}
