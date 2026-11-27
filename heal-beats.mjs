// The heartbeats of the server's background loops, for the watchdog's Loops check (heal-checks.mjs loopsCheck).
//
// Each loop registers itself when it starts and beats each time one pass of it ENDS (a pass that hangs never beats,
// which is exactly what the check looks for):
//   registerLoop(name, { label, everyMs, restart })   restart(): one more pass now, its stuck in-flight guard cleared
//   beat(name, ms?)                                    a pass ended (`ms` how long it took: the Server check names the
//                                                      slowest work of the minute)
//   restartLoop(name)                                  the watchdog's ONE restart (heal-runner.mjs restart-loop)
//   loopsView()                                        [{ name, label, everyMs, startedAt, lastAt, restartedAt, lastMs }]
//
// The loops that register (each in its own file, one line where its pass ends):
//   predict   Predict and warn's sweep, every minute (predict-routes.mjs)
//   routing   Routing's outcome sweep, every minute (routing-routes.mjs)
//   prlist    the Pull requests list's read of GitHub, every minute (prlist-store.mjs)
//   quality   the quality watch: risk labels, lessons and second opinions, every 30 seconds (quality-watch.mjs)
//   rework    the QA rework watch, every 15 seconds (qa-rework.mjs)
// Not here: the Learn verdict baselines are not a loop (each is written at the moment a rule changes), and the phone
// access watcher (phone-wiring.mjs) is left to the phone feature's own files.
//
// ONE registry per process (the module's own), so a loop beats without being handed anything; makeBeats() gives a
// test its own. A beat or restart for a name that never registered does nothing.

export function makeBeats({ now = () => Date.now() } = {}) {
  const loops = new Map()
  const iso = () => new Date(now()).toISOString()
  return {
    registerLoop(name, { label = name, everyMs, restart = null } = {}) {
      if (typeof name !== 'string' || !name || !(everyMs > 0)) return false
      const had = loops.get(name)
      loops.set(name, { name, label, everyMs, restart, startedAt: had?.startedAt || iso(), lastAt: had?.lastAt || null, restartedAt: had?.restartedAt || null, lastMs: had?.lastMs ?? null })
      return true
    },
    beat(name, ms) {
      const l = loops.get(name)
      if (!l) return
      l.lastAt = iso()
      if (Number.isFinite(ms)) l.lastMs = ms
    },
    restartLoop(name) {
      const l = loops.get(name)
      if (!l || typeof l.restart !== 'function') return false
      l.restartedAt = iso()
      try {
        const p = l.restart()
        p?.catch?.(() => {})
      } catch {
        /* the check sees it stay silent and reports it */
      }
      return true
    },
    loopsView() {
      return [...loops.values()].map(({ restart, ...rest }) => ({ ...rest }))
    },
  }
}

const shared = makeBeats()
export const registerLoop = shared.registerLoop
export const beat = shared.beat
export const restartLoop = shared.restartLoop
export const loopsView = shared.loopsView
