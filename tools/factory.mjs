#!/usr/bin/env node
// The Factory from a shell, for agents: set a ticket's review mark, write the
// work as a flow, ask the user something, or show what the page knows about a
// ticket.
//
//   node tools/factory.mjs mark ABC-123 reviewed --verdict check --note "what is left"
//   node tools/factory.mjs mark ABC-123 needs-review|no-code|not-codebase [--note "..."]
//   node tools/factory.mjs flow <command> ...            (see tools/flow-cli.mjs)
//   node tools/factory.mjs decide --question "..." --why "..." [--ticket ABC-123] [--yes "..."] [--no "..."] [--text] [--flow <id>]
//   node tools/factory.mjs show ABC-123
//   node tools/factory.mjs term "<word>" "<plain explanation>" [--more "..."] [--flow <id>]   (see tools/term-cli.mjs)
//   node tools/factory.mjs pr-pin                         the person sets the send PIN, typed in a terminal (tools/pr-pin.mjs)
//
// Marks go to data/factory-state.json; flows to data/flows/<id>.json; words to data/glossary.json. The page
// picks either up on its next poll. `decide` is the old command kept for
// existing briefs: it is now `flow ask`, on --flow or on a new one-node flow.

import { randomInt } from 'node:crypto'
import { readState, REVIEW, setMark, updateState, VERDICT } from '../factory-state.mjs'
import { AGENT_LABEL, AGENT_RULE, listFlows } from '../flows.mjs'
import { ANY_BOOLEAN, flags, NO_NAME, runFlow } from './flow-cli.mjs'
import { runPinCli } from './pr-pin.mjs'
import { runTerm } from './term-cli.mjs'

const [cmd, ...rest] = process.argv.slice(2)
// Every flag that is boolean anywhere is boolean here, so `--before --by X` keeps the name (each command parses its own).
const f = flags(rest, undefined, ANY_BOOLEAN)
/** Who is running this: the agent's dashboard label. '' when none was given (see NO_NAME). */
const by = f.by || process.env.FACTORY_BY || ''
const ctx = { by, cwd: process.cwd() }

/** Print a { out, code, err? } result (err is a stderr note); exitCode rather than exit(), so a long `flow show` is never cut off. */
function finish({ out, code, err }) {
  if (out) (code ? console.error : console.log)(out)
  if (err) console.error(err)
  process.exitCode = code
}

/** decide → flow ask, on --flow or on a new flow ask-<yyyymmdd>-<4 base36> titled by the question. */
function decide() {
  if (!by) return { out: NO_NAME, code: 1 }
  if (!f.question) return { out: 'A decision needs a question.', code: 1 }
  const opts = []
  for (const k of ['yes', 'no', 'why']) if (f[k] !== undefined) opts.push('--' + k, f[k])
  if (f.text) opts.push('--text')
  if (f.flow) return runFlow(['ask', f.flow, f.question, ...opts], ctx)

  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const id = `ask-${day}-${randomInt(36 ** 4).toString(36).padStart(4, '0')}`
  const made = runFlow(['new', id, f.question.slice(0, 80), ...(f.ticket ? ['--tickets', f.ticket] : [])], ctx)
  if (made.code) return made
  const asked = runFlow(['ask', id, f.question, ...opts], ctx)
  return { out: `${made.out}\n${asked.out}`, code: asked.code, err: asked.err }
}

try {
  // The name ends up in the relay's prompt (relay.mjs), so it is one plain line or nothing.
  if (by && !AGENT_LABEL.test(by)) throw new Error(`--by must be ${AGENT_RULE} (FACTORY_BY too)`)
  if (cmd === 'mark') {
    const [id, review] = f._
    const mark = updateState(s => setMark(s, id, { review, verdict: f.verdict, note: f.note, by: by || 'agent' }))
    console.log(`${String(id).toUpperCase()}: ${mark.review}${mark.verdict ? ' (' + mark.verdict + ')' : ''}`)
  } else if (cmd === 'pr-pin') {
    runPinCli().then(finish, e => finish({ out: e.message, code: 1 }))
  } else if (cmd === 'flow') {
    finish(runFlow(rest, ctx))
  } else if (cmd === 'decide') {
    finish(decide())
  } else if (cmd === 'term') {
    finish(runTerm(rest))
  } else if (cmd === 'show') {
    const id = String(f._[0] || '').toUpperCase()
    const flows = listFlows({ ticket: id }).flows.map(fl => fl.id)
    console.log(JSON.stringify({ mark: readState().marks[id] || null, flows }, null, 2))
  } else {
    console.log(`usage:
  mark <ID> <${REVIEW.join('|')}> [--verdict ${VERDICT.join('|')}] [--note "..."]
  decide --question "..." --why "..." [--ticket <ID>] [--yes "..."] [--no "..."] [--text] [--flow <id>]
  flow <command> ...    run flow with no command for its usage
  term "<word>" "<plain explanation, 1 or 2 sentences, at most 300 characters>" [--more "..."] [--flow <id>]
  show <ID>
  pr-pin                set the send PIN (typed by you in a terminal, never piped)`)
    process.exitCode = cmd ? 1 : 0
  }
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
}
