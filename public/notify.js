// Notifier, on every view (spec 7.4): polls /api/pulse and tells the user when
//   - an ask is waiting for them (the count on the bell, the header dot, the tab
//     title, a toast with Answer that opens the flow at that node);
//   - a flow turns blocked or done;
//   - an agent adds proof to a flow while the user is on another view (quiet);
//   - an answer could not be delivered to the agent that asked (Retry delivers again);
//   - an agent stops working (it was active or testing and is now idle);
//   - the chat agent finishes an answer.
// Each pulse is also dispatched as a `pulse` event on the document, which
// public/reminders.js listens for (its toast and desktop alert come back here).
// Desktop notifications cover the same, opt-in from the switch at the foot of the
// Alerts panel. The bell in the rail opens that panel: the last 50 toasts this
// browser showed (localStorage alerts.history), newest first, each with its action.
//
// The rules that decide which alerts one poll raises are pure
// (window.NotifyRules: alerts, retryDelivery with fetch injected, and the history:
// history, loadHistory and saveHistory with storage injected) and tested
// in test/notify.test.mjs, which loads this file with no document: everything
// after them touches the DOM.
(() => {
  // ═══ rules: no DOM ═══

  /** A flow first seen after the baseline counts from here. */
  const FRESH_FLOW = { status: 'open', evidence: 0, undelivered: 0 }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

  /**
   * The alerts for one pulse.
   *   prevFlows  the `flows` this returned last time (Map id -> line), or null on the
   *              first poll: that poll is the baseline and raises no flow alerts.
   *   p          the pulse: { waiting: [{ flowId, flowTitle, agent, nodeId, question, why }],
   *              flows: [{ id, title, agent, status, evidence, undelivered }] }
   *   seen       ask keys (`flowId:nodeId`) already alerted, kept across reloads.
   *   first      the first poll since the page loaded: several new asks become one summary.
   *   onFlows    the user is on the Flows page, where new proof and the waiting asks are already in view.
   * Returns { open, seen, flows, alerts }: `seen` is every open ask's key, to add to the
   * kept set; `flows` is the next baseline. Each alert has a `type` and a plain `text`.
   */
  function alerts(prevFlows, p, { seen = [], first = false, onFlows = false } = {}) {
    const waiting = p.waiting || []
    const lines = p.flows || []
    const out = []
    const keyOf = a => `${a.flowId}:${a.nodeId}`
    const known = new Set(seen)
    const fresh = waiting.filter(a => !known.has(keyOf(a)))

    if (first && waiting.length && fresh.length !== 1) {
      // on the Flows page the header dot and the Waiting on you strip already say it: no summary there
      if (!onFlows) out.push({ type: 'summary', count: waiting.length, text: `${plural(waiting.length, 'ask')} waiting for you on the Flows page.`, desktop: fresh.length > 0 })
    } else {
      for (const a of fresh) {
        out.push({ type: 'waiting', flowId: a.flowId, nodeId: a.nodeId, agent: a.agent, title: a.flowTitle, text: `Waiting on you: ${a.flowTitle}`, body: a.question, why: a.why || '' })
      }
    }

    const flows = new Map(lines.map(f => [f.id, f]))
    if (prevFlows) {
      for (const f of lines) {
        const before = prevFlows.get(f.id) || FRESH_FLOW
        const about = { flowId: f.id, agent: f.agent, title: f.title }
        if (f.status !== before.status && (f.status === 'blocked' || f.status === 'done')) {
          out.push({ type: f.status, ...about, text: `${f.agent}: ${f.title} is ${f.status}` })
        }
        if (f.evidence > before.evidence && !onFlows) {
          out.push({ type: 'proof', ...about, text: `${f.agent} added proof to ${f.title}` })
        }
        if (f.undelivered > before.undelivered) {
          out.push({ type: 'undelivered', ...about, text: `${f.agent}: an answer could not be delivered` })
        }
      }
    }
    return { open: waiting.length, seen: waiting.map(keyOf), flows, alerts: out }
  }

  /**
   * The Retry button on an undelivered toast: deliver again, for real. The pulse line has
   * no node ids, so read the flow first, then POST /api/flows/<id>/deliver { node } for
   * each ask whose answer is not delivered, one after another (each is one relay turn,
   * about $0.30; the click on a button labelled Retry is the consent). `fetchFn` is
   * injected for the test. Never throws: returns { found, sent, errors: [{ nodeId, error }] }.
   */
  async function retryDelivery(flowId, fetchFn) {
    const base = `/api/flows/${encodeURIComponent(flowId)}`
    const errors = []
    let flow
    try {
      const r = await fetchFn(base)
      const j = await r.json().catch(() => ({}))
      if (!r.ok) return { found: 0, sent: 0, errors: [{ nodeId: null, error: j?.error || `Failed (${r.status})` }] }
      flow = j
    } catch (e) {
      return { found: 0, sent: 0, errors: [{ nodeId: null, error: e?.message || String(e) }] }
    }
    const failed = (flow?.nodes || []).filter(n => n.type === 'ask' && n.deliveryError != null).map(n => n.id)
    let sent = 0
    for (const nodeId of failed) {
      try {
        const r = await fetchFn(`${base}/deliver`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ node: nodeId }) })
        const j = await r.json().catch(() => ({}))
        if (r.ok && j?.ok) sent++
        else errors.push({ nodeId, error: j?.error || `Failed (${r.status})` })
      } catch (e) {
        errors.push({ nodeId, error: e?.message || String(e) })
      }
    }
    return { found: failed.length, sent, errors }
  }

  // ─── the alert history behind the bell (spec 5): this browser only, never sent anywhere ───

  const HISTORY_KEY = 'alerts.history'
  const HISTORY_CAP = 50

  /** A NEW history with `entry` first and at most `cap` entries. `list` is never changed; anything but an array counts as empty. */
  function history(list, entry, cap = HISTORY_CAP) {
    return [entry, ...(Array.isArray(list) ? list : [])].slice(0, cap)
  }
  const isEntry = e => e != null && typeof e === 'object' && typeof e.html === 'string' && typeof e.at === 'string'
  /**
   * The kept history, newest first. `storage` returns the Storage, because reaching
   * window.localStorage can itself throw (blocked site data, a sandboxed frame): any throw,
   * a missing key, a corrupt value or a non-list reads as [], and odd entries are dropped.
   */
  function loadHistory(storage) {
    try {
      const v = JSON.parse(storage().getItem(HISTORY_KEY))
      return Array.isArray(v) ? v.filter(isEntry).slice(0, HISTORY_CAP) : []
    } catch {
      return []
    }
  }
  /** Keep `list` under alerts.history: false when storage is blocked or full, never a throw. */
  function saveHistory(storage, list) {
    try {
      storage().setItem(HISTORY_KEY, JSON.stringify(list))
      return true
    } catch {
      return false
    }
  }
  /**
   * Pure: whether this keydown is the alerts panel Escape. Not when something on top took it
   * (defaultPrevented), and not while the command palette is open (palette.js, z 60, above the
   * panel at 45): one Escape closes the top-most thing only, whatever order the scripts load in.
   */
  const takesEscape = (e, panelOpen, w = window) => e.key === 'Escape' && panelOpen && !e.defaultPrevented && !w.Palette?.isOpen
  window.NotifyRules = { alerts, retryDelivery, history, loadHistory, saveHistory, takesEscape }
  if (!window.document) return

  // ═══ the page ═══

  const POLL_MS = 15_000
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const enc = encodeURIComponent
  const store = {
    get(k, d) { try { const v = localStorage.getItem('notify.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
    set(k, v) { try { localStorage.setItem('notify.' + k, JSON.stringify(v)) } catch {} },
  }
  /** The raw Storage for alerts.history (no notify. prefix); loadHistory and saveHistory catch its throws. */
  const raw = () => window.localStorage
  const baseTitle = document.title
  const onFlows = () => window.Shell?.current?.view === 'flows'
  let prevAgents = null
  let prevFlows = null
  let prevChatBusy = null
  let first = true
  let lastOpen = 0

  // ─── the desktop switch: kept in memory too, so it still works when storage throws ───
  let desktopPref = store.get('desktop', true)
  const desktopOn = () => 'Notification' in window && Notification.permission === 'granted' && desktopPref !== false
  function setDesktop(on) {
    desktopPref = on
    store.set('desktop', on)
  }

  // ─── rail: the bell (in the shell's Alerts slot), its count the asks waiting ───
  const slot = document.getElementById('railAlerts')
  const bell = document.createElement('button')
  bell.type = 'button'
  bell.className = 'nt-bell'
  bell.setAttribute('aria-haspopup', 'dialog')
  bell.setAttribute('aria-controls', 'ntPanel')
  bell.setAttribute('aria-expanded', 'false')
  bell.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg><span class="nt-count" hidden></span>'
  slot?.appendChild(bell)

  function paintBell(open) {
    bell.classList.toggle('on', desktopOn())
    bell.title = open ? `Alerts: ${plural(open, 'ask')} waiting` : 'Alerts'
    bell.setAttribute('aria-label', bell.title)
    const c = bell.querySelector('.nt-count')
    c.hidden = !open
    c.textContent = open || ''
  }

  // ─── the panel: the last 50 alerts, newest first, each with the action its toast had ───
  // Appended to body, not the rail: the rail clips its overflow. shell.css places it beside
  // the rail (bottom-aligned with the bell, through --nt-bottom) or above the bottom bar.
  const panel = document.createElement('div')
  panel.id = 'ntPanel'
  panel.className = 'nt-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Alerts')
  panel.tabIndex = -1
  panel.hidden = true
  panel.innerHTML = `<div class="nt-panel-head"><h2>Alerts</h2><button type="button" class="link nt-clear" title="Empty the alerts kept in this browser">Clear</button></div>
    <ul class="nt-list"></ul>
    <div class="nt-panel-foot"><label><input type="checkbox" role="switch" class="nt-switch"> Desktop alerts</label><span class="nt-note faint" hidden></span></div>`
  document.body.appendChild(panel)
  const list = panel.querySelector('.nt-list')
  const sw = panel.querySelector('.nt-switch')
  const note = panel.querySelector('.nt-note')
  let shown = [] // the entries drawn, so a click maps to the row it was drawn from

  function renderPanel() {
    if (panel.hidden) return
    shown = loadHistory(raw)
    // each html was escaped when its toast was built
    list.innerHTML = shown.length
      ? shown.map((e, i) => `<li class="nt-row"><div class="nt-text">${e.html}</div><div class="nt-row-foot"><time class="faint" datetime="${esc(e.at)}">${window.Shell.ago(e.at)}</time>${
          KINDS.includes(e.action?.kind) ? `<button type="button" class="link nt-go" data-i="${i}">${esc(e.action.label)}</button>` : ''}</div></li>`).join('')
      : '<li class="nt-empty faint">No alerts yet.</li>'
    panel.querySelector('.nt-clear').hidden = !shown.length
    paintSwitch()
  }
  function paintSwitch() {
    const has = 'Notification' in window
    const blocked = has && Notification.permission === 'denied'
    sw.checked = desktopOn()
    sw.disabled = !has || blocked
    note.textContent = !has ? 'Not in this browser.' : blocked ? 'Blocked in the browser settings.' : ''
    note.hidden = !note.textContent
  }
  sw.addEventListener('change', async () => {
    if (sw.checked && Notification.permission !== 'granted') {
      try { await Notification.requestPermission() } catch {}
      setDesktop(Notification.permission === 'granted')
    } else {
      setDesktop(sw.checked)
    }
    paintSwitch()
    paintBell(lastOpen)
  })
  function place() {
    const r = slot?.getBoundingClientRect()
    if (r) panel.style.setProperty('--nt-bottom', `${Math.max(8, Math.round(window.innerHeight - r.bottom))}px`)
  }
  function openPanel() {
    window.Shell?.collapseRail?.()
    panel.hidden = false
    bell.setAttribute('aria-expanded', 'true')
    place()
    renderPanel()
    panel.focus({ preventScroll: true })
  }
  function closePanel(refocus) {
    if (panel.hidden) return
    panel.hidden = true
    bell.setAttribute('aria-expanded', 'false')
    if (refocus) bell.focus()
  }
  // Opening marks nothing read: there is no unread state, only the history.
  bell.addEventListener('click', () => (panel.hidden ? openPanel() : closePanel(false)))
  panel.addEventListener('click', e => {
    const btn = e.target.closest('.nt-go')
    if (btn) {
      const a = shown[Number(btn.dataset.i)]?.action
      closePanel(false)
      if (a) runAction(a)
    } else if (e.target.closest('.nt-clear')) {
      saveHistory(raw, [])
      renderPanel()
      panel.focus({ preventScroll: true })
    }
  })
  document.addEventListener('click', e => {
    if (!panel.hidden && e.target.isConnected && !panel.contains(e.target) && !bell.contains(e.target)) closePanel(false)
  })
  // Capture, before the shell's own Escape (which closes the chat drawer only when nothing else took the key).
  window.addEventListener('keydown', e => {
    if (takesEscape(e, !panel.hidden)) {
      e.preventDefault()
      closePanel(true)
    }
  }, true)
  window.addEventListener('resize', () => panel.hidden || place())

  // ─── where an action goes ───
  // Every toast action is plain data, { label, kind, flowId, nodeId } (a Retry also names the
  // agent and the flow title for its result toasts), so the history keeps it and runAction
  // re-creates what it does: ONE place for the toast and the panel.
  const KINDS = ['answer', 'open', 'retry', 'tickets', 'drawer']
  const act = (label, kind, flowId, nodeId) => ({ label, kind, flowId, nodeId })
  function runAction(a) {
    switch (a.kind) {
      // the Flows page with the flow open at that node, or the strip in view without a flow:
      // FlowsView.gotoFlow goes to #/flows and waits for the board to mount (Shell.whenReady)
      case 'answer':
      case 'open': return window.FlowsView?.gotoFlow(a.flowId, a.nodeId)
      case 'retry': return retry(a)
      case 'tickets': return window.Shell?.go('#/tickets')
      case 'drawer': return window.Shell?.drawer.open()
    }
  }
  const go = a => () => runAction(a)
  /** The flow, opened at its first ask whose answer was not delivered (its drawer shows the error). */
  const openFailed = flowId => async () => {
    let nodeId
    try {
      const r = await fetch(`/api/flows/${enc(flowId)}`)
      if (r.ok) nodeId = (await r.json()).nodes?.find(n => n.type === 'ask' && n.deliveryError != null)?.id
    } catch {}
    runAction(act('Open', 'open', flowId, nodeId))
  }
  /**
   * Retry delivers again (NotifyRules.retryDelivery: about $0.30 and ten seconds per ask),
   * then says how it went: sent, nothing left to send, or still not delivered with the error.
   */
  async function retry(a) {
    toast(`Retrying the delivery to <b>${esc(a.agent)}</b>…`, { kind: 'info' })
    const r = await retryDelivery(a.flowId, (url, init) => fetch(url, init))
    if (r.errors.length) {
      const why = r.errors.map(e => esc(e.error)).join('<br>')
      toast(`<b>Still not delivered</b> to ${esc(a.agent)} · ${esc(a.title)}<br>${why}`, { kind: 'decision', action: act('Open', 'open', a.flowId, r.errors[0].nodeId || undefined), sticky: true })
    } else if (r.sent) {
      toast(`<b>Sent</b>: ${esc(a.agent)} has the answer${r.sent > 1 ? 's' : ''} to ${esc(a.title)}.`, { kind: 'agent' })
    } else {
      toast(`Nothing left to deliver in ${esc(a.title)}.`, { kind: 'info' })
    }
  }

  // ─── toasts: each one also goes into the history ───
  const stack = document.createElement('div')
  stack.className = 'nt-stack'
  stack.setAttribute('role', 'status')
  stack.setAttribute('aria-live', 'polite')
  document.body.appendChild(stack)
  /**
   * `html` is already escaped; `action` is the plain { label, kind, flowId, nodeId } runAction knows.
   * `keep: false` leaves it out of the history (the per-load summary: the asks it counts are already there).
   */
  function toast(html, { kind = 'info', action, sticky = false, keep = true } = {}) {
    const a = KINDS.includes(action?.kind) ? JSON.parse(JSON.stringify(action)) : null
    if (keep) {
      saveHistory(raw, history(loadHistory(raw), { at: new Date().toISOString(), html, action: a }))
      renderPanel()
    }
    const el = document.createElement('div')
    el.className = `nt-toast ${kind}`
    el.innerHTML = `<div class="nt-text">${html}</div><div class="nt-actions">${a ? `<button type="button" class="link nt-go">${esc(a.label)}</button>` : ''}<button type="button" class="link nt-x" aria-label="Dismiss">✕</button></div>`
    el.querySelector('.nt-x').addEventListener('click', () => el.remove())
    if (a) el.querySelector('.nt-go').addEventListener('click', () => { el.remove(); runAction(a) })
    stack.appendChild(el)
    while (stack.children.length > 4) stack.firstChild.remove()
    if (!sticky) setTimeout(() => el.remove(), 12_000)
  }
  function desktop(title, body, onClick) {
    if (!desktopOn() || document.visibilityState === 'visible' && document.hasFocus()) return
    try {
      const n = new Notification(title, { body, tag: title + body, icon: undefined })
      n.onclick = () => { window.focus(); onClick?.(); n.close() }
    } catch {}
  }

  /** One alert from the rules, as a toast and a desktop notification. */
  function raise(a) {
    const from = `<span class="faint"> · from ${esc(a.agent)}</span>`
    switch (a.type) {
      case 'summary': {
        const open = act('Open', 'open')
        toast(`<b>${esc(a.text)}</b>`, { kind: 'decision', action: open, sticky: true, keep: false })
        if (a.desktop) desktop(`${plural(a.count, 'ask')} waiting`, 'Open the Flows page to answer them.', go(open))
        break
      }
      case 'waiting': {
        const answer = act('Answer', 'answer', a.flowId, a.nodeId)
        // a `decide` flow is titled by its question: say it once
        // why it is asked goes under the question: in the toast, its line in the alerts panel, and the desktop alert
        const why = a.why ? `<br><span class="nt-why">Why? ${esc(a.why)}</span>` : ''
        toast(`<b>Waiting on you</b> · ${esc(a.title)}${a.body !== a.title ? `<br>${esc(a.body)}` : ''}${why}${from}`, { kind: 'decision', action: answer, sticky: true })
        desktop(a.text, a.why ? `${a.body}\nWhy? ${a.why}` : a.body, go(answer))
        break
      }
      case 'blocked':
      case 'done':
        toast(`<b>${esc(a.agent)}</b>: ${esc(a.title)} is ${a.type}`, { kind: a.type === 'blocked' ? 'decision' : 'agent', action: act('Open', 'open', a.flowId), sticky: a.type === 'blocked' })
        desktop(a.text, 'Open the flow on the Flows page.', go(act('Open', 'open', a.flowId)))
        break
      case 'proof':
        toast(`<b>${esc(a.agent)}</b> added proof to ${esc(a.title)}`, { kind: 'info', action: act('See it', 'open', a.flowId) })
        desktop(a.text, 'Open the flow to see it.', go(act('Open', 'open', a.flowId)))
        break
      case 'undelivered':
        toast(`<b>${esc(a.agent)}</b>: an answer could not be delivered<span class="faint"> · ${esc(a.title)}</span>`, { kind: 'decision', action: { ...act('Retry', 'retry', a.flowId), agent: a.agent, title: a.title }, sticky: true })
        // a desktop click only opens the flow: the paid retry stays behind the labelled button
        desktop(a.text, `${a.title}: open it to retry.`, openFailed(a.flowId))
        break
    }
  }

  // ─── poll ───
  async function poll() {
    let p
    try {
      const r = await fetch('/api/pulse')
      if (!r.ok) return
      p = await r.json()
    } catch { return }
    // reminders.js (and anything else) reads each pulse from here, with no second poll
    document.dispatchEvent(new CustomEvent('pulse', { detail: p }))

    // asks waiting, flows that changed
    const seen = store.get('seenAsks', [])
    const r = alerts(prevFlows, p, { seen, first, onFlows: onFlows() })
    lastOpen = r.open
    window.Shell?.setWaiting(r.open)
    document.title = r.open ? `(${r.open}) ${baseTitle}` : baseTitle
    paintBell(r.open)
    r.alerts.forEach(raise)
    store.set('seenAsks', [...new Set([...seen, ...r.seen])].slice(-300))
    prevFlows = r.flows

    // agents that stopped working
    const now = new Map((p.agents || []).map(a => [a.label, a]))
    if (prevAgents) {
      for (const [label, a] of now) {
        const before = prevAgents.get(label)
        const wasWorking = before && (before.state === 'active' || before.state === 'testing')
        if (wasWorking && a.state === 'idle') {
          const grid = act('See the grid', 'tickets')
          toast(`<b>${esc(label)}</b> stopped working.`, { kind: 'agent', action: grid })
          desktop(`${label} stopped working`, 'Open the Tickets page for its progress report.', go(grid))
        }
      }
    }
    prevAgents = now

    // the chat agent finished an answer: the chat lives in the shell's drawer
    const chat = p.chat || {}
    const drawer = window.Shell?.drawer
    if (prevChatBusy && !chat.busy && !drawer?.isOpen) {
      const read = act('Read it', 'drawer')
      toast(`<b>${esc(chat.name)}</b> replied in the chat.`, { kind: 'agent', action: read })
      desktop(`${chat.name} replied`, 'Open Ask to read it.', go(read))
    } else if (prevChatBusy && !chat.busy) {
      desktop(`${chat.name} replied`, 'Back in the chat.', null)
    }
    // Until the drawer first opens the chat has no stream, so this poll feeds
    // the rail's Ask dot (shell.js); once mounted, the chat's own stream does.
    if (!window.FactoryChat?.mounted && Boolean(prevChatBusy) !== Boolean(chat.busy)) {
      document.dispatchEvent(new CustomEvent('chat:status', { detail: { busy: Boolean(chat.busy) } }))
    }
    prevChatBusy = chat.busy
    first = false
  }
  paintBell(0)
  poll()
  setInterval(poll, POLL_MS)
  window.Notifier = { poll, toast, desktop }
})()
