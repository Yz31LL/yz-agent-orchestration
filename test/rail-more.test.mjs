// Tests for the phone-width bar and its More sheet (public/rail-groups.js bar and more, public/rail-more.js,
// public/rail-more.css). Under 720 px the rail is a bar along the bottom; it had about 20 icons and clipped the spend
// chip at 390 px. Now the bar holds the most used pages (Home, Flows, Tickets, Agents), Ask and a More button; More
// opens a small sheet with every other page in its rail group, then Alerts, Spend today, Phone on, Settings and
// Theme. The pure halves run in a vm with a bare window; the stylesheet and the page are read as text.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n')
const plain = v => JSON.parse(JSON.stringify(v))

/** rail-groups.js, shell.js, then rail-more.js, as index.html loads them (no document: the pure halves only). */
function load() {
  const window = {}
  const ctx = { window, console: { warn: () => {} } }
  for (const f of ['rail-groups.js', 'shell.js', 'rail-more.js']) vm.runInNewContext(read(f), ctx)
  return { R: window.RailGroups, M: window.RailMore, Shell: window.Shell }
}

// ═══ which pages are in the bar, which in More ═══

test('the bar holds Home, Flows, Tickets and Agents, in rail order; every other page is in More, in its group', () => {
  const { R } = load()
  assert.deepEqual(plain(R.bar()), ['home', 'flows', 'tickets', 'agents'])
  for (const v of R.bar()) assert.ok(R.linkFor(v), v)
  const more = plain(R.more())
  assert.deepEqual(more.map(g => g.label), ['Work', 'Agents', 'Quality', 'History'])
  assert.deepEqual(more.map(g => g.entries.map(e => e.view)), [['script'], ['subagents', 'bank', 'routing', 'health'], ['qa', 'lessons', 'learn', 'suggestions'], ['timeline', 'archive', 'glossary']])
})

test('bar, More and the foot together hold every page exactly once', () => {
  const { R, Shell } = load()
  const all = [...R.bar(), ...R.more().flatMap(g => g.entries.map(e => e.view)), ...R.foot().map(e => e.view)]
  assert.equal(new Set(all).size, all.length, 'no page twice')
  const pages = plain(R.groups().flatMap(g => g.entries.map(e => e.view))).concat(['settings'])
  assert.deepEqual([...all].sort(), pages.sort())
  assert.ok(Shell.views.length > 10)
  for (const v of Shell.views) if (v !== 'agent') assert.ok(all.includes(v), v)
})

test('a group whose pages are all in the bar is left out of More, and a link added later shows in More', () => {
  const { R } = load()
  assert.ok(R.add('work', { view: 'extra', href: '#/extra', label: 'Extra', icon: '<path d="M1 1h2"/>' }))
  assert.deepEqual(plain(R.more()[0].entries.map(e => e.view)), ['script', 'extra'])
  assert.ok(R.more().every(g => g.entries.length > 0))
})

test('navHtml takes an id prefix, so the sheet never repeats the rail heading ids', () => {
  const { R } = load()
  const sheet = R.navHtml(R.more(), null, 'rm-')
  const ids = [...sheet.matchAll(/ id="([^"]+)"/g)].map(m => m[1])
  assert.ok(ids.length >= 4)
  assert.ok(ids.every(id => id.startsWith('rm-')), ids.join(' '))
  assert.match(R.navHtml(R.groups()), /id="rg-work"/, 'the rail keeps rg-')
})

// ═══ the sheet ═══

