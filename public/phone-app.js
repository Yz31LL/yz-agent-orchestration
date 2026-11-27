// The phone page's live half (public/phone.html): it signs in, fetches, polls and binds the clicks; the words come
// from phone-state.js and the markup from phone-view.js, phone-agents.js and phone-chat.js. Everything it calls is on the phone listener
// (phone-server.mjs): /phone/login, /phone/logout and /phone/api/*. Every POST carries the session's CSRF token in
// X-Phone-CSRF; the session itself is an HttpOnly cookie this script never sees.
//
// Rules this file keeps:
// - The PIN is read once from its field when the user signs in, sent once and the field emptied. Nothing here
//   stores it, or anything else, in the browser (no web storage, no cookie it can read, no cache): there is no service worker.
// - Polling only while the page is visible: the summary every SUMMARY_MS (and the orchestration with it, on the
//   Agents tab) and, on the coordinator's tab, the thread
//   on PhoneChat.pollMs (5 s while a message is on its way or the coordinator works, else 15 s). Hidden, it stops;
//   visible again, it refreshes at once. After a 429 (too many requests) each poll waits twice as long, up to 60 s
//   (phone-state.js backoffMs), and the next answer that is not a 429 puts it back: a refused phone slows down
//   instead of hammering. ⚠️ A chain of timeouts, never a fixed interval, so each wait is worked out afresh.
// - A redraw keeps what the user is typing (every [data-draft] field) and where the focus is, so a poll never eats
//   an answer half written.
// - The chat's live half (reading the thread, the pill, Send, Try again) is public/phone-chat-live.js, made once here
//   with this file's state, network call and draw. The composer stays above the on-screen keyboard (phone-composer.js).
// - The address names the tab (#talk, #needs …) or the open flow sheet (#flow=<id>), so a reload or a home-screen
//   icon opens where the user was.
// - A pull request opens in its own sheet (public/phone-pr-live.js), or on GitHub, as the Options sheet (the gear in
//   the header) says; that choice is kept on the session, read back from /phone/api/me.
// - The flow sheet (a chip on the Agents tab) is a modal dialog: focus moves into it and stays there (Tab wraps),
//   Escape, Close or a tap outside it closes it and gives the focus back to its chip; a poll that redraws it keeps
//   its scroll. An answer given in it reloads it.
// - The PC unreachable: a quiet line at the top, and the page keeps trying. The session over (401): back to the PIN.
// - BOOT: the page holds a quiet Loading line until the first draw (phone.html), and every object this file needs is
//   set by a script before it. ⚠️ If one has not run (a script that failed or is late), this file waits ONCE for the
//   page's load event and starts then, or says the page did not load completely: never a blank page, never a throw
//   on a missing object (QA, 2026-11-26: one of 40 quick reloads showed an empty body).
;(function boot(retry = false) {
  const NEEDS = ['PhoneState', 'PhoneText', 'PhoneChat', 'PhoneView', 'PhoneAgents', 'PhoneComposer', 'PhoneChatLive', 'PhonePr', 'PhonePrLive']
  if (NEEDS.some(name => !window[name])) {
    const el = window.document?.getElementById?.('app')
    if (retry && el) el.innerHTML = '<p class="ph-muted ph-boot" role="status">The page did not load completely. Reload it to try again.</p>'
    if (!retry) window.addEventListener('load', () => boot(true), { once: true })
    return
  }
  const S = window.PhoneState
  const V = window.PhoneView
  const K = window.PhoneComposer
  const A = window.PhoneAgents
  const doc = window.document
  const root = doc.getElementById('app')
  if (!root) return

  const SUMMARY_MS = 15_000
  const OFFLINE = 'Cannot reach your PC. It may be off or asleep; trying again.'
  const OFF = 'Phone access is off on your PC.'
  const SLOWED = 'Your PC asked for a pause. Checking again more slowly.'

  const first = S.routeOf(window.location.hash)
  const st = {
    signedIn: false, csrf: '', tab: first.tab, summary: null, orch: null, sheet: null, pr: null, options: null, thread: null, notice: '', pill: false,
    signIn: { status: '', busy: false }, ui: { status: {}, busy: {}, confirm: null, talkDraft: '', prLinks: 'here' }, limited: 0,
  }
  let timers = []
  let round = 0 // bumped by stop(): a poll that was already on its way does not schedule another after it

  // ═══ the network ═══

  async function call(method, url, body) {
    let r
    try {
      r = await window.fetch(url, {
        method, credentials: 'same-origin', cache: 'no-store',
        headers: method === 'POST' ? { 'content-type': 'application/json', 'x-phone-csrf': st.csrf } : {},
        body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      })
    } catch {
      st.notice = OFFLINE
      return { status: 0, json: {} }
    }
    const json = await r.json().catch(() => ({}))
    st.limited = S.limitedAfter(st.limited, r.status)
    st.notice = r.status === 503 ? OFF : r.status === 429 ? SLOWED : ''
    if (r.status === 401 && url !== '/phone/login' && url !== '/phone/api/me') signedOut('Your session ended. Sign in again.')
    return { status: r.status, json }
  }

  function signedOut(why) {
    stop()
    Object.assign(st, { signedIn: false, csrf: '', summary: null, orch: null, sheet: null, pr: null, options: null, thread: null, pill: false })
    st.signIn = { status: why || '', busy: false }
    draw()
  }

  async function loadSummary() {
    const r = await call('GET', '/phone/api/summary')
    if (r.status === 200) st.summary = r.json
    draw()
  }

  async function loadOrch() {
    const r = await call('GET', '/phone/api/orchestration')
    if (r.status === 200) st.orch = r.json
    draw()
  }

  // ═══ the flow sheet ═══

  const chipOf = id => [...root.querySelectorAll('[data-ph-flow]')].find(b => b.getAttribute('data-ph-flow') === id)

  async function loadSheet() {
    const id = st.sheet?.id
    if (!id) return
    const r = await call('GET', `/phone/api/flow?id=${encodeURIComponent(id)}`)
    if (st.sheet?.id !== id) return // closed or another one opened meanwhile
    st.sheet = r.status === 200 ? { id, data: r.json } : { id, error: r.status ? r.json.error || 'That flow could not be read.' : OFFLINE }
    draw()
  }

  function openSheet(id) {
    st.sheet = { id, loading: true }
    window.history?.replaceState?.(null, '', `#flow=${encodeURIComponent(id)}`)
    draw()
    // the heading (the flow's name, tabindex -1) takes the focus, so a screen reader starts there; a redraw keeps it
    root.querySelector('#phSheetTitle')?.focus()
    return loadSheet()
  }

  function closeSheet() {
    const id = st.sheet?.id
    st.sheet = null
    window.history?.replaceState?.(null, '', S.hashOf(st.tab))
    draw()
    chipOf(id)?.focus()
  }

  /** Tab and Shift+Tab stay inside the open sheet. */
  function trapTab(e) {
    const sheet = root.querySelector('.ph-sheet') // only one sheet is ever drawn: Options, a pull request, or a flow
    if (!sheet) return
    const list = [...sheet.querySelectorAll('button:not([disabled]), a[href], textarea, input:not([disabled])')]
    if (!list.length) return
    const at = list.indexOf(doc.activeElement)
    if (e.shiftKey && at <= 0) { e.preventDefault(); list.at(-1).focus() }
    else if (!e.shiftKey && (at === -1 || at === list.length - 1)) { e.preventDefault(); list[0].focus() }
  }

  // ═══ polling, only while visible ═══

  const visible = () => doc.visibilityState !== 'hidden'
  function stop() {
    round++
    for (const t of timers) window.clearTimeout(t)
    timers = []
    chat.stop()
  }
  /** The next summary poll (and the orchestration with it on the Agents tab), waiting longer after a 429. */
  function tick() {
    const mine = round
    timers = [window.setTimeout(async () => {
      await (st.tab === 'agents' ? Promise.all([loadSummary(), loadOrch()]) : loadSummary())
      if (mine === round && st.signedIn && visible()) tick()
    }, S.backoffMs(SUMMARY_MS, st.limited))]
  }
  function start() {
    stop()
    if (!st.signedIn || !visible()) return
    tick()
    chat.schedule()
  }
  doc.addEventListener('visibilitychange', () => {
    if (!visible()) return stop()
    if (!st.signedIn) return
    loadSummary()
    if (st.tab === 'talk') chat.load()
    if (st.tab === 'agents') loadOrch()
    start()
  })

  // ═══ drawing, keeping drafts and focus ═══

  /** A selector that finds the same control after a redraw: its id, or its tag and data- attributes. */
  function selectorOf(el) {
    if (!el || el === doc.body || !el.tagName) return ''
    if (el.id) return `#${el.id}`
    const data = [...el.attributes].filter(a => a.name.startsWith('data-')).map(a => `[${a.name}="${String(a.value).replace(/"/g, '\\"')}"]`).join('')
    return data ? `${el.tagName.toLowerCase()}${data}` : ''
  }

  function draw(put = {}) {
    const drafts = {}
    for (const f of root.querySelectorAll('[data-draft]')) drafts[f.getAttribute('data-draft')] = f.value
    Object.assign(drafts, put)
    if (drafts.talk !== undefined) st.ui.talkDraft = drafts.talk
    const focus = selectorOf(doc.activeElement)
    const sheetTop = root.querySelector('.ph-sheet-body')?.scrollTop || 0
    const patches = pr.keep()
    const label = st.summary?.coordinator || st.thread?.label || 'Master'
    // the browser tab and the home-screen switcher say where the user is: Sign in before the PIN, else the tab
    doc.title = st.signedIn ? V.tabTitle(st.tab, label) : 'Sign in'
    if (!st.signedIn) {
      root.innerHTML = V.signIn(st.signIn)
    } else {
      const body = st.tab === 'needs' ? V.needs(st.summary, st.ui)
        : st.tab === 'outputs' ? V.outputs(st.summary, st.ui)
        : st.tab === 'talk' ? V.talk(st.thread, st.ui)
        : A.view(st.orch, st.summary, Date.now(), st.ui)
      root.innerHTML = '<div class="ph-app">' +
        `<header class="ph-top"><span class="ph-brand">${V.esc(V.tabTitle(st.tab, label))}</span><span class="ph-notice" role="status">${V.esc(st.notice)}</span>` +
        `${window.PhonePr.gear()}<button type="button" class="link ph-out" data-ph-signout>Sign out</button></header>` +
        `<main class="ph-main${st.tab === 'talk' ? ' is-chat' : ''}" id="phMain">${body}</main>${V.nav(st.tab, st.summary, label)}` +
        `${st.options ? window.PhonePr.options(st.ui.prLinks, st.options) : st.pr ? window.PhonePr.sheet(st.pr, st.pr) : st.sheet ? A.sheet(st.sheet, st.ui) : ''}</div>`
    }
    for (const f of root.querySelectorAll('[data-draft]')) {
      const k = f.getAttribute('data-draft')
      if (drafts[k] !== undefined) f.value = drafts[k]
    }
    if (st.tab === 'talk') {
      K.grow(root.querySelector('#phTalk'))
      K.measure(root)
      chat.showPill()
    }
    doc.documentElement.classList.toggle('sheet-open', !!(st.signedIn && (st.sheet || pr.isOpen())))
    const body = root.querySelector('.ph-sheet-body')
    if (body) body.scrollTop = sheetTop
    pr.restore(patches)
    if (focus) root.querySelector(focus)?.focus?.({ preventScroll: true })
  }

  const say = (key, text) => { st.ui.status[key] = text; draw() }
  const chat = window.PhoneChatLive.make({ root, st, call, draw, say, offline: OFFLINE })
  const pr = window.PhonePrLive.make({ root, st, call, draw, offline: OFFLINE, openFlow: id => openSheet(id), hashOfTab: () => S.hashOf(st.tab) })

  // ═══ actions ═══

  async function signIn(form) {
    const field = form.querySelector('[data-ph-pin]')
    const pin = field?.value || ''
    if (field) field.value = '' // read once, never kept
    const problem = S.pinProblem(pin)
    if (problem) { st.signIn = { status: problem, busy: false }; return draw() }
    st.signIn = { status: '', busy: true }
    draw()
    const r = await call('POST', '/phone/login', { pin })
    if (r.status !== 200) {
      st.signIn = { status: r.status ? r.json.error || 'Sign-in failed.' : OFFLINE, busy: false }
      return draw()
    }
    Object.assign(st, { signedIn: true, csrf: r.json.csrf, signIn: { status: '', busy: false } })
    st.ui.prLinks = 'here' // a new sign-in starts at the default (phone-auth.mjs)
    opened()
  }

  async function act(key, url, body, done) {
    st.ui.busy[key] = true
    st.ui.status[key] = 'Sending…'
    draw()
    const r = await call('POST', url, body)
    delete st.ui.busy[key]
    if (r.status === 401) return
    st.ui.status[key] = r.status === 200 ? done : r.status ? r.json.error || `Not done (${r.status}).` : OFFLINE
    if (r.status === 200) {
      await loadSummary()
      if (st.sheet) await loadSheet() // an answer given in the flow sheet: the sheet shows it gone
    } else draw()
    return r
  }

  function answer(btn, value) {
    const flowId = btn.getAttribute('data-flow')
    const nodeId = btn.getAttribute('data-node')
    const key = `ask:${flowId}:${nodeId}`
    if (value === undefined) {
      value = root.querySelector(`[data-draft="${key}"]`)?.value || ''
      if (!value.trim()) return say(key, 'Type an answer first.')
    }
    return act(key, '/phone/api/answer', { flowId, nodeId, answer: value }, 'Answered. The agent hears it shortly.')
  }

  /** A refused tick redraws from the summary as it was, so the box goes back to what is stored.
   *  ⚠️ NOT named tick: that is the poll above, and a second function tick in this scope replaced it (no poll ran). */
  function tickStep(box) {
    const flowId = box.getAttribute('data-flow')
    const on = !!box.checked
    return act(`hand:${flowId}`, '/phone/api/tick', { flowId, step: box.getAttribute('data-step'), done: on }, on ? 'Ticked.' : 'Unticked.')
  }

  async function complete(flowId) {
    const r = await act(`out:${flowId}`, '/phone/api/complete', { flowId }, 'Completed.')
    if (r?.status === 200) st.ui.confirm = null
    draw()
  }

  function go(tab) {
    st.tab = tab
    st.sheet = st.pr = st.options = null
    st.ui.confirm = null
    chat.reset()
    window.history?.replaceState?.(null, '', S.hashOf(tab))
    draw()
    window.scrollTo(0, 0)
    chat.schedule()
    if (tab === 'talk') chat.load()
    else loadSummary()
    if (tab === 'agents') loadOrch()
  }

  /** Signed in (or a session already open): the summary, the tab the address named, and the polls. */
  async function opened() {
    draw()
    // #pr=<flow id> or #options, once: opened at once, not after the agent list (it can take seconds to build)
    if (!first.seen && !first.flow) pr.fromAddress()
    first.seen = true
    await loadSummary()
    if (st.tab === 'talk') await chat.load()
    if (st.tab === 'agents') await loadOrch()
    if (first.flow) {
      first.flow = null
      const id = S.routeOf(window.location.hash).flow
      if (id) await openSheet(id)
    }
    start()
  }

  root.addEventListener('click', e => {
    const t = e.target?.closest ? e.target : null
    if (!t) return
    const key = t.closest('[data-ph-key]')
    if (key) {
      const field = root.querySelector('[data-ph-pin]')
      if (!field) return
      const k = key.getAttribute('data-ph-key')
      field.value = k === 'clear' ? '' : k === 'back' ? field.value.slice(0, -1) : (field.value + k).slice(0, 12)
      return
    }
    if (pr.onClick(t)) return // the pull request sheet, the gear and Options (phone-pr-live.js)
    if (t.closest('[data-ph-sheet-close]')) return closeSheet()
    const tab = t.closest('[data-ph-tab]')
    if (tab) return go(tab.getAttribute('data-ph-tab'))
    const chip = t.closest('[data-ph-flow]')
    if (chip) return openSheet(chip.getAttribute('data-ph-flow'))
    // a box's +N more: the rest of its flows in the box, Show fewer folds them (the focus stays on the button)
    const boxMore = t.closest('[data-ph-box-more]')
    if (boxMore) {
      const id = boxMore.getAttribute('data-ph-box-more')
      const open = new Set(st.ui.openBoxes || [])
      if (open.has(id)) open.delete(id)
      else open.add(id)
      st.ui.openBoxes = [...open]
      return draw()
    }
    const again = t.closest('[data-ph-retry]')
    if (again) return chat.retry(again.getAttribute('data-ph-retry'))
    if (t.closest('[data-ph-newreply]')) {
      st.pill = false
      chat.showPill()
      return window.scrollTo(0, doc.documentElement.scrollHeight)
    }
    const yn = t.closest('[data-ph-answer]')
    if (yn) return answer(yn, yn.getAttribute('data-ph-answer'))
    const txt = t.closest('[data-ph-answer-text]')
    if (txt) return answer(txt)
    const c = t.closest('[data-ph-complete]')
    if (c) {
      st.ui.confirm = c.getAttribute('data-flow')
      draw()
      return root.querySelector('[data-ph-complete-yes]')?.focus()
    }
    const yes = t.closest('[data-ph-complete-yes]')
    if (yes) return complete(yes.getAttribute('data-flow'))
    const no = t.closest('[data-ph-complete-no]')
    if (no) {
      const id = no.getAttribute('data-flow')
      st.ui.confirm = null
      draw()
      return root.querySelector(`[data-ph-complete][data-flow="${id}"]`)?.focus()
    }
    if (t.closest('[data-ph-signout]')) {
      return call('POST', '/phone/logout', {}).then(() => signedOut('Signed out.'))
    }
  })
  root.addEventListener('change', e => {
    if (e.target?.matches?.('[data-ph-tick]')) tickStep(e.target)
    else pr.onChange(e.target)
  })
  root.addEventListener('input', e => {
    if (e.target?.id !== 'phTalk') return
    st.ui.talkDraft = e.target.value
    K.grow(e.target)
    K.measure(root)
    chat.updateSend()
  })
  root.addEventListener('submit', e => {
    e.preventDefault()
    if (e.target.matches('[data-ph-login]')) return signIn(e.target)
    if (e.target.matches('[data-ph-talk]')) return chat.send(e.target)
  })
  root.addEventListener('keydown', e => {
    if ((st.sheet || pr.isOpen()) && e.key === 'Tab') return trapTab(e)
    if (e.key === 'Escape' && pr.onEscape()) return
    if (st.sheet && e.key === 'Escape') return closeSheet()
    if (e.key === 'Escape' && st.ui.confirm) {
      const id = st.ui.confirm
      st.ui.confirm = null
      draw()
      root.querySelector(`[data-ph-complete][data-flow="${id}"]`)?.focus()
    }
  })
  window.addEventListener('scroll', () => chat.onScroll(), { passive: true })
  K.watchKeyboard()

  // ═══ start: a session already open (the cookie) goes straight in ═══
  ;(async () => {
    const r = await call('GET', '/phone/api/me')
    if (r.status === 200) {
      Object.assign(st, { signedIn: true, csrf: r.json.csrf })
      st.ui.prLinks = r.json.prLinks === 'github' ? 'github' : 'here'
      await opened()
    } else {
      st.signedIn = false
      st.signIn.status = r.status === 0 ? OFFLINE : r.status === 503 ? OFF : ''
      draw()
      root.querySelector('[data-ph-pin]')?.focus()
    }
  })()
})()
