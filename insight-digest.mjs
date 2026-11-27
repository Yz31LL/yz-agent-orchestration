// The digest in words: what `node tools/factory.mjs orchestration` prints for the coordinator to read in one go,
// at the start of a session, before planning work, and whenever the dashboard says something changed.
//
//   renderDigest({ at, by, inbox, sections, only })   plain text: the inbox lines, then the six parts under stable
//                                                     headings, each cut to its share of DIGEST_MAX characters
//   SECTION_NAMES                                     pipeline, work, numbers, signals, health, suggestions
//
// THE SHAPE, for an agent to read every time (the brief: enough to plan from, short enough to read each session):
// - The first lines say what changed: `N new since you last read` with those items (insight-inbox.mjs).
// - Each part starts with `== NAME ==` on its own line, always in the same order, so a reader (or a grep) finds it.
// - Each part has a budget (BUDGET); what does not fit ends with `… N more lines: --section <name> shows all of it`.
//   `only` (--section) prints that one part in full: no budget, and no line cut short (each part's lines take the
//   cutter as `cut`: whole in --section, cutTo in the full digest; QA, 2026-11-27: Health lines were cut even there).
// - The full digest cuts each Health line to 200 characters, except the paid ticket refresh: its line carries the
//   cost AND the real error after it, so it gets REFRESH_LINE (the error is what to act on).
// - A part whose source failed says `Left out: <why>` and nothing else: never a guessed figure. A part that is there
//   but missing a piece lists that piece as `Left out: …` at its end.
// ⚠️ PURE: words only. The data comes from insight-sections.mjs and the watchdog's view (heal-runner.mjs).

import { durationText, tokensText, usdText } from './predict-words.mjs'