test('the sheet is a labelled modal dialog: a heading, a close button, the groups, then Alerts, Spend, Phone on, Settings and Theme', () => {
  const { R, M } = load()
  const h = M.sheetHtml(R.more(), 'qa')
  assert.match(h, /role="dialog" aria-modal="true" aria-labelledby="railMoreTitle"/)
  assert.match(h, /<h2 [^>]*id="railMoreTitle"[^>]*>More<\/h2>/)
  assert.match(h, /<button type="button" class="rm-x" data-rm-close aria-label="Close">/)
  assert.match(h, /<nav class="rm-nav" aria-label="More pages">/)
  const views = [...h.matchAll(/data-view="([a-z]+)"/g)].map(m => m[1])
  assert.deepEqual(views, [...plain(R.more().flatMap(g => g.entries.map(e => e.view))), 'settings'])
  assert.equal((h.match(/aria-current="page"/g) || []).length, 1)
  assert.match(h, /data-view="qa" title="QA" aria-current="page"/)
  const foot = h.slice(h.indexOf('rm-foot'))
  const at = s => foot.indexOf(s)
  for (const s of ['data-rm-alerts', 'id="railMoreSlots"', 'data-view="settings"', 'data-rm-theme']) assert.ok(at(s) > 0, s)
  assert.ok(at('data-rm-alerts') < at('id="railMoreSlots"') && at('id="railMoreSlots"') < at('data-view="settings"') && at('data-view="settings"') < at('data-rm-theme'))
  const ids = [...h.matchAll(/ id="([^"]+)"/g)].map(m => m[1])
  assert.equal(new Set(ids).size, ids.length, 'no id twice')
  assert.ok(!ids.some(id => id.startsWith('rg-')), 'no id the rail already uses')
  assert.doesNotMatch(h, /tabindex="[1-9]/)
})

test('Tab and Shift+Tab stay inside the open sheet', () => {
  const { M } = load()
  assert.equal(M.nextFocus(5, 4, false), 0, 'Tab from the last goes to the first')
  assert.equal(M.nextFocus(5, 0, true), 4, 'Shift+Tab from the first goes to the last')
  assert.equal(M.nextFocus(5, 2, false), null, 'inside: the browser moves the focus')
  assert.equal(M.nextFocus(5, -1, false), 0, 'from outside the sheet: its first')
  assert.equal(M.nextFocus(5, -1, true), 4)
  assert.equal(M.nextFocus(0, -1, false), null)
})

test('the More button is marked while the page shown is one of its pages', () => {
  const { M } = load()
  for (const v of ['qa', 'settings', 'learn', 'script', 'subagents']) assert.equal(M.moreLit(v), true, v)
  for (const v of ['home', 'flows', 'tickets', 'agents', '', null, undefined]) assert.equal(M.moreLit(v), false, String(v))
})

// ═══ the shell, the page and the look ═══

test('the shell draws a More button last in the bottom block, a dialog opener with its state', () => {
  const shell = read('shell.js')
  const bottom = shell.slice(shell.indexOf('<div class="rail-bottom">'))
  assert.match(bottom, /<button type="button" class="rail-item rail-more-btn" id="railMore" aria-haspopup="dialog" aria-controls="railMoreSheet" aria-expanded="false" title="More">/)
  assert.ok(bottom.indexOf('id="railMore"') > bottom.indexOf('id="themeToggle"'))
})

test('index.html loads rail-more.js after the shell and its stylesheet after shell.css; npm run check covers it', () => {
  const html = read('index.html')
  const at = s => html.indexOf(s)
  assert.ok(at('<script src="rail-more.js"></script>') > at('<script src="shell.js"></script>'))
  assert.ok(at('<link rel="stylesheet" href="rail-more.css">') > at('<link rel="stylesheet" href="shell.css">'))
  assert.match(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'), /node --check public\/rail-more\.js/)
})

test('the look: More only under 720 px; there the bar shows only its pages, Ask and More; the sheet follows the theme', () => {
  const css = read('rail-more.css')
  assert.match(css, /#railMore \{ display: none; \}/)
  const phone = css.slice(css.indexOf('@media (max-width: 720px)'))
  assert.match(phone, /\.rail-nav \.rail-item:not\(\.in-bar\)/)
  assert.match(phone, /\.rail-bottom > :not\(#railAsk\):not\(#railMore\)/)
  assert.match(phone, /#railMore \{ display: flex; \}/)
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b/i, 'tokens only, so dark mode follows')
  assert.match(css, /prefers-reduced-motion: reduce/)
})

test('the live half: the slots move into the sheet and back, Escape closes it, the focus comes back to More', () => {
  const src = read('rail-more.js')
  assert.match(src, /matchMedia\('\(max-width: 720px\)'\)/)
  assert.match(src, /\['railSpend', 'railPhone'\]/)
  assert.match(src, /e\.key === 'Escape'/)
  assert.match(src, /preventDefault\(\)/)
  assert.match(src, /btn\.focus\(\)/)
  assert.match(src, /setAttribute\('aria-expanded'/)
  assert.doesNotMatch(src, /insertAdjacentHTML/)
})

test('under 720 px the toast stack sits above the bar, offset by the bar height from the same variable, plus a gap', () => {
  const css = read('rail-more.css')
  const phone = css.slice(css.indexOf('@media (max-width: 720px)'))
  assert.match(phone, /\.nt-stack \{ bottom: calc\(var\(--rail-w\) \+ 8px\); \}/)
  const shell = read('shell.css')
  const bar = shell.slice(shell.indexOf('@media (max-width: 720px)'))
  assert.match(bar, /height: var\(--rail-w\)/, 'the bar is var(--rail-w) high: the stack follows it if it ever changes')
  // rail-more.css loads after orchestration.css (where the stack is placed), so its rule wins at equal weight
  const html = read('index.html')
  assert.ok(html.indexOf('href="rail-more.css"') > html.indexOf('href="orchestration.css"'))
  assert.match(read('orchestration.css'), /\.nt-stack \{ position: fixed; right: 16px; bottom: 16px;/, 'wide windows keep their place')
})
