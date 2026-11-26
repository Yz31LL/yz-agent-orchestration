// The Agents page (#/agents): the orchestration diagram. Who hands work to whom, from the Request to the
// Output, drawn from /api/pipeline's graph (pipeline-layout.js, pipeline-view.js), every ticket as a chip on
// the node it stands at now, a details pane below (pipeline-details.js: the clicked agent's card from
// agent-cards.js, Progress report and all), and a pull-out panel on the right (pipeline-panel.js) whose
// Tickets and Outputs lists select a ticket and light its path through the diagram. Above the diagram, the
// pipeline score (score-strip.js), read again with every pipeline read, and under it Pipeline time (time-strip.js).
// At the very top, the watchdog's line while a health check is not OK and the line of Master's open suggestions
// (insight-pages.js fills [data-insight-agents]). Then, above the score, the Alerts line while any alert stands (predict-alerts.js: Show them opens its rows, as
// does #/agents?alerts). Right over the diagram, one line while finished outputs wait for the user's sign-off (completed-view.js: Show them
// opens the Output list in the panel); marking one completed re-reads the pipeline at once (`outputs:change`).
//
// shell.js calls AgentsPage.open/close; app.js hands every /api/status load to AgentsPage.update(data)
// (and the same data again every 15 s, to refresh the times). A NEW /api/status load also re-reads
// /api/pipeline, so the diagram refreshes at exactly the status cadence (every minute, and on Refresh).
// The diagram is built once and patched after, so a refresh never flickers or drops the selection.
//
//   click a node        its details below (again: back to the default pane)
//   click a chip        that ticket's explanation on Flows (FlowsView.explain, else the flow)
//   click a panel row   select the ticket: its route lights up from its own progress (flow-route.js highlight):
//                       done and current in the accent, the steps still ahead as a dashed accent outline; the
//                       same row again, or Escape, clears it
//   click an agent box  its settings as a WINDOW in the middle of the screen (agent-window.js): the card, Model,
//                       Subagents, Specification and rules (the editor, agent-rules.js), Files and context, Changes.
//                       The address says it (#/agents?agent=<label>), so the window opens from a link too, and
//                       closing it takes that part off. Request, Push and Output keep the pane below.
//   Settings (an agent's, in the pane a flow's step line opened)  opens that window
//   AgentsPage.showNode(nodeId, flowId)   from a flow's step line (flow-route.js go): this page with that node's
//                       details open and that flow selected
;(() => {
  let showing = false
  let box = null
  let view = null
  let panel = null
  let details = null
  let score = null
  let time = null
  let tokens = null
  let pipeline = null
  let failure = null
  let status = null // the last /api/status data
  let statusSeen = null // the status object the pipeline was last read for
  let loading = false
  let selNode = null
  let selTicket = null
  // How many test steps each output QA never saw has on its own Output (derived.output.tests), from
  // /api/flows/<id>, so How to test shows only where there is something to show (PipelineTickets.testTarget).
  const steps = {} // id -> count
  const stepsAt = {} // id -> the updatedAt that count was read at

  // The legend behind the header chip's ?.
  const AGENTS_HELP = '<p>Who hands work to whom: a request goes to the coordinator, who hands it to a producer (through the planner, when there is one); every code change goes to QA ' +
    '(then to Security, when there is one), and QA pushes it once it passed, or it goes back on a failure (the return arrows). Work with no code changes goes straight to the Output (dashed), ' +
    'and so does the chat agent\'s: it answers, explains and reviews, and changes no code.</p>' +
    '<p>Each chip is a ticket where it stands now: green passed, red failed, grey anything else. Click a step for its details, a chip for its explanation, ' +
    'and open Tickets on the right to light one ticket\'s route: the steps it has taken in the accent, those still ahead dashed. A red mark on an agent means it pushed outside QA today.</p>' +
    '<p><b>Human review</b>, under the diagram, is everything waiting on you: questions (answer them there), work only you can do, blocked flows, ' +
    'and tickets marked as work for a person. Its head says how many of each; the chips show one kind. The number on Agents in the rail and ' +
    '<b>N waiting on you</b> at the top count questions and by-hand work only: what keeps an agent waiting. Click a title to open it.</p>' +
    '<p>Click an agent for its settings: the model you want it on, its subagents, its specification and rules, and the files and notes it is given. ' +
    'A green pill on an agent says how many subagents run under it now.</p>' +
    '<p><b>Completed</b> is your sign-off on a finished output. Only you can give it: tick an output in the Output list (open Outputs on the right), or ' +
    'press Completed at the end of the Output tab of an opened flow. A completed flow goes to the flow archive and off every board, and still counts in the score. Archiving is not a sign-off: an archived output you never marked completed still waits, with an Archived mark in the Output list. ' +
    'A finished output you have not marked carries an amber dot; after 2 days the line over the diagram turns into a notice, and once 7 wait the Ask ' +
    'drawer reminds you before a new request (outputs.warnAfterDays and outputs.max in config.json).</p>'

  const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  function mount() {
    const section = document.getElementById('agentsView')
    section.innerHTML = `<div class="pl-insight" id="plInsight" data-insight-agents hidden></div>
    <div class="pl-alerts" id="plAlerts" data-pe-alerts hidden></div>
    <div class="pl-prs" id="plPrs" data-prl hidden></div>
    <div class="pl-page">
      <div class="pl-main">
        <div class="psc" id="plScore"></div>
        <div class="psc ptm" id="plTime"></div>
        <div class="psc ptk" id="plTokens"></div>
        <div class="pl-outputs" id="plOutputs" data-cv-line hidden></div>
        <div class="pl-wrap" id="plDiagram"></div>
        <div class="pl-details" id="plDetails"></div>
      </div>
      <aside class="pl-panel" id="plPanel" aria-label="Tickets and outputs"></aside>
    </div>`
    box = section.querySelector('.pl-page')
    details = section.querySelector('#plDetails')
    view = window.PipelineView.create(section.querySelector('#plDiagram'), { onNode: pickNode, onChip: id => window.PipelineTickets.explain(id), humanReview: true })
    panel = window.PipelinePanel.create(section.querySelector('#plPanel'), { page: box, onSelect: pickTicket })
    // the agents' settings window (agent-window.js) holds the rules editor now; closing it clears the address
    window.AgentWindow?.attach({ data: () => ({ graph: pipeline?.graph || null, status }), onClose: closedAgent })
    // the scorecard above the diagram (score-strip.js): read again with every pipeline read
    score = window.ScoreStrip?.create(section.querySelector('#plScore')) || null
    // Pipeline time under it (time-strip.js): the score's window switch drives both, read at the same cadence
    time = window.TimeStrip?.create(section.querySelector('#plTime')) || null
    // Pipeline tokens under that (token-strip.js), on the same switch and cadence
    tokens = window.TokenStrip?.create(section.querySelector('#plTokens')) || null
    // the line over the diagram (completed-view.js fills it), and a sign-off re-reads the pipeline: the flow leaves it
    window.CompletedView?.paint(section)
    window.PredictAlerts?.paint(section) // the Alerts line at the top of the page (predict-alerts.js)
    window.PrList?.paint(section) // the Pull requests list under it, fading into fog (prlist.js)
    document.addEventListener('outputs:change', () => showing && loadPipeline(true))
    // Delegated: the agent card's Progress report (agent-cards.js leaves [data-report] to its page), a
    // subagent row (watch it live), the pane's Close, and the ticket rows of Here now.
    details.addEventListener('click', e => {
      const set = e.target.closest('[data-ar-act="settings"]')
      if (set && window.AgentWindow) return openAgent(pipeline?.graph?.nodes.find(n => n.label === set.dataset.arLabel)?.id, set)
      const rep = e.target.closest('[data-report]')
      if (rep) return window.OrchestrationGrid?.report(rep.dataset.report, rep.dataset.label)
      const sub = e.target.closest('[data-href]')
      if (sub) return (location.hash = sub.dataset.href)
      if (e.target.closest('[data-close]')) return pickNode(selNode)
      const row = e.target.closest('[data-ticket]')
      if (row) pickTicket(row.dataset.ticket)
    })
    // Escape clears the ticket, then the node, one per press; never one typed in the Ask drawer, and never
    // one a popover or the palette already took (they preventDefault, as shell.js expects).
    document.addEventListener('keydown', e => {
      if (!showing || e.key !== 'Escape' || e.defaultPrevented || e.target?.closest?.('#drawer')) return
      if (window.AgentWindow?.isOpen()) return // the window takes its own Escape (agent-window.js)
      if (window.AgentRules?.escape()) return e.preventDefault() // an open Settings editor first
      if (selTicket) selTicket = null
      else if (selNode) selNode = null
      else return
      e.preventDefault()
      render()
    })
  }

  /** The node `id`'s settings window, from `from` (the focus goes back there); the address says which agent. */
  function openAgent(id, from) {
    const node = id && pipeline?.graph?.nodes.find(n => n.id === id)
    if (!node || node.kind !== 'agent') return
    window.AgentWindow.open(id, from || box.querySelector(`[data-node="${CSS.escape(id)}"] .pl-node-head`))
    view.setNode(id)
    const want = `#/agents?agent=${encodeURIComponent(node.label)}`
    if (location.hash !== want) history.replaceState(null, '', want)
  }
  function closedAgent() {
    if (/^#\/agents\/?\?/.test(location.hash)) history.replaceState(null, '', '#/agents')
    view?.setNode(selNode)
  }
  /** The address names an agent (#/agents?agent=<label>): open its window once the graph is known. */
  function syncFromHash() {
    if (!window.AgentWindow || !pipeline) return
    const m = /^#\/agents\/?\?(.*)$/.exec(location.hash || '')
    const label = m ? new URLSearchParams(m[1]).get('agent') : null
    const node = label && pipeline.graph.nodes.find(n => n.kind === 'agent' && n.label === label)
    if (node && window.AgentWindow.current() !== label) openAgent(node.id)
    else if (!label && window.AgentWindow.isOpen()) window.AgentWindow.close()
  }

  function pickNode(id) {
    const node = window.AgentWindow && pipeline?.graph?.nodes.find(n => n.id === id)
    if (node?.kind === 'agent') return openAgent(id)
    if (pipeline?.graph?.nodes.find(n => n.id === id)?.role === 'human') return window.HumanReview?.show() // the user's box: the list under the diagram
    selNode = selNode === id ? null : id
    render()
    if (selNode && details.getBoundingClientRect().top > window.innerHeight - 80) details.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'nearest' })
  }
  function pickTicket(id) {
    selTicket = selTicket === id ? null : id
    render()
  }

  /** A read asked for while one is in flight (a sign-off, completed-view.js): that read may predate it, so one more follows. */
  let again = false
  async function loadPipeline(fresh = false) {
    if (loading) return void (again ||= fresh)
    loading = true
    window.AgentRules?.load() // the saved specifications and rules, at the same cadence
    score?.refresh()
    time?.refresh()
    tokens?.refresh()
    try {
      const r = await fetch('/api/pipeline')
      if (!r.ok) throw new Error(await r.text())
      pipeline = await r.json()
      failure = null
    } catch (e) {
      failure = e.message || String(e)
    } finally {
      loading = false
    }
    render()
    syncFromHash()
    if (pipeline) loadSteps(pipeline.tickets)
    if (again) {
      again = false
      loadPipeline()
    }
  }

  /** Looks up the test steps of the outputs with no QA record that are new or changed since last read. */
  async function loadSteps(tickets) {
    const T = window.PipelineTickets
    const outputs = T.outputList(tickets, { archived: true })
    for (const t of outputs) if (t.id in steps && stepsAt[t.id] !== t.updatedAt) delete steps[t.id]
    const ids = T.stepsToFetch(outputs, steps).slice(0, 20)
    if (!ids.length) return
    await Promise.all(ids.map(async id => {
      try {
        const r = await fetch(`/api/flows/${encodeURIComponent(id)}`)
        if (r.status === 404) steps[id] = 0
        else if (r.ok) steps[id] = Number((await r.json())?.derived?.output?.tests) || 0
        else return // a failed read: no button for now, looked up again on the next load
        stepsAt[id] = outputs.find(t => t.id === id)?.updatedAt
      } catch {}
    }))
    render()
  }

  function renderDetails(groups, labels) {
    const node = selNode && pipeline.graph.nodes.find(n => n.id === selNode)
    const agent = node?.kind === 'agent' ? (status?.agents || []).find(a => a.label === node.label) || null : null
    const html = node
      ? window.PipelineDetails.html(node, { agent, worktrees: status?.worktrees || [], tickets: groups[node.id] || [], labels, selected: selTicket, rules: node.kind === 'agent' ? paneRules(node) : null })
      : window.PipelineDetails.empty()
    // AgentRules.paint keeps a Settings editor in use where it is and swaps only what is around it
    if (!(window.AgentRules ? window.AgentRules.paint(details, html) : details._html !== html && ((details.innerHTML = details._html = html), true))) return
    if (!node || node.role === 'chat') window.AgentCards?.renderChat?.() // the default pane and the chat node hold its card
  }

  /** The pane shows an agent's rules read only: its editor is in the window (one editor per agent, one set of ids). */
  function paneRules(node) {
    const opts = window.AgentRules?.paneOpts(node)
    return opts && window.AgentWindow ? { ...opts, draft: null } : opts
  }

  function renderStatus() {
    const { esc } = window.UI
    const when = window.Shell.ago(pipeline?.builtAt)
    const line = pipeline ? `updated ${when || '—'}` : 'Loading…'
    window.Shell.setStatus(failure ? `<span class="warn">Could not load the pipeline: ${esc(failure)}</span>${pipeline ? ` · ${line}` : ''}` : line, AGENTS_HELP)
    if (status) window.Shell.setTitle('Agents', 'agents', status.agents.length)
  }

  function render() {
    if (!showing || !box) return
    renderStatus()
    if (!pipeline) return
    const { graph, tickets } = pipeline
    // A selection outlives a refresh while what it points at still exists. It is dropped only against a
    // pipeline read NOW: open() draws at once with the one an earlier visit read, and a flow started since
    // (showNode from its head) would lose its selection before the fresh list arrived (QA, 2026-11-24).
    const fresh = !loading
    if (fresh && selNode && !graph.nodes.some(n => n.id === selNode)) selNode = null
    const ticket = selTicket ? tickets.find(t => t.id === selTicket) : null
    if (fresh && !ticket) selTicket = null
    view.update({ graph, tickets, agents: status?.agents || [] })
    view.setPath(ticket ? window.FlowRoute.highlight(graph, ticket.progress) : null)
    view.setNode(selNode)
    panel.update(pipeline, selTicket, steps)
    renderDetails(window.PipelineTickets.byNode(tickets), window.PipelineTickets.labelsOf(graph))
    window.AgentWindow?.refresh()
  }

  /** Every /api/status load (and the 15 s redraw with the same data): a new load re-reads the pipeline. */
  function update(data) {
    if (data) status = data
    if (!showing) return
    if (status && status !== statusSeen) {
      statusSeen = status
      loadPipeline()
    }
    render()
  }

  window.AgentsPage = {
    open() {
      showing = true
      if (!box) mount()
      status = window.UI.data() || status
      statusSeen = status
      loadPipeline()
      render()
      syncFromHash() // an address naming an agent opens its window (again once the pipeline is read)
    },
    close() {
      showing = false
    },
    update,
    /** This page with node `id`'s details open and flow `flowId` selected (its route lit); from a flow's step line. */
    showNode(id, flowId) {
      selNode = id || null
      selTicket = flowId || null
      if (location.hash === '#/agents' && showing) render()
      else location.hash = '#/agents'
    },
  }
})()