export const SECTION_NAMES = Object.freeze(['pipeline', 'work', 'numbers', 'signals', 'health', 'suggestions'])
export const DIGEST_MAX = 12_000
/** Each part's share of DIGEST_MAX, in characters; together with the head they stay under it. */
export const BUDGET = Object.freeze({ inbox: 1200, pipeline: 1400, work: 2600, numbers: 1700, signals: 1800, health: 1400, suggestions: 1200 })
const TITLE = { pipeline: 'PIPELINE', work: 'WORK', numbers: 'NUMBERS', signals: 'SIGNALS', health: 'HEALTH', suggestions: 'SUGGESTIONS' }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = n => String(n).padStart(2, '0')
const when = iso => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${d.getDate()} ${MONTHS[d.getMonth()]} ${two(d.getHours())}:${two(d.getMinutes())}`
}
const pct = v => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : 'no data')
const age = ms => (Number.isFinite(ms) ? durationText(ms) : 'age not known')
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const cutTo = (s, n = 110) => {
  const t = oneLine(s)
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}
/** --section: every line whole (still one line). */
const whole = s => oneLine(s)
/** The refresh check's line in the full digest: its sentence, its cost, and the real error (heal-checks.mjs cuts that at 200). */
const REFRESH_LINE = 520

/** Lines cut to `budget` characters; the last line says how many more there are and how to see them. */
export function fit(lines, budget, name) {
  if (budget == null) return lines
  const out = []
  let used = 0
  for (let i = 0; i < lines.length; i++) {
    const cost = lines[i].length + 1
    if (used + cost > budget - 70) {
      out.push(`… ${plural(lines.length - i, 'more line')}: --section ${name} shows all of it.`)
      return out
    }
    out.push(lines[i])
    used += cost
  }
  return out
}

// ═══ the parts ═══

function pipelineLines(d, cut = cutTo) {
  const nodes = d.boxes || []
  const route = []
  for (const b of nodes) {
    if (b.role === 'chat') continue
    const prev = route.at(-1)
    if (b.role === 'producer' && prev?.producer) prev.labels.push(b.label)
    else route.push({ producer: b.role === 'producer', labels: [b.label] })
  }
  const lines = [`Route: ${route.map(r => r.labels.join(' | ')).join(' > ')}`]
  const chat = nodes.find(b => b.role === 'chat')
  if (chat) lines.push(`Beside it: ${chat.label}, the chat agent (answers, explains and reviews; changes no code).`)
  for (const b of nodes.filter(x => x.kind === 'agent')) {
    const parts = [b.state ?? 'state left out']
    parts.push(b.model ? `set to ${b.model}${b.effort ? ` ${b.effort}` : ''}${b.fixed ? ' (fixed for this role)' : ''}` : 'no model set (its session decides)')
    if (b.ranOn && b.ranOn !== b.model) parts.push(`last reply on ${b.ranOn}`)
    if (Array.isArray(b.subagents) && b.subagents.length) parts.push(`${plural(b.subagents.length, 'subagent')} running: ${b.subagents.slice(0, 3).map(s => cut(s, 40)).join('; ')}`)
    lines.push(`${b.label} (${b.role}): ${parts.join(' · ')}`)
  }
  return lines
}

function workLines(d, cut = cutTo) {
  const lines = [`Open flows: ${d.open}${d.open ? ', by where they stand, the longest there first:' : '.'}`]
  for (const g of d.byStage || []) {
    lines.push(`  ${g.where}: ${g.flows.map(f => `${f.id} (${age(f.ageMs)})`).join(', ')}`)
  }
  const w = d.waiting || {}
  const n = k => (w[k] || []).length
  lines.push(`Waiting on the user: ${plural(n('asks'), 'question')}, ${plural(n('hand'), 'by-hand task')}, ${plural(n('blocked'), 'blocked flow')}, ${plural(w.signoff?.count || 0, 'output')} to sign off${w.signoff?.overdue ? ` (${w.signoff.overdue} overdue)` : ''}.`)
  for (const a of w.asks || []) lines.push(`  Question on ${a.id} (${age(a.ageMs)}): ${cut(a.text)}`)
  for (const h of w.hand || []) lines.push(`  By hand on ${h.id} (${age(h.ageMs)}): ${cut(h.text)}`)
  for (const b of w.blocked || []) lines.push(`  Blocked: ${b.id} (${age(b.ageMs)}): ${cut(b.text)}`)
  if (d.stopped?.length) {
    lines.push(`Stopped by a gate (only the user moves these on): ${d.stopped.length}`)
    for (const s of d.stopped) lines.push(`  ${s.id}: stopped by ${s.by} (${age(s.ageMs)} ago)${s.agent ? `, producer ${s.agent}` : ''}`)
  } else lines.push('Stopped by a gate: none.')
  if (Array.isArray(d.prs)) {
    lines.push(`Open pull requests: ${d.prs.length}${d.prs.length ? '' : '.'}`)
    for (const p of d.prs) lines.push(`  ${p.label || 'a pull request'} ${cut(p.title, 70)} · checks ${p.checks || 'not known'}${p.needs ? ` · needs ${p.needs}` : ''}${p.draft ? ' · draft' : ''}${p.flow ? ` · flow ${p.flow}` : ''}`)
  }
  return lines
}

function numbersLines(d, cut = cutTo) {
  const lines = []
  for (const p of d.periods || []) {
    const a = p.now
    const b = p.before
    const tag = `(${p.days} days; before = the ${p.days} days before that)`
    const before = (v, fmt) => ` (before ${fmt(v)})`
    const dur = v => (Number.isFinite(v) ? durationText(v) : 'no data')
    lines.push(`Score ${tag}: precision ${pct(a.score.precision)}${before(b.score.precision, pct)}, recall ${pct(a.score.recall)}${before(b.score.recall, pct)}, right first time ${pct(a.score.rightFirstTime)} of ${plural(a.score.judged, 'judged flow')}${before(b.score.rightFirstTime, pct)}.`)
    const stages = a.time.stages.length ? `; longest stages: ${a.time.stages.map(s => `${s.label} ${durationText(s.medianMs)}`).join(', ')}` : ''
    lines.push(`Time (${p.days} days): ${a.time.finished} finished${before(b.time.finished, String)}, ${Number.isFinite(a.time.perDay) ? `${a.time.perDay.toFixed(1)} a day` : 'no rate yet'}, median ${dur(a.time.medianMs)} a job${before(b.time.medianMs, dur)}, ${pct(a.time.waitShare)} of it waiting${stages}.`)
    if (a.tokens) {
      const usd = v => (Number.isFinite(v) ? `about ${usdText(v)}` : 'no price')
      const top = a.tokens.agents.map(x => `${x.label} ${Number.isFinite(x.usd) ? usdText(x.usd) : tokensText(x.all)}`).join(', ')
      lines.push(`Tokens (${p.days} days): ${tokensText(a.tokens.all) || '0'}, ${usd(a.tokens.usd)}${before(b.tokens?.usd ?? null, usd)}, ${pct(a.tokens.cacheShare)} read from cache${Number.isFinite(a.tokens.perJobUsd) ? `, ${usdText(a.tokens.perJobUsd)} a finished job` : ''}${top ? `; most: ${top}` : ''}.`)
    }
  }
  return lines
}

function signalsLines(d, cut = cutTo) {
  const lines = []
  if (d.alerts) {
    lines.push(`Alerts: ${d.alerts.count}${d.alerts.count ? ` (${d.alerts.kinds})` : ''}${d.alerts.hidden ? `, ${d.alerts.hidden} dismissed today` : ''}${d.alerts.building ? '; token alerts wait for the index' : ''}.`)
    for (const l of d.alerts.lines.slice(0, 5)) lines.push(`  ${cut(l, 150)}`)
  }
  if (d.misses?.length) {
    lines.push(`Estimate misses this week: ${d.misses.length}`)
    for (const m of d.misses) lines.push(`  ${cut(m, 150)}`)
  } else lines.push('Estimate misses this week: none.')
  if (d.lessons?.length) lines.push(`Lessons hit most: ${d.lessons.map(l => `"${cut(l.text, 80)}" (${l.count}, ${l.area})`).join('; ')}`)
  if (d.learn) {
    const ps = d.learn.proposals
    lines.push(`Learn last ran ${when(d.learn.at)}${d.learn.ok ? '' : `, and failed: ${cut(d.learn.error, 80)}`}${ps.length ? `: ${plural(ps.length, 'proposal')}` : ': no proposals'}.`)
    for (const p of ps) lines.push(`  ${p.state}: ${p.target} ${p.action} "${cut(p.rule, 90)}"${p.reason ? `; the reason: ${cut(p.reason, 80)}` : ''}`)
  } else lines.push('Learn has not run yet.')
  if (d.due?.length) {
    lines.push(`Rule changes with a verdict due (the user decides on the Learn page): ${d.due.length}`)
    for (const c of d.due) lines.push(`  ${c.label}${c.by === 'learn' ? ' (from Learn)' : c.by === 'master' ? ' (from your suggestion)' : ''}: ${[...c.added.map(r => `+ ${cut(r, 70)}`), ...c.removed.map(r => `- ${cut(r, 70)}`)].join(' ') || 'the specification changed'}`)
  } else lines.push('Rule changes with a verdict due: none.')
  const r = d.routing
  if (r?.recorded) {
    const side = (s, word) => `${word} ${plural(s.flows, 'flow')}, right first time ${pct(s.firstTime)}${s.judged ? ` of ${s.judged}` : ''}`
    const unknown = r.recorded - r.followed.flows - r.notFollowed.flows
    lines.push(`Routing suggestions: ${side(r.followed, 'followed')}; ${side(r.notFollowed, 'not followed')} (${plural(r.recorded, 'finished flow')} recorded${unknown ? `, ${unknown} from before routing kept a record` : ''}).`)
  } else lines.push('Routing suggestions: no finished flow recorded yet.')
  return lines
}

const STATE_WORD = { ok: 'ok', degraded: 'DEGRADED', failing: 'FAILING', off: 'off' }
function healthLines(d, cut = cutTo) {
  if (!d) return []
  const lines = []
  if (!d.enabled) lines.push('The watchdog is off (config healing.enabled false): nothing is checked.')
  else if (!d.repairs) lines.push('Repairs are off (config healing.repairs false): the watchdog only reports.')
  if (d.seenAt) lines.push(`As the watchdog last saw it, ${when(d.seenAt)}${d.stale ? ' (no running dashboard answered this read)' : ''}:`)
  const checks = Array.isArray(d.checks) ? d.checks : []
  const worst = [...checks].sort((a, b) => rank(b.state) - rank(a.state))
  for (const c of worst) {
    lines.push(`${STATE_WORD[c.state] || c.state}: ${c.name}${c.state === 'ok' || c.state === 'off' ? '' : `: ${cut(c.text, c.id === 'refresh' ? REFRESH_LINE : 200)}`}`)
  }
  const repairs = Array.isArray(d.repairs24h) ? d.repairs24h : []
  lines.push(repairs.length ? `Repairs in the last 24 hours: ${repairs.length}` : 'Repairs in the last 24 hours: none.')
  for (const r of repairs.slice(0, 6)) lines.push(`  ${when(r.at)} ${r.name}: ${cut(r.did, 120)} (${r.result})`)
  lines.push('The watchdog owns these repairs: do not repair them yourself; suggest a change instead.')
  return lines
}
const rank = s => ({ failing: 3, degraded: 2, ok: 1, off: 0 })[s] ?? 0

function suggestionsLines(d, cut = cutTo) {
  const lines = []
  if (d.broken) lines.push('The suggestions file is damaged: tell the user. The Health page keeps a copy.')
  lines.push(`Your suggestions: ${d.counts.open} open, ${d.counts.accepted} accepted, ${d.counts.rejected} rejected, ${d.counts.done} done.`)
  for (const s of d.open) lines.push(`  open ${s.id} (${s.kind}${s.target ? `, ${s.target}` : ''}): ${cut(s.text)}`)
  if (d.decided.length) lines.push(`Decided since your last read: ${d.decided.length}`)
  for (const s of d.decided) {
    const said = s.state === 'rejected' ? `rejected${s.reason ? `: ${cut(s.reason, 90)}` : ', no reason given'}` : `${s.state}${s.outcome ? `: ${cut(s.outcome, 90)}` : ''}`
    lines.push(`  ${s.id} ${said} (${cut(s.text, 80)})`)
  }
  if (d.rejected.length) {
    lines.push('Rejected, never propose these again:')
    for (const s of d.rejected) lines.push(`  ${s.id}${s.target ? ` ${s.target}` : ''}: ${cut(s.text, 90)}`)
  }
  return lines
}

const LINES = { pipeline: pipelineLines, work: workLines, numbers: numbersLines, signals: signalsLines, health: healthLines, suggestions: suggestionsLines }

/** One part in words: its heading, its lines (or the reason it is left out), its left-out pieces, cut to `budget`. */
export function sectionText(name, part, budget) {
  const head = `== ${TITLE[name]} ==`
  if (!part || part.ok === false) return [head, `Left out: ${part?.why || 'its source could not be read'}.`].join('\n')
  const body = LINES[name](part.data, budget == null ? whole : cutTo)
  const left = (part.data?.left || []).map(l => `Left out: ${l}.`)
  return [head, ...fit([...body, ...left], budget, name)].join('\n')
}

/** The inbox lines: `N new since you last read` and the newest items first. */
function inboxText(inbox, budget) {
  if (!inbox) return 'What changed since your last read is left out: the inbox could not be read.'
  const items = Array.isArray(inbox.items) ? inbox.items : []
  const since = inbox.readAt ? `since you last read (${when(inbox.readAt)})` : 'since the inbox began (you have not read it yet)'
  if (!items.length) return `Nothing new ${since}.`
  const lines = [`${items.length} new ${since}:`, ...[...items].reverse().map(i => `  ${when(i.at)} ${i.kind}: ${cutTo(i.text, 160)}`)]
  const shown = fit(lines, budget, 'inbox')
  // the inbox is no part of its own: what does not fit is the oldest, and the parts below say the same in full
  if (/more line/.test(shown.at(-1))) shown[shown.length - 1] = `  … and ${lines.length - shown.length + 1} older: the parts below have them in full.`
  return shown.join('\n')
}

/**
 * The whole digest. `sections` is { name: { ok, data } | { ok: false, why } }; `only` one part's name, in full.
 * `at` is when it was built, `by` who reads it (the read marker moves only for the coordinator: insight-inbox.mjs).
 */
export function renderDigest({ at, by = '', inbox = null, sections = {}, only = null, source = 'dashboard' }) {
  if (only) return sectionText(only, sections[only], null)
  const head = `ORCHESTRATION DIGEST · ${when(at)}${by ? ` · read by ${by}` : ''}${source === 'files' ? ' · built from the files: no running dashboard answered' : ''}`
  const parts = [head, inboxText(inbox, BUDGET.inbox), ...SECTION_NAMES.map(n => sectionText(n, sections[n], BUDGET[n]))]
  return parts.join('\n\n')
}
