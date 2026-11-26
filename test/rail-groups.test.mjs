// Tests for the grouped rail (public/rail-groups.js): ONE definition decides which page sits in which group and in
// what order, and a feature adds its link by name through RailGroups.add, never by appending HTML to the end of the
// rail. The shell (public/shell.js) registers the links of the later features (the bank, Routing, Lessons, Learn)
// through it and draws the rail from it. Browser scripts in a vm with a bare window: only the pure halves run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')
const plain = v => JSON.parse(JSON.stringify(v))

/** rail-groups.js alone, with a console that records its warnings. */
function bare() {
  const warnings = []
  const window = {}
  vm.runInNewContext(read('rail-groups.js'), { window, console: { warn: (...a) => warnings.push(a.join(' ')) } })
  return { R: window.RailGroups, warnings }
}
/** rail-groups.js then shell.js, as index.html loads them: the shell registers the later features' links. */
function withShell() {
  const warnings = []
  const window = {}
  const ctx = { window, console: { warn: (...a) => warnings.push(a.join(' ')) } }
  vm.runInNewContext(read('rail-groups.js'), ctx)
  vm.runInNewContext(read('shell.js'), ctx)
  return { R: window.RailGroups, Shell: window.Shell, warnings }
}
const views = g => g.entries.map(e => e.view)
const entry = (view, label = view) => ({ view, href: `#/${view}`, label, icon: '<path d="M1 1h2"/>' })

// ═══ the groups ═══

test('the rail has four groups in order, Work, Agents, Quality and History, each page in its place', () => {
  const { R, warnings } = withShell()
  const groups = plain(R.groups())
  assert.deepEqual(groups.map(g => g.id), ['work', 'agents', 'quality', 'history'])
  assert.deepEqual(groups.map(g => g.label), ['Work', 'Agents', 'Quality', 'History'])
  assert.deepEqual(groups.map(views), [
    ['home', 'flows', 'tickets', 'script'],
    ['agents', 'subagents', 'bank', 'routing', 'health'],
    ['qa', 'lessons', 'learn', 'suggestions'],
    ['timeline', 'archive', 'glossary'],
  ])
  assert.deepEqual(warnings, [], 'the shell registers its links without a warning')
})

test('every page keeps its address, its name and an icon', () => {
  const { R, Shell } = withShell()
  const want = { home: '#/home', flows: '#/flows', tickets: '#/tickets', script: '#/generators', agents: '#/agents', subagents: '#/subagents', bank: '#/bank', routing: '#/routing', qa: '#/qa', lessons: '#/lessons', learn: '#/learn', suggestions: '#/suggestions', health: '#/health', timeline: '#/timeline', archive: '#/archive', glossary: '#/glossary', settings: '#/settings' }
  for (const [view, href] of Object.entries(want)) {
    const e = R.linkFor(view)
    assert.equal(e?.href, href, view)
    assert.equal(Shell.resolve(href).view, view, `${href} opens ${view}`)
    assert.match(e.icon, /<(path|circle)/, `${view} has an icon`)
  }
  assert.equal(R.linkFor('script').label, 'Generators')
  assert.equal(R.linkFor('bank').label, 'Orchestration bank')
  assert.equal(R.linkFor('archive').label, 'Flow archive')
})

test('Settings is a link in the bottom block, not in a group', () => {
  const { R } = withShell()
  assert.deepEqual(plain(R.foot().map(e => e.view)), ['settings'])
  assert.ok(!R.groups().some(g => g.entries.some(e => e.view === 'settings')))
})

test('every view the shell routes has exactly one rail entry: a new page without one fails here', () => {
  const { R, Shell } = withShell()
  const all = [...R.groups().flatMap(g => g.entries), ...R.foot()].map(e => e.view)
  // `agent` is the live view of one session: it lights Agents or Subagents (Shell.railFor) and has no entry of its own.
  for (const view of Shell.views.filter(v => v !== 'agent')) {
    assert.equal(all.filter(v => v === view).length, 1, `${view} has exactly one rail entry`)
  }
  for (const view of all) assert.ok(Shell.views.includes(view), `${view} on the rail is a page the shell routes`)
})

test('linkFor: an unknown or non-string view is null', () => {
  const { R } = bare()
  assert.equal(R.linkFor('nope'), null)
  assert.equal(R.linkFor(undefined), null)
  assert.equal(R.linkFor({}), null)
})

test('groups() hands out copies: changing one never changes the rail', () => {
  const { R } = bare()
  const g = R.groups()
  g[0].entries.length = 0
  g.pop()
  assert.equal(R.groups().length, 4)
  assert.ok(R.groups()[0].entries.length > 0)
})

// ═══ add ═══

test('add places a link right after the named one, inside the named group', () => {
  const { R, warnings } = bare()
  assert.equal(R.add('work', entry('drafts', 'Drafts'), { after: 'flows' }), true)
  assert.deepEqual(plain(views(R.groups()[0])), ['home', 'flows', 'drafts', 'tickets', 'script'])
  assert.deepEqual(warnings, [])
})

