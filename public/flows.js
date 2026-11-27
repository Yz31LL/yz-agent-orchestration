// Flows (spec 5 and 7.3): the board, mounted by the Flows page (flows-page.js).
// The questions agents ask across flows are not here: they are in the Human
// review box on the Agents page (human-review.js), answered through `answer`.
//   the board  a card per open flow (flow-board.js), grouped by agent in the grid's
//              column order, a `Done` row, dropped flows behind a toggle; or, once a
//              card is clicked, that flow opened: header, then one of four views
//              behind tabs (flow-tabs.js, remembered in flows.view): Output, the
//              storyboard (flow-output.js); Explain, the slides (flow-explain-view.js);
//              Status, the rows (flow-status.js); or
//              Process, the chart (flow-chart.js) with zoom (flow-zoom.js) and the
//              node drawer (flow-drawer.js renders it, this file runs its actions,
//              for Status too). Above the views, on every tab: Do this by hand, the
//              by-hand steps as a checklist (flow-hand.js), when the flow has any or
//              Human review says it needs the user (human-review.js)
// Polls /api/flows every 15 s while the board is mounted. An opened flow
// refreshes IN PLACE: the chart keeps its scroll, the drawer is redrawn only
// when its node changed, and text typed into an answer box survives a redraw.
// gotoFlow opens a flow from anywhere: it goes to #/flows first when the board
// is not mounted (notify.js toasts, the grid hover card, Human review).
// Archive and Delete (flow-trash.js): on each card and in an opened flow's ⋯ menu.
// Under the board a quiet line links to the flow archive (#/archive,
// archive-page.js). An archived or deleted flow is left out of /api/flows, so
// one opened from the archive (or by link) is fetched on its own after each poll
// and kept (never on the board: FlowBoard.shown). It opens
// READ-ONLY: a banner says it is archived or deleted, with Restore, and every
// control that would change it is hidden (archive.css) and refused here.
;(() => {
  const $ = (s, el = document) => el.querySelector(s)
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const enc = encodeURIComponent
  const store = {
    get(k, d) { try { const v = localStorage.getItem('flows.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
    set(k, v) { try { localStorage.setItem('flows.' + k, JSON.stringify(v)) } catch {} },
  }

  const POLL_MS = 15_000
  const COLUMNS = ['Coordinator', 'Agent 1', 'Agent 2', 'Agent 3', 'Independent'] // when the grid has not loaded yet
  const FLOW_STATUS = ['open', 'blocked', 'done', 'dropped'] // MUST CHANGE IN LOCKSTEP with flows.mjs FLOW_STATUS
  const PAD = 16 // the chart scroller's padding, unscaled by the zoom
  // The opened flow's ONE ?: each Output block, the views and the proof marks (flow-head.js; spec 6: legends are never a row on the page).
  const LEGEND = window.FlowHead?.HELP || ''
  // The empty board is one line; how a flow starts is behind its ? (spec 6).
  const NO_FLOWS_HELP = '<p>A flow is the plan an agent writes as it works: steps, checks, and the asks that wait on you.</p>' +
    '<p>Agents start one with <code>node tools/factory.mjs flow write</code>. Done and dropped flows stay below the open ones.</p>'

  let board = null
  let timer = null
  let gen = 0
  let data = { flows: [], invalid: [] }
  let showDropped = false
  /** the opened flow: its id, the node in the drawer, and what was last drawn (to redraw only on change) */
  let opened = null
  /** A card whose Delete waits on the server's question: { id, message } (FlowBoard.card shows it inline) */
  let cardAsking = null
  let zoom = store.get('zoom', 1) // a number, or 'fit'
  let view = window.FlowTabs?.view.get() || 'output' // or 'status' / 'process'; `?.`: a test may load no flow-tabs.js
  let z = 1 // the scale in effect
  /** called with the data after every load (flows-page.js writes the page head from it) */
  const loaded = []

  const flowOf = id => data.flows.find(f => f.id === id)
  /** An archived or deleted flow (opened from the archive): shown, never changed. */
  const readonly = f => !!(f?.archivedAt || f?.deletedAt)
  const mounted = () => !!board

  // ═══ load and post ═══

  async function load() {
    const mine = ++gen
    try {
      const r = await fetch('/api/flows')
      let j = await r.json()
      if (!r.ok) throw new Error(j.error || r.status)
      if (mine !== gen || !mounted()) return
      if (board && opened && !j.flows.some(f => f.id === opened.id)) {
        const one = await fetchOpened() // archived or deleted: still open, read-only
        if (mine !== gen || !mounted()) return
        if (one) j = { ...j, flows: [...j.flows, one] }
      }
      data = j
      render()
      for (const fn of loaded) fn(data)
    } catch (e) {
      if (mine === gen && board && !opened) board.innerHTML = `<div class="banner">Flows: ${esc(e.message)}</div>`
    }
  }
  /**
   * The opened flow on its own, when the list left it out: the flow (an archived one, or a deleted one with its
   * `deletedAt`), or null with `opened.gone` holding why (no such flow).
   */
  async function fetchOpened() {
    const id = opened.id
    try {
      const r = await fetch(`/api/flows/${enc(id)}`)
      const j = await r.json().catch(() => ({}))
      if (opened?.id !== id) return null
      opened.gone = r.ok ? null : String(j.error || '')
      return r.ok ? j : null
    } catch {
      return null
    }
  }
  /** POST to the flow's route: { j } on success, { error } on a refusal, never thrown (the caller says it). */
  async function tryPost(flowId, action, body) {
    try {
      const r = await fetch(`/api/flows/${enc(flowId)}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      const j = await r.json().catch(() => ({}))
      return r.ok ? { j } : { error: j.error || `Failed (${r.status})`, code: j.code }
    } catch (e) {
      return { error: e.message }
    }
  }
  async function post(flowId, action, body) {
    const res = await tryPost(flowId, action, body)
    if (res.error) alert(res.error)
    return res.error ? null : res.j
  }
  /** The ONE way an ask is answered on the page: here, in an opened flow, and in the Human review box. */
  async function answer(flowId, nodeId, value, note) {
    const body = { node: nodeId, answer: value }
    if (note) body.note = note
    if (!(await post(flowId, 'answer', body))) return
    if (board) load()
    window.HumanReview?.refresh()
    window.Notifier?.poll() // the bell and the tab title count the open asks now, not 15 s later
  }
  async function deliver(flowId, nodeId) {
    const r = await post(flowId, 'deliver', { node: nodeId })
    if (r && !r.ok && r.error) alert(`Not delivered: ${r.error}`)
    load()
  }

  /** Keep what was typed (and the focus) in [data-key] fields across an innerHTML swap. */
  function keepingInputs(el, swap) {
    const vals = new Map([...el.querySelectorAll('input[data-key]')].map(i => [i.dataset.key, i.value]))
    const focus = document.activeElement?.closest?.('input[data-key]') && el.contains(document.activeElement) ? document.activeElement.dataset.key : null
    swap()
    for (const i of el.querySelectorAll('input[data-key]')) if (vals.has(i.dataset.key)) i.value = vals.get(i.dataset.key)
    if (focus) el.querySelector(`input[data-key="${CSS.escape(focus)}"]`)?.focus()
  }

  // ═══ shared bits ═══

  const envPill = env => (env ? `<span class="fl-env env-${esc(env)}">${esc(env)}</span>` : '')
  const tickets = f => (f.tickets || []).map(t => `<button type="button" class="fl-tk id" data-ticket="${esc(t)}" title="Open ${esc(t)} in the table">${esc(t)}</button>`).join('')
  const statusPill = s => `<span class="fl-status fs-${esc(s)}">${esc(s)}</span>`

  // ═══ the board ═══

  function agentOrder(agents) {
    const cols = window.OrchestrationGrid?.data?.columns?.map(c => c.label) || COLUMNS
    const known = cols.filter(a => agents.has(a))
    return [...known, ...[...agents].filter(a => !cols.includes(a)).sort((a, b) => a.localeCompare(b))]
  }
  const card = f => window.FlowBoard.card(f, { asking: cardAsking })
  const small = f => window.FlowBoard.small(f, { asking: cardAsking })
  const byNewest = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))

  function renderBoard() {
    // by route, not status: a flow still on its way is a card by its agent, even when done (QA passed, Push
    // waiting); Done holds only what reached the Output (FlowBoard.groups, never an archived one)
    const { live, done, dropped } = window.FlowBoard.groups(data.flows)
    done.sort(byNewest)
    dropped.sort(byNewest)
    const groups = agentOrder(new Set(live.map(f => f.agent))).map(a => {
      const list = live.filter(f => f.agent === a).sort(byNewest)
      return `<div class="fl-group"><h3 class="fl-group-h">${esc(a)} <span class="faint">· ${list.length}</span></h3><div class="fl-cards">${list.map(card).join('')}</div></div>`
    })
    const bad = data.invalid || []
    // The page head says `Flows · N` (flows-page.js), so the board has no title of its own.
    board.innerHTML = `<section class="fl-board">
        ${dropped.length ? `<div class="section-head fl-board-head"><button type="button" class="link fl-dropped-t" data-dropped aria-pressed="${showDropped}" title="Show the dropped flows">Show dropped</button></div>` : ''}
        ${groups.join('') || '<p class="small faint fl-none">No open flows. <button type="button" class="help" aria-label="How flows start">?</button></p>'}
        ${done.length ? `<div class="fl-group"><h3 class="fl-group-h">Done <span class="faint">· ${done.length}</span></h3><div class="fl-smalls">${done.map(small).join('')}</div></div>` : ''}
        ${showDropped && dropped.length ? `<div class="fl-group"><h3 class="fl-group-h">Dropped <span class="faint">· ${dropped.length}</span></h3><div class="fl-smalls">${dropped.map(small).join('')}</div></div>` : ''}
        ${bad.length ? `<p class="small warn">Could not read ${bad.map(b => `${esc(b.id)} (${esc((b.problems || []).join('; '))})`).join(', ')}</p>` : ''}
        ${window.FlowTrash.linksHtml(data.counts)}
      </section>`
    window.FlowBoard.fit(board) // each story line on one line, cut at a word
    window.Help.attach(board.querySelector('.fl-none .help'), NO_FLOWS_HELP)
    window.Motion.enterList(board, '.fl-card, .fl-small') // the first render with cards only, never a poll
  }

  // ═══ the opened flow ═══

  function buildOpened() {
    board.innerHTML = `<section class="card fl-open">
        <div class="fl-open-head"></div>
        <div class="flow-tools fl-tools">${window.FlowTabs.tabs(view)}<span class="fl-zoom">${window.FlowZoom.controls()}</span>
          <button type="button" class="help meta-r" aria-label="What the views and marks mean">?</button></div>
        <div class="fl-open-sub"></div>
        <div class="fl-hand" hidden></div>
        <div class="fl-quality" hidden></div>
        <div class="fl-out" id="flPanelOutput" role="tabpanel" aria-labelledby="flTabOutput"></div>
        <div class="fl-explain" id="flPanelExplain" role="tabpanel" aria-labelledby="flTabExplain"></div>
        <div class="fl-stat" id="flPanelStatus" role="tabpanel" aria-labelledby="flTabStatus"></div>
        <div class="fl-scroll" id="flPanelProcess" role="tabpanel" aria-labelledby="flTabProcess"></div>
        <div class="fl-drawer" hidden></div>
      </section>`
    const tools = $('.fl-tools', board)
    window.Help.attach($('.help', tools), LEGEND)
    const scroller = $('.fl-scroll', board)
    window.FlowZoom.attach(tools, scroller, {
      current: () => z,
      apply: (next, anchor) => { zoom = next; store.set('zoom', next); drawChart(anchor) },
      active: () => tools.isConnected && view === 'process', // no zoom keys on Output or Status
    })
    // A press that moved is a pan (flow-zoom.js), not a click.
    let down = null
    scroller.addEventListener('pointerdown', e => (down = { x: e.clientX, y: e.clientY }))
    scroller.addEventListener('click', e => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) return
      chartClick(e.target)
    })
    scroller.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('.fc-node')) { e.preventDefault(); chartClick(e.target) }
    })
  }
  function chartClick(target) {
    const f = flowOf(opened?.id)
    if (!f) return
    const retry = target.closest('[data-retry]')
    if (retry) return deliver(f.id, retry.dataset.retry)
    const ans = target.closest('.fc-ans')
    if (ans) return answer(f.id, ans.dataset.node, ans.dataset.answer)
    const g = target.closest('.fc-node')
    if (g) selectNode(opened.node === g.dataset.node ? null : g.dataset.node)
  }
  function selectNode(id) {
    opened.node = id
    opened.drawn = null
    renderOpened()
    if (id) $('.fl-drawer', board)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  /** The head (flow-head.js), in two slots so the view tabs sit on the title row; each redrawn only when it changed. */
  function renderHead(f) {
    // a refusal goes once the flow moved on (Finish without Senior, Senior passed it)
    if (opened.refused && f.status !== opened.refusedStatus) opened.refused = null
    const h = window.FlowHead.html(f, { tickets, envPill, statusPill, statuses: FLOW_STATUS, asking: opened.asking, refused: opened.refused })
    $('.fl-open', board).dataset.flow = f.id // where a word card finds its flow (term-card.js)
    if (opened.head !== h.head) { $('.fl-open-head', board).innerHTML = h.head; opened.head = h.head }
    if (opened.sub !== h.sub) { $('.fl-open-sub', board).innerHTML = h.sub; opened.sub = h.sub }
    $('.fl-open-sub [data-updated]', board).textContent = h.updated // text only: the minute ticking never redraws the sub
  }

  /** The chart at the current zoom; `anchor` (client px) stays put across a zoom change. */
  function drawChart(anchor) {
    const f = flowOf(opened?.id)
    const scroller = $('.fl-scroll', board)
    if (!f || !scroller) return
    const lay = window.FlowChart.layout(f)
    if (!lay.nodes.length) {
      // nothing to chart: say so, and where the flow's content is
      scroller.innerHTML = window.FlowChart.empty()
      return
    }
    const before = z
    const avail = scroller.clientWidth - 2 * PAD
    z = window.FlowZoom.clamp(zoom === 'fit' ? Math.min(1, avail / Math.max(1, lay.width)) : Number(zoom) || 1)
    const r = scroller.getBoundingClientRect()
    const a = anchor ? { sx: anchor.x - r.left, sy: anchor.y - r.top } : null
    const keep = a ? { x: (scroller.scrollLeft + a.sx - PAD) / before, y: (scroller.scrollTop + a.sy - PAD) / before } : { left: scroller.scrollLeft, top: scroller.scrollTop }
    // class `flow` lets flow-zoom.js pan from the chart background
    scroller.innerHTML = window.FlowChart.svg(f, lay).replace('<svg class="fc"', '<svg class="fc flow"').replace('</svg>', () => `${deliveries(f, lay)}</svg>`)
    const svg = $('svg', scroller)
    svg.setAttribute('width', String(lay.width * z))
    svg.setAttribute('height', String(lay.height * z))
    decorate(svg, f)
    if (a) { scroller.scrollLeft = keep.x * z + PAD - a.sx; scroller.scrollTop = keep.y * z + PAD - a.sy }
    else { scroller.scrollLeft = keep.left; scroller.scrollTop = keep.top }
    window.FlowZoom.show($('.fl-tools', board), z, zoom === 'fit')
  }
  /** `sent` / `not delivered · retry` / `sending…` / `not sent yet · retry` under each answered ask (FlowDrawer.deliveryState), right-aligned in the gap below it. */
  function deliveries(f, lay) {
    const box = new Map(lay.nodes.map(b => [b.id, b]))
    return f.nodes.filter(n => n.type === 'ask' && window.FlowDrawer.deliveryState(n)).map(n => {
      const b = box.get(n.id)
      const at = `x="${b.x + b.w - 10}" y="${b.y + b.h + 13}" text-anchor="end"`
      const retry = `<tspan class="fc-retry" data-retry="${esc(n.id)}">retry</tspan>`
      switch (window.FlowDrawer.deliveryState(n)) {
        case 'chat': return `<text class="fc-sent" ${at}>answered in chat</text>`
        case 'sent': return `<text class="fc-sent" ${at}>sent</text>`
        case 'failed': return `<text class="fc-undelivered" ${at}><title>${esc(n.deliveryError)}</title>not delivered · ${retry}</text>`
        case 'sending': return `<text class="fc-sending" ${at}>sending…</text>`
        default: return `<text class="fc-undelivered" ${at}><title>Still not sent after two minutes</title>not sent yet · ${retry}</text>`
      }
    }).join('')
  }
  /** What the chart markup does not carry: the verified glyph, why a node is pending, the selection, keyboard focus. */
  function decorate(svg, f) {
    const reasons = window.FlowChart.pendingReasons(f)
    for (const g of svg.querySelectorAll('.fc-node')) {
      const id = g.dataset.node
      const n = f.nodes.find(x => x.id === id)
      g.setAttribute('tabindex', '0')
      g.setAttribute('role', 'button')
      if (id === opened.node) g.classList.add('sel')
      const proof = f.derived?.proof?.[id]
      if (proof === 'verified') $('.fc-glyph', g).textContent = '✓'
      const title = $('title', g)
      const why = window.FlowChart.pendingReason(f, id, reasons)
      // the chart's own tooltip (FlowChart.tip: an ask's reason too), then why it is pending or its proof
      if (why) title.textContent = `${window.FlowChart.tip(f, n)}\n${why}`
      else if (proof) title.textContent = `${window.FlowChart.tip(f, n)}\n${proof}`
    }
  }

  function renderDrawer(f) {
    const el = $('.fl-drawer', board)
    const n = f.nodes.find(x => x.id === opened.node)
    if (!n) { el.hidden = true; el.innerHTML = ''; opened.drawn = null; return }
    const pending = window.FlowChart.pendingReason(f, n.id)
    const sig = JSON.stringify([n, pending, f.derived?.proof?.[n.id]])
    if (sig === opened.drawn) return
    opened.drawn = sig
    el.hidden = false
    keepingInputs(el, () => { el.innerHTML = window.FlowDrawer.html(f, n, pending) })
    window.FlowDrawer.fill(el)
  }

  function renderOpened() {
    const f = flowOf(opened.id)
    if (!f) {
      // deleted for good (here, in another tab, or a link to one): nothing is left to show
      board.innerHTML = `<section class="card fl-open"><div class="fl-open-head"><button type="button" class="link" data-close>← Flows</button>
        <p class="small warn">No flow ${esc(opened.id)}: it may have been deleted for good.</p></div></section>`
      opened.built = false
      return
    }
    if (!opened.built) { buildOpened(); opened.built = true; opened.head = opened.sub = opened.chart = opened.drawn = opened.ro = null; showView() }
    renderReadonly(f)
    renderHead(f)
    window.FlowHand?.fill($('.fl-hand', board), f, { needs: !!window.HumanReview?.needsHand(f.id), readonly: readonly(f) })
    window.QualityFlow?.fill($('.fl-quality', board), f) // the risk label, the self-check, the second opinion (quality-flow.js)
    window.Glossary?.autoLearn(f) // its unknown marked words, once (glossary-store.js)
    // Only the shown view draws: a hidden chart would fit to a 0 px width. Output and Status gate their own redraw.
    if (view === 'output') return window.FlowOutput.fill($('.fl-out', board), f)
    if (view === 'explain') return window.FlowExplainView.fill($('.fl-explain', board), f)
    if (view === 'status') {
      window.FlowStatus.fill($('.fl-stat', board), f)
      return window.FlowStatus.revealOnce($('.fl-stat', board), opened) // a link to a node: its row, once
    }
    const chartSig = JSON.stringify([f.nodes, f.derived, f.env, opened.node])
    if (chartSig !== opened.chart) { opened.chart = chartSig; drawChart(null) }
    renderDrawer(f)
  }
  /** An archived or deleted flow is shown, never changed: the banner above the views, and the class archive.css reads. */
  function renderReadonly(f) {
    const html = readonlyBanner(f)
    if (opened.ro === html) return
    opened.ro = html
    const box = $('.fl-open', board)
    box.classList.toggle('is-readonly', !!html)
    $('.fl-readonly', board)?.remove()
    if (html) $('.fl-open-sub', board).insertAdjacentHTML('afterend', html)
  }
  /** PURE: the read-only line for an archived or deleted flow, else ''. */
  function readonlyBanner(f) {
    if (!readonly(f)) return ''
    if (f.completedAt && window.CompletedView) return window.CompletedView.readonlyHtml(f) // Uncomplete is in the archive
    const what = f.deletedAt ? `This flow is <b>deleted</b> (${window.Shell.ago(f.deletedAt)}).` : `This flow is <b>archived</b> (${window.Shell.ago(f.archivedAt)}).`
    return `<p class="fl-readonly" role="note"><span>${what} It is in the flow archive, and nothing can be changed here.</span>` +
      `<button type="button" class="link" data-ro-restore>Restore</button><a class="link" href="#/archive">Open the flow archive</a></p>`
  }

  /** Output (the storyboard), Status (the rows) or Process (the chart and drawer), remembered in flows.view. */
  function showView() {
    for (const t of board.querySelectorAll('.fl-tabs [data-view]')) {
      t.setAttribute('aria-selected', String(t.dataset.view === view))
      t.tabIndex = t.dataset.view === view ? 0 : -1
    }
    $('.fl-zoom', board).hidden = $('.fl-scroll', board).hidden = view !== 'process'
    $('.fl-out', board).hidden = view !== 'output'
    $('.fl-explain', board).hidden = view !== 'explain'
    $('.fl-stat', board).hidden = view !== 'status'
    const drawer = $('.fl-drawer', board)
    drawer.hidden = view !== 'process' || !drawer.innerHTML
  }
  function setView(next, focus = false) {
    view = next
    window.FlowTabs.view.set(next)
    showView()
    if (focus) $(`.fl-tabs [data-view="${next}"]`, board)?.focus()
    renderOpened()
  }

  function render() {
    if (board) opened ? renderOpened() : renderBoard()
  }

  // ═══ events: one delegated listener per type on the board, bound at mount ═══

  function onSubmit(e) {
    const form = e.target.closest('form[data-text]')
    if (!form) return
    e.preventDefault()
    const value = new FormData(form).get('answer').trim()
    if (value && opened && !readonly(flowOf(opened.id))) answer(opened.id, form.dataset.text, value)
  }
  function onBoardClick(e) {
    const t = e.target.closest('[data-ticket]')
    if (t) { e.stopPropagation(); return window.FactoryView?.gotoTicket(t.dataset.ticket) }
    if (e.target.closest('[data-dropped]')) { showDropped = !showDropped; return renderBoard() }
    if (e.target.closest('[data-close]')) return close()
    const act = e.target.closest('[data-card-archive], [data-card-delete], [data-card-cancel]') // a card's own Archive and Delete
    if (act) return void cardAction(act)
    const card = e.target.closest('[data-open]')
    if (card) return open(card.dataset.open)
    const f = flowOf(opened?.id)
    if (!f) return
    if (e.target.closest('[data-ro-restore]')) return void restoreOpened(f)
    // an archived or deleted flow: the views, their tabs and links still work; nothing that would change it does
    if (readonly(f) && e.target.closest('[data-drop], [data-archive], [data-delete], [data-answer], [data-reopen], [data-retry], [data-ask-chat]')) return
    if (e.target.closest('[data-drop]')) {
      if (confirm(`Drop the flow ${f.title}? It moves behind show dropped.`)) post(f.id, 'drop').then(r => r && load())
      return
    }
    if (e.target.closest('[data-archive]')) return void window.FlowTrash.archive(f.id, !f.archivedAt)
    if (e.target.closest('[data-delete-cancel]')) { opened.asking = null; return renderOpened() }
    const del = e.target.closest('[data-delete]')
    if (del) return void deleteOpened(f, del.hasAttribute('data-confirmed'))
    if (e.target.closest('[data-drawer-close]')) return selectNode(null)
    const tab = e.target.closest('.fl-tabs [data-view]')
    if (tab) return tab.dataset.view !== view && setView(tab.dataset.view)
    const pic = e.target.closest('.fl-out [data-goto]') // a box of the chart on Output: that step's row on Status, for now (not remembered)
    if (pic) { opened.node = opened.reveal = pic.dataset.goto; view = 'status'; showView(); return renderOpened() }
    const go = e.target.closest('.fl-stat [data-goto]') // a row title on Status: that node in the chart
    if (go) {
      opened.node = go.dataset.goto // selectNode's work, under the view switch: one redraw, no rebuild
      setView('process')
      return $('.fl-drawer', board)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    // The drawer, the Status view and the Story line on Output draw the same ask controls, so ONE answer path serves them all.
    const b = e.target.closest(':is(.fl-drawer, .fl-stat, .fl-out) :is([data-answer], [data-reopen], [data-retry], [data-ask-chat])')
    if (!b) return
    const node = f.nodes.find(n => n.id === (b.dataset.node || b.dataset.reopen || b.dataset.retry || b.dataset.askChat))
    if (b.dataset.answer) answer(f.id, node.id, b.dataset.answer, b.closest('.fl-drawer, .fl-stat, .fl-out').querySelector(`[data-note="${CSS.escape(node.id)}"]`)?.value.trim())
    else if (b.dataset.reopen) answer(f.id, node.id, null)
    else if (b.dataset.retry) deliver(f.id, node.id)
    else {
      // an ask goes with the reason it was asked (FlowDrawer.reason), so the chat starts from what the page shows
      const asked = node.type === 'ask' ? ` It was asked because: ${window.FlowDrawer.reason(f, node).text}` : ''
      window.FactoryChat?.send(`In flow ${f.id}, explain step ${node.id} "${node.title}": what it does, why, and how I can verify it.${asked}`)
    }
  }
  async function onBoardChange(e) {
    const f = flowOf(opened?.id)
    if (!f || readonly(f)) return
    const el = e.target
    let r = null
    if (el.matches('[data-flow-status]')) {
      // a refusal (Senior holds the flow, say) is said inline under the menu, which goes back to the real status
      const res = await tryPost(f.id, 'status', { status: el.value })
      if (res.error) {
        el.value = f.status
        // a Senior hold says what the user can do here (the server sentence is the agent one)
        opened.refused = res.code === 'senior-hold' ? window.FlowHand.holdText(f) : res.error
        opened.refusedStatus = f.status
        opened.drawn = null
        return load()
      }
      opened.refused = null
      r = res.j
    }
    else if (el.matches('[data-node-status]')) r = await post(f.id, 'status', { node: el.dataset.nodeStatus, status: el.value })
    else if (el.matches('[data-verify]')) r = await post(f.id, 'verify', { node: el.dataset.verify, verified: el.checked })
    else return
    if (!r) {
      opened.drawn = opened.chart = null // a refused change: redraw from the server's state
      if (el.matches('.fl-stat [data-verify]')) el.checked = !el.checked // Status keeps unchanged rows, so undo the tick here
    }
    load()
  }
  function onBoardKey(e) {
    // The tabs: Left and Right move along Output, Status and Process, wrapping (the ARIA tabs pattern).
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target.closest('.fl-tabs [data-view]')) return setView(window.FlowTabs.step(view, e.key === 'ArrowRight' ? 1 : -1), true)
    if (e.key !== 'Enter' || e.target.closest('button, input, select, textarea')) return
    if (e.target.closest('.fl-out [data-goto]')) return onBoardClick(e) // a chart box is a link: Enter opens it
    const card = e.target.closest('[data-open]')
    if (card) open(card.dataset.open)
  }

  // ═══ api ═══

  /**
   * Delete from the ⋯ menu (flow-trash.js makes the call): a flow its agent may be working on gets the server's
   * question back, shown in the menu (FlowHead `asking`) until Delete or Cancel; once deleted, the flow closes.
   */
  async function deleteOpened(f, confirmed) {
    const r = await window.FlowTrash.remove(f.id, confirmed)
    if (opened?.id !== f.id) return
    opened.asking = r?.needsConfirm ? r.message : null
    // out of the data first: close() draws the board at once, and the reload that drops the card is still in flight
    if (r?.ok) { data = window.FlowTrash.without(data, f.id); return close() }
    renderOpened()
    if (opened.asking) $('.fl-open-sub [data-delete][data-confirmed]', board)?.focus() // the question's own Delete
  }
  /**
   * A card's Archive or Delete (flow-board.js draws them). Delete on a flow its agent may be working on gets the
   * server's question back, shown on that card with Delete and Cancel; anything else goes at once, with Undo.
   */
  async function cardAction(btn) {
    if (btn.hasAttribute('data-card-cancel')) { cardAsking = null; return renderBoard() }
    const id = btn.dataset.cardArchive || btn.dataset.cardDelete
    if (btn.hasAttribute('data-card-archive')) {
      if (await window.FlowTrash.archive(id, true)) { data = window.FlowTrash.without(data, id); renderBoard() }
      return
    }
    const r = await window.FlowTrash.remove(id, btn.hasAttribute('data-confirmed'))
    cardAsking = r?.needsConfirm ? { id, message: r.message } : null
    if (r?.ok) data = window.FlowTrash.without(data, id)
    if (board && !opened) renderBoard()
    if (cardAsking) board?.querySelector(`[data-card-delete="${CSS.escape(id)}"][data-confirmed]`)?.focus()
  }
  /** Restore from the read-only banner: a deleted flow comes back from Deleted, an archived one to the board. */
  async function restoreOpened(f) {
    const done = f.deletedAt ? await window.FlowTrash.restore(f.id) : await window.FlowTrash.unarchive(f.id)
    if (!done || opened?.id !== f.id) return
    data = window.FlowTrash.without(data, f.id) // fetched afresh: the restored flow, live (or archived) again
    opened.ro = null
    const one = await fetchOpened()
    if (one && opened?.id === f.id) data = { ...data, flows: [...data.flows, one] }
    render()
  }

  /** `as`: a view for this open only, not remembered (FlowsView.explain opens on Explain). */
  async function open(flowId, nodeId, as) {
    if (!board) return
    cardAsking = null
    if (!as) mark(addressOf(flowId, nodeId))
    opened = { id: flowId, node: nodeId || null, built: false, reveal: nodeId || null } // reveal: once, on Status
    view = as || window.FlowTabs.view.get()
    if (nodeId && (view === 'output' || view === 'explain')) view = 'status' // no row per node there: Status, for this open only (not remembered)
    if (!flowOf(flowId)) {
      // not in the last list (just written, archived, or deleted): fetch it on its own, then merge it in
      const f = await fetchOpened()
      if (opened?.id !== flowId) return
      if (f) data = { ...data, flows: [...data.flows.filter(x => x.id !== f.id), f] }
    }
    render()
    if (!opened?.revealed) scrollTo(board) // a revealed node row has been scrolled to already
  }
  /** Open a flow at its by-hand steps (Human review's by-hand rows, `#/flows?flow=<id>&at=hand`): the checklist in view, its heading focused. */
  async function gotoHand(flowId) {
    if (!board) {
      window.Shell.go(`#/flows?flow=${enc(flowId)}&at=hand`)
      return
    }
    await open(flowId)
    if (opened?.id !== flowId) return
    const box = $('.fl-hand', board)
    if (!box || box.hidden) return
    scrollTo(box)
    box.querySelector('.fh-h')?.focus({ preventScroll: true })
  }
  /** Scroll a box to the top, clear of the sticky page header (shell.js): measured rather than read from --header-h. */
  function scrollTo(el) {
    el.style.scrollMarginTop = `${($('#pageHead')?.offsetHeight || 0) + 16}px`
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  function close() {
    opened = null
    mark('#/flows')
    if (board) renderBoard()
  }
  /**
   * Open a flow (at a node) from any page: on #/flows straight away, else through its own address,
   * `#/flows?flow=<id>&node=<node>` (flows-page.js opens it), so the address always says which flow
   * is open. Without a flow (a summary toast), what waits on the user: the Human review box on the
   * Agents page (human-review.js). `as` (a view for this open only) cannot ride on the address.
   */
  function gotoFlow(flowId, nodeId, as) {
    if (!flowId) return window.HumanReview?.show()
    if (board) return open(flowId, nodeId, as)
    if (!as) return window.Shell.go(addressOf(flowId, nodeId))
    window.Shell.go('#/flows')
    window.Shell.whenReady('#flowsView #fxFlows', () => open(flowId, nodeId, as))
  }
  /** The address of an opened flow (at a node): what a reload or a shared link opens again. */
  const addressOf = (flowId, nodeId) => `#/flows?flow=${enc(flowId)}${nodeId ? `&node=${enc(nodeId)}` : ''}`
  /** Say in the address bar which flow is open (or none), without a new history entry or a route change. */
  function mark(hash) {
    const loc = window.location
    if (!loc || !window.history?.replaceState || !/^#\/flows(\?|$)/.test(loc.hash || '') || loc.hash === hash) return
    window.history.replaceState(window.history.state, '', hash)
  }

  // ═══ mounting: the board binds its listeners on mount and drops them on unmount ═══

  const BOARD_ON = { click: onBoardClick, submit: onSubmit, change: onBoardChange, keydown: onBoardKey }
  const bind = (el, on) => { for (const [type, fn] of Object.entries(on)) el.addEventListener(type, fn) }
  const unbind = (el, on) => { for (const [type, fn] of Object.entries(on)) el.removeEventListener(type, fn) }

  /** Poll while anything is mounted; a box mounted fresh loads at once. */
  function startPolling() {
    if (!timer) timer = setInterval(() => load(), POLL_MS)
    load()
  }
  function stopPollingIfIdle() {
    if (mounted()) return
    clearInterval(timer)
    timer = null
    gen++ // a load still in flight lands nowhere
  }

  // what waits for the user's sign-off changed (completed-view.js): the marks on the board and the Sign-off block follow
  window.document?.addEventListener('outputs:change', () => render())

  window.FlowsView = {
    /** The Flows page: the board (flows-page.js). */
    mount(boardEl) {
      if (board !== boardEl) {
        if (board) unbind(board, BOARD_ON)
        board = boardEl
        bind(board, BOARD_ON)
      }
      startPolling()
    },
    unmount() {
      if (board) unbind(board, BOARD_ON)
      board = null
      opened = null
      cardAsking = null
      stopPollingIfIdle()
    },
    /** `fn(data)` after every load while mounted. */
    onLoad(fn) { loaded.push(fn) },
    load,
    open,
    close,
    gotoFlow,
    gotoHand,
    /** The ONE answer path for an ask, from anywhere (the Human review box, human-review.js): POST answer, then a reload. */
    answer: (flowId, nodeId, value) => answer(flowId, nodeId, value),
    /** Open a flow on its Explain tab from any page (the Agents page, the QA page's Explain in Flows). */
    explain: flowId => gotoFlow(flowId, null, 'explain'),
    get data() { return data },
  }
})()
