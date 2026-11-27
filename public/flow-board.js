// The pure pieces of the Flows board (flows.js draws them): read in ten seconds,
// so a card carries only what tells you where a flow stands.
//
//   ┌─────────────────────────────────────────┐
//   │ Add a dark mode toggle   [waiting on you]│   the title and ONE state chip
//   │ Saved the choice in local storage…       │   one line of story
//   │ build · at Agent 3                       │   its route (flow-route.js strip): the type, where it is now,
//   │ Request Master Agent 3 QA Push Output    │   every step done, current or upcoming; `route not set` when guessed
//   │ Agent 3  ━━━━━━━━━━━━━━━━━━━━━───  13/18 │   the agent, small and muted, and a thin progress bar
//   │                         Archive   Delete │   its own Archive and Delete (flows.js makes the calls)
//   └─────────────────────────────────────────┘
//
// Tickets, the env and the updated time live inside the opened flow (flow-head.js).
//
//   card(f, { asking })           the card markup; `asking` ({ id, message }) is a Delete waiting on the server's
//                                 question, shown on that card with Delete and Cancel instead of its two actions
//   small(f, { asking })          the tile for a flow at the Output or dropped: its title, a compact route strip
//                                 with its type (flow-route.js strip, mini), the agent and the time, and the same
//                                 two actions
//   acts(f, asking)               the two actions alone
//   groups(flows)                 { live, done, dropped }, by ROUTE, not status: live is every flow still on its
//                                 way (open, blocked, or done with a current step, like QA passed and Push
//                                 waiting), done only a flow that reached the Output, dropped the dropped ones
//   storyLine(f)                  the line of story a card shows (chips rendered)
//   fit(root)                     cut each card's line again at a word until it fits (after a draw)
//   state(f)                      { word, cls } of the one chip, or null
//   askControls(f, n, slot)       an ask's Yes and No, or its text field (the Human review box, human-review.js)
// A flow waiting at the Output for the user's sign-off (completed-view.js) says so on its card or tile: the amber
// mark and the words Mark it completed; a completed one is archived, so the board never draws it.
//
//   shown(flows)                  the flows the board draws: never an archived or deleted one (/api/flows leaves
//                                 them out, but one opened from the archive is merged into the page's data)
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
    // by-hand steps (hand-steps.mjs) not all ticked on a live flow: work only the user can do
    const hand = Array.isArray(f.hand?.steps) ? f.hand.steps : []
    if ((f.status === 'open' || f.status === 'blocked') && hand.some(s => !s?.done)) return { word: 'yours by hand', cls: 'warn' }
    if (f.status === 'blocked') return { word: 'blocked', cls: 'bad' }
    if (out.pr?.url && !ready && out.pr.state === 'merged') return { word: 'merged', cls: 'ok' }
    if (out.pr?.url && !ready && out.pr.state === 'open') return { word: 'PR open', cls: 'accent' }
    if (ready) return { word: 'to send', cls: 'neutral' }
    if (f.status === 'done') return { word: 'done', cls: 'ok' }
    return null
  }

  /** The amber mark of a flow waiting for the user's sign-off (completed-view.js), or ''. */
  function signOff(f) {
    const C = window.CompletedView
    return C?.waits(f.id) ? C.markHtml(C.overdue(f.id), Number(C.data?.warnAfterDays) || 2) : ''
  }

  /** Archive and Delete for one flow on the board; while its Delete waits on the server's question, that question. */
  function acts(f, asking = null) {
    const id = esc(f.id)
    const title = esc(f.title)
    if (asking?.id === f.id) {
      return `<div class="fl-card-acts is-asking" role="group" aria-label="Delete ${title}"><span class="fl-card-ask">${esc(asking.message)}</span>` +
        `<button type="button" class="link fl-row-bad" data-card-delete="${id}" data-confirmed aria-label="Delete ${title}">Delete</button>` +
        `<button type="button" class="link" data-card-cancel aria-label="Cancel deleting ${title}">Cancel</button></div>`
    }
    return `<div class="fl-card-acts"><button type="button" class="link" data-card-archive="${id}" aria-label="Archive ${title}">Archive</button>` +
      `<button type="button" class="link fl-row-bad" data-card-delete="${id}" aria-label="Delete ${title}">Delete</button></div>`
  }

  function card(f, { asking = null } = {}) {
    const { done = 0, total = 0 } = f.derived?.progress || {}
    const s = state(f)
    const line = storyLine(f)
    return `<article class="fl-card${f.derived?.waiting?.length ? ' is-waiting' : ''}" data-open="${esc(f.id)}" tabindex="0">` +
      `<div class="fl-card-top"><span class="fl-card-title">${esc(f.title)}</span>${s ? `<span class="fl-chip ${s.cls}">${esc(s.word)}</span>` : ''}${window.QualityFlow?.chip(f) || ''}</div>` + // the risk chip (quality-flow.js)
      (line ? `<p class="fl-card-story" data-line="${esc(rawLine(f))}">${line}</p>` : '') +
      (signOff(f) ? `<p class="fl-card-sign">${signOff(f)}</p>` : '') +
      (window.FlowRoute?.strip(f) || '') + // its route from Request to Output (flow-route.js)
      `<div class="fl-prog"><span class="fl-card-agent">${esc(f.agent)}</span>` +
      `<div class="fl-bar"><i style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></div><span>${done}/${total}</span></div>${acts(f, asking)}</article>`
  }

  const small = (f, { asking = null } = {}) => `<article class="fl-small" data-open="${esc(f.id)}" tabindex="0"><span class="fl-card-title">${esc(f.title)}</span>${signOff(f)}` +
    (window.FlowRoute?.strip(f, { mini: true }) || '') +
    `<span class="small">${esc(f.agent)} · ${esc(window.Shell.ago(f.updatedAt))}</span>${acts(f, asking)}</article>`

  /** Archived and deleted flows stay off the board (and out of Human review): they are reached from the flow archive. */
  const shown = flows => (flows || []).filter(f => !f.archivedAt && !f.deletedAt)

  /**
   * Still on its way: open or blocked, or any flow but a dropped one whose route has a current step. A done flow
   * QA passed but has not pushed is done by status and still at Push by route: it stays a full card (QA attempt 2).
   */
  const onTheWay = f => f.status === 'open' || f.status === 'blocked' ||
    (f.status !== 'dropped' && Array.isArray(f.progress) && f.progress.some(s => s.state === 'current'))
  function groups(flows) {
    const list = shown(flows)
    return {
      live: list.filter(onTheWay),
      done: list.filter(f => f.status === 'done' && !onTheWay(f)),
      dropped: list.filter(f => f.status === 'dropped'),
    }
  }

  /**
   * The controls of an open ask in the Human review box on the Agents page (human-review.js): Yes and No, or a
   * text field, posted to the flow's answer route. `slot` names the text field's kept value (data-key), so a poll
   * redraw never loses what was typed.
   */
  function askControls(f, n, slot = 'ask') {
    if (n.kind === 'text') {
      return `<form class="fl-text" data-text="${esc(n.id)}"><input name="answer" data-key="${esc(slot)}:${esc(f.id)}:${esc(n.id)}" placeholder="Your answer" required aria-label="Your answer"><button type="submit" class="primary">Save</button></form>`
    }
    return `${choiceButtons(n)}
        ${otherAnswer(n, `${slot}:${f.id}:${n.id}:other`)}`
  }

  const BUTTON_MAX = 40 // the longest button label; the full meaning stays in its title

  /** A yes/no ask's two buttons, each named by what it means (an either-or question reads right), else Yes and No. */
  function choiceButtons(n) {
    const button = (value, word) => {
      const meaning = String(n[value] ?? '').replace(/\s+/g, ' ').trim()
      const label = meaning.length > BUTTON_MAX ? `${meaning.slice(0, BUTTON_MAX - 1).trimEnd()}…` : meaning || word
      return `<button type="button" class="fl-${value}" data-answer="${value}" data-node="${esc(n.id)}" title="${esc(meaning ? `${word}: ${meaning}` : word)}">${esc(label)}</button>`
    }
    return `${button('yes', 'Yes')}
        ${button('no', 'No')}`
  }

  /** The field under a yes/no ask for the user's own words, for a question neither button fits. */
  const otherAnswer = (n, key) =>
    `<form class="fl-text fl-other" data-text="${esc(n.id)}"><input name="answer" data-key="${esc(key)}" placeholder="Or write your own answer" required aria-label="Or write your own answer"><button type="submit">Save</button></form>`

  window.FlowBoard = { card, small, acts, askControls, choiceButtons, otherAnswer, groups, storyLine, state, clip, fit, shown }
})()
