// The four repairs the watchdog may do (heal-checks.mjs REPAIRS), as actions heal-runner.mjs calls, and nothing else.
//
//   makeRepairs({ sources, relay, restartLoop, stores, rebuild, stateFile, now })
//     -> { 'pause-refresh', 'hold-deliveries', 'copy-rebuild', 'restart-loop' }: each async (target) => { ok, did?, error? }
//
//   pause-refresh     sources.pause(id): the collection's timer skips its turns, in memory (factory.mjs). config.json
//                     is never written; Resume on the Health page undoes it.
//   hold-deliveries   relay.hold(agent): no paid turn for that agent until Release (relay.mjs).
//   copy-rebuild      for each damaged store named: when the dashboard can rebuild it (`rebuild[kind]`), the damaged
//                     file is MOVED aside as `<name>.damaged-<stamp>` and the store is rebuilt from its sources; when
//                     it cannot, the file is COPIED aside and stays for the user to mend. Either way the damaged
//                     version is kept, and heal-state.json `copied` notes it so it is copied once.
//   restart-loop      restartLoop(name): one more pass of that loop (heal-beats.mjs); the check never asks twice.
// Each is local and reversible, costs nothing, and runs no model. `rebuild` is { token, standup, alerts } in the server
// (insight-wiring.mjs); tests pass their own.

import { statSync } from 'node:fs'

import { keepAside } from './heal-facts.mjs'
import { updateHealState } from './heal-store.mjs'

export function makeRepairs({ sources, relay, restartLoop, stores = [], rebuild = {}, stateFile, now = () => Date.now() }) {
  return {
    async 'pause-refresh'(id) {
      return sources?.pause?.(id) ? { ok: true } : { ok: false, error: 'there is no such collection, or it is paused already' }
    },
    async 'hold-deliveries'(agent) {
      return relay?.hold?.(agent) ? { ok: true } : { ok: false, error: 'its deliveries are held already' }
    },
    async 'copy-rebuild'(targets) {
      const did = []
      const errors = []
      for (const name of String(targets || '').split(',').filter(Boolean)) {
        const store = stores.find(s => s.name === name)
        if (!store) {
          errors.push(`${name} is not a store the watchdog knows`)
          continue
        }
        try {
          const st = statSync(store.file)
          const sig = `${st.size}:${Math.round(st.mtimeMs)}`
          const fix = store.rebuild ? rebuild[store.rebuild] : null
          const kept = keepAside(store.file, { move: !!fix, now: now() })
          const keptName = kept.replace(/\\/g, '/').split('/').pop()
          const what = store.label.replace(/^the /i, '')
          updateHealState(s => ({ ...s, copied: { ...s.copied, [name]: sig } }), stateFile)
          if (fix) {
            await fix()
            did.push(`Kept the damaged ${what} as ${keptName} and rebuilt it from its sources.`)
          } else did.push(`Kept a copy of the damaged ${what} as ${keptName}. It cannot be rebuilt from other files: mend it by hand, or put the copy back.`)
        } catch (err) {
          errors.push(`${store.label}: ${err?.message || err}`)
        }
      }
      return errors.length && !did.length ? { ok: false, error: errors.join('; ') } : { ok: true, did: [...did, ...errors.map(e => `Could not: ${e}.`)].join(' ') }
    },
    async 'restart-loop'(name) {
      return restartLoop?.(name) ? { ok: true } : { ok: false, error: 'that loop cannot be started from here' }
    },
  }
}
