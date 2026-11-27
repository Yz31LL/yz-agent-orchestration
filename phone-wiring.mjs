// Phone access, wired to the running server (server.mjs calls startPhone once, after its own 127.0.0.1 listener is
// up). Everything real is built here and nowhere else: the live remote block (phone-bind.mjs), the sign-in store
// (phone-auth.mjs), Talk to Master (phone-talk.mjs, sending through the relay's own headless turn), the allowlist
// (phone-actions.mjs), the listener (phone-server.mjs) and the door that opens and closes it (phone-door.mjs).
//
// With no `remote` block in config.json, or one that is off, nothing new listens. The door is built ALWAYS and ticked
// every CHECK_MS, so a valid block written while the dashboard runs (phone-setup, then phone-pin) opens the listener
// within CHECK_MS, as the desktop's Phone access now listens on <address> says. ⚠️ It used to be built only when the
// block was on at start, so a server started with no block never opened it until a restart (QA, 2026-11-26).
//
// The listener closes on any change (turned off on the desktop or in config.json, three lockouts in a day, a
// config.json that does not parse, this PC off the network it was set up on) and opens again when the block is good
// again, such as when the PC is back on that network.
//
//   startPhone({ getStatus, relay, run, sessions, transcriptFile, alerts?, prs?, gh? }, { reader?, configFile?, every? })   { door, stop() }
//   alerts: Predict and warn's own answer (predict-routes.mjs route.alerts), for the Agents tab's alert lines
//   prs:    the desktop's Pull requests list (prlist-store.mjs snapshot().items), for the Agents tab's open pull
//           requests: the SAME list the fog block shows, so the phone adds no gh read of its own for the list
//   gh:     server.mjs's GitHub runner, for ONE thing: reading a pull request that list holds when the phone opens it
//           (phone-pr.mjs: gh pr view and gh pr diff, read only, cached a minute, two at a time at most)

import { CONFIG, CONFIG_FILE } from './config.mjs'
import { makePhoneActions } from './phone-actions.mjs'
import { makeAuthStore } from './phone-auth.mjs'
import { makeRemoteReader } from './phone-bind.mjs'
import { turnPhoneOff } from './phone-config.mjs'
import { makeDoor } from './phone-door.mjs'
import { makePrReader } from './phone-pr.mjs'
import { makePhoneHandler, startPhoneListener } from './phone-server.mjs'
import { makeTalk } from './phone-talk.mjs'

/** The remote block as config.json and the network say now: one reader for the listener and the desktop Settings card. */
export const remoteNow = makeRemoteReader(CONFIG_FILE, { mainPort: CONFIG.port })

/** How often the door is checked against the block and the network, when no phone is asking. */
const CHECK_MS = 5000

/**
 * The CHANGE WATCHER (review point 3): every `every` ms, what config.json's remote block says now goes to the auth
 * store (phone-auth.mjs noteRemote), which turns each change of remote.enabled, remote.bind or the PIN hash into an
 * event: a toast and a Phone on badge on the desktop (public/phone-notice.js), a line in the Log and on the Phone card.
 * It runs whatever the block says, phone access off or not set up included, because the change worth seeing is
 * exactly the one that turns it on. It opens nothing and, with no block, writes nothing. A config.json that does not
 * parse is skipped (the listener is closed by the reader meanwhile).
 */
export function watchRemote({ reader = remoteNow, auth = makeAuthStore(), every = CHECK_MS } = {}) {
  const look = () => {
    try {
      const s = reader()
      if (s.unreadable) return
      auth.noteRemote({ wanted: s.wanted, bind: s.bind, pinHash: s.pinHash })
    } catch (err) {
      console.error(`phone: the change watcher could not look at config.json: ${err?.message || err}`)
    }
  }
  look()
  const timer = setInterval(look, every)
  timer.unref()
  return { look, stop: () => clearInterval(timer) }
}

/** The coordinator's session, live or pinned, by its session name (config coordinator). */
const coordinatorOf = async sessions => (await sessions()).find(s => s.name === CONFIG.coordinator) || null

export function startPhone({ getStatus, relay, run, sessions, transcriptFile, alerts = async () => null, prs = () => [], gh = async () => ({ ok: false, out: '' }) }, { reader = remoteNow, configFile = CONFIG_FILE, every = CHECK_MS } = {}) {
  const auth = makeAuthStore()
  const watcher = watchRemote({ reader, auth, every })
  const talk = makeTalk({
    agent: CONFIG.coordinator,
    label: CONFIG.coordinatorLabel,
    run,
    transcript: async () => {
      const s = await coordinatorOf(sessions)
      return s ? transcriptFile(s) : null
    },
    running: async () => {
      const s = await coordinatorOf(sessions)
      return !!s && !s.pinned // a pinned session that is closed is history, not running
    },
  })
  const lost = talk.sweep()
  if (lost) console.log(`phone: ${lost} message(s) to ${CONFIG.coordinatorLabel} were on their way when the dashboard stopped; the phone shows them as not sent`)
  const prReader = makePrReader({ gh, prs })
  const actions = makePhoneActions({ relay, talk, getStatus, alerts, prs, prReader })
  let door = null
  // 3 lockouts in 24 hours (phone-auth.mjs ESCALATE): phone access OFF in config.json, the same write as Turn phone access off
  const onEscalate = () => {
    turnPhoneOff(configFile)
    reader.invalidate()
    door.tick()
  }
  door = makeDoor({
    settings: reader,
    open: s => startPhoneListener({
      settings: s,
      handler: makePhoneHandler({ settings: reader, own: () => ({ bind: s.bind, port: s.port }), auth, actions, onOff: () => door.tick(), onEscalate }),
    }),
  })
  door.tick()
  const watch = setInterval(() => door.tick(), every)
  watch.unref()
  return { door, stop() { clearInterval(watch); watcher.stop(); door.close() } }
}
