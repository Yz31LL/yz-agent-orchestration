// A pull request, read on the phone (GET /phone/api/pr, phone-server.mjs; the sheet is public/phone-pr.js). READ ONLY.
//
// ═══ WHICH PULL REQUEST ═══ ONLY one the desktop's Pull requests list holds (prlist-store.mjs, given here as the
// `prs` provider, exactly as phone-orchestration.mjs gets it): the open pull requests of the flows. The phone names
// one by its flow id (`?flow=<id>`) or its number (`?n=<number>`), nothing else: an address with any other key (a
// repo, a link) is refused whole, and so is a number two items share. The repository and the number handed to gh are
// read from the LIST ITEM's own link, re-checked against GITHUB_PR, never from the request. Anything else is a 404
// before gh is asked anything.
//
// ═══ WHAT GH IS ASKED ═══ Two read-only commands, each value ONE argument so nothing can be read as a flag:
//   gh pr view <n> --repo=<owner/name> --json=<PR_VIEW_JSON>
//   gh pr diff <n> --repo=<owner/name> --color=never
// Nothing here creates, edits, merges, closes, approves or comments on a pull request. gh is a RUNNER passed in,
// `(args, timeoutMs) => Promise<{ ok, out, err }>` (server.mjs gh, FACTORY_TEST_GH in a scratch run), so the tests stub
// it. ⚠️ `reviewRequests` is asked for beside the fields the brief lists: the sheet says WHO a review is asked of.
//
// ═══ THE CADENCE ═══ One copy per pull request, kept CACHE_MS (60 s): reads of it within the minute, by flow or by
// number, answer from the copy; reads at the same moment share one gh read. At most IN_FLIGHT (2) gh calls run at
// once, whatever the number of pull requests asked for; the rest wait their turn. A call that hangs is given up after
// `timeoutMs` and frees its place `graceMs` later at the latest. A failed read keeps the last copy, marked stale with
// one plain sentence (`problem`), and is tried again after FAIL_MS, not before.
//
// ═══ WHAT COMES BACK ═══ A small fixed shape, every text CUT (CAPS) and every cut SAID (`cut` flags):
//   { url, label, flow, title, state, author, createdAt, updatedAt, base, head, checks, review, body, files,
//     conversation, checkedAt, stale, problem }
// ⚠️ Everything GitHub returns is HOSTILE text (anyone who can open a pull request or comment writes it). It is sent
// as plain JSON strings and the phone escapes every one (public/phone-pr.js). Names (title, author, branches, file
// paths) lose control and direction-override characters here, and a patch line shows an override as a visible mark,
// so no text can pretend to be other code (the "trojan source" trick).
//
//   makePrReader({ gh, prs, now?, timeoutMs?, graceMs?, listWaitMs? })   { read({ flow, n, keys }) -> { status, body } }
//   checksView(rollup) / reviewView(json) / patchesOf(diff) / filesView(files, patches)   the pure halves, for the tests

import { checksOf } from './pr-check.mjs'

