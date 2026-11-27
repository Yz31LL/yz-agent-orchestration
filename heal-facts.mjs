// The facts the watchdog's checks read that come from the disk (heal-runner.mjs gathers them; the checks themselves
// are pure, heal-checks.mjs and heal-reports.mjs), and the two file moves its Stores repair may make.
//
//   storeFacts(stores, cache)       [{ name, label, exists, parses, error, sig, rebuild }]: each store read and parsed
//                                   only when its size or time changed since the last look (`cache`, a Map), so the
//                                   4 MB token index is not parsed every minute
//   diskFacts({ dataDir, logs })    { items: [{ key, label, bytes }], biggest: [{ name, bytes }] }
//   configFacts({ file, readers })  { parses, error, warnings }: config.json read again, and every settings reader run
//                                   on it with a warn that collects (the warnings the console alone saw until now)
//   keepAside(file, { move, now })  a copy of a damaged file beside it, `<name>.damaged-<YYYYMMDD-HHMMSS>`: copied
//                                   (the file stays for the user to mend), or MOVED when the dashboard rebuilds it
//
// ⚠️ NOTHING HERE DELETES: a damaged file is copied or moved aside, never removed. Reads are async and never throw.

import { copyFileSync, promises as fs, renameSync } from 'node:fs'
import path from 'node:path'

const pad = n => String(n).padStart(2, '0')
const stamp = ms => {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

async function statOf(file) {
  try {
    const s = await fs.stat(file)
    return s.isFile() ? s : null
  } catch {
    return null
  }
}

/** Each store: does it exist, does it parse. `stores` is [{ name, label, file, rebuild }]. */
export async function storeFacts(stores, cache = new Map()) {
  const out = []
  for (const s of stores) {
    const st = await statOf(s.file)
    if (!st) {
      out.push({ name: s.name, label: s.label, exists: false, parses: true, error: '', sig: '', rebuild: s.rebuild || null })
      continue
    }
    const sig = `${st.size}:${Math.round(st.mtimeMs)}`
    let known = cache.get(s.file)
    if (!known || known.sig !== sig) {
      let parses = true
      let error = ''
      try {
        JSON.parse(await fs.readFile(s.file, 'utf8'))
      } catch (err) {
        parses = false
        error = String(err?.message || err).split('\n')[0].slice(0, 120)
      }
      known = { sig, parses, error }
      cache.set(s.file, known)
    }
    out.push({ name: s.name, label: s.label, exists: true, parses: known.parses, error: known.error, sig, rebuild: s.rebuild || null })
  }
  return out
}

/** Bytes under `dir` (every file, every depth); 0 when it is not there. */
async function folderBytes(dir) {
  let total = 0
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) total += await folderBytes(p)
    else if (e.isFile()) total += (await statOf(p))?.size || 0
  }
  return total
}

/** The sizes the Disk check compares with its limits, and the biggest evidence folders. */
export async function diskFacts({ dataDir, logs = [] }) {
  const size = async f => (await statOf(f))?.size ?? 0
  const evidenceDir = path.join(dataDir, 'evidence')
  const biggest = []
  try {
    for (const e of await fs.readdir(evidenceDir, { withFileTypes: true })) {
      const p = path.join(evidenceDir, e.name)
      biggest.push({ name: `evidence/${e.name}`, bytes: e.isDirectory() ? await folderBytes(p) : (await statOf(p))?.size || 0 })
    }
  } catch {
    /* no evidence yet */
  }
  biggest.sort((a, b) => b.bytes - a.bytes)
  let logBytes = 0
  for (const f of logs) logBytes += await size(f)
  const evidence = biggest.reduce((t, b) => t + b.bytes, 0)
  return {
    items: [
      { key: 'spend', label: 'spend.jsonl', bytes: await size(path.join(dataDir, 'spend.jsonl')) },
      { key: 'logs', label: 'The logs', bytes: logBytes },
      { key: 'evidence', label: 'The evidence folder', bytes: evidence },
      { key: 'tokens', label: 'The token index', bytes: await size(path.join(dataDir, 'token-index.json')) },
      { key: 'data', label: 'The data folder', bytes: await folderBytes(dataDir) },
    ],
    biggest: biggest.slice(0, 5),
  }
}

/**
 * config.json read again: `readers` is [(raw, warn) => void], each a settings reader of config.mjs and the features
 * (coordinatorSettings, pipelineSettings, …) run with a warn that collects. A reader that throws is a warning too.
 */
export async function configFacts({ file, readers = [], unwrap = raw => raw }) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    return { parses: false, error: `it cannot be read (${err?.code || err?.message || err})`, warnings: [] }
  }
  let raw
  try {
    raw = unwrap(JSON.parse(text))
  } catch (err) {
    return { parses: false, error: String(err?.message || err).slice(0, 160), warnings: [] }
  }
  const warnings = []
  for (const read of readers) {
    try {
      read(raw, w => warnings.push(String(w)))
    } catch (err) {
      warnings.push(String(err?.message || err))
    }
  }
  return { parses: true, error: '', warnings: [...new Set(warnings)] }
}

/** A copy (or, with `move`, the file itself) beside it as `<name>.damaged-<stamp>`; returns the new path. */
export function keepAside(file, { move = false, now = Date.now() } = {}) {
  const to = `${file}.damaged-${stamp(now)}`
  if (move) renameSync(file, to)
  else copyFileSync(file, to)
  return to
}
