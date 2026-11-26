// The Pull requests list on the server: it asks gh about every flow's pull request (prlist-items.mjs says which,
// and what the answers mean) and keeps the answers in memory, so GET /api/prs (prlist-routes.mjs) answers at once.
//
// ═══ READ ONLY ═══ The only gh commands here are `gh pr view <link> --json=…` (a pull request Send opened) and
// `gh pr list --head=<branch> --base=<base> --state=all --limit=1 --json=…` (one an agent opened itself). Nothing
// here creates, edits, merges, closes or comments on a pull request. Every value goes as ONE `--flag=value`
// argument, and a link is only ever an https pull request link (prlist-items.mjs checks it), so nothing can be
// read as a flag. gh is a RUNNER passed in, `(args, timeoutMs) => Promise<{ ok, out, err }>`, so the tests stub it.
//
// ═══ THE CADENCE ═══ The states are read at most once a minute however often pages ask: a request kicks a refresh
// only when the last one started a minute ago or more, and never waits for it (it answers from what is known; the
// page's next poll, 30 s later, sees the new states). A read that hangs is given up after `timeoutMs`, four at a
// time. A merged or closed pull request cannot open again, so it is never read again (a new `flow pr` after it is
// a new lookup, prlist-items.mjs). A read that fails keeps the last good answer, marked stale, and the snapshot's
// `problem` says so in one sentence; `checkedAt` stays the time of the last refresh where every read worked.
//
//   makePrList({ gh, flows, repo, now?, everyMs?, timeoutMs? })
//     .snapshot()   { items, checkedAt, problem }, and a refresh kicked in the background when one is due
//     .refresh()    reads now (the one running, when one is): a Promise
//     .idle()       resolves when no refresh is running (the tests wait on it)
//     .start()      a refresh now and then every minute, in the background (unref'd: it never keeps Node alive)
//   `flows()` is every flow, archived ones too (listFlows({ archived: 'any' })); `repo()` the `owner/name` gh is
//   given with --repo, '' for none (gh reads the remote itself), or null when it cannot be told.

import { beat, registerLoop } from './heal-beats.mjs'
import { PR_JSON, lookupOf, prItems, readOf } from './prlist-items.mjs'

const EVERY_MS = 60_000
const TIMEOUT_MS = 8_000
const IN_FLIGHT = 4
const FINAL = new Set(['merged', 'closed'])
const s = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function makePrList({ gh, flows, repo, now = Date.now, everyMs = EVERY_MS, timeoutMs = TIMEOUT_MS }) {
  const reads = new Map() // lookup key -> { value, stale }
  let startedAt = -Infinity
  let running = null
  let checkedAt = null
  let problem = null

  const allFlows = () => {
    try {
      const list = flows()
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  /** One gh call that never throws and never takes longer than the timeout: its parsed JSON, or undefined. */
  async function ask(args) {
    let timer
    const gaveUp = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) })
    try {
      const r = await Promise.race([Promise.resolve().then(() => gh(args, timeoutMs)), gaveUp])
      return r?.ok ? JSON.parse(r.out) : undefined
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  /** What gh says about one lookup: readOf's answer, null for no pull request on that branch, undefined when it failed. */
  async function read(look, name) {
    if (look.by === 'url') {
      const j = await ask(['pr', 'view', look.url, `--json=${PR_JSON}`])
      return j === undefined ? undefined : readOf(j) ?? undefined
    }
    const j = await ask(['pr', 'list', ...(name ? [`--repo=${name}`] : []), `--head=${look.head}`, `--base=${look.base}`, '--state=all', '--limit=1', `--json=${PR_JSON}`])
    if (!Array.isArray(j)) return undefined
    const found = j.length ? readOf(j[0]) : null
    if (j.length && !found) return undefined
    // ⚠️ merged or closed, and opened BEFORE the agent recorded this branch: that is the pull request before, not
    // this record's. Treated as none yet, so it is looked for again, and it does not end the lookup for good. An
    // OPEN one is this record's whatever its age: an agent may open the pull request first and record it after.
    if (found && found.state !== 'open' && look.at && Date.parse(found.openedAt || '') < Date.parse(look.at)) return null
    return found
  }

  async function run() {
    const looks = new Map()
    for (const f of allFlows()) {
      const look = f?.completedAt ? null : lookupOf(f)
      if (look) looks.set(look.key, look)
    }
    // what no flow names any more is forgotten
    for (const key of reads.keys()) if (!looks.has(key)) reads.delete(key)
    const todo = [...looks.values()].filter(l => !FINAL.has(reads.get(l.key)?.value?.state))
    let name = ''
    let noRepo = false
    if (todo.some(l => l.by === 'head')) {
      try { name = await repo() } catch { name = null }
      noRepo = name === null
    }
    let failed = 0
    const queue = todo.filter(l => !(noRepo && l.by === 'head'))
    await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, queue.length) }, async () => {
      while (queue.length) {
        const look = queue.shift()
        const value = await read(look, name)
        if (value === undefined) {
          failed++
          const old = reads.get(look.key)
          if (old) reads.set(look.key, { ...old, stale: true })
          continue
        }
        reads.set(look.key, { value, stale: false })
      }
    }))
    problem = failed
      ? `Could not read GitHub just now (${s(failed, 'pull request')}): what shows is what it said before.`
      : noRepo ? 'Could not tell the GitHub repository from the address of the remote: pull requests an agent opened itself are not looked up.' : null
    if (!failed) checkedAt = new Date(now()).toISOString()
  }

  function refresh() {
    if (running) return running
    startedAt = now()
    const t = now()
    running = run().finally(() => {
      running = null
      beat('prlist', now() - t) // the watchdog's heartbeat (heal-beats.mjs): a read of GitHub that never ends never beats
    })
    return running
  }

  /** A refresh when one is due: never two at once, never twice in a minute. */
  function kick() {
    if (!running && now() - startedAt >= everyMs) refresh().catch(() => {})
  }

  function snapshot() {
    kick()
    return { items: prItems(allFlows(), reads), checkedAt, problem }
  }

  return {
    snapshot,
    refresh,
    idle: async () => { while (running) await running.catch(() => {}) },
    start() {
      // the watchdog's one restart drops a hung read's guard and reads again
      registerLoop('prlist', { label: 'Pull requests list', everyMs, restart: () => ((running = null), refresh()) })
      kick()
      setInterval(kick, everyMs).unref?.()
    },
  }
}
