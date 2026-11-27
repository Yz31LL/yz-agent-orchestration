// What a phone session may do: a FIXED list, each entry mapped by name to the server function the desktop page
// uses. Nothing here forwards a path or a method to the desktop routes, so no desktop route is ever reachable from
// the phone, whatever the phone asks for.
//
//   summary   read: what needs the user (questions, by-hand steps, outputs to sign off) and
//             today's finished count. Built from human-routes.mjs humanGet and completed-routes.mjs outputsGet.
//   orchestration, flow   read: the pipeline's boxes with the agents' states, the flows standing at each, the alerts
//             and the open pull requests; one flow's sheet (phone-orchestration.mjs). Nothing written.
//   answer    answer ONE open question: flows.mjs applyAnswer, then relay.queue, exactly as the desktop's
//             POST /api/flows/<id>/answer does. STRICTER than the desktop: an ask that already has an answer is
//             refused (the phone never changes or reopens an answer), and so is a flow that is not open or blocked.
//   tick      tick or untick one by-hand step: human-routes.mjs handTickRoute, on a live flow only; the step must
//             belong to THAT flow (handTickRoute looks it up there).
//   complete  mark a finished flow completed: completed-routes.mjs completeRoute with completed: true. Never false:
//             Uncomplete stays on the desktop. An unfinished flow is refused with the desktop's own sentence.
//   pr        read: one pull request the Pull requests list holds, by its flow id or number (phone-pr.mjs, injected
//             as `prReader`): title, checks, review, description, files with their changes, conversation. Nothing written.
//   talk, talkSend   read the thread with Master (the same for every signed-in phone) and what a message costs
//             (phone-cost.mjs), send a message (phone-talk.mjs).
// NOT here, on purpose: delete, archive, drop, status, settings, rules, config, Finish without Senior, pull-request
// Send, merge, approve, review or comment on a pull request, Generate, Request test steps, Ask for steps, the chat. A phone that is lost while signed in can do only
// what is above until the session expires or the desktop signs it out.
//
// Each action takes the parsed JSON body and resolves { status, body }. `relay`, `talk`, `getStatus`, `alerts` and
// `prs` (the desktop's Pull requests list, prlist-store.mjs, read only) are injected (server.mjs passes its own), so
// the tests stub every side effect.

import { CONFIG } from './config.mjs'
import { completeRoute, outputsGet } from './completed-routes.mjs'
import { finishedAt, isFinished } from './completed.mjs'
import { applyAnswer, listFlows, readFlow, storyOf, validateFlow, writeFlow } from './flows.mjs'
import { handTickRoute, humanGet } from './human-routes.mjs'
import { pipelineGraph } from './pipeline.mjs'
import { phoneCost } from './phone-cost.mjs'
import { makeOrchestration } from './phone-orchestration.mjs'
import { TALK_MAX } from './phone-talk.mjs'

export const ACTIONS = Object.freeze(['summary', 'orchestration', 'flow', 'pr', 'answer', 'tick', 'complete', 'talk', 'talkSend'])
const SLUG = /^[a-z0-9-]{1,80}$/
const NODE = /^[A-Za-z0-9_-]{1,40}$/
const STORY_LINES = 8
export const COST_NOTE = 'Your answer reaches the agent through a short paid turn on your PC: a few cents each.'

const ok = body => ({ status: 200, body })
const no = (status, error) => ({ status, body: { error } })
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
/** Only a flow still on its way waits on a question or a tick: finished, dropped, archived and completed ones do not. */
const live = f => (f.status === 'open' || f.status === 'blocked') && !f.archivedAt && !f.completedAt

/** The flow for `flowId`, or the refusal: a bad id never reaches the disk. */
function flowFor(b) {
  if (!isObject(b)) return { refused: no(400, 'Send a JSON object.') }
  if (typeof b.flowId !== 'string' || !SLUG.test(b.flowId)) return { refused: no(400, 'That is not a flow id.') }
  const flow = readFlow(b.flowId)
  return flow ? { flow } : { refused: no(404, 'That flow is gone: the list will catch up in a moment.') }
}