test('add without after goes to the end of its group, never to the end of the rail', () => {
  const { R } = bare()
  R.add('quality', entry('audit', 'Audit'))
  const groups = R.groups()
  assert.equal(views(groups[2]).at(-1), 'audit')
  assert.notEqual(views(groups.at(-1)).at(-1), 'audit')
})

test('add into an unknown group puts the link in a final More group, with one console warning', () => {
  const { R, warnings } = bare()
  assert.equal(R.groups().some(g => g.id === 'more'), false, 'no More group while nothing is in it')
  assert.equal(R.add('Tools', entry('lab', 'Lab')), true)
  const groups = R.groups()
  assert.deepEqual(plain(groups.at(-1)), { id: 'more', label: 'More', entries: [entry('lab', 'Lab')] })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /Tools/)
  assert.match(warnings[0], /lab/)
})

test('add after a link that is not in the group puts it at the end of the group, with one warning', () => {
  const { R, warnings } = bare()
  R.add('history', entry('notes', 'Notes'), { after: 'nope' })
  assert.equal(views(R.groups()[3]).at(-1), 'notes')
  assert.equal(warnings.length, 1)
})

test('add refuses a view that already has a link, and an entry that is not whole, each with one warning', () => {
  const { R, warnings } = bare()
  assert.equal(R.add('work', entry('flows', 'Flows again')), false)
  assert.equal(R.groups().flatMap(g => g.entries).filter(e => e.view === 'flows').length, 1)
  const bad = [
    null,
    'flows',
    { href: '#/x', label: 'X', icon: '' },
    { view: 'x', label: 'X', icon: '' },
    { view: 'x', href: 'https://example.com', label: 'X', icon: '' },
    { view: 'x', href: '#/x', label: '', icon: '' },
    { view: 'x', href: '#/x', label: 'X'.repeat(41), icon: '' },
    { view: 'x', href: '#/x', label: 42, icon: '' },
    { view: 'X Y', href: '#/x', label: 'X', icon: '' },
    { view: 'x', href: '#/x', label: 'X', icon: 7 },
  ]
  for (const b of bad) assert.equal(R.add('work', b), false, JSON.stringify(b))
  assert.equal(warnings.length, 1 + bad.length)
  assert.equal(R.linkFor('x'), null)
})

// ═══ the markup ═══

