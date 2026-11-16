// The pure pieces of the Flows board (flows.js draws them): read in ten seconds,
// so a card carries only what tells you where a flow stands.
//
//   ┌─────────────────────────────────────────┐
//   │ Add a dark mode toggle   [waiting on you]│   the title and ONE state chip
//   │ Saved the choice in local storage…       │   one line of story
//   │ Agent 3  ━━━━━━━━━━━━━━━━━━━━━───  13/18 │   the agent, small and muted, and a thin progress bar
//   └─────────────────────────────────────────┘
//
// Tickets, the env and the updated time live inside the opened flow (flow-head.js).
//
//   card(f)                       the card markup
//   small(f)                      the one-line tile for a done or dropped flow
//   storyLine(f)                  the line of story a card shows (chips rendered)
//   fit(root)                     cut each card's line again at a word until it fits (after a draw)
//   state(f)                      { word, cls } of the one chip, or null
//   stripHead(count, openId)      Waiting on you, or Also waiting while a flow is open
//   stripRows(flows, recent, openId)   the open asks for Waiting on you, newest first,
//                                 without those of the flow that is open (its Story and
//                                 Status already ask them)
//   stripRow({ f, n })            one row of it: the question, why it is asked under it, the controls
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const chips = s => (window.Terms ? window.Terms.html(esc(s)) : esc(s))
  const LINE_MAX = 80

  /** A cut never ends on one of these: `Moved the report job to the…` reads as broken. */
  const SHORT = /\s(a|an|the|of|to|in|on|at|for|with|and|or|but|by|from|as|into|is|its|that)$/i

  /** `s` cut to `max` at a word boundary with …, never inside a [marked word], never after a short function word. */
  function clip(s, max = LINE_MAX) {
    const t = String(s ?? '').trim()
    if (t.length <= max) return t
    let cut = t.slice(0, max)
    const space = cut.lastIndexOf(' ')
    if (space > 0) cut = cut.slice(0, space)
    if ((cut.match(/\[/g) || []).length > (cut.match(/\]/g) || []).length) cut = cut.replace(/\[[^\]]*$/, '').trimEnd()
    cut = cut.replace(/[,;:.]$/, '')
    while (SHORT.test(cut)) cut = cut.replace(/\s+\S+$/, '').replace(/[,;:.]$/, '')
    return `${cut}…`
  }

  /**
   * The raw text of the line a card shows, what most needs you first: the open ask (`To decide: …`), else
   * what is blocked, else the latest line the agent wrote, else the first the dashboard made from the steps.
   */
  function rawLine(f) {
    const ask = (f.nodes || []).find(n => n.type === 'ask' && n.answer == null)
    if (ask) return `To decide: ${String(ask.title || '').trim()}`
    const stuck = (f.nodes || []).find(n => n.status === 'blocked')
    if (stuck) return `Blocked: ${String(stuck.title || '').trim()}`
    const lines = f.derived?.story || []
    const own = lines.filter(l => !l.derived)
    const line = own.length ? own.at(-1) : lines[0]
    return line ? String(line.did || '').trim().replace(/\.$/, '') : ''
  }
  const storyLine = f => chips(clip(rawLine(f)))

  /**
   * Each card's story line cut again, a word at a time, until it fits its card on one line: the
   * cut is always between two words, never the browser's ellipsis inside one. After each draw.
   */
  function fit(root) {
    for (const el of root.querySelectorAll('.fl-card-story[data-line]')) {
      for (let max = LINE_MAX; el.scrollWidth > el.clientWidth + 1 && max > 12; max -= 4) el.innerHTML = chips(clip(el.dataset.line, max))
    }
  }

  /** The one chip: what most needs you, else where it stands. */
  function state(f) {
    const d = f.derived || {}
    const out = f.output || {}
    const ready = !!d.output?.merge?.ready
    if (d.waiting?.length) return { word: 'waiting on you', cls: 'warn' }
    if (f.status === 'blocked') return { word: 'blocked', cls: 'bad' }
    if (out.pr?.url && !ready && out.pr.state === 'merged') return { word: 'merged', cls: 'ok' }
    if (out.pr?.url && !ready && out.pr.state === 'open') return { word: 'PR open', cls: 'accent' }
    if (ready) return { word: 'to send', cls: 'neutral' }
    if (f.status === 'done') return { word: 'done', cls: 'ok' }
    return null
  }

  function card(f) {
    const { done = 0, total = 0 } = f.derived?.progress || {}
    const s = state(f)
    const line = storyLine(f)
    return `<article class="fl-card${f.derived?.waiting?.length ? ' is-waiting' : ''}" data-open="${esc(f.id)}" tabindex="0">` +
      `<div class="fl-card-top"><span class="fl-card-title">${esc(f.title)}</span>${s ? `<span class="fl-chip ${s.cls}">${esc(s.word)}</span>` : ''}</div>` +
      (line ? `<p class="fl-card-story" data-line="${esc(rawLine(f))}">${line}</p>` : '') +
      `<div class="fl-prog"><span class="fl-card-agent">${esc(f.agent)}</span>` +
      `<div class="fl-bar"><i style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></div><span>${done}/${total}</span></div></article>`
  }

  const small = f => `<article class="fl-small" data-open="${esc(f.id)}" tabindex="0"><span class="fl-card-title">${esc(f.title)}</span>` +
    `<span class="small">${esc(f.agent)} · ${esc(window.Shell.ago(f.updatedAt))}</span></article>`

  function stripRows(flows, recent, openId = null) {
    const rows = []
    for (const f of flows) {
      if (f.status === 'dropped' || f.id === openId) continue
      f.nodes.forEach((n, i) => {
        if (n.type === 'ask' && (n.answer == null || recent.has(`${f.id}:${n.id}`))) rows.push({ f, n, i })
      })
    }
    // Newest first: asks carry no time of their own, so the flow's last update, then the later ask.
    return rows.sort((a, b) => String(b.f.updatedAt).localeCompare(String(a.f.updatedAt)) || b.i - a.i)
  }

  /**
   * One row of Waiting on you (Home and the Flows page): who, the flow, the question, and under it WHY it is
   * asked (FlowDrawer.why: the agent's --why, else where the ask sits), shown, not behind a hover. Then Yes and
   * No, or a text field; an ask answered from this page shows its answer and delivery until the next poll.
   */
  function stripRow({ f, n }) {
    const D = window.FlowDrawer
    let controls
    if (n.answer != null) {
      controls = `<span class="fl-answered-word">${esc(n.answer === 'yes' ? 'Yes' : n.answer === 'no' ? 'No' : n.answer)}</span>${D.delivery(n)}`
    } else if (n.kind === 'text') {
      controls = `<form class="fl-text" data-text="${esc(n.id)}"><input name="answer" data-key="strip:${esc(f.id)}:${esc(n.id)}" placeholder="Your answer" required aria-label="Your answer"><button type="submit" class="primary">Save</button></form>`
    } else {
      controls = `<button type="button" class="fl-yes" data-answer="yes" data-node="${esc(n.id)}" title="${esc(n.yes)}">Yes</button>
        <button type="button" class="fl-no" data-answer="no" data-node="${esc(n.id)}" title="${esc(n.no)}">No</button>`
    }
    return `<div class="fl-wait-row" data-flow="${esc(f.id)}">
        <div class="fl-wait-main"><div class="fl-wait-q"><b>${esc(f.agent)}</b> · <span class="fl-wait-ft">${esc(f.title)}</span> · <span class="fl-wait-ask">${chips(n.title)}</span></div>
          ${D.why(D.reason(f, n), { cls: 'fl-wait-why' })}</div>
        <div class="fl-wait-acts">${controls}<button type="button" class="link" data-show="${esc(n.id)}">show in flow</button></div>
      </div>`
  }

  /** The strip's head: one count per screen, so with a flow open (its own asks left out) it says Also waiting. */
  const stripHead = (count, openId) => (openId ? 'Also waiting' : 'Waiting on you')

  window.FlowBoard = { card, small, storyLine, state, stripRows, stripRow, stripHead, clip, fit }
})()
