// Master's insight on the page, the DOM half (the markup is insight-view.js):
//
//   SuggestionsPage   #/suggestions[?id=<id>]: GET /api/insight/suggestions; Accept, Accept and add the rule, Reject
//                     (with an optional reason), Mark done: POST /api/insight/suggestions/<id> { do, reason? }
//   HealthPage        #/health: GET /api/heal, again every 30 s while it shows; the per-check switch, Resume, Release,
//                     Stop (after a confirm) and Copy a nudge (copies a sentence; sends nothing): POST /api/heal/...
//   the lines         GET /api/insight/summary every minute (and on each page change): the lines at the top of the
//                     Agents page ([data-insight-agents]), Home's line ([data-insight-home]) and the count on the
//                     Suggestions rail link
//
// Focus stays where the user was after a press; Escape inside the reject form cancels it. Every POST is same-origin,
// so the browser sends the page's own Origin, which the server requires.
;(() => {
  window.SuggestionsPage = { open: () => {}, close: () => {} }
  window.HealthPage = { open: () => {}, close: () => {} }
  if (!window.document) return
  const doc = window.document
  const V = () => window.InsightView
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const enc = encodeURIComponent
  const HEALTH_POLL_MS = 30_000
  const SUMMARY_POLL_MS = 60_000

  async function post(url, body = {}) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    return { r, j }
  }

  // ═══ Suggestions ═══

  const sug = { state: null, ui: { busy: null, errors: {}, drafts: {}, rejecting: null, status: '' }, token: 0, focus: null }
  const sugRoot = () => doc.getElementById('suggestionsView')

  function paintSuggestions(focus) {
    const el = sugRoot()
    if (!el || !sug.state) return
    el.innerHTML = V().suggestionsHtml(sug.state, sug.ui)
    const open = sug.state.counts?.open ?? 0
    window.Shell?.setTitle('Suggestions', 'suggestions', open)
    window.Shell?.setStatus(open ? `${open} waiting for you` : 'Nothing waits for you', V().SUGGESTIONS_HELP)
    if (focus) el.querySelector(focus)?.focus()
  }

  async function loadSuggestions(focus) {
    const mine = ++sug.token
    try {
      const r = await fetch('/api/insight/suggestions', { cache: 'no-store' })
      const j = await r.json()
      if (mine !== sug.token) return
      if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
      sug.state = j
      paintSuggestions(focus)
    } catch (e) {
      if (mine === sug.token && sugRoot()) sugRoot().innerHTML = `<div class="banner">Suggestions: ${esc(e.message)}</div>`
    }
  }

  const SAID = { accept: 'Accepted: a note for you or Master to act on.', rule: 'Accepted: the rule is added, and its verdict is due on the Learn page in two weeks.', reject: 'Rejected. Master will not propose it again.', done: 'Marked done.' }
  async function decide(id, what) {
    sug.ui.busy = id
    delete sug.ui.errors[id]
    paintSuggestions()
    try {
      const { r, j } = await post(`/api/insight/suggestions/${enc(id)}`, { do: what, reason: what === 'reject' ? sug.ui.drafts[id] || '' : undefined })
      if (!r.ok) sug.ui.errors[id] = j.error || `Not saved (${r.status}).`
      else {
        sug.ui.status = SAID[what]
        sug.ui.rejecting = null
        delete sug.ui.drafts[id]
      }
    } catch (e) {
      sug.ui.errors[id] = e.message
    }
    sug.ui.busy = null
    await loadSuggestions('[data-ins-card] button')
    refreshSummary()
  }

  window.SuggestionsPage = {
    open(query = {}) {
      sug.ui = { busy: null, errors: {}, drafts: {}, rejecting: null, status: '' }
      window.Shell?.setTitle('Suggestions', 'suggestions')
      loadSuggestions().then(() => (query.id ? sugRoot()?.querySelector(`[data-ins-card="${CSS.escape(query.id)}"]`)?.scrollIntoView({ block: 'start' }) : null))
    },
    close() {
      sug.token++
    },
  }

  // ═══ Health ═══

  const heal = { view: null, ui: { busy: false, errors: {}, status: '' }, token: 0, poll: null }
  const healRoot = () => doc.getElementById('healthView')

  function paintHealth(focus) {
    const el = healRoot()
    if (!el || !heal.view) return
    const active = doc.activeElement
    const keep = focus || (active && el.contains(active) ? (active.dataset.healSwitch ? `[data-heal-switch="${CSS.escape(active.dataset.healSwitch)}"]` : null) : null)
    el.innerHTML = V().healthHtml(heal.view, heal.ui)
    const bad = heal.view.checks.filter(c => c.state === 'failing' || c.state === 'degraded').length
    window.Shell?.setTitle('Health', 'health')
    window.Shell?.setStatus(!heal.view.enabled ? 'The watchdog is off' : bad ? `${bad} not OK` : 'All OK', V().HEALTH_HELP)
    if (keep) el.querySelector(keep)?.focus()
  }

  async function loadHealth(focus) {
    const mine = ++heal.token
    try {
      const r = await fetch('/api/heal', { cache: 'no-store' })
      const j = await r.json()
      if (mine !== heal.token) return
      if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
      heal.view = j
      paintHealth(focus)
    } catch (e) {
      if (mine === heal.token && healRoot()) healRoot().innerHTML = `<div class="banner">Health: ${esc(e.message)}</div>`
    }
  }

  /** One press on the Health page: busy while it runs, the answer's view drawn, an error under its check. */
  async function healAct(url, body, { check, said, focus }) {
    heal.ui.busy = true
    delete heal.ui.errors[check]
    paintHealth()
    try {
      const { r, j } = await post(url, body)
      if (!r.ok) heal.ui.errors[check] = j.error || `Not done (${r.status}).`
      else {
        heal.ui.status = said
        if (j.checks) heal.view = j
      }
    } catch (e) {
      heal.ui.errors[check] = e.message
    }
    heal.ui.busy = false
    paintHealth(focus)
    refreshSummary()
  }

  window.HealthPage = {
    open() {
      heal.ui = { busy: false, errors: {}, status: '' }
      window.Shell?.setTitle('Health', 'health')
      loadHealth()
      clearInterval(heal.poll)
      heal.poll = setInterval(() => (heal.ui.busy ? null : loadHealth()), HEALTH_POLL_MS)
    },
    close() {
      heal.token++
      clearInterval(heal.poll)
    },
  }

  // ═══ the presses ═══

  doc.addEventListener('click', e => {
    const t = e.target.closest?.('button')
    if (!t) return
    if (sugRoot()?.contains(t)) {
      if (t.dataset.insDo && t.dataset.insDo !== 'reject') return decide(t.dataset.insId, t.dataset.insDo)
      if (t.dataset.insReject) return Object.assign(sug.ui, { rejecting: t.dataset.insReject }), paintSuggestions(`#ins-why-${CSS.escape(t.dataset.insReject)}`)
      if (t.hasAttribute('data-ins-cancel')) {
        const back = sug.ui.rejecting
        sug.ui.rejecting = null
        return paintSuggestions(back ? `[data-ins-reject="${CSS.escape(back)}"]` : null)
      }
      return
    }
    const resume = t.dataset.healResume
    if (resume) {
      e.preventDefault()
      return healAct('/api/heal/resume', { collection: resume }, { check: 'refresh', said: 'Resumed: the ticket refresh runs on its timer again.' })
    }
    if (t.dataset.healRelease) return healAct('/api/heal/release', { agent: t.dataset.healRelease }, { check: 'deliveries', said: `Released: what was kept for ${t.dataset.healRelease} went in one turn.` })
    if (t.dataset.healStop) {
      const row = t.closest('li')?.querySelector('span')?.textContent || 'this copy'
      if (!window.confirm(`Stop the dashboard copy (${row})? It stops at once; anyone looking at it loses the page.`)) return
      return healAct('/api/heal/stop', { pid: Number(t.dataset.healStop), startedAt: t.dataset.healStarted || '' }, { check: 'strays', said: 'Stopped.' })
    }
    if (t.dataset.healNudge !== undefined) {
      const n = heal.view?.checks.find(c => c.id === 'agents')?.extra?.nudges?.[Number(t.dataset.healNudge)]
      if (!n) return
      navigator.clipboard?.writeText(n.text).then(() => {
        heal.ui.status = `Copied a nudge for ${n.agent}. Paste it into that session yourself: nothing was sent.`
        paintHealth(`[data-heal-nudge="${CSS.escape(t.dataset.healNudge)}"]`)
      }, () => {
        heal.ui.errors.agents = `The browser did not allow copying. The sentence, to copy by hand: ${n.text}`
        paintHealth()
      })
    }
  })

  doc.addEventListener('change', e => {
    const sw = e.target.closest?.('[data-heal-switch]')
    if (!sw || !healRoot()?.contains(sw)) return
    const id = sw.dataset.healSwitch
    healAct('/api/heal/switch', { check: id, on: sw.checked }, { check: id, said: sw.checked ? 'Switched on: it looks again now.' : 'Switched off: it no longer looks or repairs.', focus: `[data-heal-switch="${CSS.escape(id)}"]` })
  })

  doc.addEventListener('submit', e => {
    const form = e.target.closest?.('[data-ins-reject-form]')
    if (!form) return
    e.preventDefault()
    decide(form.dataset.insRejectForm, 'reject')
  })

  doc.addEventListener('input', e => {
    const form = e.target.closest?.('[data-ins-reject-form]')
    if (form) sug.ui.drafts[form.dataset.insRejectForm] = e.target.value
  })

  doc.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !sug.ui.rejecting || !e.target.closest?.('[data-ins-reject-form]')) return
    e.preventDefault()
    const back = sug.ui.rejecting
    sug.ui.rejecting = null
    paintSuggestions(`[data-ins-reject="${CSS.escape(back)}"]`)
  })

  // ═══ the lines elsewhere and the rail count ═══

  let summary = null
  function paintLines() {
    for (const el of doc.querySelectorAll('[data-insight-agents]')) {
      const html = V().linesHtml(summary)
      if (el._html !== html) el.innerHTML = el._html = html
      el.hidden = !html
    }
    for (const el of doc.querySelectorAll('[data-insight-home]')) {
      const html = V().homeHtml(summary)
      if (el._html !== html) el.innerHTML = el._html = html
      el.hidden = !html
    }
    const icon = doc.querySelector('#rail a.rail-item[data-view="suggestions"] .rail-icon')
    if (icon) {
      const n = Number(summary?.suggestions?.open) || 0
      let b = icon.querySelector('.ins-rail-count')
      if (!b) icon.insertAdjacentHTML('beforeend', '<span class="ins-rail-count" hidden></span>'), (b = icon.querySelector('.ins-rail-count'))
      b.hidden = !n
      b.textContent = n > 9 ? '9+' : String(n)
      icon.parentElement.title = n ? `Suggestions · ${n} from Master wait for you` : 'Suggestions'
    }
  }
  async function refreshSummary() {
    try {
      const r = await fetch('/api/insight/summary', { cache: 'no-store' })
      if (!r.ok) return
      summary = await r.json()
      paintLines()
    } catch {
      /* the next poll tries again */
    }
  }
  window.Shell?.onRoute(() => {
    paintLines() // the Agents page drew its slot again: fill it at once, then read afresh
    refreshSummary()
  })
  doc.addEventListener('DOMContentLoaded', refreshSummary)
  setInterval(refreshSummary, SUMMARY_POLL_MS)
})()