export const PR_VIEW_JSON = 'title,body,author,state,isDraft,createdAt,updatedAt,baseRefName,headRefName,additions,deletions,changedFiles,files,reviewDecision,reviewRequests,statusCheckRollup,comments,reviews,mergeable,url'
export const CAPS = Object.freeze({ body: 20_000, files: 100, fileLines: 300, totalLines: 1500, comments: 30, comment: 2000, line: 500, checks: 30, names: 10 })
export const CACHE_MS = 60_000
export const FAIL_MS = 15_000
export const IN_FLIGHT = 2
const TIMEOUT_MS = 20_000
const GRACE_MS = 5_000
const LIST_WAIT_MS = 3_000
const SLUG = /^[a-z0-9-]{1,80}$/
const NUMBER = /^[1-9][0-9]{0,8}$/
/** MUST CHANGE IN LOCKSTEP with phone-orchestration.mjs GITHUB_PR: the only links the phone ever reads. */
const GITHUB_PR = /^https:\/\/github\.com\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})$/
/** MUST CHANGE IN LOCKSTEP with pr-check.mjs FAILED: a check that ended badly. */
const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])
const SKIPPED = new Set(['SKIPPED', 'NEUTRAL'])
const NOT_LISTED = 'That pull request is not on the list. It may have been merged or closed: the list catches up within a minute.'
const NO_COPY = 'Could not read this pull request from GitHub just now. Try again in a minute, or open it on GitHub.'
const STALE = 'Could not read GitHub just now: this is the copy read before.'
const NO_DIFF = 'The changes themselves could not be read just now: only the list of files shows.'

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const list = v => (Array.isArray(v) ? v : [])
const count = v => (Number.isInteger(v) && v >= 0 ? v : 0)
const when = v => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F‎‏‪-‮⁦-⁩]/g
const OVERRIDE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‎‏‪-‮⁦-⁩]/g
/** A name (title, author, branch, path): one line, no invisible or direction-changing character, cut. */
const name = (v, max) => (typeof v === 'string' ? v.replace(INVISIBLE, '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '')
/** Running text (description, comment): kept as written, the invisible tricks out, cut and said so. */
function prose(v, max) {
  const s = typeof v === 'string' ? v.replace(INVISIBLE, '') : ''
  return s.length > max ? { text: s.slice(0, max), cut: true } : { text: s, cut: false }
}
/** One line of a patch: an override shown as a visible mark (code under review must look as it IS), and cut. */
function patchLine(l) {
  const s = l.replace(/\r$/, '').replace(OVERRIDE, c => `[U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}]`)
  return s.length > CAPS.line ? `${s.slice(0, CAPS.line)}…` : s
}
const login = a => (isObject(a) ? name(a.login || a.name || a.slug, 40) : '')

/** The checks: counts, the desktop's word (pr-check.mjs checksOf), a plain summary, each failing or running one by name. */
export function checksView(rollup) {
  const counts = { passed: 0, failing: 0, running: 0, skipped: 0 }
  const named = []
  for (const c of list(rollup)) {
    if (!isObject(c)) continue
    const word = String(c.conclusion || c.state || '').toUpperCase()
    const done = c.__typename === 'StatusContext' ? !['PENDING', 'EXPECTED'].includes(word) : String(c.status || '').toUpperCase() === 'COMPLETED'
    const state = FAILED.has(word) ? 'failing' : !done ? 'running' : SKIPPED.has(word) ? 'skipped' : 'passed'
    counts[state]++
    if (state === 'failing' || state === 'running') named.push({ name: name(c.name || c.context || c.workflowName, 100) || 'A check', state })
  }
  const desk = checksOf(list(rollup).filter(isObject))
  const summary = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'No checks.'
  named.sort((a, b) => (a.state === b.state ? 0 : a.state === 'failing' ? -1 : 1))
  return { word: desk === 'pending' ? 'running' : desk, counts, summary, list: named.slice(0, CAPS.checks), more: Math.max(0, named.length - CAPS.checks) }
}

/** The review: GitHub's decision in a word, who is asked, and each reviewer's LATEST approve or changes-asked. */
export function reviewView(j) {
  const decision = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', REVIEW_REQUIRED: 'required' }[String(j?.reviewDecision || '').toUpperCase()] || 'none'
  const latest = new Map()
  const reviews = list(j?.reviews).filter(isObject).sort((a, b) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || '')))
  for (const r of reviews) {
    const who = login(r.author)
    const state = String(r.state || '').toUpperCase()
    if (who && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(state)) latest.set(who, state)
  }
  const by = state => [...latest].filter(([, s]) => s === state).map(([w]) => w).slice(0, CAPS.names)
  return { decision, requested: list(j?.reviewRequests).map(login).filter(Boolean).slice(0, CAPS.names), approvedBy: by('APPROVED'), changesBy: by('CHANGES_REQUESTED') }
}

