#!/usr/bin/env node
// A Claude Code UserPromptSubmit hook: when the user sends a session a message, tell the session which of its
// asks still wait on the dashboard, so an answer typed in the chat is recorded (`flow answered`) and leaves
// Human review (open-asks.mjs). The hook runs this with its JSON on stdin: { "session_id", "prompt", ... }.
//
// It FAILS OPEN: bad input, an unknown session, no open asks or any error ends with exit code 0 and no output,
// so the user's message always goes through. It writes nothing.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listFlows } from '../flows.mjs' // the flows on this dashboard
import { openAsksNote, sessionName } from '../open-asks.mjs' // the note and the session's name
import { CLAUDE_DIRS } from '../transcripts.mjs' // the Claude folders whose session registries name sessions

const FACTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'factory.mjs').replace(/\\/g, '/') // the CLI the note names

// Reads stdin and prints the note as extra context when this session has open asks.
async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const input = JSON.parse(raw)
  const name = sessionName(input?.session_id, CLAUDE_DIRS)
  if (!name) return
  const note = openAsksNote(listFlows({}).flows, name, `node ${FACTORY}`)
  if (!note) return
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } }))
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