const startOfToday = now => {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** How long the Agents tab waits for the agent list (phone-orchestration.mjs): a cold status build can take far longer. */
export const AGENTS_WAIT_MS = 3000

/** No reader given: every pull request is not on the list. */
const NO_READER = { read: async () => no(404, 'That pull request is not on the list.') }

export function makePhoneActions({ relay, talk, getStatus, alerts = async () => null, prs = () => [], prReader = NO_READER, config = CONFIG, now = Date.now, agentsWaitMs = AGENTS_WAIT_MS, cost = phoneCost }) {
  const orch = makeOrchestration({ getStatus, alerts, prs, config, now, agentsWaitMs })
  // the agents themselves are on the Agents tab (orchestration): the summary no longer waits for the status build
  async function summary() {
    const graph = pipelineGraph(config)
    const all = listFlows({ archived: 'any' }).flows
    const items = humanGet().body.items
    const asks = items.filter(i => i.kind === 'ask').map(i => ({
      flowId: i.flowId, nodeId: i.nodeId, flowTitle: i.title, agent: i.agent, since: i.since,
      question: i.ask.title, why: i.reason, kind: i.ask.kind, yes: i.ask.yes, no: i.ask.no,
    }))
    const hands = items.filter(i => i.kind === 'hand').map(i => {
      const steps = (readFlow(i.flowId)?.hand?.steps || []).map(s => ({ id: s.id, do: s.do || '', where: s.where || '', expect: s.expect || '', copy: s.copy || '', why: s.why || '', done: !!s.done }))
      return { flowId: i.flowId, title: i.title, agent: i.agent, reason: i.reason, steps, progress: i.progress }
    })
    const outputs = outputsGet({ config, now: now() }).body.waiting.map(w => ({
      flowId: w.id, title: w.title, agent: w.agent, finishedAt: w.finishedAt, overdue: w.overdue,
      story: storyOf(readFlow(w.id)).slice(0, STORY_LINES).map(l => ({ who: String(l.who || ''), did: String(l.did || ''), why: String(l.why || '') })),
    }))
    const midnight = startOfToday(now())
    const finishedToday = all.filter(f => {
      if (!isFinished(f, graph)) return false
      const at = finishedAt(f, graph)
      return at !== null && at >= midnight && at <= now()
    }).length
    return ok({
      builtAt: new Date(now()).toISOString(),
      coordinator: config.coordinatorLabel, // what the page calls the coordinator's tab and thread
      needs: { total: asks.length + hands.length + outputs.length, asks: asks.length, hands: hands.length, outputs: outputs.length },
      finishedToday,
      asks,
      hands,
      outputs,
      costNote: COST_NOTE,
    })
  }

  async function answer(b) {
    const { flow, refused } = flowFor(b)
    if (refused) return refused
    if (typeof b.nodeId !== 'string' || !NODE.test(b.nodeId)) return no(400, 'That is not a question id.')
    const node = (flow.nodes || []).find(n => n.id === b.nodeId)
    if (!node) return no(404, 'That question is gone: the list will catch up in a moment.')
    if (node.type !== 'ask') return no(400, 'That is not a question.')
    if (!live(flow)) return no(409, 'That flow is no longer waiting on you.')
    if (node.answer !== null && node.answer !== undefined) return no(409, 'This question already has an answer. Change it at the PC if you need to.')
    let value = b.answer
    if (node.kind === 'text') {
      if (typeof value !== 'string' || !value.trim()) return no(400, 'Type an answer first.')
      if (value.length > TALK_MAX) return no(400, `An answer is at most ${TALK_MAX} characters.`)
      value = value.trim()
    } else if (value !== 'yes' && value !== 'no') return no(400, 'The answer is yes or no.')
    try {
      applyAnswer(flow, node.id, value) // the desktop's own store function (factory-routes.mjs answer)
    } catch (err) {
      return no(400, err.message)
    }
    const problems = validateFlow(flow)
    if (problems.length) return no(400, problems.join('\n'))
    writeFlow(flow)
    relay.queue(flow.id, node.id) // the desktop's own next step: the agent hears it through the relay
    return ok({ ok: true, flowId: flow.id, nodeId: node.id, answer: value })
  }

  async function tick(b) {
    const { flow, refused } = flowFor(b)
    if (refused) return refused
    if (!live(flow)) return no(409, 'That flow is no longer waiting on you.')
    return handTickRoute(flow.id, { step: b.step, done: b.done })
  }

  async function complete(b) {
    const { flow, refused } = flowFor(b)
    if (refused) return refused
    if (b.completed !== undefined && b.completed !== true) return no(400, 'The phone only marks outputs completed. Uncomplete is on the PC.')
    return completeRoute(flow.id, { completed: true }, { config, now: now() })
  }

  // ONE thread for every signed-in phone (phone-talk.mjs); ctx.session only marks who sent a message, never shown
  const talkGet = async () => ok({ ...(await talk.threadWithReplies()), cost: cost() })
  const talkSend = async (b, ctx = {}) => talk.send(isObject(b) ? b.text : undefined, ctx.session || '')

  return { summary, orchestration: () => orch.orchestration(), flow: b => orch.flow(b), pr: b => prReader.read(b), answer, tick, complete, talk: talkGet, talkSend }
}