test('navHtml: each group is a labelled group with a heading, and the links follow the groups (the Tab order)', () => {
  const { R } = withShell()
  const html = R.navHtml(R.groups())
  const heads = [...html.matchAll(/<div class="rail-group" role="group" aria-labelledby="(rg-[a-z]+)">\s*<div class="rail-group-head"><h2 class="rail-group-label" id="([^"]+)">([^<]+)<\/h2><\/div>/g)]
  assert.deepEqual(heads.map(m => m[3]), ['Work', 'Agents', 'Quality', 'History'])
  for (const m of heads) assert.equal(m[1], m[2], 'the group is labelled by its own heading')
  const order = [...html.matchAll(/<a class="rail-item" href="[^"]+" data-view="([a-z]+)"/g)].map(m => m[1])
  assert.deepEqual(order, plain(R.groups().flatMap(g => g.entries.map(e => e.view))))
  assert.doesNotMatch(html, /tabindex="[1-9]/, 'no tabindex jumps out of the group order')
})

test('navHtml: only the current page is marked, and labels are escaped', () => {
  const { R } = bare()
  R.add('work', entry('odd', 'A <b>&</b>'))
  const html = R.navHtml(R.groups(), 'flows')
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1)
  assert.match(html, /data-view="flows" title="Flows" aria-current="page"/)
  assert.match(html, /A &lt;b&gt;&amp;&lt;\/b&gt;/)
  assert.doesNotMatch(R.navHtml(R.groups()), /aria-current/)
})

test('linkHtml draws one rail link: the icon in its box, the label beside it', () => {
  const { R } = bare()
  assert.equal(
    R.linkHtml(entry('flows', 'Flows')),
    '<a class="rail-item" href="#/flows" data-view="flows" title="Flows"><span class="rail-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 1h2"/></svg></span><span class="rail-label">Flows</span></a>',
  )
})

// ═══ the shell draws the rail from it ═══

test('the shell draws the rail from RailGroups and appends no link of its own', () => {
  const shell = read('shell.js')
  assert.match(shell, /<nav class="rail-nav" aria-label="Pages">\$\{R\.navHtml\(R\.groups\(\)\)\}<\/nav>/)
  assert.doesNotMatch(shell, /insertAdjacentHTML/, 'nothing is appended to the rail after it is drawn')
  for (const [view, group, after] of [['bank', 'agents', 'subagents'], ['routing', 'agents', 'bank'], ['lessons', 'quality', 'qa'], ['learn', 'quality', 'lessons']]) {
    assert.match(shell, new RegExp(`RailGroups\\?\\.add\\('${group}', \\{ view: '${view}'[^\\n]*\\{ after: '${after}' \\}\\)`), view)
  }
})

test('the brand mark is not a second Home entry: out of the Tab order and hidden from screen readers', () => {
  const shell = read('shell.js')
  assert.match(shell, /<a class="rail-item rail-brand" href="#\/home" tabindex="-1" aria-hidden="true" title="Home">/)
  assert.doesNotMatch(shell, /rail-brand"[^>]*data-view/)
})

test('the active page is lit by its one rail link, and a lit link scrolls into the rail when the rail is short', () => {
  const shell = read('shell.js')
  assert.match(shell, /rail\.querySelectorAll\('a\.rail-item\[data-view\]'\)\.forEach\(a => \{/)
  assert.match(shell, /scrollIntoView\?\.\(\{ block: 'nearest' \}\)/)
})

test('the bottom block: Ask, Alerts, Spend, the Phone on slot, Settings, Theme, in that order', () => {
  const shell = read('shell.js')
  const bottom = shell.slice(shell.indexOf('<div class="rail-bottom">'))
  const at = s => bottom.indexOf(s)
  const order = ['id="railAsk"', 'id="railAlerts"', 'id="railSpend"', 'id="railPhone"', "R.linkHtml(R.linkFor('settings'))", 'id="themeToggle"']
  for (const s of order) assert.ok(at(s) > 0, s)
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) < at(order[i]), `${order[i - 1]} before ${order[i]}`)
})

test('the Phone on badge fills its own slot in the bottom block; it never appends to the page links', () => {
  const src = read('phone-notice.js')
  assert.match(src, /getElementById\('railPhone'\)/)
  assert.doesNotMatch(src, /rail-nav|insertAdjacentHTML/)
})

// ═══ wiring ═══

test('index.html loads rail-groups.js before the shell and the palette, and npm run check covers it', () => {
  const html = read('index.html')
  const at = s => html.indexOf(`<script src="${s}"></script>`)
  assert.ok(at('rail-groups.js') > 0)
  assert.ok(at('rail-groups.js') < at('shell.js'))
  assert.ok(at('rail-groups.js') < at('palette.js'))
  const pkg = fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')
  assert.match(pkg, /node --check public\/rail-groups\.js/)
})

// ═══ the look (shell.css) ═══

const SHELL_CSS = read('shell.css')
/** The body of the first `@media <query> {...}` block, braces balanced. */
function media(css, query) {
  const at = css.indexOf(`@media ${query}`)
  let i = css.indexOf('{', at)
  const start = i + 1
  for (let depth = 1; depth; ) {
    i++
    if (css[i] === '{') depth++
    else if (css[i] === '}') depth--
  }
  return css.slice(start, i)
}
/** The body of the rule whose selector is exactly `sel`, at the start of a line. */
function rule(css, sel) {
  const at = css.replace(/\r\n/g, '\n').indexOf(`\n${sel} {`)
  if (at < 0) return ''
  const body = css.replace(/\r\n/g, '\n').slice(at)
  return body.slice(body.indexOf('{') + 1, body.indexOf('}'))
}

test('on a short window only the groups scroll, inside the rail; the bottom block stays and nothing scrolls sideways', () => {
  const nav = rule(SHELL_CSS, '.rail-nav')
  assert.match(nav, /flex:\s*1 1 auto/)
  assert.match(nav, /min-height:\s*0/)
  assert.match(nav, /overflow-y:\s*auto/)
  assert.match(nav, /overflow-x:\s*hidden/)
  assert.match(rule(SHELL_CSS, '.rail-bottom'), /flex:\s*none/)
  assert.match(rule(SHELL_CSS, '.rail-top'), /flex:\s*none/)
})

test('a group head: a thin line in the theme colour, and a small muted label that shows only while the rail is open', () => {
  assert.match(rule(SHELL_CSS, '.rail-group-head::before'), /border-top:\s*1px solid var\(--line\)/)
  const label = rule(SHELL_CSS, '.rail-group-label')
  assert.match(label, /font-size:\s*11px/)
  assert.match(label, /color:\s*var\(--faint\)/)
  assert.match(label, /background:\s*var\(--bg\)/)
  assert.match(label, /opacity:\s*0/)
  assert.match(SHELL_CSS, /#rail\.open \.rail-group-label, #rail:has\(:focus-visible\) \.rail-group-label, \.rail-pinned #rail \.rail-group-label \{ opacity: 1; \}/)
  assert.doesNotMatch(SHELL_CSS.slice(SHELL_CSS.indexOf('.rail-group'), SHELL_CSS.indexOf('#railPhone')), /#[0-9a-f]{3,6}\b/i, 'tokens only, so dark mode follows')
})

test('the label fade stands down under reduced motion, and the phone bar keeps one row without heads or a second Home', () => {
  assert.match(media(SHELL_CSS, '(prefers-reduced-motion: reduce)'), /\.rail-group-label \{ transition: none; \}|\.rail-group-label\s*\{[^}]*transition:\s*none/)
  const phone = media(SHELL_CSS, '(max-width: 720px)')
  assert.match(phone, /\.rail-top, \.rail-nav, \.rail-bottom, \.rail-group \{ display: contents; \}/)
  assert.match(phone, /\.rail-group-head, \.rail-bottom::before, \.rail-brand \{ display: none; \}/)
})
