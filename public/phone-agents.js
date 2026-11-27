// The phone's Agents tab (public/phone.html), PURE: the orchestration as a phone shows it, and the read-only flow
// sheet a chip opens. Each function takes plain data (GET /phone/api/orchestration, GET /phone/api/flow,
// phone-orchestration.mjs) and returns an HTML string, so the tests run it in a vm; phone-app.js fetches and binds.
//
// WHY ONE TAB, NOT A FIFTH (2026-11-26): the Now tab is folded in here. On a 360 px screen five tabs cut "Needs you"
// and the coordinator's name, and Now's one line per agent said again what the pipeline's dots say. So the tab
// opens with what Now had (what needs you, finished today), then the alerts and open pull requests, then the boxes.
//
//   view(orch, summary, nowMs)   what needs you; the alerts (count and two lines); open pull requests (links, titles
//                                only); the pipeline: each box in route order with the agent's state as a coloured dot
//                                and a word (busy, idle, no session; none for a fixed step), and the flows standing
//                                there as chips (data-ph-flow opens the sheet); other sessions; finished today
//   sheet({ loading, error, data }, ui)   the flow's title, tickets, where it stands, its route line, its open
//                                questions with the same answer buttons as Needs you (PhoneView.askCard: the
//                                existing answer action), its last QA verdict, its story, its pull request
// A pull request (the list and a flow sheet) opens as the user chose in Options (ui.prLinks, kept on the session):
// 'here', the default, is a button (data-ph-pr, the flow's id) that opens the pull request sheet (public/phone-pr.js);
// 'github' is the link to GitHub, as before. One with no flow id is always the link: the sheet is read by flow.
// ⚠️ Every value is HOSTILE (agents, tickets and transcripts wrote it): esc everywhere, and a link only to an https
// github.com address (PhoneText.isGithub), never one the data merely claims. No inline style or handler (the CSP).
;(() => {
  const S = window.PhoneState
  const X = window.PhoneText
  const esc = X.esc
  const attr = (k, v) => ` ${k}="${esc(v)}"`
  const cls = s => String(s ?? '').replace(/[^a-z0-9-]/g, '')

  const STATE_WORD = { busy: 'Busy', idle: 'Idle', none: 'No session' }
  /** A flow's route type (flow-route.mjs ROUTE_TYPES) as the user says it. */
  const KIND = { build: 'Code change', ask: 'Question', review: 'Review' }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
  const link = (url, label) => (X.isGithub(url) ? `<a class="ph-pr-link"${attr('href', url)} target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : `<span>${esc(label)}</span>`)
  const FLOW_ID = /^[a-z0-9-]{1,80}$/
  /** A pull request: the sheet here (a button), or GitHub (the link), as the user chose; `n` its number beside the title. */
  function prEntry(flowId, url, label, ui, n, inline) {
    if (ui?.prLinks === 'github' || !FLOW_ID.test(String(flowId ?? ''))) return link(url, label)
    return `<button type="button" class="ph-pr-open${inline ? ' is-inline' : ''}"${attr('data-ph-pr', flowId)}><span class="ph-pr-open-title">${esc(label)}</span>` +
      (n ? `<span class="ph-pr-open-n">#${Number(n)}</span>` : '') + '</button>'
  }

  function stateOf(state) {
    const word = STATE_WORD[state]
    return word ? `<span class="ph-state is-${state}"><span class="ph-dot" aria-hidden="true"></span>${word}</span>` : ''
  }

  function chip(f) {
    const tone = cls(f.tone)
    return `<button type="button" class="ph-chip${tone ? ` t-${tone}` : ''}"${attr('data-ph-flow', f.id)}>` +
      `<span class="ph-chip-title">${esc(f.title)}</span><span class="ph-chip-word">${esc(f.word)}</span></button>`
  }

  /** Chips a box shows before its +N more button (the server sends up to FLOWS_MAX, phone-orchestration.mjs). */
  const CHIPS = 6

  /**
   * A box: its name, its agent's state, and its flows as chips. Over CHIPS flows, the first CHIPS and a +N more
   * BUTTON that shows the rest in the box (Show fewer folds them again); flows past what the server sent are said in
   * words, `N more at the PC`. `open` is the set of box ids the user unfolded (phone-app.js st.ui.openBoxes).
   */
  function boxRow(b, open) {
    const flows = Array.isArray(b.flows) ? b.flows : []
    const kind = cls(b.kind)
    const unfolded = open.has(b.id)
    const shown = unfolded ? flows : flows.slice(0, CHIPS)
    const hidden = flows.length - shown.length
    const toggle = flows.length > CHIPS
      ? `<button type="button" class="ph-more"${attr('data-ph-box-more', b.id)} aria-expanded="${unfolded}">${unfolded ? 'Show fewer' : `+${hidden} more`}</button>`
      : ''
    const past = Number(b.more) > 0 && (unfolded || flows.length <= CHIPS) ? `<span class="ph-faint ph-more-pc">${Number(b.more)} more at the PC</span>` : ''
    return `<li class="ph-box${kind ? ` is-${kind}` : ''}${flows.length ? ' has-flows' : ''}">` +
      `<div class="ph-box-head"><span class="ph-box-name">${esc(b.label)}</span>${stateOf(b.state)}</div>` +
      (flows.length ? `<div class="ph-chips">${shown.map(chip).join('')}${toggle}${past}</div>` : '') +
      '</li>'
  }

  function alertsBlock(a) {
    if (!a) return ''
    const n = Number(a.count) || 0
    if (!n) return '<p class="ph-faint ph-alerts-none">No alerts.</p>'
    const lines = Array.isArray(a.lines) ? a.lines : []
    const rest = n - lines.length
    return '<section class="ph-alerts" aria-label="Alerts">' +
      // the count and the kinds in words, as the desktop Alerts line (one grouping for both: public/predict-group.js)
      `<p class="ph-alerts-head"><span class="ph-alert-mark" aria-hidden="true"></span>${esc(plural(n, 'alert', 'alerts'))}` +
      `${a.kinds ? `<span class="ph-faint"> · ${esc(a.kinds)}</span>` : ''}</p>` +
      `<ul class="ph-alert-lines">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` +
      (rest > 0 ? `<p class="ph-faint">${esc(`${rest} more at the PC.`)}</p>` : '') + '</section>'
  }

  function prsBlock(prs, ui) {
    const list = Array.isArray(prs) ? prs : []
    if (!list.length) return ''
    return '<h2 class="ph-h">Open pull requests</h2>' +
      `<ul class="ph-prs">${list.map(p => `<li>${prEntry(p.flow, p.url, p.title, ui, Number(p.number) || 0)}</li>`).join('')}</ul>`
  }

  function view(orch, sum, nowMs = Date.now(), ui = {}) {
    const open = new Set(Array.isArray(ui?.openBoxes) ? ui.openBoxes : [])
    const counts = sum ? S.countParts(sum.needs).map(p =>
      `<button type="button" class="ph-count"${attr('data-ph-tab', p.tab)}><span class="ph-count-n">${p.n}</span><span class="ph-count-l">${esc(p.label)}</span></button>`).join('') : ''
    const head = sum
      ? `<h1 class="ph-big">${esc(S.needsLine(sum.needs?.total))}</h1><div class="ph-counts">${counts}</div>`
      : ''
    if (!orch) return `<section class="ph-sec">${head}<p class="ph-muted ph-pad-top">Loading…</p></section>`
    const boxes = Array.isArray(orch.boxes) ? orch.boxes : []
    const others = Array.isArray(orch.others) ? orch.others : []
    return '<section class="ph-sec" aria-label="Agents">' + head + alertsBlock(orch.alerts) + prsBlock(orch.prs, ui) +
      '<h2 class="ph-h">Pipeline</h2>' +
      (orch.agentsKnown === false ? '<p class="ph-muted">Your PC is still gathering what the agents are doing. It shows here in a moment.</p>' : '') +
      `<ol class="ph-pipe">${boxes.map(b => boxRow(b, open)).join('')}</ol>` +
      (others.length ? `<h2 class="ph-h">Other sessions</h2><ul class="ph-others">${others.map(o => `<li><span class="ph-other-name">${esc(o.label)}</span>${stateOf(o.state)}</li>`).join('')}</ul>` : '') +
      (sum ? `<p class="ph-line">Finished today: <b>${Number(sum.finishedToday) || 0}</b></p>` : '') +
      `<p class="ph-faint">Updated ${esc(S.when(orch.builtAt, nowMs))}</p></section>`
  }

  function sheet(sh = {}, ui = {}) {
    const close = '<button type="button" class="link ph-sheet-close" data-ph-sheet-close>Close</button>'
    const frame = (title, body) => '<div class="ph-sheet-back" data-ph-sheet-close></div>' +
      '<section class="ph-sheet" role="dialog" aria-modal="true" aria-labelledby="phSheetTitle" tabindex="-1">' +
      // the heading takes the focus when the sheet opens (phone-app.js), so a screen reader starts at the flow's name
      `<header class="ph-sheet-head"><h2 id="phSheetTitle" class="ph-sheet-title" tabindex="-1">${esc(title)}</h2>${close}</header>` +
      `<div class="ph-sheet-body">${body}</div></section>`
    if (sh.loading && !sh.data) return frame('Flow', '<p class="ph-muted">Loading…</p>')
    if (!sh.data) return frame('Flow', `<p class="ph-muted">${esc(sh.error || 'That flow could not be read.')}</p>`)
    const f = sh.data
    // the kind of request in words; the internal route type (build, ask, review) never shows, an unknown one is left out
    const kicker = [...(Array.isArray(f.tickets) ? f.tickets : []), KIND[f.type]].filter(Boolean).join(' · ')
    const route = (Array.isArray(f.route) ? f.route : []).map(s =>
      `<li class="ph-step-${cls(s.state) || 'upcoming'}"><span>${esc(s.label)}</span></li>`).join('')
    const asks = Array.isArray(f.asks) ? f.asks : []
    const story = Array.isArray(f.story) ? f.story : []
    const qa = f.qa
      ? '<h3 class="ph-h">Last QA</h3>' +
        `<p class="ph-line">${esc([f.qa.word, f.qa.attempt ? `attempt ${f.qa.attempt}` : '', S.when(f.qa.at)].filter(Boolean).join(' · '))}</p>` +
        (f.qa.summary ? `<p class="ph-why">${esc(f.qa.summary)}</p>` : '')
      : ''
    return frame(f.title,
      (kicker ? `<p class="ph-kicker">${esc(kicker)}</p>` : '') +
      `<p class="ph-where">${esc(f.where)}</p>` +
      (route ? `<ol class="ph-route" aria-label="Its route">${route}</ol>` : '') +
      (asks.length ? `<h3 class="ph-h">${asks.length === 1 ? 'A question for you' : 'Questions for you'}</h3>${asks.map(a => window.PhoneView.askCard(a, ui)).join('')}` : '') +
      qa +
      (story.length ? `<h3 class="ph-h">Story</h3><ul class="ph-story">${story.map(l => `<li><b>${esc(l.who)}</b> ${esc(l.did)}${l.why ? ` <span class="ph-faint">${esc(l.why)}</span>` : ''}</li>`).join('')}</ul>` : '') +
      // the pull request as the PC's Pull requests list has it (phone-orchestration.mjs sheetPr): open, or a draft
      (f.pr ? `<p class="ph-line">${prEntry(f.id, f.pr.url, `${`Pull request #${Number(f.pr.number) || ''}`.trim()}${f.pr.state === 'draft' ? ', a draft' : ''}`, ui, 0, true)}</p>` : ''))
  }

  window.PhoneAgents = { view, sheet }
})()
