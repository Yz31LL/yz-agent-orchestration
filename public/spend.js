// The rail's spend chip (spec F4): what the dashboard's OWN headless turns
// (the chat, the answer relay, the explainer, the ticket refreshes, the two Generators tools) cost
// today, from GET /api/spend (spend.mjs). The user's money, spent by things
// they do not see, as one number.
//
// - shell.js gives it the `#railSpend` slot above Theme and calls
//   Spend.mount(slot) once every script is in. The slot stays hidden while
//   today is zero.
// - The chip: the short amount in the icon box (the closed 56 px rail shows
//   only that) and `Spend today` as its label beside it, so the open rail
//   shows the amount ONCE (it read `$1.97 $1.97 today` before). The exact
//   amount is in its title and its accessible name. A click opens the shared ?
//   popover (help.js) with the total by kind and the last 20 turns.
// - Rounding to cents happens HERE, not on the server. A total under half a
//   cent reads `<$0.01`, never `$0.00`: something was spent.
// - It polls every 60 s, and again at once when the chat goes idle
//   (`chat:status`), the tab comes back, or a caller asks (Spend.refresh: the
//   explainer does after an answer).
// - Every string is escaped; colours come from the tokens (shell.css).
;(() => {
  const POLL_MS = 60_000
  // `script` is the Prompt generator and `standup` the Standup creator, the two tools on the Generators page
  const KIND_LABEL = { chat: 'Chat', relay: 'Answer relay', explain: 'Explain', refresh: 'Ticket refresh', script: 'Prompt generator', standup: 'Standup creator', lesson: 'Lessons', critic: 'Second opinion' }
  const KIND_ORDER = ['chat', 'relay', 'explain', 'refresh', 'script', 'standup', 'lesson', 'critic']
  KIND_LABEL.intake = 'Ticket sorting' // ticket intake's model run (routing-intake-run.mjs)
  KIND_ORDER.push('intake')
  // the Learn page's two runs (learn-retro.mjs, learn-routes.mjs): each flow's retrospective and the weekly Learn run
  Object.assign(KIND_LABEL, { retro: 'Retrospective', learn: 'Learn' }), KIND_ORDER.push('retro', 'learn')
  KIND_LABEL.phone = 'Phone messages' // a message sent from the phone page (phone-talk.mjs)
  KIND_ORDER.push('phone')
  KIND_LABEL.insight = 'Urgent notes to the coordinator' // only with insight.notifyMaster urgent (insight-inbox.mjs)
  KIND_ORDER.push('insight')
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

  /** Pure: dollars to cents for reading, `$12.40`; a positive amount under half a cent is `<$0.01`. */
  function money(usd) {
    const v = num(usd)
    const cents = Math.round(v * 100)
    if (!cents) return v > 0 ? '<$0.01' : '$0.00'
    return `$${(cents / 100).toFixed(2)}`
  }
  /** Pure: the short form for the 36 px icon box: `$4.20`, then whole dollars from $10, `$1.2k` from $1000. */
  function short(usd) {
    const v = num(usd)
    if (v < 10) return money(v) === '<$0.01' ? '<1¢' : money(v)
    if (v < 1000) return `$${Math.round(v)}`
    return `$${(v / 1000).toFixed(1)}k`
  }

  /** Pure: the popover's HTML for a /api/spend answer. */
  function panel(data, now = Date.now()) {
    const byKind = data && typeof data.byKind === 'object' && data.byKind ? data.byKind : {}
    const recent = Array.isArray(data?.recent) ? data.recent.slice(0, 20) : []
    const label = k => esc(KIND_LABEL[k] || k)
    const kinds = KIND_ORDER.map(k => `<li${num(byKind[k]) ? '' : ' class="faint"'}><span>${label(k)}</span><span class="num">${esc(money(byKind[k]))}</span></li>`).join('')
    const rows = recent.length
      ? recent.map(l => `<li><span>${label(l?.kind)}</span><span class="num">${esc(money(l?.usd))}</span><time class="faint" datetime="${esc(l?.at)}">${esc(window.Shell?.ago(l?.at, now) ?? '')}</time></li>`).join('')
      : '<li class="faint">No turns yet.</li>'
    return (
      `<p><b>${esc(money(data?.today))} today</b> on the headless turns this dashboard ran itself.</p>` +
      `<ul class="sp-list sp-kinds">${kinds}</ul>` +
      `<p class="sp-sub faint">Latest turns</p>` +
      `<ul class="sp-list sp-recent">${rows}</ul>`
    )
  }

  let slot = null
  let btn = null
  let amt = null
  let label = null
  let inflight = null

  function paint(data) {
    const today = num(data?.today)
    const text = `${money(today)} today`
    slot.hidden = !today
    amt.textContent = short(today)
    label.textContent = 'Spend today'
    btn.setAttribute('aria-label', `Spend today: ${money(today)}`)
    btn.title = `Spent ${text} on headless turns`
    window.Help?.attach(btn, panel(data))
    if (!today && btn.getAttribute('aria-expanded') === 'true') window.Help?.close()
  }

  /** Fetch /api/spend and repaint; a failure leaves the chip as it was. Two calls at once share one fetch. */
  function refresh() {
    if (!btn) return Promise.resolve()
    if (inflight) return inflight
    // .finally always runs later, so `inflight` is set before it clears it.
    inflight = load().finally(() => (inflight = null))
    return inflight
  }
  async function load() {
    try {
      const r = await fetch('/api/spend', { cache: 'no-store' })
      if (r.ok) paint(await r.json())
    } catch {
      /* offline or the server restarting: try again on the next poll */
    }
  }

  function mount(el) {
    if (!el || btn) return
    const doc = window.document
    slot = el
    btn = doc.createElement('button')
    btn.type = 'button'
    btn.className = 'sp-chip'
    btn.setAttribute('aria-label', 'Spend today')
    amt = doc.createElement('span')
    amt.className = 'rail-icon sp-amt num'
    label = doc.createElement('span')
    label.className = 'rail-label sp-text'
    btn.appendChild(amt)
    btn.appendChild(label)
    slot.appendChild(btn)
    void refresh()
    window.setInterval(refresh, POLL_MS)
    doc.addEventListener?.('chat:status', e => {
      if (!e?.detail?.busy) void refresh()
    })
    doc.addEventListener?.('visibilitychange', () => {
      if (doc.visibilityState === 'visible') void refresh()
    })
  }

  window.Spend = { mount, refresh, money, short, panel }
})()
