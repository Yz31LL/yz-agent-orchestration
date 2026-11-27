// A pull request, read on the phone (public/phone.html), PURE: the pull request sheet and the small Options sheet
// (Open pull requests: here | on GitHub). Each function takes plain data (GET /phone/api/pr, phone-pr.mjs) and returns
// an HTML string, so the tests run it in a vm; phone-pr-live.js fetches, opens, closes and binds.
//
//   sheet(pr, ui, nowMs)   pr = { flow, loading, error, url, data }; ui = { files: [open file indexes], bodyOpen }
//       the title (the heading, it takes the focus), repo #number, Open or Draft, the branch into the base, who opened
//       it and when, when it was read, Refresh; Checks (a plain summary, each failing or running check by name);
//       Review (requested of, approved by, changes asked for by); Description (folded after FOLD_LINES lines, Show
//       more); Files changed (the totals, each file a button that unfolds its patch); Conversation (newest last);
//       Open on GitHub and Open the flow at the bottom. Every cut the server made is SAID, with GitHub as the way on.
//   options(prLinks, ui)   the Options sheet: the one choice, as two radio buttons, and where it is kept
//   gear()                 the header's Options button
//   routeOf(hash) / hashOf(flowId)   #pr=<flow id> or #options: a reload, or a screenshot, opens there
//   fold(text, lines) / names(list) / patch(lines)   the small pure helpers, for the tests
//
// ⚠️ EVERY value is HOSTILE (GitHub's: anyone who can open a pull request or comment wrote it): esc everywhere. The
// description and the comments go through PhoneText.render, the SAME renderer as the chat with the coordinator, so
// only https://github.com links are tappable and no image or HTML ever is. A patch line is escaped text in a span of
// this file's own, its + or − kept (colour is never the only cue). A link only to an https github.com address
// (PhoneText.isGithub), never one the data merely claims. No inline style or handler (the CSP allows neither).
;(() => {
  const S = window.PhoneState
  const X = window.PhoneText
  const esc = X.esc
  const attr = (k, v) => ` ${k}="${esc(v)}"`
  const SLUG = /^[a-z0-9-]{1,80}$/
  const FOLD_LINES = 40
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  const num = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0)
  const thousands = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const list = v => (Array.isArray(v) ? v : [])
  /** A word from one of this file's own maps, never an inherited one (a state of 'toString' is no state). */
  const own = (map, key) => (typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : undefined)

  /** 'a', 'a and b', 'a, b and c'. */
  function names(v) {
    const l = list(v).map(String)
    return l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l.at(-1)}`
  }

  /** The first `lines` lines, a ``` block cut in half closed again, so the fold never swallows what follows. */
  function fold(text, lines = FOLD_LINES) {
    const all = String(text ?? '').split('\n')
    if (all.length <= lines) return { text: all.join('\n'), folded: false }
    const head = all.slice(0, lines)
    const fences = head.filter(l => /^\s*```/.test(l)).length
    return { text: head.join('\n') + (fences % 2 ? '\n```' : ''), folded: true }
  }

  /** A patch, line by line: escaped text in a span whose class says added, removed or a hunk head. */
  function patch(lines) {
    const kind = l => (l.startsWith('+') ? ' is-add' : l.startsWith('-') ? ' is-del' : l.startsWith('@@') ? ' is-hunk' : l.startsWith('\\') ? ' is-note' : '')
    // each line is a block of its own (phone.css .ph-ln), so nothing goes between them: a newline would be a blank line
    return list(lines).map(l => String(l ?? '')).map(l => `<span class="ph-ln${kind(l)}">${esc(l)}</span>`).join('')
  }

  const github = (url, label, cls = 'ph-btn primary') => (X.isGithub(url) ? `<a class="${cls}"${attr('href', url)} target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : '')

  function frame(title, body, close = 'data-ph-pr-close', extra = '') {
    return `<div class="ph-sheet-back" ${close}></div>` +
      `<section class="ph-sheet${extra}" role="dialog" aria-modal="true" aria-labelledby="phSheetTitle" tabindex="-1">` +
      `<header class="ph-sheet-head"><h2 id="phSheetTitle" class="ph-sheet-title" tabindex="-1">${esc(title)}</h2>` +
      `<button type="button" class="link ph-sheet-close" ${close}>Close</button></header>` +
      `<div class="ph-sheet-body">${body}</div></section>`
  }

  const STATE = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' }
  const CHECK = { failing: 'Failing', running: 'Running', passing: 'Passing', none: '' }

  function checksBlock(c = {}) {
    const word = own(CHECK, c.word) ?? ''
    const named = list(c.list).map(k => `<li class="is-${k?.state === 'failing' ? 'failing' : 'running'}"><span class="ph-pr-check-name">${esc(k?.name)}</span>` +
      `<span class="ph-pr-check-word">${k?.state === 'failing' ? 'Failing' : 'Running'}</span></li>`).join('')
    return '<h3 class="ph-h">Checks</h3>' +
      `<p class="ph-pr-checks is-${own(CHECK, c.word) === undefined ? 'none' : c.word}"><span class="ph-dot" aria-hidden="true"></span>${word ? `<b>${word}:</b> ` : ''}${esc(c.summary || 'No checks.')}</p>` +
      (named ? `<ul class="ph-pr-checklist">${named}</ul>` : '') +
      (num(c.more) ? `<p class="ph-faint">${esc(`${num(c.more)} more at GitHub.`)}</p>` : '')
  }

  function reviewBlock(r = {}) {
    const lines = []
    if (list(r.requested).length) lines.push(`Review requested from ${names(r.requested)}.`)
    if (list(r.changesBy).length) lines.push(`Changes asked for by ${names(r.changesBy)}.`)
    if (list(r.approvedBy).length) lines.push(`Approved by ${names(r.approvedBy)}.`)
    if (!lines.length) lines.push(r.decision === 'required' ? 'A review is needed before it can merge.' : r.decision === 'approved' ? 'Approved.' : r.decision === 'changes' ? 'Changes were asked for.' : 'No review yet.')
    return `<h3 class="ph-h">Review</h3>${lines.map(l => `<p class="ph-line">${esc(l)}</p>`).join('')}`
  }

  function bodyBlock(b = {}, open) {
    const raw = typeof b.text === 'string' ? b.text : ''
    if (!raw.trim()) return '<h3 class="ph-h">Description</h3><p class="ph-faint">No description.</p>'
    const f = fold(raw)
    return '<h3 class="ph-h">Description</h3>' +
      `<div class="ph-md ph-pr-desc" id="phPrDesc">${X.render(open || !f.folded ? raw : f.text)}</div>` +
      (f.folded ? `<button type="button" class="ph-more" data-ph-pr-body aria-expanded="${!!open}" aria-controls="phPrDesc">${open ? 'Show less' : 'Show more'}</button>` : '') +
      (b.cut ? '<p class="ph-faint">The description is longer than 20,000 characters: the rest is on GitHub.</p>' : '')
  }

  const WHY = {
    binary: 'A binary file: nothing to show as text.',
    empty: 'No lines changed: it was renamed or its mode changed.',
    later: 'Not shown here: the changes above already run to 1,500 lines. Open on GitHub to read this one.',
    missing: 'Its changes could not be read here. Open on GitHub to see them.',
  }
  const counts = (add, del) => `<span class="ph-pr-counts"><span class="is-add">+${num(add)}</span> <span class="is-del">−${num(del)}</span></span>`

  function filesBlock(fs = {}, open) {
    const items = list(fs.list)
    const rows = items.map((f, i) => {
      const unfolded = open.has(i)
      const lines = Array.isArray(f?.patch) && f.patch.length
      const inner = !unfolded ? ''
        : lines ? `<div class="ph-patch" id="phPatch${i}" data-ph-patch="${i}" role="region"${attr('aria-label', `Changes in ${f.path}`)} tabindex="0"><pre><code>${patch(f.patch)}</code></pre></div>` +
            (f.cut ? '<p class="ph-faint">Cut at 300 lines: the rest of this file is on GitHub.</p>' : '')
          : `<p class="ph-faint" id="phPatch${i}">${esc(own(WHY, f?.why) || WHY.missing)}</p>`
      return `<li><button type="button" class="ph-pr-file" data-ph-pr-file="${i}" aria-expanded="${unfolded}" aria-controls="phPatch${i}">` +
        // a long path breaks after a slash (a <wbr> of this file's own, between escaped pieces), not mid-name
        `<span class="ph-pr-path">${String(f?.path ?? '').split('/').map(esc).join('/<wbr>')}</span>${counts(f?.additions, f?.deletions)}</button>${inner}</li>`
    }).join('')
    const total = num(fs.count) || items.length
    return '<h3 class="ph-h">Files changed</h3>' +
      `<p class="ph-line">${esc(`${plural(total, 'file')}, `)}${counts(fs.additions, fs.deletions)}</p>` +
      (rows ? `<ul class="ph-pr-files">${rows}</ul>` : '') +
      (fs.cut ? `<p class="ph-faint">${esc(`Showing the first ${items.length} of ${thousands(total)} files. The rest are on GitHub.`)}</p>` : '') +
      (fs.linesCut ? '<p class="ph-faint">The changes shown here stop at 1,500 lines in all: the rest are on GitHub.</p>' : '')
  }

  const DID = { comment: 'commented', approved: 'approved', changes: 'asked for changes', commented: 'reviewed', dismissed: 'review dismissed' }

  function conversationBlock(c = {}) {
    const items = list(c.items)
    if (!items.length) return '<h3 class="ph-h">Conversation</h3><p class="ph-faint">No comments yet.</p>'
    const rows = items.map(i => {
      const did = i?.kind === 'review' ? own(DID, i.state) || 'reviewed' : 'commented'
      const head = [i?.author || 'Someone', S.when(i?.at), did].filter(Boolean)
      const body = typeof i?.text === 'string' && i.text.trim() ? `<div class="ph-md">${X.render(i.text)}</div>` : ''
      return `<li><p class="ph-pr-who"><b>${esc(head[0])}</b>${head.slice(1).map(h => ` · ${esc(h)}`).join('')}</p>${body}` +
        (i?.cut ? '<p class="ph-faint">Cut at 2,000 characters.</p>' : '') + '</li>'
    }).join('')
    return '<h3 class="ph-h">Conversation</h3>' + `<ol class="ph-convo">${rows}</ol>` +
      (c.cut ? `<p class="ph-faint">${esc(`The ${items.length} latest of ${num(c.total)} shown. The rest are on GitHub.`)}</p>` : '')
  }

  function foot(url, flowId) {
    const flow = SLUG.test(String(flowId ?? '')) ? `<button type="button" class="ph-btn"${attr('data-ph-pr-flow', flowId)}>Open the flow</button>` : ''
    const out = github(url, 'Open on GitHub')
    return out || flow ? `<div class="ph-actions ph-pr-foot">${out}${flow}</div>` : ''
  }

  function sheet(pr = {}, ui = {}, nowMs = Date.now()) {
    const d = pr.data
    if (!d) {
      if (pr.loading || !pr.error) return frame('Pull request', '<p class="ph-muted">Loading…</p>', 'data-ph-pr-close', ' is-pr')
      return frame('Pull request', `<p class="ph-muted">${esc(pr.error)}</p>${foot(pr.url, pr.flow)}`, 'data-ph-pr-close', ' is-pr')
    }
    const open = new Set(list(ui.files).map(Number))
    const state = own(STATE, d.state) ? d.state : 'open'
    const branch = d.head && d.base ? ` <span class="ph-pr-branch"><code>${esc(d.head)}</code> into <code>${esc(d.base)}</code></span>` : ''
    // when it was opened as the rest of the phone says a time (PhoneState.when: a clock today, else a date): the
    // desktop's one relative-time helper is not loaded here, and no second one may be written (test/copy.test.mjs)
    const opened = S.when(d.createdAt, nowMs)
    const by = [d.author ? `By ${d.author}` : '', opened ? `opened ${opened}` : ''].filter(Boolean).join(' · ')
    const read = pr.loading ? 'Reading…' : d.checkedAt && S.clock(d.checkedAt) ? `Read from GitHub at ${S.clock(d.checkedAt)}` : ''
    const note = pr.note || d.problem
    return frame(d.title || 'Pull request',
      `<p class="ph-kicker">${esc(d.label)}</p>` +
      `<p class="ph-pr-meta"><span class="ph-pr-state is-${state}">${STATE[state]}</span>${branch}</p>` +
      `<p class="ph-faint">${esc(by)}${by && read ? ' · ' : ''}${esc(read)} <button type="button" class="link ph-pr-refresh" data-ph-pr-refresh>Refresh</button></p>` +
      (note ? `<p class="ph-note ph-pr-problem" role="status">${esc(note)}</p>` : '') +
      checksBlock(d.checks) + reviewBlock(d.review) + bodyBlock(d.body, ui.bodyOpen) + filesBlock(d.files, open) + conversationBlock(d.conversation) +
      foot(d.url, d.flow?.id ?? pr.flow),
      'data-ph-pr-close', ' is-pr')
  }

  /** The page's one option, MUST CHANGE IN LOCKSTEP with phone-auth.mjs PREFS: kept on the session, never here. */
  const CHOICES = [['here', 'phPrefHere', 'Here', 'Read it on this page: checks, review, files and comments.'], ['github', 'phPrefGithub', 'On GitHub', 'Leave for GitHub in a new tab, as before.']]
  function options(prLinks, ui = {}) {
    const now = prLinks === 'github' ? 'github' : 'here'
    const radios = CHOICES.map(([value, id, label, sub]) =>
      `<label class="ph-radio"${attr('for', id)}><input type="radio"${attr('id', id)} name="phPrLinks"${attr('value', value)} data-ph-pref${now === value ? ' checked' : ''}${ui.busy ? ' disabled' : ''}>` +
      `<span class="ph-radio-text"><b>${esc(label)}</b><span class="ph-sub">${esc(sub)}</span></span></label>`).join('')
    return frame('Options',
      `<fieldset class="ph-opt"><legend class="ph-h">Open pull requests</legend>${radios}</fieldset>` +
      '<p class="ph-faint">Kept until you sign out: the phone stores nothing itself.</p>' +
      `<p class="ph-status" role="status">${esc(ui.status || '')}</p>`,
      'data-ph-options-close')
  }

  const GEAR = '<svg class="ph-gear-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="3"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
  const gear = () => `<button type="button" class="link ph-gear" data-ph-options aria-label="Options" aria-haspopup="dialog">${GEAR}</button>`

  function routeOf(hash) {
    const h = String(hash ?? '').replace(/^#/, '')
    const m = /^pr=(.*)$/.exec(h)
    return { pr: m && SLUG.test(m[1]) ? m[1] : null, options: h === 'options' }
  }
  const hashOf = flowId => `#pr=${flowId}`

  window.PhonePr = { sheet, options, gear, routeOf, hashOf, fold, names, patch }
})()
