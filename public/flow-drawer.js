// The drawer under an opened flow's chart (flows.js owns it and its actions):
// one node in full. Rendering only; every button and field here carries a
// data-* hook that flows.js handles, so this file never posts anything.
//
//   html(flow, node, pending)  the markup; `pending` is the dimmed-node reason or ''
//   fill(el)                   loads the evidence that needs a fetch (commit, diff,
//                              a test's output file) into its placeholders
//   delivery(node)             `sent` / `not delivered · retry` / `sending…` /
//                              `not sent yet · retry` for an answered ask
//   deliveryState(node, now?)  which of those four it is (flows.js draws the chart's from it)
//   ask, evidenceHead, evidenceBody, evidenceUrl, md, chips   pieces the Output and Status views reuse
//   reason(flow, node)         why an ask is asked: { text, auto } (flows.mjs askReason, via derived.reasons)
//   why(reason, opts)          that reason as the `Why? …` line under a question: the strip, the Story,
//                              Status and this drawer all draw it, so an ask is never a bare question
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  /** Escaped text with its marked words ([word]) as term chips (terms.js); the text itself when terms.js is not loaded. */
  const chips = s => (window.Terms ? window.Terms.html(s) : s)
  /** Agent Markdown, with term chips: every md() on the flow pages goes through here. */
  const md = s => chips(window.FactoryChat?.md ? window.FactoryChat.md(s) : `<p>${esc(s)}</p>`)
  /** /evidence/<flow>/<file>, each segment encoded (the ref is agent-written text). */
  const evidenceUrl = ref => '/evidence/' + String(ref).split('/').map(encodeURIComponent).join('/')
  const ext = ref => (/\.([a-z0-9]+)$/i.exec(String(ref)) || [])[1]?.toLowerCase() || ''
  const IMAGE = ['png', 'jpg', 'jpeg', 'webp', 'gif']
  const VIDEO = ['webm', 'mp4']
  const NODE_STATUS = ['todo', 'doing', 'done', 'blocked', 'skipped'] // MUST CHANGE IN LOCKSTEP with flows.mjs NODE_STATUS
  // The words public/glossary.json explains (explain.js): node types, proof states, evidence kinds.
  const TERMS = ['step', 'check', 'ask', 'note', 'claimed', 'unproven', 'verified', 'commit', 'diff', 'test', 'shot', 'url']
  /** `word` as a <dfn> when the glossary has it, else plain escaped text (agent-written values never become terms). */
  const term = word => (TERMS.includes(word) ? `<dfn data-term="${word}" tabindex="0">${word}</dfn>` : esc(word))

  /** How long an answer may sit unsent (the relay's 30 s wait plus a turn of up to 90 s) before a retry is offered. */
  const STALE_MS = 2 * 60_000
  /**
   * An answered ask's delivery: `sent`, `failed` (deliveryError), `sending`
   * (neither yet, answered under STALE_MS ago) or `stale` (neither, and older:
   * the answer may have been lost, so the page offers a retry); '' when open.
   */
  function deliveryState(n, now = Date.now()) {
    if (n.answer == null) return ''
    if (n.sentAt) return 'sent'
    if (n.deliveryError) return 'failed'
    const at = Date.parse(n.answeredAt || '')
    return Number.isFinite(at) && now - at <= STALE_MS ? 'sending' : 'stale'
  }
  function delivery(n) {
    const retry = `<button type="button" class="link" data-retry="${esc(n.id)}">retry</button>`
    switch (deliveryState(n)) {
      case 'sent': return `<span class="fl-sent" title="Delivered ${esc(window.Shell.ago(n.sentAt))}"><dfn data-term="sent" tabindex="0">sent</dfn></span>`
      case 'failed': return `<span class="fl-undelivered" title="${esc(n.deliveryError)}"><dfn data-term="not delivered" tabindex="0">not delivered</dfn> · ${retry}</span>`
      case 'sending': return '<span class="fl-sending" title="The answer goes to the agent within about two minutes">sending…</span>'
      case 'stale': return `<span class="fl-undelivered" title="Still not sent after two minutes">not sent yet · ${retry}</span>`
      default: return ''
    }
  }
  // ─── why an ask is asked ───

  /**
   * Why the user is asked: the server's derived.reasons (flows.mjs askReason: the agent's --why, else
   * { auto: true } with the flow and the step the ask follows). A flow with no derived yet (a test, a
   * flow fetched on its own before a poll) falls back to the node's own why, then to the flow's title.
   */
  function reason(flow, n) {
    const r = flow?.derived?.reasons?.[n.id]
    if (r && typeof r.text === 'string' && r.text.trim()) return { text: r.text, auto: !!r.auto }
    const own = String(n.why ?? '').trim()
    return own ? { text: own, auto: false } : { text: `Part of ${String(flow?.title ?? '').trim()}`, auto: true }
  }
  /**
   * The reason as one `Why? …` line under the question. `markdown`: the agent's why is Markdown (Status and
   * this drawer render it); elsewhere it is one plain line with term chips. The fallback is the dashboard's
   * own words, never Markdown, and carries is-auto (drawn fainter, so it does not pass for the agent's).
   */
  function why(r, { tag = 'p', cls = '', markdown = false } = {}) {
    const body = markdown && !r.auto ? md(r.text) : chips(esc(r.text))
    return `<${tag} class="${cls ? `${cls} ` : ''}fl-ask-why${r.auto ? ' is-auto' : ''}"><span class="st-why-k">Why?</span> ${body}</${tag}>`
  }

  const answerWord = n => (n.answer === 'yes' ? 'Yes' : n.answer === 'no' ? 'No' : String(n.answer))

  // ─── one node, by type ───

  function work(n, flow) {
    const proof = flow.derived?.proof?.[n.id]
    const ev = n.evidence || []
    return `<div class="fl-dctl">
        <label class="small">Status <select data-node-status="${esc(n.id)}">${NODE_STATUS.map(s => `<option value="${s}" ${n.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" data-verify="${esc(n.id)}" ${n.verified ? 'checked' : ''}> verified</label>
        ${proof && proof !== 'verified' ? `<span class="fl-proof proof-${esc(proof)}">${term(proof)}</span>` : ''}
        ${n.verified ? `<span class="small faint">ticked by ${esc(n.verified.by)} ${esc(window.Shell.ago(n.verified.at))}</span>` : ''}
        ${n.env ? `<span class="fl-env env-${esc(n.env)}">${esc(n.env)}</span>` : ''}
      </div>
      <h4>Evidence</h4>
      ${ev.length ? `<ul class="fl-evlist">${ev.map(evidence).join('')}</ul>` : '<p class="small faint">No evidence yet.</p>'}`
  }

  function ask(n) {
    const meanings = n.kind === 'text' ? '' : `<dl class="fl-means">
        ${n.yes ? `<dt>Yes</dt><dd>${chips(esc(n.yes))}</dd>` : ''}${n.no ? `<dt>No</dt><dd>${chips(esc(n.no))}</dd>` : ''}</dl>`
    if (n.answer != null) {
      const meaning = n.answer === 'yes' ? n.yes : n.answer === 'no' ? n.no : ''
      return `<div class="fl-answered ans-${n.answer === 'yes' ? 'yes' : n.answer === 'no' ? 'no' : 'text'}">
          <b>${esc(answerWord(n))}</b>${meaning ? ` <span>${chips(esc(meaning))}</span>` : ''}
          <span class="faint">· ${esc(window.Shell.ago(n.answeredAt))}</span> ${delivery(n)}
          <button type="button" class="link" data-reopen="${esc(n.id)}">Change</button>
        </div>${n.note ? `<p class="small">Note: ${esc(n.note)}</p>` : ''}`
    }
    if (n.kind === 'text') {
      return `<form class="fl-text" data-text="${esc(n.id)}"><input name="answer" data-key="drawer-text:${esc(n.id)}" placeholder="Your answer" required aria-label="Your answer"><button type="submit" class="primary">Save</button></form>`
    }
    const board = window.FlowBoard // the buttons named by their meaning, and the own-words field, as in Human review
    const buttons = board?.choiceButtons ? board.choiceButtons(n) : `<button type="button" class="fl-yes" data-answer="yes" data-node="${esc(n.id)}">Yes</button>
        <button type="button" class="fl-no" data-answer="no" data-node="${esc(n.id)}">No</button>`
    return `${meanings}<div class="fl-yn">
        ${buttons}
        <input data-note="${esc(n.id)}" data-key="drawer-note:${esc(n.id)}" placeholder="A note for the agent (optional)" aria-label="A note for the agent">
      </div>${board?.otherAnswer ? board.otherAnswer(n, `drawer-other:${n.id}`) : ''}`
  }

  // ─── evidence ───

  /** The kind, the label and when: one line (the Output view puts it in a <summary>). */
  const evidenceHead = e =>
    `<div class="fl-ev-head"><span class="fl-ev-kind">${term(e.kind)}</span>${e.label ? `<span>${esc(e.label)}</span>` : ''}<span class="faint">${esc(window.Shell.ago(e.at))}</span></div>`
  function evidence(e) {
    return `<li class="fl-ev">${evidenceHead(e)}<div class="fl-ev-body">${evidenceBody(e)}</div></li>`
  }

  /** The body now, or a placeholder that fill() loads (data-load + what to load). */
  function evidenceBody(e) {
    const ref = String(e.ref ?? '')
    const wait = (kind, value) => `<div data-load="${kind}" data-ref="${esc(value)}" class="small faint">Loading…</div>`
    switch (e.kind) {
      case 'commit': return `<code class="fl-ref">${esc(ref)}</code>${wait('commit', ref)}`
      case 'diff': return `<span class="small">Uncommitted changes in <code class="fl-ref">${esc(ref)}</code></span>${wait('diff', ref)}`
      case 'test': {
        const file = e.file ? (ext(e.file) === 'txt' ? wait('text', e.file) : `<a class="link" href="${esc(evidenceUrl(e.file))}" target="_blank" rel="noopener">the full output</a>`) : ''
        return `<code class="fl-testline">${esc(ref)}</code>${file}`
      }
      case 'shot': {
        const url = esc(evidenceUrl(ref))
        const x = ext(ref)
        if (IMAGE.includes(x)) return `<a href="${url}" target="_blank" rel="noopener"><img class="fl-shot" src="${url}" alt="${esc(e.label || ref)}" loading="lazy"></a>`
        if (VIDEO.includes(x)) return `<video class="fl-shot" src="${url}" controls preload="metadata"></video>`
        return `<a class="link" href="${url}" target="_blank" rel="noopener">${esc(ref)}</a>`
      }
      // Only http(s): a javascript: or data: ref must never become a live link.
      case 'url': return /^https?:\/\//i.test(ref) ? `<a class="link" href="${esc(ref)}" target="_blank" rel="noopener noreferrer">${esc(ref)}</a>` : `<span>${esc(ref)}</span>`
      default: return `<p class="fl-evnote">${esc(ref)}</p>`
    }
  }

  // A commit never changes, so its fetch is kept for the page's life.
  const commits = new Map()
  async function fetchJson(url) {
    const r = await fetch(url)
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }
  }
  const LOADERS = {
    async commit(sha) {
      if (!commits.has(sha)) commits.set(sha, fetchJson(`/api/commit?sha=${encodeURIComponent(sha)}`))
      const r = await commits.get(sha)
      if (r.status === 404) return '<p class="small faint">not found in the repo</p>'
      if (!r.ok) return `<p class="small warn">${esc(r.body.error || `Could not load (${r.status})`)}</p>`
      const c = r.body
      const p = c.patch ? window.Diff.patch(c.patch) : null
      return `<div class="fl-commit"><b>${esc(c.subject)}</b>
          <span class="small faint">${esc(String(c.sha || '').slice(0, 9))} · ${esc(c.author)} · ${esc(c.date)}</span>${p ? window.Diff.counts(p.add, p.del) : ''}</div>
        ${p?.html || '<p class="small faint">No file changes.</p>'}`
    },
    async diff(worktree) {
      const r = await fetchJson(`/api/diff?worktree=${encodeURIComponent(worktree)}`)
      if (r.status === 404) return '<p class="small faint">no such worktree</p>'
      if (!r.ok) return `<p class="small warn">${esc(r.body.error || `Could not load (${r.status})`)}</p>`
      const p = r.body.patch ? window.Diff.patch(r.body.patch) : null
      return p?.html || '<p class="small faint">No uncommitted changes.</p>'
    },
    async text(file) {
      const r = await fetch(evidenceUrl(file))
      if (!r.ok) return '<p class="small faint">The output file is missing.</p>'
      return `<pre class="fl-output">${esc(await r.text())}</pre>`
    },
  }

  /**
   * Load every placeholder in `el`; a drawer re-rendered meanwhile drops the stale result.
   * A slot already loading is left alone, so calling fill again (the Output view does, as
   * rows open) never fetches the same thing twice.
   */
  function fill(el) {
    for (const slot of el.querySelectorAll('[data-load]')) {
      if (slot.dataset.busy) continue
      slot.dataset.busy = '1'
      const load = LOADERS[slot.dataset.load]
      load(slot.dataset.ref)
        .catch(err => `<p class="small warn">${esc(err.message)}</p>`)
        .then(html => {
          if (slot.isConnected) slot.outerHTML = html
        })
    }
  }

  function html(flow, n, pending) {
    const chat = window.FactoryChat?.name || 'Independent'
    const body = n.type === 'ask' ? ask(n) : n.type === 'note' ? '' : work(n, flow)
    return `<div class="fl-drawer-head">
        <span class="fl-dtype type-${esc(n.type)}">${term(n.type)}</span>
        <b class="fl-dtitle">${chips(esc(n.title))}</b>
        <button type="button" class="link" data-drawer-close>Close</button>
      </div>
      ${pending ? `<p class="fl-pending-note">${esc(pending)}</p>` : ''}
      ${n.type === 'ask' ? why(reason(flow, n), { tag: 'div', cls: 'fl-why', markdown: true }) : n.why ? `<div class="fl-why">${md(n.why)}</div>` : ''}
      ${body}
      <div class="fl-drawer-foot"><button type="button" data-ask-chat="${esc(n.id)}">Ask ${esc(chat)} about this step</button></div>`
  }

  // evidenceHead, evidenceBody, evidenceUrl, ask and md are shared with the Output view (flow-output.js), so
  // evidence, Markdown and the Yes / No controls are drawn ONE way, and flows.js answers both from one handler.
  window.FlowDrawer = { html, fill, delivery, deliveryState, ask, reason, why, evidenceHead, evidenceBody, evidenceUrl, md, chips }
})()
