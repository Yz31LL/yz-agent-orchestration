// Tests for the command palette (public/palette.js, spec F3). Palette.search
// is pure: prefix matches on the label first, then substrings of the label or
// the hint, at most 12, and an empty query lists the pages then the actions.
// Palette.gather builds the items from what the pages already loaded, so a
// window with nothing loaded still gives the pages and the actions. The rest
// runs the file in a vm over a stub document: Ctrl+K or Cmd+K opens it (never
// while another field has the focus), Escape closes it before the shell can
// close the drawer, and Enter runs the chosen item.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, '..', 'public', 'palette.js'), 'utf8')

/** palette.js in a vm with a bare window: only the pure parts attach. The rail's groups load first, as in index.html. */
function pure(extra = {}) {
  const window = { ...extra }
  const ctx = { window }
  for (const f of ['rail-groups.js', 'shell.js']) vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), ctx)
  vm.runInNewContext(SRC, ctx)
  return window.Palette
}
const plain = v => JSON.parse(JSON.stringify(v))
const item = (kind, label, hint = '') => ({ kind, label, hint, run() {} })
const labels = list => plain(list.map(i => i.label))

// ═══ search ═══

test('prefix matches rank before substring matches', () => {
  const { search } = pure()
  const items = [item('flow', 'Unabridged words'), item('page', 'Abacus'), item('ticket', 'ABC-1 Reflow the grid'), item('agent', 'Agent 2', 'crabby tests')]
  assert.deepEqual(labels(search('ab', items)), ['Abacus', 'ABC-1 Reflow the grid', 'Unabridged words', 'Agent 2'])
})

test('a typed query shows at most 12 results; the empty list shows every page and every action', () => {
  const { search } = pure()
  const items = Array.from({ length: 30 }, (_, i) => item('ticket', `ABC-${100 + i} Task`))
  assert.equal(search('abc', items).length, 12)
  // QA, 2026-11-26: a cap of 12 on the empty list left Learn, Lessons and Routing out of the palette.
  const pages = Array.from({ length: 20 }, (_, i) => item('page', `Page ${i}`))
  assert.equal(search('', [...items, ...pages, item('action', 'Ask')]).length, 21)
})

test('regression: every page the shell routes is in the empty list, in the rail order, under its group', () => {
  const P = pure()
  const ctx = { window: {} }
  for (const f of ['rail-groups.js', 'shell.js']) vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), ctx)
  const { RailGroups, Shell } = ctx.window
  const shown = P.search('', P.gather({})).filter(i => i.kind === 'page')
  const want = [...RailGroups.groups().flatMap(g => g.entries), ...RailGroups.foot()]
  assert.deepEqual(plain(shown.map(i => i.hint)), plain(want.map(e => e.href)), 'every rail link, in the rail order')
  for (const view of Shell.views.filter(v => v !== 'agent')) assert.ok(shown.some(i => i.hint === RailGroups.linkFor(view).href), `${view} is in the palette`)
  for (const label of ['Learn', 'Lessons', 'Routing', 'Orchestration bank', 'Flow archive', 'Settings']) assert.ok(shown.some(i => i.label === label), label)
  assert.deepEqual(plain([...new Set(shown.map(i => i.group))]), ['Work', 'Agents', 'Quality', 'History', 'Settings and actions'])
})

test('listHtml: the empty list has a label above each group; a typed list has none', () => {
  const P = pure()
  const shown = P.search('', P.gather({}))
  const html = P.listHtml(shown, 0, true)
  const heads = [...html.matchAll(/<div class="pl-group" id="pl-g-(\d+)">([^<]+)<\/div>/g)].map(m => m[2])
  assert.deepEqual(heads, ['Work', 'Agents', 'Quality', 'History', 'Settings and actions'])
  // every option keeps its place in the one list, so Up, Down and Enter still count through all of them
  const ids = [...html.matchAll(/id="pl-o-(\d+)"/g)].map(m => Number(m[1]))
  assert.deepEqual(ids, plain(shown.map((_, i) => i)))
  assert.match(html, /<li class="pl-sec" role="group" aria-labelledby="pl-g-0">/)
  assert.ok(html.indexOf('>Work<') < html.indexOf('>Home<') && html.indexOf('>Agents</div>') < html.indexOf('>Subagents<'))
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1)
  const typed = P.listHtml(P.search('learn', P.gather({})), 0, false)
  assert.doesNotMatch(typed, /pl-group/)
  assert.match(typed, />Learn</)
  assert.match(P.listHtml([], 0, true), /Nothing matches/)
})

