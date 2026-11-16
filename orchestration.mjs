// The orchestration grid on the Factory page: one column per agent (Master,
// Agent 1, 2, 3), one row per level (Local, Dev, Stage, Prod), and in each cell
// the tickets that agent built which have reached that level and no further.
//
// Level of a ticket, highest wins:
//   prod   its id is in a commit on origin/main (subject or body: stage goes to
//          main as a squash, whose body lists the commits)
//   stage  its id is in a commit subject on origin/stage
//   dev    ... on origin/dev
//   local  its id is in a commit on followup or on any worktree (detached ones
//          included) that dev does not have, or in a worktree's branch name.
//          Uncommitted work is not counted: a session mentions many tickets it
//          is not building, so tool calls are too noisy to say "in progress".
//
// Who built it, in order: the agent on the worktree that holds it (from the
// status build), the agent the plan's wave column names (A1, A2, A3), else
// Master when it has reached any level (Master merges and ships everything).
//
// A ticket can sit in two columns when the plan splits it (e.g. "A3 web, A2 API").
//
// Each ticket also lists the open flows that name it (ticketFlows), so a row
// can say which agent is narrating it, the step it is on, and whether it waits
// on the user.

import { existsSync } from 'node:fs'
import path from 'node:path'

import { CONFIG } from './config.mjs'
import { buildFactory, readSource } from './factory.mjs'
import { listFlows } from './flows.mjs'
import { recordLevels } from './since-store.mjs'
import { idsInBranch, idsInText } from './transcripts.mjs'

const LEVELS = ['local', 'dev', 'stage', 'prod']
const CACHE_MS = 45_000

/** The grid columns: the coding agents in config order, Master first. */
function columns() {
  const labels = [...new Set(Object.values(CONFIG.codingAgents))] // two session names can share a label
  const coord = CONFIG.codingAgents[CONFIG.coordinator] || CONFIG.coordinator
  return [coord, ...labels.filter(l => l !== coord)]
}

/** Agents the plan's wave cell names: "2 (A3 web, A2 API)" -> ["Agent 3", "Agent 2"]. */
const planAgents = wave => [...String(wave || '').matchAll(/\bA(\d)\b/g)].map(m => `Agent ${m[1]}`)

/**
 * ticket id -> the flows (with `derived`) that name it, as the grid shows them:
 * `current` is the title of the node derived.current names (null when none),
 * `waiting` whether an ask is open. The caller picks which flows go in.
 */
export function ticketFlows(flows) {
  const byTicket = new Map()
  for (const f of flows) {
    const current = f.nodes.find(n => n.id === f.derived.current)?.title ?? null
    const row = { id: f.id, title: f.title, agent: f.agent, current, waiting: f.derived.waiting.length > 0 }
    for (const t of f.tickets || []) {
      if (!byTicket.has(t)) byTicket.set(t, [])
      byTicket.get(t).push(row)
    }
  }
  return byTicket
}