/** `gh pr diff` cut into files: path -> { lines (from the first @@ on), binary }. */
export function patchesOf(diff) {
  const out = new Map()
  let cur = null
  const put = () => {
    if (!cur) return
    const p = cur.to || cur.from || cur.guess
    if (p) out.set(p, { lines: cur.lines, binary: cur.binary })
  }
  for (const l of String(diff || '').split('\n')) {
    if (l.startsWith('diff --git ')) {
      put()
      // `diff --git a/<p> b/<p>`: the path when both halves agree (a name with a space in it included)
      const rest = l.slice(13)
      const half = (rest.length - 3) / 2
      cur = { lines: [], binary: false, to: '', from: '', guess: Number.isInteger(half) && rest.slice(half, half + 3) === ' b/' && rest.slice(0, half) === rest.slice(half + 3) ? rest.slice(0, half) : '', inHunk: false }
      continue
    }
    if (!cur) continue
    if (!cur.inHunk) {
      if (l.startsWith('+++ b/')) cur.to = l.slice(6).replace(/\r$/, '')
      else if (l.startsWith('--- a/')) cur.from = l.slice(6).replace(/\r$/, '')
      else if (l.startsWith('rename to ')) cur.to = l.slice(10).replace(/\r$/, '')
      else if (l.startsWith('Binary files ')) cur.binary = true
      else if (l.startsWith('@@')) cur.inHunk = true
      if (!cur.inHunk) continue
    }
    cur.lines.push(l)
  }
  put()
  return out
}

/**
 * The files list (gh's `files`, cut to CAPS.files), each with its patch: at most CAPS.fileLines lines a file and
 * CAPS.totalLines in all, in the list's order. `why` says why a file has no lines: binary, empty (a rename or a mode
 * change), later (past the total), missing (not in the diff, or the diff could not be read).
 */
export function filesView(files, patches) {
  const all = list(files).filter(isObject)
  let left = CAPS.totalLines
  let linesCut = false
  const shown = all.slice(0, CAPS.files).map(f => {
    const path = name(f.path, 300)
    const base = { path, additions: count(f.additions), deletions: count(f.deletions) }
    const p = patches?.get(path) || patches?.get(f.path)
    if (!p) return { ...base, patch: null, cut: false, why: 'missing' }
    if (p.binary) return { ...base, patch: null, cut: false, why: 'binary' }
    if (!p.lines.length) return { ...base, patch: null, cut: false, why: 'empty' }
    if (left <= 0) {
      linesCut = true
      return { ...base, patch: null, cut: false, why: 'later' }
    }
    const take = Math.min(CAPS.fileLines, left)
    left -= Math.min(take, p.lines.length)
    if (p.lines.length > take) linesCut = linesCut || take < CAPS.fileLines
    return { ...base, patch: p.lines.slice(0, take).map(patchLine), cut: p.lines.length > take, why: null }
  })
  return { list: shown, cut: all.length > CAPS.files, linesCut }
}

/** Comments and review summaries, by time, the latest CAPS.comments, newest last. */
function conversationOf(j) {
  const REVIEW = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented', DISMISSED: 'dismissed' }
  const items = [
    ...list(j.comments).filter(isObject).map(c => ({ kind: 'comment', author: login(c.author), at: when(c.createdAt), state: null, ...prose(c.body, CAPS.comment) })),
    ...list(j.reviews).filter(isObject).map(r => ({ r, state: REVIEW[String(r.state || '').toUpperCase()] || null }))
      .filter(({ r, state }) => state === 'approved' || state === 'changes' || (typeof r.body === 'string' && r.body.trim()))
      .map(({ r, state }) => ({ kind: 'review', author: login(r.author), at: when(r.submittedAt), state, ...prose(r.body, CAPS.comment) })),
  ].map((x, i) => ({ x, i })).sort((a, b) => String(a.x.at || '').localeCompare(String(b.x.at || '')) || a.i - b.i).map(({ x }) => x)
  return { items: items.slice(-CAPS.comments), total: items.length, cut: items.length > CAPS.comments }
}

const STATE = j => (String(j.state || '').toUpperCase() === 'MERGED' ? 'merged' : String(j.state || '').toUpperCase() === 'CLOSED' ? 'closed' : j.isDraft === true ? 'draft' : 'open')

/** The fixed shape from gh's two answers and the list item; `diff` null when it could not be read. */
function shapeOf(item, j, diff, checkedAt) {
  const files = filesView(j.files, diff === null ? null : patchesOf(diff))
  return {
    url: item.url, label: `${item.repo} #${item.number}`, flow: item.flow,
    title: name(j.title, 300) || name(item.title, 300) || `#${item.number}`, state: STATE(j), author: login(j.author),
    createdAt: when(j.createdAt), updatedAt: when(j.updatedAt), base: name(j.baseRefName, 100), head: name(j.headRefName, 100),
    checks: checksView(j.statusCheckRollup), review: reviewView(j), body: prose(j.body, CAPS.body),
    files: { count: count(j.changedFiles) || list(j.files).length, additions: count(j.additions), deletions: count(j.deletions), ...files },
    conversation: conversationOf(j), checkedAt,
  }
}

