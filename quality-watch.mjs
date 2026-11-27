// The server's quality watch: one tick now and then every 30 seconds (quality-wiring.mjs starts it), never two at once.
// Each tick:
//   1. THE RISK LABEL of every live flow (open or blocked, not archived) is worked out again, with the files its commits
//      touched (git show --name-only, cached by commit), when the flow moved since the last time (risk.basis: its
//      updatedAt and its commits). It is written with stamp: false (flows.mjs writeFlow): a label is not a change to
//      the work, so the scorecard's dates and the board's order do not move. Written only when it changed.
//   2. AUTO LESSONS (quality.autoLessons, default on): the oldest failure that came AFTER the library started and has
//      not been handled goes to the extractor, ONE per tick and never while it is busy (quality-extract.mjs). Older
//      failures wait for the user's Extract lessons on the Lessons page, so switching the feature on never pays for the
//      whole history at once.
//   3. AUTO CRITIC (quality.critic auto): the first flow whose handed-out plan has not had its second opinion
//      (quality-critic.mjs criticDue) gets one, never while the critic is busy.
// A failure inside a tick is logged on stderr and the next tick tries again: the watch never stops the server. The
// runners, git and the settings are injected, so tests run every step with stubs.

import { CONFIG } from './config.mjs'
import { beat, registerLoop } from './heal-beats.mjs'
import { listFlows, readFlow, writeFlow } from './flows.mjs'
import { qualityOf } from './quality-config.mjs'
import { criticDue } from './quality-critic.mjs'
import { pendingFailures } from './quality-extract.mjs'
import { riskFacts } from './quality-facts.mjs'
import { readLessons } from './quality-lessons.mjs'
import { riskOf } from './quality-risk.mjs'

const EVERY_MS = 30_000
const SHA = /^[0-9a-f]{7,40}$/i
const COMMITS_MAX = 20
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** The commit shas a flow records: in its steps' evidence and in its summary's changes, once each. */
function commitsOf(flow) {
  const fromNodes = (Array.isArray(flow?.nodes) ? flow.nodes : []).flatMap(n => (Array.isArray(n?.evidence) ? n.evidence : []).filter(e => e?.kind === 'commit').map(e => e.ref))
  const fromSummary = (Array.isArray(flow?.output?.changes) ? flow.output.changes : []).filter(c => c?.kind === 'commit').map(c => c.ref)
  return [...new Set([...fromNodes, ...fromSummary].map(String).filter(s => SHA.test(s)))].slice(0, COMMITS_MAX)
}

const filesCache = new Map() // sha -> [file]

/** The files the flow's commits touched, once each; a commit git cannot show adds none. Never throws. */
export async function filesOf(flow, git) {
  const out = []
  for (const sha of commitsOf(flow)) {
    if (!filesCache.has(sha)) {
      let r
      try {
        r = await git(['show', '--name-only', '--format=', '--no-renames', sha])
      } catch {
        r = { ok: false }
      }
      if (!r?.ok) continue // not cached: the commit may arrive with the next fetch
      filesCache.set(sha, String(r.out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 500))
    }
    for (const f of filesCache.get(sha)) if (!out.includes(f)) out.push(f)
  }
  return out
}

const basisOf = flow => `${flow.updatedAt || ''}|${commitsOf(flow).join(',')}`
const same = (a, b) => JSON.stringify([a?.level, a?.reasons, a?.needs]) === JSON.stringify([b?.level, b?.reasons, b?.needs])

/** Step 1: the risk labels of the live flows. */
async function refreshRisks(config, git) {
  const rules = qualityOf(config).riskRules
  for (const listed of listFlows({}).flows) {
    if (listed.status !== 'open' && listed.status !== 'blocked') continue
    const flow = readFlow(listed.id)
    if (!flow || flow.risk?.basis === basisOf(flow)) continue
    const files = await filesOf(flow, git)
    const risk = riskOf(flow, { ...riskFacts(flow, { files }), rules })
    const fresh = readFlow(flow.id) // as it is now: the git calls took time
    if (!fresh || basisOf(fresh) !== basisOf(flow)) continue
    fresh.risk = { ...risk, at: same(risk, fresh.risk) && fresh.risk?.at ? fresh.risk.at : new Date().toISOString(), basis: basisOf(flow) }
    writeFlow(fresh, { stamp: false })
  }
}

/** Steps 2 and 3: one automatic lesson run, one automatic second opinion. */
async function autoRuns(config, extractor, critic) {
  const q = qualityOf(config)
  const flows = listFlows({ archived: 'any' }).flows
  if (q.autoLessons && !extractor.busy()) {
    const next = pendingFailures(flows, readLessons()).find(f => f.auto)
    if (next) await extractor.extract(next)
  }
  if (q.critic === 'auto' && !critic.busy()) {
    const due = flows.find(f => isObject(f.plan) && criticDue(f, config))
    if (due) await critic.run(due.id)
  }
}

/** The watch: tick() (resolves 'busy' when one is running already) and start() (now, then every 30 seconds). */
export function makeQualityWatch({ extractor, critic, git, config = () => CONFIG, every = EVERY_MS }) {
  let ticking = false
  async function tick() {
    if (ticking) return 'busy'
    ticking = true
    const t = Date.now()
    try {
      const c = config()
      try {
        await refreshRisks(c, git)
      } catch (err) {
        console.error(`quality: the risk labels could not be worked out: ${err?.message || err}`)
      }
      try {
        await autoRuns(c, extractor, critic)
      } catch (err) {
        console.error(`quality: an automatic run failed: ${err?.message || err}`)
      }
      return 'done'
    } finally {
      ticking = false
      beat('quality', Date.now() - t) // the watchdog's heartbeat (heal-beats.mjs)
    }
  }
  function start() {
    // the watchdog's one restart drops a hung tick's guard and ticks again
    registerLoop('quality', { label: 'Quality watch (risk labels and lessons)', everyMs: every, restart: () => ((ticking = false), tick()) })
    void tick()
    return setInterval(() => void tick(), every).unref()
  }
  return { tick, start }
}
