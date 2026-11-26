// Master's insight on the page, the PURE half: the words and the HTML, no DOM, no fetch (insight-pages.js does
// those), so test/insight-view.test.mjs runs it in a vm with a bare window.
//
//   suggestionsHtml(state, ui, now)   the Suggestions page (#/suggestions): open ones first, each a card with the
//                                     text, the evidence, kind, target and effort; Accept, Reject (an optional reason,
//                                     kept so it is not proposed again) and, for a rule for an agent, Accept and add
//                                     the rule; then the decided ones
//   healthHtml(view, ui, now)         the Health page (#/health): every check with its state, what it looks at, its
//                                     one repair (or why it only reports), its last repair, its on or off switch and
//                                     its own buttons (Resume, Release, Stop, Copy a nudge); then the repair log
//   linesHtml(summary)                the lines at the top of the Agents page: the checks not ok, grouped like the
//                                     alerts (and the paused refresh's sentence with Resume), and the open suggestions
//   homeHtml(summary)                 Home's one line
//   SUGGESTIONS_HELP, HEALTH_HELP     the help behind each page's ?
// Every value from the server goes through esc. Copy is for one person: plain words, no jargon.
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const two = n => String(n).padStart(2, '0')
  function whenText(iso) {
    const d = new Date(iso)
    return !iso || Number.isNaN(d.getTime()) ? '' : `${d.getDate()} ${MONTHS[d.getMonth()]}, ${two(d.getHours())}:${two(d.getMinutes())}`
  }
  /** How long ago, short (3m, 2h, 5d): THE one helper, Shell.ago (shell.js, loaded first); '' without it. */
  const since = (iso, now = Date.now()) => window.Shell?.ago?.(iso, now) || ''
  const dur = ms => {
    const m = Math.round(ms / 60_000)
    if (m < 60) return `${Math.max(m, 1)} min`
    const h = Math.round(m / 60)
    return h >= 48 ? `${Math.round(h / 24)} days` : `${h} h`
  }

  // ═══ Suggestions ═══

  const KIND = { rule: 'Rule', setting: 'Setting', process: 'Process', fix: 'Fix' }
  const SUGGESTIONS_HELP = '<p><b>Suggestions</b> come from Master, the coordinator. It reads the whole orchestration at the start of each session (the pipeline, the open work, the numbers, the alerts, the lessons and the watchdog) and files a suggestion when it sees something worth changing, always with its evidence.</p>' +
    '<p><b>Nothing changes until you decide.</b> Accept keeps it as a note for you or Master to act on. For a rule for one agent, <b>Accept and add the rule</b> adds it to that agent\'s rules, the same as your own edit on the Agents page, and the Learn page gives it a verdict in two weeks. The dashboard changes no setting by itself.</p>' +
    '<p><b>Reject</b> takes an optional reason. Master sees it in its next read and does not propose the same idea again. At most 10 are open at once. Your decision reaches Master in its next read of the digest: no message is sent and nothing is paid.</p>'

  function suggestionCard(s, ui, agents, now) {
    const key = s.id
    const busy = ui.busy === key
    const err = ui.errors?.[key] ? `<p class="ins-error" role="alert">${esc(ui.errors[key])}</p>` : ''
    const tags = [`<span class="ins-tag">${esc(KIND[s.kind] || s.kind)}</span>`, s.target ? `<span class="ins-tag ins-tag-quiet">${esc(s.target)}</span>` : '', s.effort ? `<span class="ins-tag ins-tag-quiet">${esc(s.effort)} effort</span>` : ''].join('')
    const head = `<div class="ins-card-head"><span class="ins-tags">${tags}</span><span class="ins-meta">${esc(s.by || 'Master')} · ${esc(since(s.at, now))}</span></div>`
    const body = `<p class="ins-text">${esc(s.text)}</p><dl class="ins-why"><dt>Evidence</dt><dd>${esc(s.why)}</dd></dl>`
    let acts = ''
    if (s.state === 'open') {
      if (ui.rejecting === key) {
        acts = `<form class="ins-form" data-ins-reject-form="${esc(key)}"><label for="ins-why-${esc(key)}">Why not? (optional: Master reads it and does not propose this again)</label>` +
          `<textarea class="set-input" id="ins-why-${esc(key)}" rows="2" maxlength="300">${esc(ui.drafts?.[key] || '')}</textarea>` +
          `<div class="ins-acts"><button type="submit" class="danger" data-ins-do="reject" data-ins-id="${esc(key)}"${busy ? ' disabled' : ''}>Reject</button><button type="button" data-ins-cancel>Cancel</button></div></form>`
      } else {
        const rule = s.kind === 'rule' && agents.includes(s.target)
        acts = `<div class="ins-acts">${rule ? `<button type="button" class="primary" data-ins-do="rule" data-ins-id="${esc(key)}"${busy ? ' disabled' : ''}>Accept and add the rule</button>` : ''}` +
          `<button type="button"${rule ? '' : ' class="primary"'} data-ins-do="accept" data-ins-id="${esc(key)}"${busy ? ' disabled' : ''} title="Keep it as a note for you or Master to act on">Accept${rule ? ' as a note' : ''}</button>` +
          `<button type="button" data-ins-reject="${esc(key)}"${busy ? ' disabled' : ''}>Reject</button></div>`
      }
    } else {
      const said = s.state === 'rejected' ? `Rejected ${esc(whenText(s.decidedAt))}${s.reason ? `: ${esc(s.reason)}` : ', with no reason given.'}`
        : s.state === 'accepted' ? `Accepted ${esc(whenText(s.decidedAt))}.${s.outcome ? ` ${esc(s.outcome)}` : ' A note for you or Master to act on.'}`
          : `Done.${s.outcome ? ` ${esc(s.outcome)}` : ''}`
      acts = `<p class="ins-done ins-done-${esc(s.state)}">${said}</p>${s.state === 'accepted' ? `<div class="ins-acts"><button type="button" data-ins-do="done" data-ins-id="${esc(key)}"${busy ? ' disabled' : ''}>Mark done</button></div>` : ''}`
    }
    return `<li class="card ins-card ins-${esc(s.state)}" data-ins-card="${esc(key)}">${head}${body}${acts}${err}</li>`
  }

  function suggestionsHtml(state, ui = {}, now = Date.now()) {
    const list = Array.isArray(state?.list) ? state.list : []
    const agents = Array.isArray(state?.agents) ? state.agents : []
    const open = list.filter(s => s.state === 'open')
    const decided = list.filter(s => s.state !== 'open')
    const broken = state?.broken ? '<div class="banner">The suggestions file is damaged (data/suggestions.json does not parse), so nothing can be decided now. The Health page keeps a copy of it.</div>' : ''
    const status = ui.status ? `<p class="ins-status" role="status">${esc(ui.status)}</p>` : ''
    const intro = '<p class="ins-p">Master suggests changes from what it reads in the dashboard, each with its evidence. Nothing changes until you decide.</p>'
    const openPart = open.length
      ? `<ul class="ins-list">${open.map(s => suggestionCard(s, ui, agents, now)).join('')}</ul>`
      : '<p class="ins-empty">No suggestion waits for you. Master files them with <code>factory.mjs suggest</code> when it sees something worth changing.</p>'
    const decidedPart = decided.length
      ? `<section class="ins-sec" aria-labelledby="ins-decided-h"><h2 class="ins-h" id="ins-decided-h">Decided · ${decided.length}</h2><ul class="ins-list">${decided.map(s => suggestionCard(s, ui, agents, now)).join('')}</ul></section>`
      : ''
    return `<div class="ins-page">${broken}${intro}${status}<section class="ins-sec" aria-labelledby="ins-open-h"><h2 class="ins-h" id="ins-open-h">Open · ${open.length}</h2>${openPart}</section>${decidedPart}</div>`
  }

  // ═══ Health ═══

  const STATE_WORD = { ok: 'OK', degraded: 'Degraded', failing: 'Failing', off: 'Off' }
  const REPORT_ONLY = {
    strays: 'Report only: a copy may be a preview someone is looking at, so only you stop one.',
    disk: 'Report only: what to keep is yours to decide; nothing is deleted.',
    config: 'Report only: config.json is yours to edit.',
    server: 'Report only: restart the dashboard if it goes on.',
    agents: 'Report only: nothing is sent to an agent from here.',
  }
  const HEALTH_HELP = '<p>The <b>watchdog</b> looks at the dashboard every minute (the process list every 10 minutes, the disk every 30) and says what it sees: <b>OK</b>, <b>Degraded</b> (something is off but work goes on) or <b>Failing</b> (something is broken, or costing money for nothing).</p>' +
    '<p>It may do only four repairs, each safe, local and reversible: pause a failing paid ticket refresh until you press Resume, hold deliveries to an agent after 3 failures until you press Release, keep a copy of a damaged store and rebuild it where it can, and start a silent background loop once more. It never runs a model, pushes, deletes your data, writes config.json or touches a repo. Everything else is reported for you.</p>' +
    '<p>Each repair is written to the log below and told to Master in its next read. Switch a check off to stop it looking. <code>healing.repairs</code> false in config.json makes the watchdog report only; <code>healing.enabled</code> false switches it off.</p>'

  function extraHtml(c, ui, now) {
    const x = c.extra || {}
    const busy = ui.busy
    if (c.id === 'refresh') {
      return (x.collections || []).filter(r => r.paused).map(r => `<div class="ins-acts"><button type="button" class="primary" data-heal-resume="${esc(r.id)}"${busy ? ' disabled' : ''}>Resume ${esc(r.name)}</button><span class="ins-meta">Resume starts its timer again. Each refresh is a paid turn.</span></div>`).join('')
    }
    if (c.id === 'deliveries') {
      return (x.held || []).map(h => `<div class="ins-acts"><button type="button" data-heal-release="${esc(h.agent)}"${busy ? ' disabled' : ''}>Release ${esc(h.agent)}</button><span class="ins-meta">${plural(h.items, 'delivery', 'deliveries')} kept. Release sends ${h.items === 1 ? 'it' : 'them'} in one paid turn.</span></div>`).join('')
    }
    if (c.id === 'strays' && (x.strays || []).length) {
      return `<ul class="ins-rows">${x.strays.map(s => `<li><span>${s.port ? `Port ${esc(s.port)}` : 'No port'} · ${esc(dur(s.ageMs))} · ${esc(s.folder || 'folder not known')}</span>` +
        (s.canStop ? `<button type="button" class="danger" data-heal-stop="${esc(s.pid)}" data-heal-started="${esc(s.startedAt || '')}"${busy ? ' disabled' : ''}>Stop</button>` : '<span class="ins-meta">Stop it in its own terminal.</span>') + '</li>').join('')}</ul>`
    }
    if (c.id === 'agents' && (x.nudges || []).length) {
      return `<div class="ins-acts">${x.nudges.map((n, i) => `<button type="button" data-heal-nudge="${i}" title="Copies a sentence to paste into that session. It sends nothing.">Copy a nudge for ${esc(n.agent)}</button>`).join('')}</div>`
    }
    // config and disk say everything in their text: their warnings and biggest items are not listed twice
    void now
    return ''
  }

  function checkCard(c, ui, now) {
    const st = c.state || 'ok'
    const sw = `<label class="ins-switch"><input type="checkbox" data-heal-switch="${esc(c.id)}"${c.on !== false ? ' checked' : ''}${ui.busy ? ' disabled' : ''}> On</label>`
    const repair = c.repair ? `<p class="ins-repair"><b>Its one repair:</b> ${esc(c.repair)}</p>` : `<p class="ins-repair">${esc(REPORT_ONLY[c.id] || 'Report only.')}</p>`
    const would = c.would ? `<p class="ins-would">Repairs are off: it would have done this, and did nothing.</p>` : ''
    const last = c.lastRepair ? `<p class="ins-last">Last repair ${esc(whenText(c.lastRepair.at))}: ${esc(c.lastRepair.did)} <span class="ins-result">(${esc(c.lastRepair.result)})</span></p>` : ''
    const err = ui.errors?.[c.id] ? `<p class="ins-error" role="alert">${esc(ui.errors[c.id])}</p>` : ''
    return `<li class="card ins-check is-${esc(st)}" data-heal-check="${esc(c.id)}"><div class="ins-card-head"><h3 class="ins-h3"><i class="ins-dot" aria-hidden="true"></i>${esc(c.name)} <span class="ins-state">${STATE_WORD[st] || esc(st)}</span></h3>${sw}</div>` +
      `<p class="ins-looks">${esc(c.looksAt)}</p><p class="ins-text">${esc(c.text)}</p>${extraHtml(c, ui, now)}${repair}${would}${last}${err}</li>`
  }

  function healthHtml(view, ui = {}, now = Date.now()) {
    if (!view) return '<div class="ins-page"><p class="ins-empty">The watchdog has not looked yet.</p></div>'
    const checks = Array.isArray(view.checks) ? view.checks : []
    const count = st => checks.filter(c => c.state === st).length
    const head = !view.enabled ? 'The watchdog is off (<code>healing.enabled</code> in config.json): nothing is checked.'
      : `${count('failing') ? `<b>${plural(count('failing'), 'check')} failing</b>, ` : ''}${count('degraded') ? `<b>${count('degraded')} degraded</b>, ` : ''}${count('ok')} OK${count('off') ? `, ${count('off')} switched off` : ''}. ` +
        (view.repairs ? 'It may do its four safe repairs.' : 'Repairs are off (<code>healing.repairs</code>): it only reports.') + (view.seenAt ? ` Last look at ${esc(whenText(view.seenAt).split(', ')[1] || '')}.` : '')
    const status = ui.status ? `<p class="ins-status" role="status">${esc(ui.status)}</p>` : ''
    const order = { failing: 0, degraded: 1, ok: 2, off: 3 }
    const sorted = [...checks].sort((a, b) => (order[a.state] ?? 4) - (order[b.state] ?? 4))
    const log = Array.isArray(view.log) ? view.log : []
    const logPart = log.length
      ? `<div class="ins-table-wrap"><table class="ins-table"><caption class="ins-sr">The watchdog's repairs and your presses, newest first</caption><thead><tr><th scope="col">When</th><th scope="col">Check</th><th scope="col">What it saw</th><th scope="col">What it did</th><th scope="col">Result</th></tr></thead><tbody>` +
        log.map(l => `<tr><td>${esc(whenText(l.at))}</td><td>${esc(l.name)}</td><td>${esc(l.saw)}</td><td>${esc(l.did)}</td><td>${esc(l.result)}</td></tr>`).join('') + '</tbody></table></div>'
      : '<p class="ins-empty">No repair yet.</p>'
    return `<div class="ins-page"><p class="ins-p ins-summary">${head}</p>${status}<ul class="ins-list ins-checks">${sorted.map(c => checkCard(c, ui, now)).join('')}</ul>` +
      `<section class="ins-sec" aria-labelledby="ins-log-h"><h2 class="ins-h" id="ins-log-h">Repair log</h2>${logPart}</section></div>`
  }

  // ═══ the lines elsewhere ═══

  /** The Agents page's lines: the checks not OK grouped like the alerts, the paused refresh with Resume, the open suggestions. */
  function linesHtml(sum) {
    const h = sum?.health
    const out = []
    if (h && h.enabled !== false && (h.failing?.length || h.degraded?.length)) {
      const kinds = [...(h.failing || []).map(c => `${c.name} failing`), ...(h.degraded || []).map(c => `${c.name} degraded`)].join(' · ')
      const paused = (h.paused || []).map(p => `<button type="button" class="link" data-heal-resume="${esc(p.id)}">Resume ${esc(p.name)}</button>`).join('')
      const lead = (h.failing || []).find(c => c.id === 'refresh')
      out.push(`<p class="pe-line ins-line is-${h.failing?.length ? 'failing' : 'degraded'}" role="status"><i class="pe-dot ins-dot" aria-hidden="true"></i><b>Health: ${h.failing?.length ? `${h.failing.length} failing` : ''}${h.failing?.length && h.degraded?.length ? ', ' : ''}${h.degraded?.length ? `${h.degraded.length} degraded` : ''}</b>` +
        `<span class="pe-kinds">${esc(lead ? lead.text : kinds)}</span><span class="pe-line-end">${paused}<a class="link" href="#/health">Open Health</a></span></p>`)
    }
    const open = Number(sum?.suggestions?.open) || 0
    if (open) out.push(`<p class="pe-line ins-line is-note" role="status"><i class="pe-dot ins-dot" aria-hidden="true"></i><b>${plural(open, 'suggestion')} from Master</b><span class="pe-kinds">${open === 1 ? 'It waits' : 'They wait'} for your decision.</span><span class="pe-line-end"><a class="link" href="#/suggestions">Open ${open === 1 ? 'it' : 'them'}</a></span></p>`)
    return out.join('')
  }

  /** Home's one line: the same counts, shorter. */
  function homeHtml(sum) {
    const h = sum?.health
    const parts = []
    if (h && h.enabled !== false && h.failing?.length) parts.push(`<a class="link" href="#/health">${plural(h.failing.length, 'health check')} failing</a>`)
    else if (h && h.enabled !== false && h.degraded?.length) parts.push(`<a class="link" href="#/health">${plural(h.degraded.length, 'health check')} degraded</a>`)
    const open = Number(sum?.suggestions?.open) || 0
    if (open) parts.push(`<a class="link" href="#/suggestions">${plural(open, 'suggestion')} from Master</a>`)
    return parts.length ? `<p class="pe-line ins-home" role="status"><i class="pe-dot ins-dot" aria-hidden="true"></i>${parts.join('<span class="ins-sep" aria-hidden="true">·</span>')}</p>` : ''
  }

  window.InsightView = { suggestionsHtml, healthHtml, linesHtml, homeHtml, whenText, SUGGESTIONS_HELP, HEALTH_HELP }
})()
