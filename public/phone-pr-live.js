// The pull request sheet's live half (public/phone.html), and the Options sheet's: opening, reading, Refresh, the
// folds, closing with the focus given back, and the one option. phone-app.js makes ONE of these with its own state,
// network call and draw; the markup and the words are public/phone-pr.js.
//
// Rules this file keeps:
// - A pull request is read by its FLOW ID only (GET /phone/api/pr?flow=<id>): the server reads it from the Pull
//   requests list, never from anything the page sends (phone-pr.mjs). Nothing here writes to GitHub.
// - It is read when the sheet opens and when Refresh is tapped, never on a timer; the server keeps a copy a minute,
//   so Refresh within the minute shows the same copy and says when it was read. A failed Refresh keeps the copy on
//   screen with the plain line the server gave.
// - Each sheet is a modal dialog like the flow sheet: the heading takes the focus, Tab stays inside (phone-app.js
//   trapTab), Escape, Close or a tap outside closes it and gives the focus back to what opened it. Opened from a flow
//   sheet, Close goes back to THAT sheet, as it was, with the focus on its pull request.
// - The address names the open sheet (#pr=<flow id>, #options), so a reload opens it again.
// - A redraw (the 15 s poll) keeps which files are unfolded, the description's fold, the sheet's scroll (phone-app.js)
//   and how far each patch was scrolled sideways (keep / restore).
// - The option (Open pull requests: here | on GitHub) lives on the SESSION, not here: the page stores nothing
//   (phone-app.js). It is sent with POST /phone/api/prefs and read back from /phone/api/me.
//
//   PhonePrLive.make({ root, st, call, draw, offline, openFlow, hashOfTab }) ->
//     { open(flowId), close(), refresh(), fromAddress(), isOpen(), onClick(target), onChange(target), onEscape(),
//       keep(), restore(kept) }
;(() => {
  const P = window.PhonePr

  function make({ root, st, call, draw, offline, openFlow, hashOfTab }) {
    const setHash = h => window.history?.replaceState?.(null, '', h)
    const focus = sel => root.querySelector(sel)?.focus()
    /** What opened a pull request: inside an open sheet first (the list under it has the same button). */
    const prButton = id => [...(root.querySelector('.ph-sheet') || root).querySelectorAll('[data-ph-pr]')].find(b => b.getAttribute('data-ph-pr') === id)

    async function load() {
      const id = st.pr?.flow
      if (!id) return
      st.pr.loading = true
      draw()
      const r = await call('GET', `/phone/api/pr?flow=${encodeURIComponent(id)}`)
      if (st.pr?.flow !== id) return // closed, or another opened meanwhile
      st.pr.loading = false
      if (r.status === 200) Object.assign(st.pr, { data: r.json, error: '', note: '' })
      else if (r.status !== 401) {
        const why = r.status ? r.json.error || 'That pull request could not be read.' : offline
        // a copy already on screen stays, with the reason it could not be read again
        if (st.pr.data) st.pr.note = why
        else Object.assign(st.pr, { error: why, url: r.json?.url || '' })
      }
      draw()
    }

    /** Opens the sheet for this flow's pull request; from a flow sheet, that sheet is kept to come back to. */
    function open(id) {
      st.pr = { flow: id, loading: true, data: null, error: '', note: '', url: '', files: [], bodyOpen: false, back: st.sheet || null }
      st.sheet = null
      setHash(P.hashOf(id))
      draw()
      focus('#phSheetTitle')
      return load()
    }

    function close() {
      const { flow, back } = st.pr || {}
      st.pr = null
      st.sheet = back || null
      setHash(back ? `#flow=${encodeURIComponent(back.id)}` : hashOfTab())
      draw()
      prButton(flow)?.focus()
    }

    function openOptions() {
      st.options = { status: '', busy: false }
      setHash('#options')
      draw()
      focus('#phSheetTitle')
    }
    function closeOptions() {
      st.options = null
      setHash(hashOfTab())
      draw()
      focus('[data-ph-options]')
    }

    async function setPref(value) {
      if (!st.options || st.options.busy) return
      st.options = { status: 'Saving…', busy: true }
      draw()
      const r = await call('POST', '/phone/api/prefs', { prLinks: value })
      if (r.status === 401 || !st.options) return
      if (r.status === 200) st.ui.prLinks = r.json.prLinks === 'github' ? 'github' : 'here'
      st.options = { busy: false, status: r.status === 200 ? 'Saved.' : r.status ? r.json.error || 'Not saved.' : offline }
      draw()
      focus(st.ui.prLinks === 'github' ? '#phPrefGithub' : '#phPrefHere')
    }

    function toggle(list, value) {
      const set = new Set(list)
      if (set.has(value)) set.delete(value)
      else set.add(value)
      return [...set]
    }

    function onClick(t) {
      if (t.closest('[data-ph-options-close]')) return closeOptions(), true
      if (t.closest('[data-ph-options]')) return openOptions(), true
      if (t.closest('[data-ph-pr-close]')) return close(), true
      const pr = t.closest('[data-ph-pr]')
      if (pr) return open(pr.getAttribute('data-ph-pr')), true
      if (!st.pr) return false
      if (t.closest('[data-ph-pr-refresh]')) return load(), true
      const file = t.closest('[data-ph-pr-file]')
      if (file) {
        st.pr.files = toggle(st.pr.files, Number(file.getAttribute('data-ph-pr-file')))
        return draw(), true
      }
      if (t.closest('[data-ph-pr-body]')) {
        st.pr.bodyOpen = !st.pr.bodyOpen
        return draw(), true
      }
      const flow = t.closest('[data-ph-pr-flow]')
      if (flow) {
        st.pr = null
        openFlow(flow.getAttribute('data-ph-pr-flow'))
        return true
      }
      return false
    }

    const onChange = t => (t?.matches?.('[data-ph-pref]') ? (setPref(t.value), true) : false)
    /** Escape: Options first, then the pull request sheet; false when neither is open. */
    const onEscape = () => (st.options ? (closeOptions(), true) : st.pr ? (close(), true) : false)
    const isOpen = () => !!(st.pr || st.options)

    /** The sheet the address names, once, after sign-in (phone-app.js opened). */
    function fromAddress() {
      const r = P.routeOf(window.location.hash)
      if (r.options) return openOptions()
      if (r.pr) return open(r.pr)
    }

    // how far each unfolded patch was scrolled sideways, so a redraw does not jump it back to the start
    const keep = () => [...root.querySelectorAll('[data-ph-patch]')].map(el => [el.getAttribute('data-ph-patch'), el.scrollLeft])
    function restore(kept) {
      for (const [k, left] of kept || []) {
        const el = [...root.querySelectorAll('[data-ph-patch]')].find(e => e.getAttribute('data-ph-patch') === k)
        if (el) el.scrollLeft = left
      }
    }

    return { open, close, refresh: load, fromAddress, isOpen, onClick, onChange, onEscape, keep, restore }
  }

  window.PhonePrLive = { make }
})()
