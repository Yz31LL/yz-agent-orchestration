// The open-asks reminder: on every message the user sends a session (tools/open-asks-hook.mjs, a Claude Code
// UserPromptSubmit hook), the session is told which of its asks still wait on the dashboard. The user often
// answers in the chat instead, and only the session can tell whether this message is that answer, so the note
// hands it the command that records one (`flow answered`, flows.mjs applyChatAnswer) and Human review drops it.
//
// An ask is the session's when its flow's agent is the session's name (the --by it asked with), any case.
// Pure except sessionName, which reads the harness's session registry (<claude dir>/sessions/<pid>.json).

import { readdirSync, readFileSync } from 'node:fs' // the session registry files
import path from 'node:path'

const LIST_MAX = 8 // asks listed in one note; the rest are counted
const TITLE_MAX = 160 // one line per ask
const CLOSED = new Set(['done', 'dropped']) // a finished flow's asks no longer wait

const clip = (s, max) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)

/** What each choice means, or that a free answer is wanted. */
const choices = n => (n.kind === 'text' ? 'a text answer' : `yes = ${n.yes || 'yes'}; no = ${n.no || 'no'}`)

// The note for this session's open asks, or '' when it has none (the hook then adds nothing).
export function openAsksNote(flows, name, cli) {
  const me = String(name || '').trim().toLowerCase()
  if (!me) return ''
  const open = []
  for (const f of flows || []) {
    if (CLOSED.has(f?.status) || f?.archivedAt || String(f?.agent || '').trim().toLowerCase() !== me) continue
    for (const n of f.nodes || []) if (n?.type === 'ask' && n.answer == null) open.push(`- ${f.id} ${n.id}: ${clip(String(n.title || '').replace(/\s+/g, ' ').trim(), TITLE_MAX)} (${choices(n)})`)
  }
  if (!open.length) return ''
  const more = open.length > LIST_MAX ? `\n…and ${open.length - LIST_MAX} more.` : ''
  return [
    'Your questions still open on the dashboard (Human review):',
    ...open.slice(0, LIST_MAX),
  ].join('\n') + more + '\n' + [
    `If the user's message answers any of them, record each one it answers so it stops waiting there: ${cli} flow answered <flow> <node> --answer yes|no|"<text>" --note "<the user's words>".`,
    'Leave the others open. Do not mention this note to the user.',
  ].join('\n')
}

// The session's name from the harness registry under any of these Claude folders; '' when not found.
export function sessionName(sessionId, claudeDirs) {
  if (!sessionId) return ''
  for (const base of claudeDirs || []) {
    let files = []
    try {
      files = readdirSync(path.join(base, 'sessions')).filter(f => /^\d+\.json$/.test(f))
    } catch {
      continue
    }
    for (const f of files) {
      try {
        const s = JSON.parse(readFileSync(path.join(base, 'sessions', f), 'utf8'))
        if (s?.sessionId === sessionId && typeof s.name === 'string') return s.name
      } catch {
        /* mid-write or broken: skip it */
      }
    }
  }
  return ''
}