export function makeOrchestration({ git, getStatus, listWorktrees }) {
  let cache = null

  /**
   * `{ ok, index }`: index is id -> newest commit naming it, over subjects and
   * bodies, in one log call; ok is false when that log failed (index empty).
   */
  async function idIndex(range, withBody = false) {
    const fmt = withBody ? '%h%x09%cs%x09%s%x09%b%x1e' : '%h%x09%cs%x09%s%x1e'
    const r = await git(['log', ...range, `--format=${fmt}`])
    const index = new Map()
    if (!r.ok) return { ok: false, index }
    for (const rec of r.out.split('\x1e')) {
      const [sha, date, subject = '', body = ''] = rec.trim().split('\t')
      if (!sha) continue
      for (const id of idsInText(subject + ' ' + body)) if (!index.has(id)) index.set(id, { sha, date, subject })
    }
    return { ok: true, index }
  }

  /**
   * Tickets with work that is only local: commits ahead of dev in each worktree (detached too) and on followup.
   * `ok` is false when any worktree log failed (a lock, a transient git error): its tickets read as no local level.
   * A worktree git still lists but whose folder is gone (or marked prunable) is skipped first: its log
   * fails with ENOENT on EVERY build, which would keep `ok` false and stop the level record for good.
   */
  async function localWork() {
    const where = new Map() // id -> [{ worktree, subject }]
    const add = (id, worktree, subject) => {
      if (!where.has(id)) where.set(id, [])
      if (!where.get(id).some(w => w.worktree === worktree)) where.get(id).push({ worktree, subject })
    }
    let ok = true
    const trees = (await listWorktrees()).filter(w => !w.prunable && existsSync(w.path))
    await Promise.all(
      trees.map(async w => {
        const name = path.basename(w.path)
        for (const id of idsInBranch(w.branch)) add(id, name, `branch ${w.branch}`)
        const r = await git(['log', '--format=%s', `${CONFIG.levels.dev}..HEAD`], w.path)
        if (!r.ok) {
          ok = false
          return
        }
        for (const s of r.out.split('\n')) for (const id of idsInText(s)) add(id, name, s)
      })
    )
    return { ok, where, trees }
  }

  async function build(collectionId) {
    const [factory, status, mainIdx, stageIdx, devIdx, local] = await Promise.all([
      buildFactory(collectionId),
      getStatus(false),
      idIndex([CONFIG.levels.prod, '--since=9.months'], true),
      idIndex([CONFIG.levels.stage, '--since=9.months']),
      idIndex([CONFIG.levels.dev, '--since=9.months']),
      localWork(),
    ])
    const [main, stage, dev] = [mainIdx.index, stageIdx.index, devIdx.index]
    const cols = columns()
    const statusTickets = new Map((status.tickets || []).map(t => [t.id, t]))
    const agentByLabel = new Map((status.agents || []).map(a => [a.label, a]))

    // The collection's tickets, plus anything an agent has in flight outside it
    // (its title, state and owner from the collection's source when it is there:
    // a filter can leave out a ticket the source has).
    const byId = new Map(factory.tickets.map(t => [t.id, t]))
    const source = readSource(factory.collection?.id)?.tickets || {}
    for (const t of status.tickets || []) {
      if (byId.has(t.id)) continue
      const s = source[t.id]
      byId.set(t.id, { id: t.id, title: s?.title || t.title, state: s?.state || t.switchboard?.state || '', owner: s?.owner || 'none', outside: true })
    }

    const flowsOf = ticketFlows(listFlows({ open: true }).flows)
    const tickets = {}
    const cells = Object.fromEntries(cols.map(c => [c, { local: [], dev: [], stage: [], prod: [] }]))
    const planned = Object.fromEntries(cols.map(c => [c, []]))

    for (const t of byId.values()) {
      const st = statusTickets.get(t.id)
      const fromPlan = planAgents(t.plan?.wave).filter(a => cols.includes(a))
      const fromTree = (st?.agents || []).filter(a => cols.includes(a) && a !== cols[0])
      let agents = fromTree.length ? fromTree : fromPlan

      const levels = {
        prod: main.get(t.id) || null,
        stage: stage.get(t.id) || null,
        dev: dev.get(t.id) || null,
        local: local.where.get(t.id) || null,
      }
      const level = [...LEVELS].reverse().find(l => levels[l]) || null
      if (!agents.length && level) agents = [cols[0]]

      tickets[t.id] = {
        id: t.id,
        title: t.title,
        state: t.state,
        owner: t.owner,
        mark: t.mark || null,
        plan: t.plan || null,
        outside: Boolean(t.outside),
        level,
        levels,
        moreLocal: Boolean(level && level !== 'local' && levels.local),
        agents,
        flows: flowsOf.get(t.id) || [],
      }
      for (const a of agents) {
        if (level) cells[a][level].push(t.id)
        else if (t.mark?.review !== 'not-codebase') planned[a].push(t.id)
      }
    }

    // Home's Since card: each ticket's level against the previous build, noted on change (since-store.mjs).
    // ⚠️ Only from a build whose logs all read, the remotes and every local worktree:
    // a failed log is an empty index, so every ticket would drop a level here and rise again next build.
    if (mainIdx.ok && stageIdx.ok && devIdx.ok && local.ok) recordLevels(Object.fromEntries(Object.values(tickets).map(t => [t.id, t.level])))

    const sortIds = ids => ids.sort((x, y) => Number(x.split('-')[1]) - Number(y.split('-')[1]))
    for (const c of cols) {
      for (const l of LEVELS) sortIds(cells[c][l])
      sortIds(planned[c])
    }

    return {
      builtAt: new Date().toISOString(),
      levels: LEVELS,
      // The collection's ticket prefix: the grid shows its ids by number alone.
      prefix: factory.collection?.prefix || '',
      columns: cols.map(label => {
        const a = agentByLabel.get(label)
        return {
          label,
          planned: planned[label],
          agent: a
            ? {
                sessionId: a.sessionId,
                name: a.name,
                state: a.state,
                status: a.status,
                lastTool: a.lastTool,
                at: a.transcriptAt || a.updatedAt,
                talkingWith: a.talkingWith,
                subagentsRunning: (a.subagents || []).filter(s => s.state && s.state !== 'idle' && s.state !== 'done').length,
              }
            : null,
        }
      }),
      cells,
      tickets,
    }
  }

  return async function orchestration(collectionId, force = false) {
    const key = collectionId || ''
    if (!force && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.data
    const data = await build(collectionId)
    cache = { key, at: Date.now(), data }
    return data
  }
}

// ═══ The pulse ═══

/** When an ask was put: the node's own `at` when the store stamped one, else the flow's last write. */
const askedAt = (flow, node) => node.at || flow.updatedAt

/** Open asks across flows that are not dropped, newest first, each with why it is asked (flows.mjs askReason). */
function waitingAsks(flows) {
  const asks = []
  for (const f of flows) {
    for (const id of f.derived.waiting) {
      const node = f.nodes.find(n => n.id === id)
      asks.push({ flowId: f.id, flowTitle: f.title, agent: f.agent, nodeId: id, question: node.title, why: f.derived.reasons?.[id]?.text || '', askedAt: askedAt(f, node) })
    }
  }
  return asks.sort((a, b) => String(b.askedAt || '').localeCompare(String(a.askedAt || '')))
}

/** One line per flow: how much proof it carries and how many answers failed to reach the agent. */
const flowLine = f => ({
  id: f.id,
  title: f.title,
  agent: f.agent,
  status: f.status,
  updatedAt: f.updatedAt,
  evidence: f.nodes.reduce((sum, n) => sum + (n.evidence?.length || 0), 0),
  undelivered: f.nodes.filter(n => n.type === 'ask' && n.deliveryError != null).length,
})

/**
 * Pure: the chat agent's state as the pages show it (the rail's Ask dot, the
 * drawer head, the Independent card on Home and the Agents page).
 * - working: a turn is running;
 * - waiting: it waits on the user, either an open ask in one of ITS flows (a
 *   live flow whose agent is the chat's name) or its last reply ended with a
 *   question (chatStatus().asked);
 * - idle: anything else.
 */
export function chatState({ busy = false, asked = false, name = '', flows = [] } = {}) {
  if (busy) return 'working'
  if (asked) return 'waiting'
  const open = Boolean(name) && flows.some(f => f.agent === name && f.status !== 'dropped' && f.derived?.waiting?.length > 0)
  return open ? 'waiting' : 'idle'
}

/**
 * The small, frequent poll behind the notifier: open asks, every live flow, agent states, the chat's
 * status with its state (chatState), and the reminders from the config (already validated in config.mjs), so the page reads
 * them here instead of from a route of their own (public/reminders.js).
 */
export async function pulse({ getStatus, chatStatus }) {
  const live = listFlows().flows.filter(f => f.status !== 'dropped')
  let agents = []
  try {
    const st = await getStatus(false)
    agents = (st.agents || []).map(a => ({ label: a.label, state: a.state, status: a.status, at: a.transcriptAt || a.updatedAt, coding: a.coding }))
  } catch {
    agents = []
  }
  const chat = chatStatus()
  return {
    at: new Date().toISOString(),
    waiting: waitingAsks(live),
    flows: live.map(flowLine),
    agents,
    chat: { ...chat, state: chatState({ ...chat, flows: live }) },
    reminders: CONFIG.reminders,
  }
}
