// The chart of one flow (the Flows notebook page draws it): a layered layout
// and the SVG markup for it, as plain strings. No DOM here, so the Node tests
// can run this file in a vm with a stub window.
//
//   layout(flow)       rows by the longest path from a root, columns in list
//                      order, each lone child under its parent
//   svg(flow, layout)  one <g class="fc-node ..."> per node, elbow edges, and
//                      a rail per row coloured by that row's env
//
// The after rule matches resolveAfter in flows.mjs: an EMPTY after means the
// node follows the previous node in the list (the first node is the root),
// and several ids join branches. MUST CHANGE IN LOCKSTEP with flows.mjs.
;(() => {
  const NODE_W = 260
  const NODE_H = 40
  const GAP_X = 24
  const GAP_Y = 36
  const TITLE_PX = 13
  const TITLE_X = 28 // the title starts here, after the glyph
  const TITLE_MAX = NODE_W - 90 // room left for the glyph, env pill and evidence count

  // ═══ ASK NODES ═══ the right of an ask is RESERVED for its Yes / No buttons
  // or its answer, and the question is fitted to end CLEAR px left of that
  // area, so a long question never runs under the buttons.
  const CLEAR = 8
  const BTN_W = 30
  const YES_X = NODE_W - 92 // Yes button left edge, from the node left
  const NO_X = NODE_W - 58
  const ANSWER_PX = 12
  const ANSWER_W = 100 // the answered area, ending END_PAD px from the right
  const END_PAD = 10
  const ENV_PX = 11

  const GLYPH = { todo: '○', doing: '◐', done: '●', blocked: '■', skipped: '–' }

  const esc = s =>
    String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  // ─── text fitting ───────────────────────────────────────────────────────────
  // flow.js fit() measures with a canvas; this file has no DOM, so it estimates
  // each character's width as a share of the font size instead. Close enough to
  // keep a title inside its box; the full title is in the node's <title>.

  const charW = c =>
    ' iljtf.,:;|!\'"()[]'.includes(c) ? 0.3
      : 'mwMW@%'.includes(c) ? 0.85
        : c >= 'A' && c <= 'Z' ? 0.68
          : 0.56

  const textW = (text, px, weight) => {
    let w = 0
    for (const c of text) w += charW(c)
    return w * px * (weight >= 600 ? 1.06 : 1)
  }

  function fit(text, px, weight, max) {
    text = String(text || '')
    if (textW(text, px, weight) <= max) return text
    let lo = 0
    let hi = text.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (textW(`${text.slice(0, mid)}…`, px, weight) <= max) lo = mid
      else hi = mid - 1
    }
    return `${text.slice(0, lo).trimEnd()}…`
  }

  // ─── layout ─────────────────────────────────────────────────────────────────

  /** Map of node id to its parent ids, with the empty-after rule applied. */
  function resolveAfter(flow) {
    const map = new Map()
    flow.nodes.forEach((n, i) => {
      map.set(n.id, n.after?.length ? [...n.after] : i > 0 ? [flow.nodes[i - 1].id] : [])
    })
    return map
  }

  /** Row of each node: 1 + the deepest parent, roots on row 0. Parents come earlier in the list. */
  function rows(flow, parents) {
    const row = new Map()
    for (const n of flow.nodes) {
      const ps = parents.get(n.id).filter(p => row.has(p))
      row.set(n.id, ps.length ? 1 + Math.max(...ps.map(p => row.get(p))) : 0)
    }
    return row
  }

  /**
   * Column of each node. Within a row, nodes keep list order left to right; a
   * node with ONE parent sits under it when that column is still free, else it
   * takes the next free column. A join or a root takes the next free column.
   */
  function columns(flow, parents, row) {
    const col = new Map()
    const next = new Map() // row → first free column
    for (const n of flow.nodes) {
      const r = row.get(n.id)
      const free = next.get(r) ?? 0
      const ps = parents.get(n.id).filter(p => col.has(p))
      const c = ps.length === 1 ? Math.max(free, col.get(ps[0])) : free
      col.set(n.id, c)
      next.set(r, c + 1)
    }
    return col
  }

  function layout(flow) {
    const parents = resolveAfter(flow)
    const row = rows(flow, parents)
    const col = columns(flow, parents, row)
    const nodes = flow.nodes.map(n => ({
      id: n.id,
      x: col.get(n.id) * (NODE_W + GAP_X),
      y: row.get(n.id) * (NODE_H + GAP_Y),
      w: NODE_W,
      h: NODE_H,
      row: row.get(n.id),
      col: col.get(n.id),
    }))
    const edges = []
    for (const n of flow.nodes) {
      for (const p of parents.get(n.id)) if (row.has(p)) edges.push({ from: p, to: n.id })
    }
    const right = nodes.reduce((m, b) => Math.max(m, b.x + b.w), 0)
    const bottom = nodes.reduce((m, b) => Math.max(m, b.y + b.h), 0)
    return { nodes, edges, width: nodes.length ? right + GAP_X : 0, height: nodes.length ? bottom + GAP_Y : 0 }
  }

  // ─── svg ────────────────────────────────────────────────────────────────────

  const glyphOf = n => (n.type === 'ask' ? '?' : n.type === 'note' ? '·' : GLYPH[n.status] || GLYPH.todo)

  function nodeClass(flow, n) {
    const d = flow.derived || {}
    const cls = ['fc-node', `type-${n.type}`]
    if (n.status) cls.push(`st-${n.status}`)
    if ((d.pending || []).includes(n.id)) cls.push('pending')
    if (n.type === 'ask' && n.answer == null) cls.push('waiting')
    const proof = d.proof?.[n.id]
    if (proof) cls.push(`proof-${proof}`)
    return esc(cls.join(' '))
  }

  /** The node outline: a rect, or for an ask a diamond inscribed in the same box. */
  function shape(n, b) {
    if (n.type !== 'ask') return `<rect class="fc-shape" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6"/>`
    const cx = b.x + b.w / 2
    const cy = b.y + b.h / 2
    return `<path class="fc-shape" d="M${cx} ${b.y} L${b.x + b.w} ${cy} L${cx} ${b.y + b.h} L${b.x} ${cy} Z"/>`
  }

  /**
   * The right-hand area of an ask, and where its question must end.
   * Open: the Yes and No buttons. Answered: the Yes / No word or the first 20
   * chars of the text, fitted into ANSWER_W px, end-anchored at the right.
   * The env pill goes in the answered area only when it fits beside the
   * answer; an open ask has no room for it beside the buttons, so it is
   * dropped there (the row rail still shows the env). Asks take no evidence
   * (flows.mjs addEvidence refuses them), so no count is drawn.
   * ⚠️ An open TEXT ask gets no Yes and No: pressing Yes there saved the text "yes" as its answer.
   * It gets one `Answer…` pill instead, not an .fc-ans, so a click selects the node and the drawer
   * opens with its text field.
   */
  function askParts(flow, n, b, cy) {
    const parts = []
    const showEnv = n.env && n.env !== flow.env
    if (n.answer == null && n.kind === 'text') {
      const w = NO_X + BTN_W - YES_X
      parts.push(`<g class="fc-type"><rect x="${b.x + YES_X}" y="${b.y + b.h / 2 - 9}" width="${w}" height="18" rx="9"/>` +
        `<text x="${b.x + YES_X + w / 2}" y="${cy}" text-anchor="middle">Answer…</text></g>`)
      return { parts, titleMax: YES_X - CLEAR - TITLE_X }
    }
    if (n.answer == null) {
      const btn = (val, label, x) =>
        `<g class="fc-ans" data-answer="${val}" data-node="${esc(n.id)}">` +
        `<rect x="${x}" y="${b.y + b.h / 2 - 9}" width="${BTN_W}" height="18" rx="9"/>` +
        `<text x="${x + BTN_W / 2}" y="${cy}" text-anchor="middle">${label}</text></g>`
      parts.push(btn('yes', 'Yes', b.x + YES_X), btn('no', 'No', b.x + NO_X))
      return { parts, titleMax: YES_X - CLEAR - TITLE_X }
    }
    const raw = n.answer === 'yes' ? 'Yes' : n.answer === 'no' ? 'No' : String(n.answer).slice(0, 20)
    const text = fit(raw, ANSWER_PX, 600, ANSWER_W)
    const end = b.x + b.w - END_PAD
    parts.push(`<text class="fc-answer" x="${end}" y="${cy}" text-anchor="end">${esc(text)}</text>`)
    const used = textW(text, ANSWER_PX, 600) + 6
    if (showEnv && used + textW(n.env, ENV_PX, 500) <= ANSWER_W) {
      parts.push(`<text class="fc-env" x="${end - used}" y="${cy}" text-anchor="end">${esc(n.env)}</text>`)
    }
    return { parts, titleMax: NODE_W - END_PAD - ANSWER_W - CLEAR - TITLE_X }
  }

  /** A title as the chart shows it: marked words without their brackets (an SVG label is not a chip, terms.js). */
  const plain = s => (typeof window !== 'undefined' && window.Terms ? window.Terms.plain(s) : String(s ?? ''))
  /**
   * A node's tooltip: its title, and for an ask WHY it is asked (FlowDrawer.reason: the agent's --why, else
   * where it sits), since the diamond has no room to show it. flows.js decorate adds a pending reason under it.
   */
  function tip(flow, n) {
    const title = plain(n.title)
    if (n.type !== 'ask') return title
    const D = typeof window !== 'undefined' ? window.FlowDrawer : null
    const why = D?.reason ? D.reason(flow, n).text : flow.derived?.reasons?.[n.id]?.text || String(n.why ?? '').trim()
    return why ? `${title}\nWhy? ${plain(why)}` : title
  }

  function renderNode(flow, n, b) {
    const cy = b.y + b.h / 2 + 4.5 // text baseline that centres 13 px text
    const ask = n.type === 'ask' ? askParts(flow, n, b, cy) : null
    const parts = [
      `<g class="${nodeClass(flow, n)}" data-node="${esc(n.id)}">`,
      `<title>${esc(tip(flow, n))}</title>`,
      shape(n, b),
      `<text class="fc-glyph" x="${b.x + 14}" y="${cy}" text-anchor="middle">${glyphOf(n)}</text>`,
      `<text class="fc-title" x="${b.x + TITLE_X}" y="${cy}">${esc(fit(plain(n.title), TITLE_PX, 500, ask ? ask.titleMax : TITLE_MAX))}</text>`,
    ]
    if (ask) parts.push(...ask.parts)
    else {
      if (n.env && n.env !== flow.env) {
        parts.push(`<text class="fc-env" x="${b.x + b.w - 30}" y="${cy}" text-anchor="end">${esc(n.env)}</text>`)
      }
      if (n.evidence?.length) {
        parts.push(`<text class="fc-ev" x="${b.x + b.w - 10}" y="${cy}" text-anchor="end">${n.evidence.length}</text>`)
      }
    }
    parts.push('</g>')
    return parts.join('')
  }

  /** An elbow from the bottom centre of `from` to the top centre of `to`, turning in the gap below `from`. */
  function renderEdge(e, box) {
    const a = box.get(e.from)
    const b = box.get(e.to)
    if (!a || !b) return ''
    const x1 = a.x + a.w / 2
    const y1 = a.y + a.h
    const x2 = b.x + b.w / 2
    const y2 = b.y
    return `<path class="fc-edge" d="M${x1} ${y1} V${y1 + GAP_Y / 2} H${x2} V${y2}"/>`
  }

  /** One rail per row in the left margin, coloured by the row's first node env, else the flow's. */
  function renderRails(flow, lay) {
    const byId = new Map(flow.nodes.map(n => [n.id, n]))
    const first = new Map() // row → first node in list order
    for (const b of lay.nodes) if (!first.has(b.row)) first.set(b.row, byId.get(b.id))
    return [...first.keys()].sort((a, b) => a - b).map(r => {
      const env = first.get(r)?.env || flow.env
      return `<rect class="fc-rail env-${esc(env)}" x="${-GAP_X / 2}" y="${r * (NODE_H + GAP_Y)}" width="4" height="${NODE_H}"/>`
    }).join('')
  }

  /** The whole chart. The view box keeps half a gap of margin on every side, where the rails sit. */
  function svg(flow, lay) {
    const box = new Map(lay.nodes.map(b => [b.id, b]))
    const byId = new Map(flow.nodes.map(n => [n.id, n]))
    const vb = `${-GAP_X / 2} ${-GAP_Y / 2} ${lay.width} ${lay.height}`
    return `<svg class="fc" xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${lay.width}" height="${lay.height}">` +
      `<g class="fc-rails">${renderRails(flow, lay)}</g>` +
      `<g class="fc-edges">${lay.edges.map(e => renderEdge(e, box)).join('')}</g>` +
      `<g class="fc-nodes">${lay.nodes.map(b => (byId.has(b.id) ? renderNode(flow, byId.get(b.id), b) : '')).join('')}</g>` +
      '</svg>'
  }

  // ─── why a node is pending ──────────────────────────────────────────────────
  // ONE copy, shared by the chart's tooltips and the drawer (flows.js) and the
  // Output view (flow-output.js). The server's derived.pending says WHICH nodes
  // wait; this says why, over the same after rule.

  const PENDING = { waiting: 'waiting on the answer', no: 'after a No; the agent decides what happens next' }
  /** Why each node downstream of an ask waits: downstream of an open ask wins over downstream of a No. */
  function pendingReasons(flow) {
    const next = new Map(flow.nodes.map(n => [n.id, []]))
    for (const [id, ps] of resolveAfter(flow)) for (const p of ps) next.get(p)?.push(id)
    const reason = new Map()
    const spread = (from, why) => {
      const queue = [...from]
      while (queue.length) for (const id of next.get(queue.shift()) || []) if (!reason.has(id)) { reason.set(id, why); queue.push(id) }
    }
    const asks = flow.nodes.filter(n => n.type === 'ask')
    spread(asks.filter(n => n.answer == null).map(n => n.id), PENDING.waiting)
    spread(asks.filter(n => n.answer === 'no').map(n => n.id), PENDING.no)
    return reason
  }
  /** The reason node `id` is pending, or '' when derived.pending does not list it. */
  function pendingReason(flow, id, reasons = null) {
    if (!(flow.derived?.pending || []).includes(id)) return ''
    return (reasons || pendingReasons(flow)).get(id) || PENDING.waiting
  }

  // textW and fit measure text for diagram.js too, so the Output's charts fit their labels the same way.
  if (typeof window !== 'undefined') window.FlowChart = { layout, svg, tip, pendingReasons, pendingReason, textW, fit, NODE_W, NODE_H, GAP_X, GAP_Y }
})()