test('an empty query lists pages first, then the actions, and nothing else', () => {
  const { search } = pure()
  const items = [item('action', 'Ask'), item('flow', 'A flow'), item('page', 'Home'), item('ticket', 'ABC-1 x'), item('page', 'Flows'), item('agent', 'Agent 1'), item('action', 'Refresh')]
  assert.deepEqual(labels(search('', items)), ['Home', 'Flows', 'Ask', 'Refresh'])
  assert.deepEqual(labels(search('   ', items)), ['Home', 'Flows', 'Ask', 'Refresh'])
})

test('searching with no flows or tickets loaded does not throw and returns pages and actions', () => {
  const P = pure()
  const items = P.gather({}) // no FlowsView, FactoryView, App, Theme or document at all
  const kinds = [...new Set(items.map(i => i.kind))]
  assert.deepEqual(kinds, ['page', 'action'])
  assert.deepEqual(labels(P.search('', items)).slice(0, 10), ['Home', 'Flows', 'Tickets', 'Generators', 'Agents', 'Subagents', 'Orchestration bank', 'Routing', 'Health', 'QA'])
  assert.ok(labels(P.search('', items)).includes('Ask'))
  assert.deepEqual(plain(P.search('zzz', items)), [])
  assert.doesNotThrow(() => P.search(undefined, undefined))
  // a getter that throws, or data still null, is no items rather than an error
  const odd = P.gather({ FlowsView: { data: null }, FactoryView: { tickets: () => { throw new Error('x') } }, App: { agents: () => null } })
  assert.deepEqual(plain([...new Set(odd.map(i => i.kind))]), ['page', 'action'])
})

test('ticket ids match case-insensitively: abc-10 finds ABC-101', () => {
  const P = pure()
  const items = P.gather({ FactoryView: { tickets: () => [{ id: 'ABC-101', title: 'Add a dark mode toggle', state: 'Started' }, { id: 'ABC-5', title: 'Other' }] } })
  assert.deepEqual(labels(P.search('abc-10', items)), ['ABC-101 Add a dark mode toggle'])
  assert.deepEqual(labels(P.search('ABC-10', items)), ['ABC-101 Add a dark mode toggle'])
})

test('a ticket number alone ranks the ticket first, ahead of a flow that only mentions it', () => {
  const P = pure()
  const w = {
    FlowsView: { data: { flows: [{ id: 'f1', title: 'Ship ABC-101 to stage', status: 'open', agent: 'Agent 1' }] } },
    FactoryView: { tickets: () => [{ id: 'ABC-101', title: 'Add a dark mode toggle' }] },
  }
  const out = P.search('101', P.gather(w))
  assert.deepEqual(labels(out), ['ABC-101 Add a dark mode toggle', 'Ship ABC-101 to stage'])
})

// ═══ gather ═══

test('gather: flows, tickets and agents from what the pages loaded, each running the right helper', () => {
  const P = pure()
  const calls = []
  const w = {
    Shell: { go: h => calls.push(['go', h]), drawer: { open: () => calls.push(['drawer']) } },
    FlowsView: { data: { flows: [{ id: 'f9', title: 'Dark mode', status: 'blocked', agent: 'Agent 3' }] }, gotoFlow: id => calls.push(['flow', id]) },
    FactoryView: { tickets: () => [{ id: 'ABC-1', title: 'One' }], gotoTicket: id => calls.push(['ticket', id]) },
    App: { agents: () => [{ label: 'Agent 3', name: 'agent-3', sessionId: 'a b/c', state: 'active' }, { label: 'No session' }] },
    Theme: { set: t => calls.push(['theme', t]), get: () => 'dark' },
  }
  const items = P.gather(w)
  const by = l => items.find(i => i.label === l)
  assert.equal(by('Dark mode').kind, 'flow')
  assert.match(by('Dark mode').hint, /blocked/)
  assert.match(by('Dark mode').hint, /Agent 3/)
  by('Dark mode').run()
  by('ABC-1 One').run()
  by('Agent 3').run()
  by('Flows').run()
  by('Ask').run()
  by('Theme: light').run()
  assert.equal(items.filter(i => i.kind === 'agent').length, 1, 'an agent with no session has no live view to open')
  assert.deepEqual(calls, [['flow', 'f9'], ['ticket', 'ABC-1'], ['go', '#/agent/a%20b%2Fc'], ['go', '#/flows'], ['drawer'], ['theme', 'light']])
  assert.deepEqual(labels(items.filter(i => i.label.startsWith('Theme'))), ['Theme: light', 'Theme: dark', 'Theme: system'])
})

