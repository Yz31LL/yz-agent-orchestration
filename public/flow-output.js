// The Output view of an opened flow, the default tab (flows.js), built to be
// read in ten seconds: one column, three blocks, then the rest folded away.
//
//   Story         who did what, and why, in plain lines: the lead, no head, no border (flow-story.js)
//   Before → Now  how it was and how it is now, one line each, when the agent said so (here, FlowCompare.strip)
//   PICTURE       one visual, always: screenshots, the agent's diagram, or the auto chart (flow-visual.js)
//   HOW TO TEST   the test steps as cards in a row (flow-steps.js)
//   ▸ Details     the long summary and Changes · N, collapsed (here)
//   Send          the pull request the work becomes: review it, send it, its state (flow-send.js)
//
// Marked words ([word]) in any of them are term chips (terms.js) that explain
// themselves on hover (term-card.js). A head is one or two words; what a block
// is lives behind the opened flow's one `?` (flow-head.js), never on the page.
//
//   model(flow)            PURE: { story, visual, result, before, change, diagram, diagramBefore, picture, summary, changes,
//                          testing, requestedAt, complete, source }
//   html(flow, now?)       the markup
//   fill(root, flow)       draw in place, keyed and signature-gated like Status: no flicker, no
//                          scroll jump, a typed note and the ticked boxes kept across the 15 s poll;
//                          each chart is redrawn for its box's width (and on resize)
//   checklist.get / set    the `I saw this` ticks: localStorage `flows.tested.<flowId>`, a list of
//                          step ids. YOUR checklist in this browser, never written to the flow.
//   details.get / set      whether Details is open for a flow, in this browser (flows.details)
//
// The one thing this view posts is the request button (POST request-tests): the server relays it to
// the flow's agent, or, when that agent is the chat itself, hands the text back and it goes into the
// Ask drawer for the user to send (FactoryChat.prefill). Evidence and Markdown are drawn by
// FlowDrawer, screenshots open in the shared lightbox (lightbox.js).
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const D = () => window.FlowDrawer
  const FRESH_MS = 30 * 60_000 // a request shows in the head this long, unless a step arrives first
  const DRAW_W = 960 // the width a chart is drawn for before fill() measures its box
  // What each block is lives in the opened flow's ONE ? (flow-head.js HELP), never on a block.

  // ═══ what this browser remembers ═══

  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d } catch { return d } }
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

  // A tick is `<step id>@<when the step was recorded>`, never the bare id: test-clear then recording
  // again restarts at t1, and --replace keeps the id, but both stamp a new `at`, so a step you have
  // not seen is never shown as checked.
  const checklist = {
    slot: id => `flows.tested.${id}`,
    of: step => `${step.id}@${step.at || ''}`,
    get(flowId) {
      const v = read(this.slot(flowId), [])
      return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []
    },
    set(flowId, tick, on) {
      const ticks = this.get(flowId).filter(x => x !== tick)
      if (on) ticks.push(tick)
      write(this.slot(flowId), ticks)
    },
  }
  const details = {
    get: flowId => [].concat(read('flows.details', [])).includes(flowId),
    set(flowId, open) {
      const ids = [].concat(read('flows.details', [])).filter(x => typeof x === 'string' && x !== flowId)
      if (open) ids.push(flowId)
      write('flows.details', ids.slice(-50))
    },
  }

  // ═══ model: pure ═══

  const shot = (ref, caption, at) => ({ ref: String(ref ?? ''), caption: caption || '', at: at || null })
  const change = c => ({ kind: c.kind, ref: String(c.ref ?? ''), label: c.label || '', at: c.at || null })

  function model(flow) {
    const out = flow.output || {}
    const shots = []
    const proofChanges = []
    for (const n of flow.nodes || []) {
      for (const e of n.evidence || []) {
        if (e.kind === 'shot') shots.push({ ...shot(e.ref, e.label, e.at), nodeId: n.id })
        else if ((e.kind === 'commit' || e.kind === 'diff') && !proofChanges.some(c => c.kind === e.kind && c.ref === e.ref)) proofChanges.push(change(e))
      }
    }
    // a before shot (`flow result --before`) is kept apart: the result is how it is now (flow-compare.js pairs them)
    const result = (out.result || []).filter(r => r?.when !== 'before').map(r => shot(r.ref, r.caption, r.at))
    const before = (out.result || []).filter(r => r?.when === 'before').map(r => shot(r.ref, r.caption, r.at))
    const summary = typeof out.summary === 'string' ? out.summary.trim() : ''
    const changes = (out.changes || []).map(change)
    const testing = (out.testing || []).map(t => ({ id: String(t.id), do: t.do || '', expect: t.expect || '', shot: t.shot || '', at: t.at || null }))
    // Standing in for the agent's Result, the flow's LATEST screenshot leads (stable: no time keeps flow order).
    const latest = [...shots].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    const d = out.diagram
    const drawing = g => (g?.nodes?.length ? { nodes: g.nodes.map(n => ({ id: n.id, label: n.label, kind: n.kind })), edges: g.edges || [] } : null)
    const diagram = drawing(d)
    // any result shot, a before one too, is a screenshot to show (flows.mjs visualOf)
    const visual = out.result?.length || shots.length ? 'shots' : diagram ? 'diagram' : 'auto'
    const ch = out.change
    const changeLines = ch && typeof ch === 'object' ? { before: ch.before || '', after: ch.after || '', at: ch.at || null } : null
    const lines = (flow.derived?.story || []).map(l => ({ who: l.who || '', did: l.did || '', why: l.why || '', derived: !!l.derived }))
    // ⚠️ The open asks are in the model, not read off the flow by the Story: fill() redraws only when the
    // model's signature changes, so an answer that changed nothing else on Output left the answered ask
    // on the Story with its Yes and No, for good (pressing again answered again). Each carries its reason.
    const asks = (flow.nodes || []).filter(n => n.type === 'ask' && n.answer == null).map(n => ({
      id: n.id, title: String(n.title || '').trim(), kind: n.kind || 'yesno', yes: n.yes || '', no: n.no || '', why: D().reason(flow, n),
    }))
    return {
      story: { lines, derived: !lines.length || lines.some(l => l.derived), asks },
      visual,
      result: result.length ? result : latest,
      before,
      change: changeLines,
      diagram,
      diagramBefore: drawing(out.diagramBefore),
      picture: visual === 'auto' ? window.FlowPicture.graph(flow) : null,
      summary,
      changes: changes.length ? changes : proofChanges,
      testing,
      requestedAt: out.requestedAt || null,
      requestSentAt: out.requestSentAt || null,
      requestError: out.requestError || null,
      complete: flow.derived?.output?.complete ?? (result.length > 0 && !!summary && testing.length > 0),
      source: { result: result.length ? 'agent' : shots.length ? 'derived' : 'empty' },
    }
  }

  /**
   * The request for test steps, as the head shows it, or null when there is nothing to say (none, or a
   * step has arrived since). The relay records what became of it (relay.mjs): `requestError` is
   * { text: 'not sent', why } until you ask again, however old; sent or still pending is
   * { text: 'requested 3m' } (Shell.ago) for 30 minutes. flow-cli.mjs `flow show` reads it the same way.
   */
  function requested(m, now) {
    const t = Date.parse(m.requestedAt || '')
    if (!Number.isFinite(t) || m.testing.some(s => Date.parse(s.at || '') > t)) return null
    if (m.requestError) return { text: 'not sent', why: m.requestError }
    if (now - t > FRESH_MS) return null
    return { text: `requested ${window.Shell.ago(m.requestedAt, now)}`, why: '' }
  }

  // ═══ html ═══ each block is its own small module over one render context; every keyed piece
  // carries data-sb, and render() keeps its signature for fill().

  /** Details: the summary (md, with chips) and the changes, collapsed; nothing when there is neither. */
  function detailsBlock(c) {
    const { m, flow } = c
    if (!m.summary && !m.changes.length) return ''
    // a change is collapsed to one line, as on Status, and loads when opened
    const changeItem = (ch, i) => `<li class="fl-ev sb-ev" ${c.keyed(`c:${i}`, ch)}><details><summary>${D().evidenceHead(ch)}<code class="fl-ref">${esc(ch.ref.slice(0, 40))}</code></summary>
        <div class="fl-ev-body">${D().evidenceBody(ch)}</div></details></li>`
    const n = m.changes.length
    return `<details class="ob ob-details" aria-label="Details" data-ob-details ${c.keyed('details', [m.summary, m.changes])}${details.get(flow.id) ? ' open' : ''}>` +
      `<summary class="ob-sum"><span class="ob-h">Details</span>${n ? ` <span class="faint small">· Changes ${n}</span>` : ''}</summary>` +
      (m.summary ? `<div class="sb-md">${D().md(m.summary)}</div>` : '') +
      (n ? `<details class="ob-changes" ${c.keyed('changes', m.changes)}><summary class="sb-sub">Changes <span class="faint">· ${n}</span></summary>` +
        `<ul class="sb-evlist">${m.changes.map(changeItem).join('')}</ul></details>` : '') + '</details>'
  }

  /** Before / Now, a slim block of its own right under the Story; nothing without a change. */
  const changeBlock = c => (c.m.change ? `<section class="ob ob-change" aria-label="What changed" ${c.keyed('change', c.m.change)}>` +
    `${window.FlowCompare.strip(c.m)}</section>` : '')

  function render(flow, now = Date.now()) {
    const m = model(flow)
    const done = new Set(checklist.get(flow.id))
    const keys = new Map()
    const charts = new Map() // data-dg key -> { graph, title }, for fill() to redraw at the real width
    const keyed = (key, sig) => { keys.set(key, JSON.stringify(sig)); return `data-sb="${esc(key)}"` }
    const c = {
      flow, m, done, keyed, charts, checklist,
      ticked: m.testing.filter(t => done.has(checklist.of(t))).length,
      asked: requested(m, now),
      /** A block head: the name (· N), a tag, then anything else on the same row (a switch, a button) at its end. */
      head: (name, n, tag = '', extra = '') => `<div class="ob-head"><h3 class="ob-h">${name}${n ? ` <span class="faint">· ${n}</span>` : ''}</h3>${tag}` +
        `${extra ? `<span class="ob-head-end">${extra}</span>` : ''}</div>`,
      /** A chart's box: drawn now at DRAW_W, redrawn by fill() for its real width. Keyed by its graph alone. */
      chart: (key, graph, title) => {
        charts.set(key, { graph, title })
        return `<div class="dg-host" data-dg="${esc(key)}" ${keyed(`dg:${key}`, graph)}>${window.Diagram.svg(graph, { dir: 'auto', maxWidth: DRAW_W, title })}</div>`
      },
    }
    // a result screenshot on show: on a wide stage it sits beside How to test (flow-output.css .ob-split), both in
    // view; a before and after pair needs the whole width, How to test under it
    const C = window.FlowCompare
    const split = window.FlowVisual.shows(m) === 'screens' && !C.pairs(m).pairs.length ? ' ob-split' : ''
    const html = `<div class="ob-col${split}">${window.FlowStory.html(c)}${changeBlock(c)}${window.FlowVisual.html(c)}${window.FlowSteps.html(c)}${detailsBlock(c)}${window.FlowSend.html(c)}</div>`
    const send = [flow.output?.merge, flow.output?.pr, flow.derived?.output?.merge, window.FlowSend.sig(flow.id)]
    return { html, keys, charts, sig: JSON.stringify([m, [...done], c.asked, flow.agent, window.FlowVisual.pref.get(), C.step.raw(flow.id), send]) }
  }

  const html = (flow, now) => render(flow, now).html

  // ═══ fill: in place, the same keyed swap as flow-status.js ═══

  const drawn = new WeakMap() // root -> { sig, keys, charts } last drawn
  const shown = new WeakMap() // root -> the flow last drawn, for the handlers
  const bound = new WeakSet()

  function fill(root, flow) {
    if (!root) return
    bind(root)
    shown.set(root, flow)
    window.FlowSend.update(flow, () => fill(root, shown.get(root))) // the Send facts, or the pull request's checks, when due
    const r = render(flow)
    const prev = drawn.get(root)
    if (prev && prev.sig === r.sig) return redraw(root)
    const doc = root.ownerDocument
    // ⚠️ Both taken BEFORE any live node moves (see flow-status.js fill).
    const focused = root.contains(doc.activeElement) ? doc.activeElement : null
    const win = doc.defaultView
    const y = win?.scrollY
    const fresh = doc.createElement('div')
    fresh.innerHTML = r.html
    if (prev) {
      const old = new Map([...root.querySelectorAll('[data-sb]')].map(el => [el.dataset.sb, el]))
      for (const el of [...fresh.querySelectorAll('[data-sb]')]) {
        const k = el.dataset.sb
        if (old.has(k) && fresh.contains(el) && prev.keys.get(k) === r.keys.get(k)) el.replaceWith(old.get(k))
      }
    }
    root.replaceChildren(...fresh.childNodes)
    if (focused?.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true })
    if (win && win.scrollY !== y) win.scrollTo(win.scrollX, y)
    drawn.set(root, { sig: r.sig, keys: r.keys, charts: r.charts })
    redraw(root)
    sync(root, flow)
  }

  /**
   * Each chart drawn for the width of its own box (LR while two columns fit, else TB; wrapped, never
   * scaled). A kept box whose width has not changed keeps its SVG; a hidden one (0 px) waits.
   */
  function redraw(root) {
    const charts = drawn.get(root)?.charts
    for (const host of root.querySelectorAll('[data-dg]')) {
      const c = charts?.get(host.dataset.dg)
      const w = host.clientWidth
      if (!c || !w) continue
      const at = `${w}|${JSON.stringify(c.graph)}`
      if (host._drawnAt === at) continue
      host._drawnAt = at
      host.innerHTML = window.Diagram.svg(c.graph, { dir: 'auto', maxWidth: w, title: c.title })
    }
  }

  /** What a kept node may hold stale: a tick (from another tab), and the button's expanded state. */
  function sync(root, flow) {
    const done = new Set(checklist.get(flow.id))
    for (const box of root.querySelectorAll('[data-sb-saw]')) box.checked = done.has(box.dataset.sbSaw)
    const form = root.querySelector('[data-sb-form]')
    root.querySelector('[data-sb-request]')?.setAttribute('aria-expanded', String(!!form && !form.hidden))
  }

  function bind(root) {
    if (bound.has(root)) return
    bound.add(root)
    // A change loads when ITS row is opened; Details remembers being open, per flow.
    root.addEventListener('toggle', e => {
      const flow = shown.get(root)
      if (e.target.matches?.('[data-ob-details]') && flow) details.set(flow.id, e.target.open)
      else if (e.target.open && e.target.closest('.sb-ev')) D().fill(e.target)
    }, true)
    window.Lightbox.bind(root)
    // the before and after slider and its stepper (flow-compare.js)
    window.FlowCompare.bind(root, () => shown.get(root), flow => fill(root, flow))
    // the Send bar: open the review, send, try again (flow-send.js)
    window.FlowSend.bind(root, () => shown.get(root), () => fill(root, shown.get(root)))
    // the window or the page around it changes the width: each chart re-wraps (guarded: the tests have no observer)
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => redraw(root)).observe(root)
    root.addEventListener('change', e => {
      const box = e.target.closest?.('[data-sb-saw]')
      const flow = shown.get(root)
      if (!box || !flow) return
      checklist.set(flow.id, box.dataset.sbSaw, box.checked)
      fill(root, flow) // the count in the head; the steps themselves are kept
    })
    root.addEventListener('click', e => {
      const pic = e.target.closest('[data-pic]')
      if (pic) {
        window.FlowVisual.pref.set(pic.dataset.pic)
        return fill(root, shown.get(root))
      }
      const form = root.querySelector('[data-sb-form]')
      if (!form) return
      if (e.target.closest('[data-sb-request]')) {
        form.hidden = !form.hidden
        if (!form.hidden) form.querySelector('input').focus()
      } else if (e.target.closest('[data-sb-cancel]')) form.hidden = true
      else return
      sync(root, shown.get(root))
    })
    root.addEventListener('submit', e => {
      const form = e.target.closest('[data-sb-form]')
      if (!form) return
      e.preventDefault()
      void send(root, form)
    })
  }

  /** POST the request; via the chat, the text goes into the Ask drawer for the user to send. */
  async function send(root, form) {
    const flow = shown.get(root)
    const button = form.querySelector('[type="submit"]')
    const error = form.querySelector('.sb-req-error')
    const note = form.elements.note.value.trim()
    button.disabled = true
    error.hidden = true
    try {
      const r = await fetch(`/api/flows/${encodeURIComponent(flow.id)}/request-tests`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(note ? { note } : {}),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
      form.hidden = true
      form.reset()
      if (j.via === 'chat') window.FactoryChat?.prefill(j.text)
      else {
        // the head says requested now at once; the route cleared the last outcome, so this copy does too
        flow.output = { ...flow.output, requestedAt: j.requestedAt, requestSentAt: null, requestError: null }
        fill(root, flow)
        window.FlowsView?.load()
      }
      sync(root, shown.get(root))
    } catch (err) {
      error.textContent = err.message
      error.hidden = false
    } finally {
      button.disabled = false
    }
  }

  window.FlowOutput = { model, html, fill, checklist, details }
})()
