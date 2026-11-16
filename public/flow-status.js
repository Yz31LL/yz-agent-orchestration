// The Status view of an opened flow (flows.js shows it behind the Status tab;
// Output is the storyboard, Process the chart). It answers "where does this
// flow stand?" row by row:
//
//   model(flow, now?)  PURE: { built, missing, decisions, notes, shots } from the
//                      flow and its server-side `derived` (no DOM, so the Node
//                      tests run it in a vm)
//   html(flow)         the markup: a one-line summary, then Built, Left,
//                      Decisions, Notes (hidden when 0) and Proof (the
//                      screenshots, hidden when 0). Each row is ONE line with its
//                      proof mark; a built row's evidence folds behind it (a click
//                      on the row opens it, remembered while the page is open)
//   fill(root, flow)   draw into `root`, in place: a poll that changed nothing
//                      touches nothing, and a poll that changed one row keeps
//                      every OTHER row's DOM (its loaded diff, its open
//                      <details>, typed text), so nothing is fetched twice
//   reveal / revealOnce  a link that opens the flow at a node lands on its row
//
// ═══ NOTHING IS DRAWN TWICE ═══ evidence, the ask controls and the pending
// reason come from the drawer (FlowDrawer.evidenceHead / evidenceBody / ask /
// fill) and the chart (FlowChart.pendingReason); screenshots open in the shared
// lightbox (lightbox.js). Every button here carries the same data-* hooks the
// drawer uses, and flows.js answers, retries and ticks verified from its ONE
// handler, so this file never posts anything.
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const D = () => window.FlowDrawer
  const WORK = ['step', 'check']
  const MISSING = ['todo', 'doing', 'blocked'] // skipped is a decision not to, so it is not missing

  // ═══ model: pure ═══

  function model(flow, now = Date.now()) {
    const d = flow.derived || {}
    const reasons = window.FlowChart.pendingReasons(flow)
    const out = { built: [], missing: [], decisions: [], notes: [], shots: [] }
    for (const n of flow.nodes || []) {
      const env = n.env || flow.env || ''
      if (WORK.includes(n.type) && n.status === 'done') {
        const proof = d.proof?.[n.id] || (n.verified ? 'verified' : n.evidence?.length ? 'claimed' : 'unproven')
        out.built.push({ id: n.id, title: n.title, env, proof, evidence: n.evidence || [] })
      } else if (WORK.includes(n.type) && MISSING.includes(n.status)) {
        const reason = window.FlowChart.pendingReason(flow, n.id, reasons)
        out.missing.push({ id: n.id, title: n.title, env, status: n.status, pending: !!reason, reason })
      } else if (n.type === 'ask') {
        out.decisions.push({
          id: n.id, question: n.title, kind: n.kind || 'yesno', yes: n.yes ?? '', no: n.no ?? '',
          answer: n.answer ?? null, answeredAt: n.answeredAt ?? null, note: n.note ?? '',
          open: n.answer == null, delivery: D().deliveryState(n, now), why: D().reason(flow, n),
        })
      } else if (n.type === 'note') {
        out.notes.push({ id: n.id, title: n.title, text: n.why || '' })
      }
      for (const e of n.evidence || []) {
        if (e.kind === 'shot') out.shots.push({ nodeId: n.id, nodeTitle: n.title, ref: String(e.ref ?? ''), caption: e.label || '' })
      }
    }
    return out
  }

  // ═══ html ═══ every keyed piece carries data-sv, and render() keeps its signature for fill()

  // The proof marks of the ? legend in flows.js: the same glyphs and the same ok / cl / un classes.
  const MARK = { verified: ['ok', '✓'], claimed: ['cl', '●'], unproven: ['un', '●'] }
  const pill = env => (env ? `<span class="fl-env env-${esc(env)}">${esc(env)}</span>` : '')
  // a title's marked words are term chips (FlowDrawer.chips): hovering one explains it, clicking it pins the card, not the link
  /** The rows whose evidence is unfolded, `<flow id>:<node id>`, for the life of the page. */
  const unfolded = new Set()
  /** A title as plain words, for an aria-label (its marked words without brackets). */
  const plainTitle = t => (window.Terms?.plain ? window.Terms.plain(t) : String(t ?? '').replace(/[[\]]/g, ''))
  const goto = (id, title) => `<button type="button" class="link sv-title" data-goto="${esc(id)}" title="Show it in the Process chart">${D().chips(esc(title))}</button>`

  function render(flow, now = Date.now()) {
    const m = model(flow, now)
    const keys = new Map()
    const keyed = (key, sig) => { keys.set(key, JSON.stringify(sig)); return `data-sv="${esc(key)}"` }
    const nodeOf = id => flow.nodes.find(n => n.id === id)

    const evItem = (nodeId, e, i) => {
      const at = keyed(`e:${nodeId}:${i}`, e)
      const body = `<div class="fl-ev-body">${D().evidenceBody(e)}</div>`
      // Commits and diffs are long: collapsed to their one line, loaded when opened.
      if (e.kind === 'commit' || e.kind === 'diff') {
        return `<li class="fl-ev sv-ev" ${at}><details><summary>${D().evidenceHead(e)}<code class="fl-ref">${esc(String(e.ref ?? '').slice(0, 40))}</code></summary>${body}</details></li>`
      }
      return `<li class="fl-ev sv-ev" ${at}>${D().evidenceHead(e)}${body}</li>`
    }
    // an env pill only where a row's env differs from the flow's: the head already says the flow's
    const envOf = env => (env && env !== (flow.env || '') ? pill(env) : '')
    const built = b => {
      const [cls, glyph] = MARK[b.proof] || MARK.unproven
      const head = `<b class="sv-mark ${cls}" title="${esc(b.proof)}">${glyph}</b>${goto(b.id, b.title)}${envOf(b.env)}
          <input type="checkbox" class="sv-verify" data-verify="${esc(b.id)}" aria-label="Verified: ${esc(plainTitle(b.title))}"${b.proof === 'verified' ? ' checked' : ''}>`
      if (!b.evidence.length) return `<li class="sv-row" ${keyed(`b:${b.id}`, b)}><div class="sv-row-head">${head}</div></li>`
      const open = unfolded.has(`${flow.id}:${b.id}`) ? ' open' : ''
      return `<li class="sv-row" ${keyed(`b:${b.id}`, [b, !!open])}><details class="sv-fold" data-fold="${esc(`${flow.id}:${b.id}`)}"${open}>
          <summary class="sv-row-head" title="Show the proof">${head}</summary>
          <ul class="sv-evlist">${b.evidence.map((e, i) => evItem(b.id, e, i)).join('')}</ul></details></li>`
    }
    const missing = x => `<li class="sv-row${x.pending ? ' is-pending' : ''}" ${keyed(`m:${x.id}`, x)}><div class="sv-row-head">
        <span class="fl-status fs-${esc(x.status)}">${esc(x.status)}</span>${goto(x.id, x.title)}${envOf(x.env)}</div>
        ${x.reason ? `<p class="sv-sub sv-reason">${esc(x.reason)}</p>` : ''}</li>`
    const decision = x => {
      const n = nodeOf(x.id)
      return `<li class="sv-row sv-ask${x.open ? ' is-open' : ''}" ${keyed(`d:${x.id}`, x)}><div class="sv-row-head">
          <b class="sv-q" aria-hidden="true">?</b>${goto(x.id, x.question)}</div>
          ${D().why(x.why, { tag: 'div', cls: 'fl-why sv-md', markdown: true })}${D().ask(n)}</li>`
    }
    // why and note text are agent Markdown: the drawer and the header render it with the same md() helper.
    const note = x => `<li class="sv-row sv-note" ${keyed(`n:${x.id}`, x)}><div class="sv-row-head">${goto(x.id, x.title)}</div>
        ${x.text ? `<div class="fl-why sv-md">${D().md(x.text)}</div>` : ''}</li>`
    const shot = (s, i) => `<li class="sv-shot" ${keyed(`s:${s.nodeId}:${i}`, s)}><figure>
        ${D().evidenceBody({ kind: 'shot', ref: s.ref, label: s.caption })}
        <figcaption>${s.caption ? `${esc(s.caption)} · ` : ''}${goto(s.nodeId, s.nodeTitle)}</figcaption></figure></li>`

    /** `Name · N`, then the rows; with none, the `empty` line, or nothing at all when `empty` is null. */
    const section = (name, list, row, empty, cls = 'sv-list', hint = '') => {
      if (!list.length && empty == null) return ''
      const tip = hint && list.length ? ` <span class="sv-hint">${hint}</span>` : ''
      return `<section class="sv-sec"><h3 class="sv-h">${name} <span class="faint">· ${list.length}</span>${tip}</h3>
        ${list.length ? `<ul class="${cls}">${list.map(row).join('')}</ul>` : `<p class="small faint sv-empty">${empty}</p>`}</section>`
    }

    const { done = 0, total = 0 } = flow.derived?.progress || {}
    const waiting = m.decisions.filter(x => x.open).length
    const verified = m.built.filter(b => b.proof === 'verified').length
    // a count of nothing says nothing: only the ones above zero
    const summary = [`${done}/${total} done`, waiting && `${waiting} waiting`, verified && `${verified} verified`].filter(Boolean).join(' · ')
    const html = `<p class="sv-summary">${summary}</p>` +
      section('Built', m.built, built, 'Nothing built yet.', 'sv-list', 'tick = you verified it') +
      section('Left', m.missing, missing, 'Nothing left.') +
      section('Decisions', m.decisions, decision, 'No decisions.') +
      section('Notes', m.notes, note, null) +
      section('Proof', m.shots, shot, null, 'sv-shots')
    return { html, keys, sig: JSON.stringify([m, done, total]) }
  }

  const html = flow => render(flow).html

  // ═══ fill: in place ═══

  /** root -> what was drawn last: the whole signature, and each keyed piece's */
  const drawn = new WeakMap()
  const bound = new WeakSet()

  function fill(root, flow) {
    if (!root) return
    bind(root)
    const r = render(flow)
    const prev = drawn.get(root)
    if (prev && prev.sig === r.sig) return // the poll changed nothing here
    const doc = root.ownerDocument
    // ⚠️ Both taken BEFORE any live node moves: moving the focused field out of the page blurs it, and
    // reading scrollY while the rows are out forces a layout of a SHORT page, which clamps it (often to 0).
    const focused = root.contains(doc.activeElement) ? doc.activeElement : null
    const win = doc.defaultView
    const y = win?.scrollY
    const fresh = doc.createElement('div')
    fresh.innerHTML = r.html
    if (prev) {
      // Put each unchanged piece's LIVE node back in place of its fresh copy, outermost first:
      // an unchanged row brings its children along, and a changed row still keeps its unchanged evidence.
      const old = new Map([...root.querySelectorAll('[data-sv]')].map(el => [el.dataset.sv, el]))
      for (const el of [...fresh.querySelectorAll('[data-sv]')]) {
        const k = el.dataset.sv
        if (old.has(k) && fresh.contains(el) && prev.keys.get(k) === r.keys.get(k)) el.replaceWith(old.get(k))
      }
    }
    root.replaceChildren(...fresh.childNodes) // no layout ran in between, so the page never saw it short
    if (focused?.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true })
    if (win && win.scrollY !== y) win.scrollTo(win.scrollX, y) // a lost scroll anchor must not move the page either
    drawn.set(root, { sig: r.sig, keys: r.keys })
    loadOpen(root)
  }

  /** Load what is on show: every evidence body not inside a closed <details> (a test's output file, say). */
  function loadOpen(root) {
    for (const body of root.querySelectorAll('.fl-ev-body')) if (!body.closest('details:not([open])')) D().fill(body)
  }

  function bind(root) {
    if (bound.has(root)) return
    bound.add(root)
    // toggle does not bubble, so capture: a commit or diff loads the first time it is opened.
    root.addEventListener('toggle', e => {
      const fold = e.target.dataset?.fold
      if (fold) e.target.open ? unfolded.add(fold) : unfolded.delete(fold) // a poll keeps it as you left it
      if (e.target.open) D().fill(e.target)
    }, true)
    window.Lightbox.bind(root) // a screenshot opens full size; a missing one reads as one line
  }

  // ═══ reveal ═══ a link that opens a flow AT a node (the strip's show in flow, a toast's Open or Retry)
  // lands here (flows.js shows Status for it, since Output has no row per node): that node's row scrolls
  // into view and flashes. ONCE per open: `state` is flows.js's opened flow, whose `reveal` holds the
  // node until the first draw that has its row.

  const ROW_KEYS = ['d', 'b', 'm', 'n'] // decision, built, missing, note: every row a node can have
  /** Scroll to and flash `nodeId`'s row in `root`; false when it has none (a skipped step). */
  function reveal(root, nodeId) {
    const keys = ROW_KEYS.map(p => `${p}:${nodeId}`)
    const row = [...root.querySelectorAll('[data-sv]')].find(el => keys.includes(el.dataset.sv))
    if (!row) return false
    row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    row.classList.remove('sv-flash')
    row.classList.add('sv-flash') // the outline fade in flows.css; none under reduced motion
    setTimeout(() => row.classList.remove('sv-flash'), 1800)
    return true
  }
  /** The one-shot: reveals `state.reveal` and clears it, so the 15 s polls never scroll the page again. */
  function revealOnce(root, state) {
    if (!state?.reveal) return false
    const id = state.reveal
    state.reveal = null
    state.revealed = reveal(root, id)
    return state.revealed
  }

  window.FlowStatus = { model, html, fill, reveal, revealOnce }
})()