test('gather: Mark read only while the Since card shows, and Refresh clicks the page Refresh', () => {
  const P = pure()
  const clicked = []
  const marked = []
  const els = { homeSince: { hidden: true }, refresh: { click: () => clicked.push('refresh') } }
  const w = { document: { getElementById: id => els[id] || null }, Since: { markRead: () => marked.push(1) } }
  assert.equal(P.gather(w).some(i => i.label === 'Mark read'), false)
  els.homeSince.hidden = false
  const items = P.gather(w)
  items.find(i => i.label === 'Mark read').run()
  items.find(i => i.label === 'Refresh').run()
  els.fxRefresh = { click: () => clicked.push('fxRefresh') } // the Tickets page has its own
  P.gather(w).find(i => i.label === 'Refresh tickets').run()
  assert.deepEqual(marked, [1])
  assert.deepEqual(clicked, ['refresh', 'fxRefresh'])
})

test('Refresh says what the button it clicks does: the Tickets one reads Switchboard, not a page rebuild', () => {
  const P = pure()
  const els = { refresh: { title: 'Rebuild now', click() {} } }
  const w = { document: { getElementById: id => els[id] || null } }
  const plainOne = P.gather(w).find(i => i.kind === 'action' && i.label.startsWith('Refresh'))
  assert.equal(plainOne.label, 'Refresh')
  assert.equal(plainOne.hint, 'Rebuild now')
  els.fxRefresh = { title: 'Read every ticket from Switchboard now (read only)', click() {} }
  const tickets = P.gather(w).find(i => i.kind === 'action' && i.label.startsWith('Refresh'))
  assert.equal(tickets.label, 'Refresh tickets')
  assert.equal(tickets.hint, 'Read every ticket from Switchboard now (read only)')
  assert.notEqual(tickets.hint, plainOne.hint)
  assert.equal(P.gather(w).filter(i => i.label.startsWith('Refresh')).length, 1, 'one Refresh, never both')
})

// ═══ the palette on a page (stub DOM) ═══

/** A stub element: attributes, listeners, and querySelector handing out one child per selector. */
function stubEl(doc, tagName = 'DIV') {
  const kids = new Map()
  const e = {
    tagName,
    hidden: false,
    innerHTML: '',
    className: '',
    value: '',
    attrs: {},
    listeners: {},
    isConnected: true,
    setAttribute(k, v) { this.attrs[k] = String(v) },
    removeAttribute(k) { delete this.attrs[k] },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn) },
    focus() { doc.activeElement = e },
    blur() { if (doc.activeElement === e) doc.activeElement = doc.body },
    querySelector(sel) {
      if (!kids.has(sel)) kids.set(sel, stubEl(doc, sel === '.pl-input' ? 'INPUT' : 'UL'))
      return kids.get(sel)
    },
    querySelectorAll() { return [] },
    scrollIntoView() {},
  }
  return e
}

function page({ withData = true, modal = { shown: false } } = {}) {
  const doc = { activeElement: null, body: { appended: [], appendChild(x) { this.appended.push(x) } }, getElementById: () => null }
  doc.querySelector = sel => (sel === '.ox-modal:not([hidden])' && modal.shown ? { className: 'ox-modal' } : null)
  doc.createElement = tag => stubEl(doc, tag.toUpperCase())
  doc.body.focus = () => (doc.activeElement = doc.body)
  doc.activeElement = doc.body
  const winListeners = { capture: [], bubble: [] }
  const calls = []
  const entered = []
  const window = {
    document: doc,
    addEventListener: (t, fn, capture) => t === 'keydown' && winListeners[capture ? 'capture' : 'bubble'].push(fn),
    Motion: { enterList: (el, sel) => entered.push([el, sel]) },
    Shell: { go: h => calls.push(['go', h]), drawer: { open() {} } },
  }
  if (withData) {
    window.FactoryView = { tickets: () => [{ id: 'ABC-101', title: 'Add <b>dark</b> mode' }, { id: 'ABC-106', title: 'Next' }], gotoTicket: id => calls.push(['ticket', id]) }
    window.FlowsView = { data: { flows: [{ id: 'x', title: '<img src=x onerror=alert(1)>', status: 'open', agent: 'A&B' }] }, gotoFlow: id => calls.push(['flow', id]) }
  }
  // The shell: on window, bubble, LAST; it closes the drawer on an Escape nobody took.
  let drawerClosed = false
  winListeners.bubble.push(e => {
    if (e.key === 'Escape' && !e.defaultPrevented) drawerClosed = true
  })
  const ctx = { window, document: doc }
  vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'rail-groups.js'), 'utf8'), ctx) // the pages come from the rail's groups
  vm.runInNewContext(SRC, ctx)
  const key = (k, target = doc.activeElement, mods = {}) => {
    const e = {
      key: k,
      target,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...mods,
      defaultPrevented: false,
      stopped: false,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { this.stopped = true },
      stopImmediatePropagation() { this.stopped = true },
    }
    for (const fn of [...winListeners.capture, ...winListeners.bubble]) {
      if (e.stopped) break
      fn(e)
    }
    return e
  }
  const back = () => doc.body.appended[0]
  const input = () => back().querySelector('.pl-input')
  const list = () => back().querySelector('.pl-list')
  const type = text => {
    input().value = text
    for (const fn of input().listeners.input || []) fn({ target: input() })
  }
  return { window, doc, key, back, input, list, type, calls, entered, drawerClosed: () => drawerClosed, P: window.Palette }
}

