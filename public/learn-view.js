// The Learn page's markup (#/learn, learn-page.js draws it; GET /api/learn, learn-routes.mjs, gives the state):
//
//   Learn                          what it does and costs, Run Learn, the reminder when the last run is a week old
//   Verdict due · N                a rule change whose two weeks are up: before against after, one sentence, and
//                                  Keep, Revert, Wait two more weeks (nothing reverts by itself)
//   Proposals                      the newest run's: each a card with Accept, Edit then accept, Reject (a reason kept
//                                  for the next run); a settings one is text to apply by hand
//   Earlier runs                   every run kept, folded: when, what it cost, what was proposed and done
//   Rule changes · N               every rule change, newest first, with its verdict or the day it is due
//
//   PURE, for the tests: pageHtml(state, ui), proposalHtml(run, p, ui), verdictCardHtml(c, ui), changeRowHtml(c, now),
//   numberText(key, value), whenText(iso), statusLine(state, now), HELP, VERDICT_HELP
// The words a verdict uses come from the server (learn-verdicts.mjs verdictOf); this file only lays them out.
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const enc = encodeURIComponent
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const two = n => String(n).padStart(2, '0')
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  const DAY = 86_400_000

  /** `25 Nov 2026, 09:05` in local time; '' for anything that is not a time. */
  function whenText(iso) {
    const d = new Date(iso)
    if (!iso || Number.isNaN(d.getTime())) return ''
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${two(d.getHours())}:${two(d.getMinutes())}`
  }
  const dayText = iso => {
    const d = new Date(iso)
    return !iso || Number.isNaN(d.getTime()) ? '' : `${d.getDate()} ${MONTHS[d.getMonth()]}`
  }
  const usd = v => (typeof v === 'number' && Number.isFinite(v) ? `$${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}` : '')
  function duration(ms) {
    if (!Number.isFinite(ms)) return ''
    const min = Math.round(ms / 60_000)
    if (min < 1) return 'under a minute'
    const h = Math.floor(min / 60)
    const m = min % 60
    if (h >= 48) return `${Math.round(h / 24)} days`
    return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`
  }

  /** One of the four numbers as the page says it; a dash when there is none. */
  function numberText(key, v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '–'
    if (key === 'rightFirstTime') return `${Math.round(v * 100)}%`
    if (key === 'medianMs') return duration(v)
    if (key === 'costPerJob') return usd(v)
    return v.toFixed(1)
  }
  const LABEL = { rightFirstTime: 'Right first time', medianMs: 'Median time per job', costPerJob: 'Cost per job', qaFailures: 'QA failures per flow' }
  const CHANGE = { better: 'Better', worse: 'Worse', same: 'No clear change', few: 'Too few', none: 'Not known' }
  const OVERALL = { better: 'Better', worse: 'Worse', same: 'No clear change', few: 'Too few flows to tell' }

  /** What the help says about the verdict: MUST CHANGE IN LOCKSTEP with learn-verdicts.mjs VERDICT_RULES and MIN_FLOWS. */
  const VERDICT_HELP = '<p><b>How a verdict is decided.</b> When an agent rule changes, the dashboard keeps four numbers from the 14 days before: right first time, the median time per job, the estimated cost per job and QA failures per finished flow. When the verdict is due it compares them with the days since.</p>' +
    '<p>A number counts as moved when right first time changes by 10 points, the time or the cost by 20 percent, or QA failures by a quarter of a failure per flow. <b>Better</b>: at least one number got better and none got worse. <b>Worse</b>: the other way round. <b>No clear change</b>: nothing moved enough, or one got better while another got worse. <b>Too few flows to tell</b>: fewer than 3 flows finished before or after. A number with fewer than 3 flows under it is left out.</p>' +
    '<p>Nothing reverts by itself. Keep, Revert (puts back the exact text) or Wait two more weeks.</p>'
  const HELP = '<p><b>Learn</b> reads what the dashboard recorded since the last run: the pipeline score, time and token cost, the retrospective of each finished flow, and the QA, Security and Senior failure texts. It proposes at most 3 rule or settings changes, each with its evidence. Nothing changes until you accept.</p>' +
    '<p>A run uses Opus at high effort: about 11 cents on a week of 16 finished flows, more when there is more to read. A retrospective (three lines per finished flow) uses Sonnet at low effort: about 1 cent. Both show on the spend chip.</p>' +
    '<p>Settings: the <code>learn</code> block of config.json. <code>enabled</code> switches every run off, <code>autoRetro</code> the retrospective on Completed, <code>weekly</code> a run on opening this page once a week, <code>verdictAfterDays</code> when a verdict is due.</p>' + VERDICT_HELP

  /** The header chip: when Learn last ran, or that it never did. */
  function statusLine(s, now = Date.now()) {
    if (s?.running) return 'Learn is running…'
    if (!s?.lastRunAt) return 'Not run yet'
    const days = Math.floor((now - Date.parse(s.lastRunAt)) / DAY)
    return `Last run ${days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`}`
  }

  // ═══ the Run card ═══

  function runCard(s, ui, now) {
    const off = s.settings && !s.settings.enabled
    const running = s.running
      ? `<p class="ln-running" role="status"><span class="ln-dot" aria-hidden="true"></span>Learn is reading the week and writing its proposals. This takes a few minutes; you can leave this page.</p>` : ''
    const remind = !off && !s.running && s.remind ? `<p class="ln-remind">${esc(s.remind)}</p>` : ''
    const button = off ? '<p class="ln-p">Learn is switched off in config.json (<code>learn.enabled</code>).</p>'
      : `<button type="button" class="primary" data-ln-run${s.running ? ' disabled' : ''}>${s.running ? 'Running…' : 'Run Learn'}</button>`
    return `<section class="card ln-card ln-run" aria-labelledby="ln-run-h"><div class="ln-run-text"><h2 id="ln-run-h" class="ln-h">Learn from the work</h2>` +
      '<p class="ln-p">Reads the scores, QA reports and every retrospective since the last run, and proposes up to 3 rule changes. You decide on each one.</p>' +
      `${remind}${running}${ui.status ? `<p class="ln-status" role="status">${esc(ui.status)}</p>` : ''}</div><div class="ln-run-act">${button}</div></section>`
  }

  // ═══ verdicts ═══

  function rulesText(c) {
    const lines = [...(c.added || []).map(t => `<li class="ln-add"><span class="ln-sign" aria-label="added">+</span> ${esc(t)}</li>`), ...(c.removed || []).map(t => `<li class="ln-del"><span class="ln-sign" aria-label="removed">−</span> ${esc(t)}</li>`)]
    if (c.spec) lines.push(`<li class="ln-spec">The specification was ${c.spec === 'set' ? 'set' : c.spec === 'cleared' ? 'cleared' : 'changed'}.</li>`)
    return lines.length ? `<ul class="ln-rules">${lines.join('')}</ul>` : ''
  }
  const upper = t => t.charAt(0).toUpperCase() + t.slice(1)
  const byTag = c => (c.by === 'learn' ? '<span class="ln-tag">From Learn</span>' : c.by === 'master' ? '<span class="ln-tag">From a suggestion</span>' : '<span class="ln-tag ln-tag-you">Your edit</span>')

  function numbersTable(c) {
    const rows = (c.verdict?.rows || []).map(r => `<tr><th scope="row">${LABEL[r.key]}</th><td>${numberText(r.key, r.before)}</td><td>${numberText(r.key, r.after)}</td>` +
      `<td><span class="ln-chg ln-chg-${esc(r.change)}">${CHANGE[r.change] || ''}</span></td></tr>`).join('')
    const b = c.baseline?.finished ?? 0
    const a = c.after?.finished ?? 0
    return `<div class="ln-table-wrap"><table class="ln-table"><caption class="ln-sr">Before against after for ${esc(c.label)}</caption>` +
      `<thead><tr><th scope="col">Number</th><th scope="col">14 days before <span class="faint">· ${plural(b, 'flow')}</span></th><th scope="col">Since <span class="faint">· ${plural(a, 'flow')}</span></th><th scope="col">Change</th></tr></thead><tbody>${rows}</tbody></table></div>`
  }

  /** A Verdict due card: what changed, the numbers, the sentence, and the three choices. */
  function verdictCardHtml(c, ui = {}) {
    const busy = ui.busy === `change:${c.id}`
    const word = c.verdict?.overall || 'few'
    return `<li class="card ln-card ln-verdict" data-ln-change="${esc(c.id)}"><div class="ln-card-head"><h3 class="ln-h3">${esc(c.label)}: a rule change from ${esc(dayText(c.at))}</h3>${byTag(c)}</div>` +
      rulesText(c) + numbersTable(c) +
      `<p class="ln-sentence ln-overall-${esc(word)}"><b>${OVERALL[word]}.</b> ${esc(upper(String(c.verdict?.sentence || '').replace(/^[^:]*:\s*/, '')))}</p>` +
      (c.backfilled ? '<p class="ln-note">This change was made before verdicts were kept, so its 14 days before were worked out later from the stored flows.</p>' : '') +
      `<div class="ln-acts"><button type="button" data-ln-decide="keep" data-ln-id="${esc(c.id)}"${busy ? ' disabled' : ''}>Keep</button>` +
      `<button type="button" data-ln-decide="revert" data-ln-id="${esc(c.id)}"${busy ? ' disabled' : ''}>Revert</button>` +
      `<button type="button" class="link" data-ln-decide="wait" data-ln-id="${esc(c.id)}"${busy ? ' disabled' : ''}>Wait two more weeks</button></div>` +
      (ui.errors?.[`change:${c.id}`] ? `<p class="ln-error" role="alert">${esc(ui.errors[`change:${c.id}`])}</p>` : '') + '</li>'
  }

  /** One row of Rule changes: when, whose, what, and its verdict or the day it is due. */
  function changeRowHtml(c, now = Date.now()) {
    const what = [...(c.added || []).map(t => `+ ${t}`), ...(c.removed || []).map(t => `− ${t}`), ...(c.spec ? [`specification ${c.spec}`] : [])].join('; ')
    const state = c.state === 'kept' ? `Kept · ${OVERALL[c.verdict?.overall] || ''}` : c.state === 'reverted' ? `Reverted · ${OVERALL[c.verdict?.overall] || ''}`
      : c.due ? 'Verdict due now' : `Verdict due ${dayText(c.dueAt)}`
    return `<li class="ln-row"><span class="ln-row-when">${esc(dayText(c.at))}</span><span class="ln-row-who">${esc(c.label)} ${c.by === 'learn' ? '<span class="ln-tag">Learn</span>' : c.by === 'master' ? '<span class="ln-tag">Suggestion</span>' : ''}</span>` +
      `<span class="ln-row-what" title="${esc(what)}">${esc(what || 'saved')}</span><span class="ln-row-state ln-state-${esc(c.due && c.state === 'waiting' ? 'due' : c.state)}">${esc(state)}</span></li>`
  }

  // ═══ proposals ═══

  const ACTION = { add: 'Add a rule to', change: 'Change a rule of', remove: 'Remove a rule from' }

  /** One proposal card: what it changes, the evidence, and Accept, Edit then accept, Reject; or what was done. */
  function proposalHtml(run, p, ui = {}) {
    const key = `${run.id}:${p.n}`
    const settings = p.target === 'settings'
    const head = settings ? 'A settings change, to apply by hand' : `${ACTION[p.action] || 'Change'} ${esc(p.target)}`
    const flows = (p.flows || []).map(id => `<a class="ln-flow" href="#/flows?flow=${enc(id)}">${esc(id)}</a>`).join(', ')
    const editing = ui.editing === key
    const rejecting = ui.rejecting === key
    const busy = ui.busy === `p:${key}`
    let foot
    if (p.state === 'accepted') foot = `<p class="ln-done ln-done-ok">Accepted ${esc(dayText(p.decidedAt))}.${p.note ? ` ${esc(p.note)}` : ''}</p>`
    else if (p.state === 'rejected') foot = `<p class="ln-done">Rejected ${esc(dayText(p.decidedAt))}.${p.reason ? ` Reason: ${esc(p.reason)}` : ''}</p>`
    else if (editing) {
      foot = `<form class="ln-form" data-ln-edit-form="${esc(key)}"><label for="ln-edit-${esc(key)}">The rule as it will be saved</label>` +
        `<textarea id="ln-edit-${esc(key)}" class="set-input" rows="3" maxlength="300">${esc(ui.drafts?.[key] ?? p.rule)}</textarea>` +
        `<div class="ln-acts"><button type="submit" class="primary"${busy ? ' disabled' : ''}>Save and accept</button><button type="button" data-ln-cancel>Cancel</button></div></form>`
    } else if (rejecting) {
      foot = `<form class="ln-form" data-ln-reject-form="${esc(key)}"><label for="ln-why-${esc(key)}">Why not? <span class="faint">(optional: the next run reads it, so the idea is not proposed again)</span></label>` +
        `<input id="ln-why-${esc(key)}" class="set-input" maxlength="300" autocomplete="off" value="${esc(ui.drafts?.[`why:${key}`] ?? '')}">` +
        `<div class="ln-acts"><button type="submit"${busy ? ' disabled' : ''}>Reject</button><button type="button" data-ln-cancel>Cancel</button></div></form>`
    } else {
      foot = `<div class="ln-acts"><button type="button" class="primary" data-ln-accept="${esc(key)}"${busy ? ' disabled' : ''}>${settings ? 'Accept, I will apply it' : 'Accept'}</button>` +
        (settings || p.action === 'remove' ? '' : `<button type="button" data-ln-edit="${esc(key)}"${busy ? ' disabled' : ''}>Edit then accept</button>`) +
        `<button type="button" class="link" data-ln-reject="${esc(key)}"${busy ? ' disabled' : ''}>Reject</button></div>`
    }
    const err = ui.errors?.[`p:${key}`] ? `<p class="ln-error" role="alert">${esc(ui.errors[`p:${key}`])}</p>` : ''
    return `<li class="card ln-card ln-prop ln-prop-${esc(p.state)}" data-ln-prop="${esc(key)}"><div class="ln-card-head"><h3 class="ln-h3">${head}</h3>${settings ? '<span class="ln-tag ln-tag-you">Settings</span>' : ''}</div>` +
      (p.action !== 'add' && p.old ? `<p class="ln-old"><span class="faint">${p.action === 'remove' ? 'Remove' : 'Now'}:</span> ${esc(p.old)}</p>` : '') +
      (p.action !== 'remove' ? `<p class="ln-rule">${esc(p.state === 'accepted' && p.text ? p.text : p.rule)}</p>` : '') +
      `<dl class="ln-why"><dt>Evidence</dt><dd>${esc(p.evidence)}${flows ? ` <span class="ln-flows">Flows: ${flows}</span>` : ''}</dd>` +
      `<dt>Expected effect</dt><dd>${esc(p.effect)}</dd><dt>How to tell in two weeks</dt><dd>${esc(p.check)}</dd></dl>${foot}${err}</li>`
  }

  function runMeta(run) {
    const parts = [whenText(run.at), usd(run.cost), run.window ? `covers ${dayText(run.window.from)} to ${dayText(run.window.to)}${run.window.widened ? ' (widened: few flows finished)' : ''}` : ''].filter(Boolean)
    return `<p class="ln-meta">${esc(parts.join(' · '))}</p>${run.read ? `<p class="ln-meta">${esc(run.read)}</p>` : ''}${run.left ? `<p class="ln-meta ln-left">${esc(run.left)}</p>` : ''}`
  }

  function runBody(run, ui) {
    if (!run.ok) return `<p class="ln-error">${esc(run.error || 'The run stopped before it finished.')}</p>`
    const props = run.proposals || []
    const nothing = !props.length ? `<div class="card ln-card ln-nothing"><p class="ln-p"><b>Nothing worth changing.</b> ${esc(run.nothing || '')}</p></div>` : ''
    const dropped = (run.dropped || []).length
      ? `<details class="ln-dropped"><summary>${plural(run.dropped.length, 'idea was', 'ideas were')} thrown away by the checks</summary><ul>${run.dropped.map(d => `<li>${esc(d.why)}</li>`).join('')}</ul></details>` : ''
    return `${nothing}${props.length ? `<ul class="ln-list">${props.map(p => proposalHtml(run, p, ui)).join('')}</ul>` : ''}${dropped}`
  }

  // ═══ the page ═══

  function pageHtml(s, ui = {}, now = Date.now()) {
    const due = s.verdicts?.due || []
    const changes = s.verdicts?.changes || []
    const runs = s.runs || []
    const [latest, ...earlier] = runs
    const verdictSec = due.length
      ? `<section class="ln-sec" aria-labelledby="ln-due-h"><h2 id="ln-due-h" class="ln-h">Verdict due <span class="faint">· ${due.length}</span></h2><ul class="ln-list">${due.map(c => verdictCardHtml(c, ui)).join('')}</ul></section>` : ''
    const propSec = latest
      ? `<section class="ln-sec" aria-labelledby="ln-prop-h"><h2 id="ln-prop-h" class="ln-h">Proposals</h2>${runMeta(latest)}${runBody(latest, ui)}</section>`
      : '<section class="ln-sec" aria-labelledby="ln-prop-h"><h2 id="ln-prop-h" class="ln-h">Proposals</h2><div class="card ln-card"><p class="ln-p">No run yet. Run Learn to get its first proposals.</p></div></section>'
    const earlierSec = earlier.length
      ? `<section class="ln-sec" aria-labelledby="ln-earlier-h"><h2 id="ln-earlier-h" class="ln-h">Earlier runs <span class="faint">· ${earlier.length}</span></h2>` +
        earlier.map(r => `<details class="card ln-card ln-earlier" data-ln-run-id="${esc(r.id)}"${ui.openRun === r.id ? ' open' : ''}><summary><span>${esc(whenText(r.at))}</span>` +
          `<span class="faint">${esc([usd(r.cost), r.ok ? plural((r.proposals || []).length, 'proposal') : 'failed'].filter(Boolean).join(' · '))}</span></summary>${runMeta(r)}${runBody(r, ui)}</details>`).join('') + '</section>' : ''
    const changeSec = `<section class="ln-sec" aria-labelledby="ln-changes-h"><h2 id="ln-changes-h" class="ln-h">Rule changes <span class="faint">· ${changes.length}</span></h2>` +
      (s.verdicts?.error ? `<p class="ln-error">${esc(s.verdicts.error)}</p>` : '') +
      (changes.length ? `<ul class="card ln-rows">${changes.map(c => changeRowHtml(c, now)).join('')}</ul>` : '<div class="card ln-card"><p class="ln-p">No rule has changed yet. Every change made on the Agents page, or accepted here, gets a verdict two weeks later.</p></div>') + '</section>'
    return `<div class="ln-page">${runCard(s, ui, now)}${verdictSec}${propSec}${earlierSec}${changeSec}</div>`
  }

  /** The line Run Learn shows while its run goes on. */
  const STARTED = 'Learn started. Its proposals show here when it is done.'
  /** The status line after a load: the started line goes once the run that was running has finished (QA, 2026-11-26). */
  const statusAfter = (status, wasRunning, running) => (status === STARTED && wasRunning && !running ? '' : status)

  window.LearnView = { STARTED, statusAfter, pageHtml, proposalHtml, verdictCardHtml, changeRowHtml, numberText, whenText, statusLine, HELP, VERDICT_HELP }
})()
