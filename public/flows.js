// Flows (spec 5 and 7.3). Two boxes, mounted independently:
//   the strip  `Waiting on you`: every open ask across flows, answerable inline.
//              Home mounts it alone (mountStrip, from app.js); the Flows page
//              mounts it with the board (mount, from flows-page.js). Only one
//              page shows at a time, so there is ONE strip slot: whichever page
//              mounts last owns it.
//   the board  a card per open flow (flow-board.js), grouped by agent in the grid's
//              column order, a `Done` row, dropped flows behind a toggle; or, once a
//              card is clicked, that flow opened: header, then one of three views
//              behind tabs (flow-tabs.js, remembered in flows.view): Output, the
//              storyboard (flow-output.js); Status, the rows (flow-status.js); or
//              Process, the chart (flow-chart.js) with zoom (flow-zoom.js) and the
//              node drawer (flow-drawer.js renders it, this file runs its actions,
//              for Status too)
// Polls /api/flows every 15 s while either box is mounted. An opened flow
// refreshes IN PLACE: the chart keeps its scroll, the drawer is redrawn only
// when its node changed, and text typed into an answer box survives a redraw.
// gotoFlow opens a flow from anywhere: it goes to #/flows first when the board
// is not mounted (notify.js toasts, the grid hover card, the strip on Home).
;(() => {
  const $ = (s, el = document) => el.querySelector(s)
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const enc = encodeURIComponent
  const store = {
    get(k, d) { try { const v = localStorage.getItem('flows.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
    set(k, v) { try { localStorage.setItem('flows.' + k, JSON.stringify(v)) } catch {} },
  }

  const POLL_MS = 15_000
  const COLUMNS = ['Master', 'Agent 1', 'Agent 2', 'Agent 3', 'Independent'] // when the grid has not loaded yet
  const FLOW_STATUS = ['open', 'blocked', 'done', 'dropped'] // MUST CHANGE IN LOCKSTEP with flows.mjs FLOW_STATUS
  const PAD = 16 // the chart scroller's padding, unscaled by the zoom
  // The opened flow's ONE ?: each Output block, the views and the proof marks (flow-head.js; spec 6: legends are never a row on the page).
  const LEGEND = window.FlowHead?.HELP || ''
  // The empty board is one line; how a flow starts is behind its ? (spec 6).
  const NO_FLOWS_HELP = '<p>A flow is the plan an agent writes as it works: steps, checks, and the asks that wait on you.</p>' +
    '<p>Agents start one with <code>node tools/factory.mjs flow write</code>. Done and dropped flows stay below the open ones.</p>'

  let strip = null
  let board = null
  let timer = null
  let gen = 0
  let data = { flows: [], invalid: [] }
  let showDropped = false
  let stripHtml = '' // what the strip shows now, so a poll with nothing new leaves it (and any typing) alone
  /** asks answered from this page since the last poll: they stay in the strip, showing their delivery, until then */
  const recent = new Set()
  /** the opened flow: its id, the node in the drawer, and what was last drawn (to redraw only on change) */
  let opened = null
  let zoom = store.get('zoom', 1) // a number, or 'fit'
  let view = window.FlowTabs?.view.get() || 'output' // or 'status' / 'process'; `?.`: the strip-only tests load no flow-tabs.js
  let z = 1 // the scale in effect
  /** called with the data after every load (flows-page.js writes the page head from it) */
  const loaded = []

  const flowOf = id => data.flows.find(f => f.id === id)
  const mounted = () => !!(strip || board)

  // ═══ load and post ═══

  async function load(fromPoll = false) {
    const mine = ++gen
    try {
      const r = await fetch('/api/flows')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || r.status)
      if (mine !== gen || !mounted()) return
      if (fromPoll) recent.clear()
      data = j
      render()
      for (const fn of loaded) fn(data)
    } catch (e) {
      if (mine === gen && board && !opened) board.innerHTML = `<div class="banner">Flows: ${esc(e.message)}</div>`
    }
  }
  async function post(flowId, action, body) {
    try {
      const r = await fetch(`/api/flows/${enc(flowId)}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
      return j
    } catch (e) {
      alert(e.message)
      return null
    }
  }
  /** `fromStrip`: the row stays in the strip, showing its delivery, until the next poll. */
  async function answer(flowId, nodeId, value, note, fromStrip = false) {
    const body = { node: nodeId, answer: value }
    if (note) body.note = note
    if (!(await post(flowId, 'answer', body))) return
    const key = `${flowId}:${nodeId}`
    value !== null && fromStrip ? recent.add(key) : recent.delete(key)
    load()
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

  // ═══ the strip: Waiting on you (each row, its why under the question, is FlowBoard.stripRow) ═══

  function renderStrip() {
    // the flow open on the board asks its own questions (its Story and Status): its rows leave the strip
    const rows = window.FlowBoard.stripRows(data.flows, recent, board && opened ? opened.id : null)
    const open = rows.filter(r => r.n.answer == null).length
    // the header dot on every page counts every open ask, the open flow's too (notify.js keeps it current elsewhere)
    window.Shell?.setWaiting(window.FlowBoard.stripRows(data.flows, new Set()).length)
    strip.hidden = !rows.length
    const html = rows.length
      ? `<section class="card fl-wait"><div class="card-head"><h3>${window.FlowBoard.stripHead(open, board && opened ? opened.id : null)} <span class="faint">· ${open}</span></h3></div>
          <div class="fl-wait-list">${rows.map(r => window.FlowBoard.stripRow(r)).join('')}</div></section>`
      : ''
    if (html !== stripHtml) keepingInputs(strip, () => { strip.innerHTML = html; stripHtml = html })
  }

  // ═══ the board ═══

  function agentOrder(agents) {
    const cols = window.OrchestrationGrid?.data?.columns?.map(c => c.label) || COLUMNS
    const known = cols.filter(a => agents.has(a))
    return [...known, ...[...agents].filter(a => !cols.includes(a)).sort((a, b) => a.localeCompare(b))]
  }
  const card = f => window.FlowBoard.card(f)
  const small = f => window.FlowBoard.small(f)
  const byNewest = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))

  function renderBoard() {
    const live = data.flows.filter(f => f.status === 'open' || f.status === 'blocked')
    const done = data.flows.filter(f => f.status === 'done').sort(byNewest)
    const dropped = data.flows.filter(f => f.status === 'dropped').sort(byNewest)
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
        <div class="fl-out" id="flPanelOutput" role="tabpanel" aria-labelledby="flTabOutput"></div>
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
    const h = window.FlowHead.html(f, { tickets, envPill, statusPill, statuses: FLOW_STATUS })
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
      board.innerHTML = `<section class="card fl-open"><div class="fl-open-head"><button type="button" class="link" data-close>← Flows</button>
        <p class="small warn">No flow ${esc(opened.id)}: it may have been removed.</p></div></section>`
      opened.built = false
      return
    }
    if (!opened.built) { buildOpened(); opened.built = true; opened.head = opened.sub = opened.chart = opened.drawn = null; showView() }
    renderHead(f)
    window.Glossary?.autoLearn(f) // its unknown marked words, once (glossary-store.js)
    // Only the shown view draws: a hidden chart would fit to a 0 px width. Output and Status gate their own redraw.
    if (view === 'output') return window.FlowOutput.fill($('.fl-out', board), f)
    if (view === 'status') {
      window.FlowStatus.fill($('.fl-stat', board), f)
      return window.FlowStatus.revealOnce($('.fl-stat', board), opened) // a link to a node: its row, once
    }
    const chartSig = JSON.stringify([f.nodes, f.derived, f.env, opened.node])
    if (chartSig !== opened.chart) { opened.chart = chartSig; drawChart(null) }
    renderDrawer(f)
  }
  /** Output (the storyboard), Status (the rows) or Process (the chart and drawer), remembered in flows.view. */
  function showView() {
    for (const t of board.querySelectorAll('.fl-tabs [data-view]')) {
      t.setAttribute('aria-selected', String(t.dataset.view === view))
      t.tabIndex = t.dataset.view === view ? 0 : -1
    }
    $('.fl-zoom', board).hidden = $('.fl-scroll', board).hidden = view !== 'process'
    $('.fl-out', board).hidden = view !== 'output'
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
    if (strip) renderStrip()
    if (board) opened ? renderOpened() : renderBoard()
  }

  // ═══ events: one delegated listener per box, bound at mount ═══

  function onStripClick(e) {
    const row = e.target.closest('.fl-wait-row')
    if (!row) return
    const flowId = row.dataset.flow
    const b = e.target.closest('[data-answer], [data-show], [data-retry]')
    if (!b) return
    if (b.dataset.answer) answer(flowId, b.dataset.node, b.dataset.answer, undefined, true)
    else if (b.dataset.show) gotoFlow(flowId, b.dataset.show)
    else deliver(flowId, b.dataset.retry)
  }
  function onSubmit(e) {
    const form = e.target.closest('form[data-text]')
    if (!form) return
    e.preventDefault()
    const row = form.closest('.fl-wait-row')
    const value = new FormData(form).get('answer').trim()
    if (value) answer(row?.dataset.flow || opened?.id, form.dataset.text, value, undefined, !!row)
  }
  function onBoardClick(e) {
    const t = e.target.closest('[data-ticket]')
    if (t) { e.stopPropagation(); return window.FactoryView?.gotoTicket(t.dataset.ticket) }
    if (e.target.closest('[data-dropped]')) { showDropped = !showDropped; return renderBoard() }
    if (e.target.closest('[data-close]')) return close()
    const card = e.target.closest('[data-open]')
    if (card) return open(card.dataset.open)
    const f = flowOf(opened?.id)
    if (!f) return
    if (e.target.closest('[data-drop]')) {
      if (confirm(`Drop the flow ${f.title}? It moves behind show dropped.`)) post(f.id, 'drop').then(r => r && load())
      return
    }
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
    if (!f) return
    const el = e.target
    let r = null
    if (el.matches('[data-flow-status]')) r = await post(f.id, 'status', { status: el.value })
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

  async function open(flowId, nodeId) {
    if (!board) return
    opened = { id: flowId, node: nodeId || null, built: false, reveal: nodeId || null } // reveal: once, on Status
    view = window.FlowTabs.view.get()
    if (nodeId && view === 'output') view = 'status' // Output has no row per node: Status, for this open only (not remembered)
    if (!flowOf(flowId)) {
      // not in the last list (just written): fetch it on its own, then merge it in
      try {
        const r = await fetch(`/api/flows/${enc(flowId)}`)
        if (r.ok) { const f = await r.json(); data = { ...data, flows: [...data.flows.filter(x => x.id !== f.id), f] } }
      } catch {}
      if (opened?.id !== flowId) return
    }
    render()
    if (!opened?.revealed) scrollTo(board) // a revealed node row has been scrolled to already
  }
  /** Scroll a box to the top, clear of the sticky page header (shell.js): measured rather than read from --header-h. */
  function scrollTo(el) {
    el.style.scrollMarginTop = `${($('#pageHead')?.offsetHeight || 0) + 16}px`
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  function close() {
    opened = null
    if (strip) renderStrip() // the closed flow's asks come back to the strip
    if (board) renderBoard()
  }
  /**
   * Open a flow (at a node) from any page: on #/flows straight away, else go there and open it
   * once the board mounts. Without a flow (the header dot, a summary toast), the strip in view:
   * a flow opened below it has scrolled the strip under the header.
   */
  function gotoFlow(flowId, nodeId) {
    if (board) return flowId ? open(flowId, nodeId) : strip && scrollTo(strip)
    window.Shell.go('#/flows')
    if (flowId) window.Shell.whenReady('#flowsView #fxFlows', () => open(flowId, nodeId))
    else window.Shell.whenReady('#flowsView #fxWaiting:not([hidden])', scrollTo) // shown once the first load finds an ask
  }

  // ═══ mounting: each box binds its listeners on mount and drops them on unmount ═══
  // Home's strip box lives as long as the page, so a listener left behind would fire twice.

  const STRIP_ON = { click: onStripClick, submit: onSubmit }
  const BOARD_ON = { click: onBoardClick, submit: onSubmit, change: onBoardChange, keydown: onBoardKey }
  const bind = (el, on) => { for (const [type, fn] of Object.entries(on)) el.addEventListener(type, fn) }
  const unbind = (el, on) => { for (const [type, fn] of Object.entries(on)) el.removeEventListener(type, fn) }

  function attachStrip(el) {
    if (strip === el) return
    detachStrip()
    strip = el
    stripHtml = ''
    recent.clear()
    strip.innerHTML = ''
    strip.hidden = true
    bind(strip, STRIP_ON)
  }
  function detachStrip() {
    if (!strip) return
    unbind(strip, STRIP_ON)
    strip.innerHTML = ''
    strip.hidden = true
    strip = null
    stripHtml = ''
  }
  /** Poll while anything is mounted; a box mounted fresh loads at once. */
  function startPolling() {
    if (!timer) timer = setInterval(() => load(true), POLL_MS)
    load()
  }
  function stopPollingIfIdle() {
    if (mounted()) return
    clearInterval(timer)
    timer = null
    gen++ // a load still in flight lands nowhere
  }

  window.FlowsView = {
    /** The Flows page: the strip and the board (flows-page.js). */
    mount(stripEl, boardEl) {
      attachStrip(stripEl)
      if (board !== boardEl) {
        if (board) unbind(board, BOARD_ON)
        board = boardEl
        bind(board, BOARD_ON)
      }
      startPolling()
    },
    unmount() {
      detachStrip()
      if (board) unbind(board, BOARD_ON)
      board = null
      opened = null
      stopPollingIfIdle()
    },
    /** Home: the strip alone, same handlers and the same poll. Idempotent. */
    mountStrip(el) {
      if (!el || strip === el) return
      attachStrip(el)
      startPolling()
    },
    /** Drop the strip; with `el`, only if that box still holds it (the Flows page may have taken it since). */
    unmountStrip(el) {
      if (el && strip !== el) return
      detachStrip()
      stopPollingIfIdle()
    },
    /** `fn(data)` after every load while mounted. */
    onLoad(fn) { loaded.push(fn) },
    load,
    open,
    close,
    gotoFlow,
    get data() { return data },
  }
})()