test('Ctrl+K opens the palette with the focus in its input; Cmd+K does too', () => {
  const t = page()
  const e = t.key('k', t.doc.body, { ctrlKey: true })
  assert.equal(e.defaultPrevented, true, 'the browser does not also take Ctrl+K')
  assert.equal(t.P.isOpen, true)
  assert.equal(t.back().hidden, false)
  assert.equal(t.doc.activeElement, t.input())
  t.P.close()
  assert.equal(t.P.isOpen, false)
  t.key('K', t.doc.body, { metaKey: true })
  assert.equal(t.P.isOpen, true)
})

test('Ctrl+K inside a textarea, an input or a contenteditable does nothing', () => {
  const t = page()
  for (const target of [{ tagName: 'TEXTAREA' }, { tagName: 'INPUT' }, { tagName: 'DIV', isContentEditable: true }]) {
    const e = t.key('k', target, { ctrlKey: true })
    assert.equal(e.defaultPrevented, false, target.tagName)
    assert.equal(t.P.isOpen, false, target.tagName)
  }
})

test('Ctrl+K in the palette input closes it again', () => {
  const t = page()
  t.key('k', t.doc.body, { ctrlKey: true })
  const e = t.key('k', t.input(), { ctrlKey: true })
  assert.equal(e.defaultPrevented, true)
  assert.equal(t.P.isOpen, false)
})

test('Escape closes the palette and the shell leaves the drawer open: one Escape closes one thing', () => {
  const t = page()
  t.key('k', t.doc.body, { ctrlKey: true })
  const e = t.key('Escape')
  assert.equal(e.defaultPrevented, true)
  assert.equal(t.P.isOpen, false)
  assert.equal(t.back().hidden, true)
  assert.equal(t.drawerClosed(), false)
  assert.equal(t.doc.activeElement, t.doc.body, 'the focus goes back where it was')
  // closed, an Escape is the shell's again
  t.key('Escape', t.doc.body)
  assert.equal(t.drawerClosed(), true)
})

test('a plain k, or Ctrl+Shift+K, never opens it', () => {
  const t = page()
  t.key('k', t.doc.body)
  t.key('K', t.doc.body, { ctrlKey: true, shiftKey: true })
  assert.equal(t.P.isOpen, false)
})

test('results re-render on input; Enter runs the chosen ticket and closes', () => {
  const t = page()
  t.key('k', t.doc.body, { ctrlKey: true })
  assert.match(t.list().innerHTML, /Home/)
  assert.match(t.list().innerHTML, /<div class="pl-group" id="pl-g-0">Work<\/div>/, 'the empty list: a label above each group')
  t.type('abc-10')
  assert.doesNotMatch(t.list().innerHTML, /Home/)
  assert.doesNotMatch(t.list().innerHTML, /pl-group/, 'a typed list is ranked, not grouped')
  assert.match(t.list().innerHTML, /ABC-101/)
  assert.equal(t.input().getAttribute('aria-activedescendant'), 'pl-o-0')
  const e = t.key('Enter', t.input())
  assert.equal(e.defaultPrevented, true)
  assert.equal(t.P.isOpen, false)
  assert.deepEqual(t.calls, [['ticket', 'ABC-101']])
})

