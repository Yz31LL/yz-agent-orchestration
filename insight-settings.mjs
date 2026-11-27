// The two config.json blocks of Master's insight (the digest, the suggestions, the watchdog and the inbox):
//
//   "healing": { "enabled": true, "repairs": true }
//       enabled   the watchdog runs its checks every minute (heal-runner.mjs) and the Health page shows them; false:
//                 no checks at all, and the page says the watchdog is off
//       repairs   the watchdog may do its fixed list of safe repairs (heal-checks.mjs REPAIRS); false: it only
//                 reports, and every check says what it WOULD have done
//   "insight": { "notifyMaster": "off" }
//       notifyMaster   off (the default): nothing is ever sent to Master by itself; what changed waits in
//                      data/master-inbox.jsonl and the digest's first lines say it. urgent: a FAILING health check
//                      or a flow a gate stopped is also sent to Master through the answer relay, one message at a
//                      time and at most one per 30 minutes, only while Master has a session open. Each message is a
//                      short headless turn on factory.relayModel, about 1 to 3 cents, shown as `insight` spend.
//
// Rules this file keeps:
// - Read ONCE, at startup, like the rest of CONFIG. Nothing here writes config.json.
// - A wrong value is never fatal: the default is used and `warn` says so in one plain sentence, which the Health
//   page's Config check also shows (heal-checks.mjs configCheck runs these same functions with a collecting warn).

export const HEALING_DEFAULTS = Object.freeze({ enabled: true, repairs: true })
export const NOTIFY = Object.freeze(['off', 'urgent'])
export const INSIGHT_DEFAULTS = Object.freeze({ notifyMaster: 'off' })

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** The `healing` block, checked: { enabled, repairs }. */
export function healingSettings(raw, warn = console.warn) {
  const out = { ...HEALING_DEFAULTS }
  if (raw === undefined || raw === null) return out
  if (!isObj(raw)) {
    warn('config.json: "healing" must be an object such as { "enabled": true, "repairs": true }; the defaults are used.')
    return out
  }
  for (const key of ['enabled', 'repairs']) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] === 'boolean') out[key] = raw[key]
    else warn(`config.json: "healing.${key}" must be true or false; ${HEALING_DEFAULTS[key]} is used.`)
  }
  return out
}

/** The `insight` block, checked: { notifyMaster }. */
export function insightSettings(raw, warn = console.warn) {
  const out = { ...INSIGHT_DEFAULTS }
  if (raw === undefined || raw === null) return out
  if (!isObj(raw)) {
    warn('config.json: "insight" must be an object such as { "notifyMaster": "off" }; the defaults are used.')
    return out
  }
  if (raw.notifyMaster !== undefined) {
    if (NOTIFY.includes(raw.notifyMaster)) out.notifyMaster = raw.notifyMaster
    else warn('config.json: "insight.notifyMaster" must be "off" or "urgent"; off is used.')
  }
  return out
}
