// The story of a flow: a few plain lines of who did what, and why, that the
// page shows before anything else ("Agent 1: Did playwright testing").
//
// The agent writes them with `flow say` into output.story (validated in
// flows.mjs validateOutput): [{ id: 's1', who, did, why?, at }], at most 8
// lines, `did` 1 to 140 characters, `why` at most 160, one line each.
//
// When the agent wrote none, storyOf DERIVES one from the flow itself, without
// any model, in the same plain voice, at most 3 lines:
//   <agent>: Finished <N> steps                     (when any step is done)
//   <agent>: Is working on: <step>                  (the first step that is doing; not on a done flow)
//   You:     Answered Yes|No to: <ask>              (the latest answered ask; Replied to: for a text ask)
//   You:     To decide: <ask>                       (the first open ask: the decision is yours)
// A dropped flow is only what was finished and <agent>: Dropped this work. The
// counts of what is left are not a line: the Picture shows them. Over 3 lines,
// the Answered line is the one left out: you know what you answered. Titles are cut near
// 90 characters after a whole word (clip). The name You is kept for these
// lines: validateStory refuses it from an agent.
// Pure: no file access.

export const STORY_MAX = Object.freeze({ lines: 8, did: 140, why: 160 })
/** A story line id: s1, s2 and so on. */
export const STORY_ID = /^s[1-9]\d*$/
/** The plain refusal for text over its limit (a story line, a glossary explanation): the agent says it shorter. */
export const sayShorter = (max, length) => `say it shorter: at most ${max} characters (this has ${length})`
/** The name kept for what the user did (derived lines only). */
export const YOU = /^\s*you\s*$/i
const DERIVED_MAX = 3
const TITLE_MAX = 90

const WORK = new Set(['step', 'check'])

/**
 * Small words a cut never ends on: `Turn on the new schedule…`, not `Turn on the new schedule in…`.
 * MUST CHANGE IN LOCKSTEP with public/flow-picture.js SMALL.
 */
export const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with'])

/**
 * `text` in at most `max` characters, the ellipsis included: cut after a whole word, never ending on a
 * small word or a comma. Text that fits is returned whole (spaces collapsed). A first word longer than
 * `max` is the one case cut inside a word. MUST CHANGE IN LOCKSTEP with public/flow-picture.js clip.
 */
export function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  const out = []
  let len = 0
  for (const w of s.split(' ')) {
    const next = len + (out.length ? 1 : 0) + w.length
    if (next + 1 > max) break
    out.push(w)
    len = next
  }
  const bare = w => w.toLowerCase().replace(/[.,;:!?]+$/, '')
  while (out.length > 1 && SMALL.has(bare(out[out.length - 1]))) out.pop()
  if (!out.length) return `${s.slice(0, max - 1)}…`
  return `${out.join(' ').replace(/[.,;:!?]+$/, '')}…`
}

const derivedLine = (who, did) => ({ who, did, why: '', derived: true })
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const title = n => clip(n.title, TITLE_MAX)

/** The lines made from the flow's own nodes (see the header). */
function derivedStory(flow) {
  const agent = String(flow?.agent || 'The agent')
  const status = flow?.status || 'open'
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : []
  const work = nodes.filter(n => WORK.has(n?.type))
  const done = work.filter(n => n.status === 'done').length
  const finished = done ? derivedLine(agent, `Finished ${plural(done, 'step')}`) : null
  if (status === 'dropped') return [finished, derivedLine(agent, 'Dropped this work')].filter(Boolean)

  const doing = status === 'done' ? null : work.find(n => n.status === 'doing')
  const answered = nodes
    .filter(n => n?.type === 'ask' && n.answer != null)
    .sort((a, b) => String(b.answeredAt || '').localeCompare(String(a.answeredAt || '')))[0]
  const open = nodes.find(n => n?.type === 'ask' && n.answer == null)
  const you = answered
    ? derivedLine('You', answered.answeredIn === 'chat' ? `Answered in the chat: ${title(answered)}`
      : answered.kind === 'text' || !['yes', 'no'].includes(answered.answer)
      ? `Replied to: ${title(answered)}`
      : `Answered ${answered.answer === 'yes' ? 'Yes' : 'No'} to: ${title(answered)}`)
    : null
  const lines = [
    finished,
    doing ? derivedLine(agent, `Is working on: ${title(doing)}`) : null,
    you,
    open ? derivedLine('You', `To decide: ${title(open)}`) : null,
  ].filter(Boolean)
  return lines.length > DERIVED_MAX ? lines.filter(l => l !== you).slice(0, DERIVED_MAX) : lines
}

/**
 * The lines the page shows: the agent's story when it has at least one line,
 * each { id, who, did, why ('' when none), at, derived: false }; otherwise the
 * derived lines, each { who, did, why: '', derived: true }.
 */
export function storyOf(flow) {
  const story = flow?.output?.story
  if (Array.isArray(story) && story.length) {
    return story.map(l => ({ id: l.id, who: l.who, did: l.did, why: l.why ?? '', at: l.at, derived: false }))
  }
  return derivedStory(flow)
}