test('Up and Down move the choice, wrapping at the ends', () => {
  const t = page()
  t.key('k', t.doc.body, { ctrlKey: true })
  t.type('abc-')
  t.key('ArrowDown', t.input())
  assert.equal(t.input().getAttribute('aria-activedescendant'), 'pl-o-1')
  t.key('ArrowDown', t.input())
  assert.equal(t.input().getAttribute('aria-activedescendant'), 'pl-o-0', 'past the last wraps to the first')
  t.key('ArrowUp', t.input())
  assert.equal(t.input().getAttribute('aria-activedescendant'), 'pl-o-1')
  t.key('Enter', t.input())
  assert.deepEqual(t.calls, [['ticket', 'ABC-106']])
})

test('no match shows one line and Enter does nothing', () => {
  const t = page()
  t.key('k', t.doc.body, { ctrlKey: true })
  t.type('qqqq')
  assert.match(t.list().innerHTML, /Nothing matches/)
  assert.equal(t.input().getAttribute('aria-activedescendant'), null)
  t.key('Enter', t.input())
  assert.equal(t.P.isOpen, true)
  assert.deepEqual(t.calls, [])
})

test('every label and hint is escaped', () => {
  const t = page()
  t.key('k', t.doc.body, { ctrlKey: true })
  t.type('img')
  assert.doesNotMatch(t.list().innerHTML, /<img/)
  assert.match(t.list().innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/)
  t.type('a&b')
  assert.match(t.list().innerHTML, /A&amp;B/)
  t.type('dark')
  assert.match(t.list().innerHTML, /&lt;b&gt;dark&lt;\/b&gt;/)
})

test('the list enters with Motion.enterList when it opens, and a reopen re-gathers', () => {
  const t = page({ withData: false })
  t.key('k', t.doc.body, { ctrlKey: true })
  assert.equal(t.entered.length, 1)
  assert.equal(t.entered[0][0], t.list())
  t.P.close()
  t.window.FactoryView = { tickets: () => [{ id: 'ABC-1', title: 'Loaded since' }], gotoTicket() {} }
  t.P.open()
  t.type('abc-1')
  assert.match(t.list().innerHTML, /Loaded since/)
})

// ═══ the sources: the getters the palette reads ═══

test('App.agents() is an empty list before /api/status has answered', () => {
  const window = {}
  vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'app.js'), 'utf8'), { window })
  assert.equal(typeof window.App.agents, 'function')
  assert.deepEqual(plain(window.App.agents()), [])
})

test('FactoryView exposes tickets(), an empty list until the collection loads', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'public', 'factory.js'), 'utf8')
  assert.match(src, /tickets:\s*\(\)\s*=>\s*data\?\.tickets\s*\|\|\s*\[\]/)
})

test('the Ask tooltip in the rail names the palette shortcut', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'public', 'shell.js'), 'utf8')
  assert.match(src, /'⌘K' : 'Ctrl K'/)
  assert.match(src, /id="railAsk"[^>]*title="\$\{ASK_TIP\}"/)
  // the state title (working, waiting on you, idle) keeps the shortcut on its second line
  assert.match(src, /is \$\{CHAT_WORDS\[s\]\}\\n\$\{ASK_TIP\}`/)
})

test('Ctrl+K while the report modal shows does nothing: the palette never opens under it', () => {
  const modal = { shown: true }
  const t = page({ modal })
  const e = t.key('k', t.doc.body, { ctrlKey: true })
  assert.equal(t.P.isOpen, false)
  assert.equal(e.defaultPrevented, false)
  t.P.open() // a direct call too
  assert.equal(t.P.isOpen, false)
  modal.shown = false
  t.key('k', t.doc.body, { ctrlKey: true })
  assert.equal(t.P.isOpen, true)
})

test('index.html loads palette.js before notify.js: its Escape listener must run first', () => {
  const html = fs.readFileSync(path.join(HERE, '..', 'public', 'index.html'), 'utf8')
  const pal = html.indexOf('<script src="palette.js">')
  const note = html.indexOf('<script src="notify.js">')
  assert.ok(pal > 0 && note > 0, 'both scripts are loaded')
  assert.ok(pal < note, 'palette.js comes first')
})

// QA, 2026-11-25: after the rename, typing script no longer found the page. Its old name and prompt stay as keys.
test('regression: script, prompt, brainstorming and standup still find Generators, as hidden keys that are never shown', () => {
  const P = pure()
  const items = P.gather({})
  for (const q of ['script', 'SCR', 'prompt', 'brainstorming', 'standup', 'stand up']) assert.equal(labels(P.search(q, items))[0], 'Generators', q)
  const page = items.find(i => i.label === 'Generators')
  assert.equal(page.hint, '#/generators', 'the row still shows only its own address')
})