/** The list item a request names, re-checked, or null; see the head of this file. */
function pick(items, b) {
  if (!isObject(b) || !Array.isArray(b.keys)) return null
  const keys = new Set(b.keys)
  if (keys.size !== 1 || ![...keys].every(k => k === 'flow' || k === 'n')) return null
  const ok = items.map(p => {
    const m = isObject(p) ? GITHUB_PR.exec(String(p.url || '')) : null
    const flowId = isObject(p?.flow) && typeof p.flow.id === 'string' && SLUG.test(p.flow.id) ? p.flow.id : null
    return m && flowId ? { url: m[0], repo: `${m[1]}/${m[2]}`, number: Number(m[3]), title: p.title, flow: { id: flowId, title: name(p.flow.title, 200) } } : null
  }).filter(Boolean)
  if (keys.has('flow')) return typeof b.flow === 'string' && SLUG.test(b.flow) ? ok.find(p => p.flow.id === b.flow) || null : null
  if (typeof b.n !== 'string' || !NUMBER.test(b.n)) return null
  const found = ok.filter(p => p.number === Number(b.n))
  return new Set(found.map(p => p.url)).size === 1 ? found[0] : null
}

export function makePrReader({ gh, prs = () => [], now = Date.now, timeoutMs = TIMEOUT_MS, graceMs = GRACE_MS, listWaitMs = LIST_WAIT_MS }) {
  const copies = new Map() // url -> { value, problem, triedAt }
  const reading = new Map() // url -> the read on its way
  let active = 0
  const queue = []

  /** One gh call in one of the IN_FLIGHT places: its output, or null (failed, threw or gave up after the timeout). */
  async function call(args) {
    while (active >= IN_FLIGHT) await new Promise(resolve => queue.push(resolve))
    active++
    let freed = false
    const free = () => {
      if (freed) return
      freed = true
      active--
      queue.shift()?.()
    }
    const run = Promise.resolve().then(() => gh(args, timeoutMs)).catch(() => null)
    // the place is held while gh runs (the runner's own timeout ends the process), and never past timeout + grace
    const hold = setTimeout(free, timeoutMs + graceMs)
    run.finally(() => { clearTimeout(hold); free() })
    let timer
    const gaveUp = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) })
    try {
      const r = await Promise.race([run, gaveUp])
      return r?.ok ? String(r.out ?? '') : null
    } finally {
      clearTimeout(timer)
    }
  }

  async function fetchOne(item) {
    const target = [String(item.number), `--repo=${item.repo}`]
    const text = await call(['pr', 'view', ...target, `--json=${PR_VIEW_JSON}`])
    let j = null
    try { j = text === null ? null : JSON.parse(text) } catch { j = null }
    const old = copies.get(item.url)
    if (!isObject(j)) {
      copies.set(item.url, { value: old?.value || null, problem: old?.value ? STALE : NO_COPY, triedAt: now() })
      return
    }
    const diff = await call(['pr', 'diff', ...target, '--color=never'])
    copies.set(item.url, { value: shapeOf(item, j, diff, new Date(now()).toISOString()), problem: diff === null ? NO_DIFF : null, triedAt: now() })
  }

  const due = c => !c || now() - c.triedAt >= (c.problem ? FAIL_MS : CACHE_MS)

  async function items() {
    let timer
    try {
      const late = new Promise(resolve => { timer = setTimeout(() => resolve([]), listWaitMs) })
      const r = await Promise.race([Promise.resolve().then(prs).catch(() => []), late])
      return Array.isArray(r) ? r : []
    } finally {
      clearTimeout(timer)
    }
  }

  async function read(b) {
    const item = pick(await items(), b)
    if (!item) return { status: 404, body: { error: NOT_LISTED } }
    if (due(copies.get(item.url))) {
      if (!reading.has(item.url)) reading.set(item.url, fetchOne(item).finally(() => reading.delete(item.url)))
      await reading.get(item.url)
    }
    const c = copies.get(item.url)
    if (!c?.value) return { status: 502, body: { error: c?.problem || NO_COPY, url: item.url } }
    return { status: 200, body: { ...c.value, stale: c.problem === STALE, problem: c.problem } }
  }

  return { read }
}
