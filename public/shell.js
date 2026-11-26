// The app shell (spec 5): the left rail, the one-row page header, the chat
// drawer frame and hash routing. Each page keeps its own section and its own
// window.X object; the shell shows exactly one section and calls that page's
// open/close, the way app.js route() did before.
//
// Routes: #/ Flows (the landing page: every request is a flow), #/flows (the same page, so old links
// keep working), #/home Home, #/qa[/<flow id>], #/generators[?tool=standup], #/tickets, #/timeline, #/agents, #/subagents,
// #/glossary, #/settings, #/archive (the flow archive), #/learn, #/agent/<id>[/<sub>]. Old links redirect (#/factory → #/tickets,
// #/flow → #/timeline, #/script and #/brainstorming → #/generators, a query kept) and anything unknown goes to the landing page.
// A page route may carry a query, `#/flows?flow=dark-mode&at=hand`, handed to the page as params.query (an
// object of strings): a link that opens a page in a given state (archive-page.js, flows-page.js, human-review.js).
//
// Shell.resolve is pure and is attached BEFORE the DOM code, which returns
// early when there is no document, so test/shell.test.mjs can load this file
// in a vm with a bare window.
;(() => {
  const VIEWS = ['home', 'flows', 'qa', 'script', 'tickets', 'timeline', 'agents', 'subagents', 'glossary', 'settings', 'archive', 'agent']
  VIEWS.push('bank') // the Orchestration bank (bank-page.js): #/bank, #/bank/<id>, #/bank/<id>/use
  VIEWS.push('lessons') // the Lessons page (quality-lessons-page.js): #/lessons[?area=tests|edit=<candidate>]
  VIEWS.push('routing') // the Routing page (routing-page.js): #/routing, #/routing?flow=<id>
  VIEWS.push('learn') // Learn (learn-page.js): #/learn[?run=<id>], retrospectives and a verdict on every rule change
  VIEWS.push('suggestions', 'health') // Master's insight (insight-pages.js): #/suggestions[?id=<id>] and #/health, the watchdog
  // Their rail links, by group and by name (rail-groups.js decides the rest; a new page adds its link the same way).
  // The bank: three stacked layers (saved ways of working), after Subagents.
  window.RailGroups?.add('agents', { view: 'bank', href: '#/bank', label: 'Orchestration bank', icon: '<path d="m12 3.5 8.5 4.25L12 12 3.5 7.75Z"/><path d="m3.5 12 8.5 4.25L20.5 12"/><path d="m3.5 16.25 8.5 4.25 8.5-4.25"/>' }, { after: 'subagents' })
  // Routing: a signpost, one way splitting in two (who gets a task), after the bank.
  window.RailGroups?.add('agents', { view: 'routing', href: '#/routing', label: 'Routing', icon: '<path d="M12 21v-7.5"/><path d="m12 13.5-5.5-5.5"/><path d="m12 13.5 5.5-5.5"/><path d="M5 11.5V6.5h5"/><path d="M19 11.5V6.5h-5"/>' }, { after: 'bank' })
  // Lessons: an open book with a tick on its right page (what earlier work taught), after QA.
  window.RailGroups?.add('quality', { view: 'lessons', href: '#/lessons', label: 'Lessons', icon: '<path d="M3 5.5c3-1.2 6-1 9 1 3-2 6-2.2 9-1V19c-3-1.2-6-1-9 1-3-2-6-2.2-9-1Z"/><path d="M12 6.5V20"/><path d="m14.8 12.2 1.7 1.7 3-3.4"/>' }, { after: 'qa' })
  // Learn: a light bulb (an idea, from what the work taught), after Lessons.
  window.RailGroups?.add('quality', { view: 'learn', href: '#/learn', label: 'Learn', icon: '<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2v.5h5V16c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z"/>' }, { after: 'lessons' })
  // Suggestions: a speech bubble with a star (what Master proposes), after Learn. Health: a heart with a pulse line, last of Agents.
  window.RailGroups?.add('quality', { view: 'suggestions', href: '#/suggestions', label: 'Suggestions', icon: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4 4v-4h-.5A1.5 1.5 0 0 1 4 14.5Z"/><path d="m12 6.8 1 2.1 2.2.3-1.6 1.5.4 2.2-2-1-2 1 .4-2.2-1.6-1.5 2.2-.3Z"/>' }, { after: 'learn' })
  window.RailGroups?.add('agents', { view: 'health', href: '#/health', label: 'Health', icon: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.2a4.2 4.2 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z"/><path d="M6.5 12.5h3l1.4-2.6 2 4.4 1.3-1.8h3.3"/>' })
  const OLD = { factory: 'tickets', flow: 'timeline' }
  const route = (view, params = {}, redirect = null) => ({ view, params, redirect })
  const decode = s => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s // a malformed % escape: keep the raw text rather than throw
    }
  }

  /** Pure: a location hash → { view, params, redirect }. `redirect` is the canonical hash for an old or unknown route, else null. */
  function resolve(hash) {
    const h = typeof hash === 'string' ? hash : ''
    if (h === '' || h === '#' || h === '#/') return route('flows')
    const agent = /^#\/agent\/([^/]+)(?:\/([^/]*))?/.exec(h)
    if (agent) return route('agent', { id: decode(agent[1]), sub: agent[2] ? decode(agent[2]) : null })
    const qa = /^#\/qa\/([^/]+)\/?$/.exec(h) // one ticket opened on the QA page
    if (qa) return route('qa', { id: decode(qa[1]) })
    const bank = /^#\/bank\/([^/]+)(?:\/(use))?\/?$/.exec(h) // one saved orchestration opened, or its Use confirmation
    if (bank) return route('bank', { id: decode(bank[1]), mode: bank[2] || null })
    const [, page, query] = /^#\/([a-z]+)\/?(?:\?([^#]*))?$/.exec(h) || []
    const params = query ? { query: queryOf(query) } : {}
    // Generators was Brainstorming, and SCRIPT before that: its view keeps the oldest name (script-page.js says why),
    // and the old links still land on it, with their query (?tool=standup opens the Standup creator).
    if (page === 'generators') return route('script', params)
    if (page === 'script' || page === 'brainstorming') return route('script', params, `#/generators${query ? `?${query}` : ''}`)
    if (page && page !== 'agent' && VIEWS.includes(page)) return route(page, params)
    const old = /^#\/(factory|flow)\b/.exec(h)?.[1]
    if (old) return route(OLD[old], {}, `#/${OLD[old]}`)
    return route('flows', {}, '#/')
  }

  /** Pure: `flow=a&at=hand` → { flow: 'a', at: 'hand' } (strings, decoded; a malformed escape kept raw; the last of a repeat wins). */
  function queryOf(s) {
    const out = {}
    for (const part of String(s).split('&')) {
      if (!part) continue
      const at = part.indexOf('=')
      const key = decode((at < 0 ? part : part.slice(0, at)).replace(/\+/g, ' '))
      if (key) out[key] = at < 0 ? '' : decode(part.slice(at + 1).replace(/\+/g, ' '))
    }
    return out
  }

  /**
   * Wait for a page to mount after a route change: polls `selector` every 50 ms
   * and calls `fn(el)` once it matches, or gives up after `timeoutMs`. The page
   * mounts on the hashchange that follows Shell.go, so a caller cannot reach
   * into it straight away. Resolves to the element, or null on a timeout.
   */
  function whenReady(selector, fn, timeoutMs = 2000) {
    const until = Date.now() + timeoutMs
    return new Promise(done => {
      const tick = () => {
        const el = window.document?.querySelector(selector)
        if (el) {
          fn?.(el)
          return done(el)
        }
        if (Date.now() >= until) return done(null)
        setTimeout(tick, 50)
      }
      tick()
    })
  }

  /**
   * Pure: how long ago `iso` was, short (spec 6): `now` under a minute (a
   * clock a little ahead too), then whole `3m`, `2h`, `5d`. '' for anything
   * that is not a time. THE one relative-time helper: every page uses it.
   */
  function ago(iso, now = Date.now()) {
    const t = iso ? Date.parse(iso) : NaN
    if (Number.isNaN(t)) return ''
    const s = Math.floor((now - t) / 1000)
    if (s < 60) return 'now'
    if (s < 3600) return `${Math.floor(s / 60)}m`
    if (s < 86400) return `${Math.floor(s / 3600)}h`
    return `${Math.floor(s / 86400)}d`
  }

  /** How the rail's title says each chat state (the drawer head and the cards say the one glossary word). */
  const CHAT_WORDS = { working: 'working', waiting: 'waiting on you', idle: 'idle' }
  /**
   * Pure: Independent's state from what the page knows: `busy` (the chat's own
   * stream, always current) and `state` (the last /api/pulse chat.state). A
   * running turn is working; otherwise only the pulse's waiting counts, so a
   * pulse that still says working after the turn ended reads idle.
   */
  const chatState = ({ busy, state } = {}) => (busy ? 'working' : state === 'waiting' ? 'waiting' : 'idle')

  let current = null
  const listeners = []
  // go, setStatus, setTitle, setWaiting, the drawer, collapseRail and onRoute are
  // function declarations further down (hoisted), so the object can name them here.
  /** Pure: the rail entry a route lights. The live view lights Subagents for a subagent and Agents for a session. */
  const railFor = r => (r.view === 'agent' ? (r.params?.sub ? 'subagents' : 'agents') : r.view)

  window.Shell = {
    resolve,
    railFor,
    views: VIEWS.slice(), // every view this shell routes (test/rail-groups.test.mjs: each but `agent` has one rail link)
    whenReady,
    ago,
    chatState,
    go,
    get current() {
      return current
    },
    setStatus,
    setTitle,
    setWaiting,
    drawer: {
      open: () => setDrawer(true),
      close: () => setDrawer(false),
      toggle: () => setDrawer(!drawerOpen()),
      get isOpen() {
        return drawerOpen()
      },
    },
    onRoute,
    collapseRail,
  }
  if (!window.document) return

  // ═══ the page ═══

  const doc = window.document
  const $ = id => doc.getElementById(id)
  const PIN_KEY = 'shell.railPinned'
  const HOVER_MS = 300
  const TITLE = { home: 'Home', flows: 'Flows', qa: 'QA', script: 'Generators', tickets: 'Tickets', timeline: 'Timeline', agents: 'Agents', subagents: 'Subagents', glossary: 'Glossary', settings: 'Settings', archive: 'Flow archive', agent: 'Agent' }
  // Which section each view shows, and which page object it opens and closes.
  const SECTION = { home: 'home', flows: 'flowsView', qa: 'qaView', script: 'scriptView', tickets: 'factoryView', timeline: 'flowView', agents: 'agentsView', subagents: 'subagentsView', glossary: 'glossaryView', settings: 'settingsView', archive: 'archiveView', agent: 'agentView' }
  const PAGE = { flows: 'FlowsPage', qa: 'QaPage', script: 'ScriptPage', tickets: 'FactoryView', timeline: 'FlowView', agents: 'AgentsPage', subagents: 'SubagentsPage', glossary: 'GlossaryPage', settings: 'SettingsPage', archive: 'ArchivePage', agent: 'AgentView' }
  Object.assign(TITLE, { bank: 'Orchestration bank' }), Object.assign(SECTION, { bank: 'bankView' }), Object.assign(PAGE, { bank: 'BankPage' })
  Object.assign(TITLE, { lessons: 'Lessons' }), Object.assign(SECTION, { lessons: 'lessonsView' }), Object.assign(PAGE, { lessons: 'QualityLessons' })
  Object.assign(TITLE, { routing: 'Routing' }), Object.assign(SECTION, { routing: 'routingView' }), Object.assign(PAGE, { routing: 'RoutingPage' })
  Object.assign(TITLE, { learn: 'Learn' }), Object.assign(SECTION, { learn: 'learnView' }), Object.assign(PAGE, { learn: 'LearnPage' })
  Object.assign(TITLE, { suggestions: 'Suggestions', health: 'Health' }), Object.assign(SECTION, { suggestions: 'suggestionsView', health: 'healthView' }), Object.assign(PAGE, { suggestions: 'SuggestionsPage', health: 'HealthPage' })

  // ─── icons: 24-unit boxes drawn at 20 px, 1.75 stroke (shell.css); the pages' own are in rail-groups.js ───
  const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`
  const R = window.RailGroups
  const ICON = {
    ask: svg('<path d="M12 3.5a8.5 8.5 0 0 0-7.4 12.7L3.5 20.5l4.3-1.1A8.5 8.5 0 1 0 12 3.5Z"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'),
    moon: svg('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
    pin: svg('<path d="M9 3h6l-1 6 3 4H7l3-4Z"/><path d="M12 13v8"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    // More: three dots in a row (the rest of the pages, in the phone-width bar)
    more: svg('<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>'),
  }

  // ─── the rail ───
  // The command palette shortcut (palette.js), named in the Ask tooltip: Cmd on a Mac, Ctrl elsewhere.
  const PALETTE_KEY = /Mac|iPhone|iPad/.test(window.navigator?.platform || window.navigator?.userAgent || '') ? '⌘K' : 'Ctrl K'
  const ASK_TIP = `Ask · ${PALETTE_KEY} goes to anything`
  const rail = $('rail')
  // Top to bottom: the brand and the pin, the Project menu's slot (project-menu.js fills it), the page links in their
  // groups (rail-groups.js, the ONE place that orders them), then the bottom block, which never scrolls away.
  // ⚠️ The brand is a mouse shortcut Home, not a second Home entry: Home's one link is in Work, so the brand is out
  // of the Tab order and hidden from screen readers (a reader would otherwise hear Home twice).
  // The Phone on slot is phone-notice.js's: it fills it while phone access is on.
  rail.innerHTML = `
    <div class="rail-top">
      <a class="rail-item rail-brand" href="#/home" tabindex="-1" aria-hidden="true" title="Home"><span class="rail-icon"><span class="rail-mark">${svg(R.linkFor('home').icon)}</span></span><span class="rail-label">Orchestration</span></a>
      <button type="button" class="rail-pin" id="railPin" aria-pressed="false" title="Keep the rail open">${ICON.pin}</button>
    </div>
    <div class="rail-project" id="railProject"></div>
    <nav class="rail-nav" aria-label="Pages">${R.navHtml(R.groups())}</nav>
    <div class="rail-bottom">
      <button type="button" class="rail-item" id="railAsk" aria-controls="drawer" aria-expanded="false" title="${ASK_TIP}"><span class="rail-icon">${ICON.ask}</span><span class="rail-label">Ask</span></button>
      <div class="rail-item rail-slot" id="railAlerts"></div>
      <div class="rail-item rail-slot" id="railSpend" hidden></div>
      <div class="rail-slot" id="railPhone" hidden></div>
      ${R.linkHtml(R.linkFor('settings'))}
      <button type="button" class="rail-item" id="themeToggle" title="Theme"><span class="rail-icon"><span class="theme-sun">${ICON.sun}</span><span class="theme-moon">${ICON.moon}</span><i class="theme-dot" aria-hidden="true"></i></span><span class="rail-label">Theme</span></button>
      <button type="button" class="rail-item rail-more-btn" id="railMore" aria-haspopup="dialog" aria-controls="railMoreSheet" aria-expanded="false" title="More"><span class="rail-icon">${ICON.more}</span><span class="rail-label">More</span></button>
    </div>`
  // ⚠️ More (rail-more.js, rail-more.css) shows only in the phone-width bar, under 720 px: the bar keeps the most used
  // pages (RailGroups.bar) with Ask and More, and More opens a sheet with the rest in their groups.

  // Labels as tooltips by default; after a 300 ms hover the rail opens to
  // 200 px over the page. Pinned, it stays open and pushes the page instead.
  const store = {
    get(k) {
      try {
        return window.localStorage.getItem(k)
      } catch {
        return null
      }
    },
    set(k, v) {
      try {
        if (v == null) window.localStorage.removeItem(k)
        else window.localStorage.setItem(k, v)
      } catch {}
    },
  }
  const root = doc.documentElement
  const paintPin = pinned => {
    root.classList.toggle('rail-pinned', pinned)
    const b = $('railPin')
    b.setAttribute('aria-pressed', String(pinned))
    b.title = pinned ? 'Let the rail close' : 'Keep the rail open'
    b.setAttribute('aria-label', b.title)
  }
  paintPin(store.get(PIN_KEY) === '1')
  $('railPin').addEventListener('click', () => {
    const pinned = !root.classList.contains('rail-pinned')
    store.set(PIN_KEY, pinned ? '1' : null)
    paintPin(pinned)
  })
  let hoverTimer = 0
  rail.addEventListener('mouseenter', () => {
    clearTimeout(hoverTimer)
    hoverTimer = setTimeout(() => rail.classList.add('open'), HOVER_MS)
  })
  rail.addEventListener('mouseleave', collapseRail)
  /** Fold a hover-opened rail (a pinned one stays open): the Alerts panel opens beside the 56 px rail, not over its labels. */
  function collapseRail() {
    clearTimeout(hoverTimer)
    rail.classList.remove('open')
  }

  // ─── the header ───
  const escText = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  /**
   * The status chip: `html` is the one short line (fetched 3m); `help`, when
   * given, is the rest of the meta behind the chip's ? popover (help.js).
   * Both are HTML the caller owns. The ? stays the same node across calls, so
   * an open popover follows the new text instead of losing its anchor.
   */
  function setStatus(html, help) {
    const text = $('pageStatusText')
    const q = $('pageHelp')
    if (!text || !q) return
    text.innerHTML = html
    q.hidden = !help
    if (help) window.Help?.attach(q, help)
    else if (q.getAttribute('aria-expanded') === 'true') window.Help?.close()
  }
  /**
   * The page title: `text` as a <dfn> the explainer opens (explain.js: the
   * rail labels stay plain links, so the page is explained here) for glossary
   * `term`, then ` · N` when `count` is a number. A count under the same title
   * counts up to its new value (motion.js) instead of jumping.
   */
  function setTitle(text, term, count) {
    const h = $('pageTitle')
    if (!h) return
    const dfn = `<dfn data-term="${escText(term)}" tabindex="0">${escText(text)}</dfn>`
    const n = h.querySelector('#pageCount')
    const same = h.dataset.title === `${term}|${text}`
    if (same && n && count != null) return window.Motion ? window.Motion.countUp(n, count) : (n.textContent = String(count))
    h.dataset.title = `${term}|${text}`
    h.innerHTML = count == null ? dfn : `${dfn} <span class="faint">· <span class="num" id="pageCount">${Number(count)}</span></span>`
  }
  function setWaiting(n) {
    const b = $('pageWaiting')
    if (!b) return
    const count = Math.max(0, Number(n) || 0)
    b.hidden = !count
    b.innerHTML = count ? `<i class="wait-dot" aria-hidden="true"></i>${count} waiting on you` : ''
    b.title = count ? 'Open Human review on the Agents page' : ''
  }
  // The questions live in the Human review box (human-review.js), which also scrolls it into view when #/agents already shows.
  $('pageWaiting')?.addEventListener('click', () => (window.HumanReview?.show ? window.HumanReview.show() : go('#/agents?human')))

  // ─── the chat drawer ───
  // ONE head: #drawerHead holds Ask until the chat mounts, then the chat writes
  // its own line there (Ask · name, the model, Stop, New chat; factory-chat.js
  // frame). The chat mounts the first time the drawer opens and stays mounted,
  // EventSource and all, while the page lives: closing only hides it.
  const DRAWER_KEY = 'shell.drawerOpen'
  const drawer = $('drawer')
  drawer.innerHTML = `<div class="drawer-head"><div class="drawer-title" id="drawerHead"><h2>Ask</h2></div><button type="button" class="drawer-x" aria-label="Close" title="Close">${ICON.close}</button></div><div class="drawer-body" id="drawerBody"></div>`
  let chatMounted = false
  function drawerOpen() {
    return !!drawer && !drawer.hidden
  }
  function setDrawer(open) {
    if (!drawer) return
    if (open && !chatMounted && window.FactoryChat) {
      chatMounted = true
      window.FactoryChat.mount($('drawerBody'), $('drawerHead'))
    }
    drawer.hidden = !open
    doc.body.classList.toggle('drawer-open', open)
    $('railAsk').setAttribute('aria-expanded', String(open))
    store.set(DRAWER_KEY, open ? '1' : null)
  }
  $('railAsk').addEventListener('click', () => setDrawer(!drawerOpen()))
  // Ask shows Independent's state (chatState): a breathing dot while it works, an
  // amber dot while it waits on you. Busy comes from the chat's own stream
  // (chat:status, factory-chat.js; notify.js until the drawer mounts), waiting
  // from the pulse (its chat.state, orchestration.mjs chatState).
  const chatNow = { busy: false, state: 'idle', name: '' }
  function paintAsk() {
    const ask = $('railAsk')
    const s = chatState(chatNow)
    ask.classList.toggle('busy', s === 'working')
    ask.classList.toggle('waiting', s === 'waiting')
    ask.title = `${chatNow.name || window.FactoryChat?.name || 'Independent'} is ${CHAT_WORDS[s]}\n${ASK_TIP}`
  }
  doc.addEventListener('chat:status', e => {
    chatNow.busy = Boolean(e.detail?.busy)
    paintAsk()
  })
  doc.addEventListener('pulse', e => {
    const chat = e.detail?.chat || {}
    chatNow.state = chat.state || 'idle'
    if (chat.name) chatNow.name = chat.name
    paintAsk()
  })
  drawer.querySelector('.drawer-x').addEventListener('click', () => setDrawer(false))
  // On window, bubble: the LAST to hear a key, after every document listener a
  // page added (a report modal, the Timeline popover). One that took the
  // Escape calls preventDefault, so one Escape closes one thing.
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drawerOpen() && !e.defaultPrevented) setDrawer(false)
  })

  // ─── routing ───
  function go(hash) {
    if (window.location.hash === hash) show()
    else window.location.hash = hash
  }
  function onRoute(fn) {
    listeners.push(fn)
  }
  function show() {
    const r = resolve(window.location.hash)
    // An old or unknown link: swap it for the canonical one in history; the
    // hashchange that follows routes again. The old Factory page always showed
    // the chat, so its link (the one old route that lands on #/tickets) also
    // opens the drawer (spec 5).
    if (r.redirect) {
      if (r.redirect === '#/tickets') setDrawer(true)
      return window.location.replace(r.redirect)
    }
    // A new page starts from a blank chip and its plain name, BEFORE it opens:
    // the page then writes its own (a count, a collection name) whenever its
    // data lands, and a page left behind never leaves its chip on the next one.
    if (r.view !== current?.view) {
      setStatus('')
      setTitle(TITLE[r.view], r.view)
    }
    current = r
    for (const [view, id] of Object.entries(SECTION)) {
      const el = $(id)
      if (el) el.hidden = view !== r.view
    }
    for (const [view, name] of Object.entries(PAGE)) if (view !== r.view) window[name]?.close?.()
    const page = window[PAGE[r.view]]
    if (r.view === 'agent') page?.open?.(r.params.id, r.params.sub)
    else if (r.view === 'qa') page?.open?.(r.params.id)
    else if (r.view === 'bank') page?.open?.(r.params.id, r.params.mode)
    else page?.open?.(r.params.query || {})
    const lit = railFor(r)
    // On a short window the groups scroll inside the rail: the lit link scrolls into view there (the page never moves).
    rail.querySelectorAll('a.rail-item[data-view]').forEach(a => {
      if (a.dataset.view !== lit) return a.removeAttribute('aria-current')
      a.setAttribute('aria-current', 'page')
      a.scrollIntoView?.({ block: 'nearest' })
    })
    for (const fn of listeners) fn(r)
  }
  window.addEventListener('hashchange', show)
  // ONE delegated listener lights the card under the pointer on every page (motion.js).
  window.Motion?.spotlight(doc.querySelector('main'))
  // Once every page script has attached its window.X: the drawer as it was
  // left (closed by default, and closed when storage throws), then the route.
  // The spend chip (spend.js) mounts in its slot above Theme; it shows itself once today is above zero.
  doc.addEventListener('DOMContentLoaded', () => {
    window.Spend?.mount($('railSpend'))
    setDrawer(store.get(DRAWER_KEY) === '1')
    show()
  })
})()
