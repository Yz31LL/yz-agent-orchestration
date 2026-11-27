// The Story block of a flow's Output (flow-output.js): the first thing you read,
// a few plain lines of who did what and why.
//
//   ● Agent 1   Did Playwright testing.
//   ● Agent 2   Checked the code for ‹idempotency› and built it as ‹detailed OOP›.
//               Why?  If an attacker tried ‹SQL injection›, it would get through.
//
// The lines are the server's flow.derived.story (flow-story.mjs): the agent's
// own (`flow say`), or, when it wrote none, up to 3 lines made from the steps,
// which look the same (the decision waiting on you credited to You); a small
// `auto` tag then sits in the block's corner. The block has no head and no
// border: it is the lead, read like a headline paragraph. The name chip shows once per run of
// lines by the same person. Marked words become term chips (terms.js). Nothing
// else goes in this block: what it is lives behind the opened flow's one `?`.
//
// Every open ask of the flow is a `You · To decide: …` line, `Why? …` under it (the agent's
// --why, else where the ask sits: FlowDrawer.why), with its own Yes and No (or
// a text field and Save), drawn here whether the agent wrote the story or not: while a
// flow is open the Waiting on you strip leaves its asks out, so this is where they are
// answered. The buttons carry the strip's data-answer / data-node and data-text hooks,
// so flows.js answers them through the one answer path (and relays like the strip).
//
//   html(c)      the block; `c` is flow-output.js's render context ({ m, keyed, flow })
//   tint(name)   the name chip's colour class, the same for the same name everywhere
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const chips = s => (window.Terms ? window.Terms.html(s) : s)
  const MAX = 8
  const TINTS = 6 // st-c0 … st-c5 in flow-output.css, each a tint of an existing colour token

  /** A stable colour per name: a small string hash over the tints. `You` is the neutral chip. */
  function tint(name) {
    if (name === 'You') return 'st-you'
    let h = 7
    for (const ch of String(name ?? '')) h = (h * 31 + ch.codePointAt(0)) >>> 0
    return `st-c${h % TINTS}`
  }
  /** A sentence ends with a full stop unless it already ends with punctuation of its own. */
  const stop = s => (/[.!?…:]$/.test(s) ? s : `${s}.`)

  /** One line; the name chip only on the first of a run of lines by the same person, the later ones sit under it. */
  function line(l, i, all) {
    const who = String(l.who || '')
    const did = stop(String(l.did || '').trim())
    const why = String(l.why || '').trim()
    const same = i > 0 && String(all[i - 1].who || '') === who
    const name = same ? '<span class="st-who-gap" aria-hidden="true"></span>' : `<span class="st-who ${tint(who)}">${esc(who)}</span>`
    return `<li class="st-line${same ? ' st-same' : ''}">${name}<div class="st-text">` +
      `<p class="st-did">${chips(esc(did))}</p>` +
      (why ? `<p class="st-why"><span class="st-why-k">Why?</span> ${chips(esc(why))}</p>` : '') + '</div></li>'
  }

  /** An open ask (the model's story.asks) as a line of the story, its reason under it, answerable in place. */
  function askLine(flowId, n) {
    const board = window.FlowBoard // buttons named by their meaning plus your own words, as in Human review
    const controls = n.kind === 'text'
      ? `<form class="fl-text" data-text="${esc(n.id)}"><input name="answer" data-key="story:${esc(flowId)}:${esc(n.id)}" placeholder="Your answer" required aria-label="Your answer"><button type="submit" class="primary">Save</button></form>`
      : board?.choiceButtons
        ? board.choiceButtons(n) + board.otherAnswer(n, `story:${flowId}:${n.id}:other`)
        : `<button type="button" class="fl-yes" data-answer="yes" data-node="${esc(n.id)}" title="${esc(n.yes || '')}">Yes</button>` +
          `<button type="button" class="fl-no" data-answer="no" data-node="${esc(n.id)}" title="${esc(n.no || '')}">No</button>`
    return `<li class="st-line st-ask" data-ask="${esc(n.id)}"><span class="st-who st-you">You</span><div class="st-text">` +
      `<p class="st-did">To decide: ${chips(esc(n.title))}</p>${window.FlowDrawer.why(n.why, { cls: 'st-why' })}` +
      `<div class="st-answer">${controls}</div></div></li>`
  }

  function html(c) {
    // the asks come from the model (flow-output.js), so an answer changes the signature and the line goes
    const { lines, derived, asks = [] } = c.m.story
    // the derived To decide line is drawn again below, with its buttons
    const told = lines.filter(l => !(l.derived && /^To decide:/.test(l.did))).slice(0, MAX)
    const shown = told.length || asks.length
    return `<section class="ob ob-story" aria-label="Story" ${c.keyed('story', [told, derived, asks])}>` +
      (derived && told.length ? '<span class="ob-corner"><span class="sb-tag">auto</span></span>' : '') +
      (shown ? `<ol class="st-list">${told.map(line).join('')}${asks.map(n => askLine(c.flow.id, n)).join('')}</ol>` : '<p class="small faint ob-empty">Nothing yet.</p>') +
      '</section>'
  }

  window.FlowStory = { html, tint }
})()
