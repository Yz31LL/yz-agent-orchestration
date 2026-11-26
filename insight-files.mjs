// The digest's providers read from the FILES (insight-gather.mjs takes them): what the CLI uses when no dashboard is
// running, and the base the server's own providers start from (insight-wiring.mjs swaps in its in-memory stores).
//
//   fileProviders({ config, now })   every provider insight-gather.mjs knows, from data/ and config.json
//
// Without a running dashboard some parts cannot be read, and they are LEFT OUT with the reason, never guessed:
// who is busy (the session registry is read by the server), the pull requests (GitHub, through the server), the
// alerts (worked out by the server from its token index). The watchdog's Health part is its LAST look, marked stale.
// Read only: nothing here writes a file.

import { readAgentSettings } from './agent-settings.mjs'
import { CONFIG } from './config.mjs'
import { listFlows } from './flows.mjs'
import { healthFromFiles } from './heal-store.mjs'
import { unread } from './insight-inbox.mjs'
import { healingSettings } from './insight-settings.mjs'
import { readSuggestions } from './insight-suggestions.mjs'
import { listRuns, RUNS_DIR } from './learn-runs.mjs'
import { readVerdicts } from './learn-verdicts.mjs'
import { pipelineGraph } from './pipeline.mjs'
import { misses } from './predict-estimate.mjs'
import { listLessons } from './quality-lessons.mjs'
import { readOutcomes } from './routing-outcomes.mjs'
import { makeTokenIndex } from './token-index.mjs'
import { TOKEN_INDEX_FILE } from './token-routes.mjs'
import { priceTable } from './token-usage.mjs'
import './public/predict-group.js' // puts the alerts' grouping and words on globalThis.PredictGroup, as the phone does

export function fileProviders({ config = CONFIG, now = () => Date.now() } = {}) {
  return {
    graph: () => pipelineGraph(config),
    status: () => null,
    settings: () => readAgentSettings(),
    flows: () => listFlows({ archived: 'any' }).flows,
    prs: () => null,
    tokens: () => ({ ...makeTokenIndex({ file: TOKEN_INDEX_FILE }).snapshot(), prices: priceTable(config.tokens).prices }),
    alerts: () => null,
    group: globalThis.PredictGroup,
    misses: (flows, graph, since) => misses(flows, { graph, since, now: now() }),
    lessons: () => listLessons(),
    runs: () => listRuns(RUNS_DIR, 1),
    verdicts: () => readVerdicts().changes,
    outcomes: () => readOutcomes(),
    health: () => healthFromFiles({ now: now(), settings: healingSettings(config.healing, () => {}) }),
    suggestions: () => readSuggestions(),
    inbox: () => unread(),
  }
}
