# Yz Agent Orchestration

**New here? Read the [user guide](docs/USER_GUIDE.md).**

A local web page that shows what each Claude Code session is building in one
git repo: per ticket, per agent and per worktree, at three levels (local
branch, the integration branch on the remote, and the release branch on the
remote). It reads git and Claude Code's own session files and never changes
the repo, with one opt-in exception you turn on yourself: **Send**, which pushes a
branch and opens a pull request when you click it (see Send to the base branch). Agents can also narrate their work as **flows** (steps, checks,
questions for you, and proof), which the page draws and lets you answer.

It was built for one person running a coordinating session ("Coordinator") and
several coding agents in git worktrees.

## What you need

- Node 20 or newer. There are no npm dependencies, so there is nothing to install.
- git, and the repo your Claude Code sessions work in.
- Claude Code. Sessions are read from `~/.claude` (and any other folders you list).
  The features that run headless turns need a Claude Code binary: by default the
  newest one bundled with an IDE extension, or set `claudeBin`.
- Optional: a Switchboard MCP server for `switchboard` ticket collections, and the
  Playwright MCP server if you want the chat agent to check things in a browser.

## Run it

```
git clone https://github.com/Yz31LL/yz-agent-orchestration.git
cd yz-agent-orchestration
cp config.example.json config.json   # then set "repo" and your session names
npm start
```

Open http://127.0.0.1:4317. The server listens on 127.0.0.1 only. If
`stopHour` is set, it stops itself at that hour.

The tests (`npm run check && npm test`) read `config.json` too, so copy the
example first. `npm run check` runs `node --check` on every file listed in `checkList` in
`package.json` (`tools/check.mjs`); a new source file goes on that list. It is not the `check`
script itself because the list grew past what a Windows command line can hold.

## A quick tour

- **Flows** (the landing page, `#/`): every request as a flow, each with its route from the
  Request to the Output (build, review or ask) drawn as steps done, current and upcoming. **Output** is meant to be read in ten
  seconds: a plain **Story** of who did what and why, one **Picture** (a screenshot
  of the result, the agent's diagram of how it works, or a summary chart drawn from
  the flow), and **How to test** it by hand, step by step, with the long summary
  folded under **Details**; **Explain** walks through it one slide at a time (what
  and why, before and after, how it works, its path through the agents, the QA
  result); **Status** lists what is built, missing and waiting on you; **Process**
  shows the chart of steps.
  Answer an agent's question inline; the answer is pushed back to that agent.
- **Home** (`#/home`): what changed since you last looked, open questions from agents, a
  compact card per agent, and who is messaging whom.
- **QA**: every ticket that passed QA, with QA's report, its screenshots, the steps
  to test it yourself and links to the tested commit and the pushed branch.
- **Generators**: two writing tools behind two pills. The **Prompt generator** (it was Brainstorming) turns a rough idea
  into a ready-to-paste prompt in six labelled parts, streamed, with a soft pop when it is done; its **Context** panel
  tells it about your agents, a live session and your own notes. The **Standup creator** writes your daily stand-up or
  weekly progress from your git work, the saved ticket list and the flows, and keeps every one in a dated archive.
- **Tickets**: a ticket collection from your tracker, an orchestration grid of
  which agent took which ticket how far (local, dev, stage, prod), the ticket
  table with code review marks, and every worktree.
- **Timeline**: what each agent did on each task as a zoomable flowchart, built
  from the transcripts and git.
- **Agents**: the orchestration as a pipeline diagram, from request to outcome, under a
  pipeline score (precision, recall, F-score, accuracy and correctness) and Pipeline time (tickets finished per
  day and per hour, time per job, where the time goes) and Pipeline tokens (what the sessions spent in tokens and
  what that would cost at API prices), with
  a live view of one agent (its feed, its edits as diffs, its uncommitted changes)
  and a draft progress report.
- **Subagents**: every subagent the sessions started, live or ended: what each one is working on, how it
  went, its pull request and its final report, with builders apart from quick lookups.
- **The Ask drawer**: a chat with a Claude Code session ("Independent") that can
  read the code, write flows, message agents and drive a browser.
- **Sessions waiting on you**: a Claude Code hook tells the dashboard when a session stops for your
  permission or reply; its card, Human review and the page head say so (see the waiting hook below).
- **Alerts and reminders**: toasts and desktop notifications for new questions,
  blocked or finished flows and failed deliveries, plus daily reminders at a set time.
- **Explain**: hover a tinted or underlined word, or select any text, for a short explanation.
- **Plain story and a glossary that learns**: agents tell each flow in a few plain lines and mark technical
  words in square brackets; the page explains each one on hover, looks up the new ones by itself, and
  keeps them all on the **Glossary** page.
- **Command palette**: `Ctrl+K` jumps to any page, flow, ticket or agent.
- **Spend today**: what the dashboard's own headless turns cost today.
- **Keep-alive**: `tools\keep-alive.cmd` (Windows) restarts the server when it stops.

Each of these is described in detail below.

## What costs money

Reading git and transcripts is free, and so are the Subagents page and the stop check (they read transcripts
and ask `gh` for pull request states). These features run headless Claude Code
turns, billed to your Claude account like any other session:

- **The chat** (the Ask drawer, and the per-ticket review, explain and task
  actions that go through it): about $0.45 for the first message of a light chat
  and a few cents for a short follow-up; a chat forked from your own session
  costs about $7 for its first message.
- **The answer relay**: each answer pushed to an agent, and each **Request test steps**, is a short turn,
  roughly $0.30 (several for one agent within 30 seconds go as one).
- **Explain**: a selection the glossary does not know is one small turn, about a cent.
- **Learning words**: a flow's marked words the glossary does not know yet, up to 12 in one small turn,
  a fraction of a cent; at most 200 words a day.
- **Ticket refresh**: each refresh of a collection (the button, or its timer) is one turn.
- **Prompt generator** (`#/generators`): each **Generate** is one Opus 5.5 turn at high effort, about 10 cents for
  the first run in an hour and about 5 cents for each run after it (measured 2026-11-25, with the brainstorming skill
  and the orchestration brief).
- **Standup creator** (`#/generators?tool=standup`): each **Generate** is one Opus 5.5 turn at medium effort, about
  11 cents (measured 2026-11-25 on a real week of one repo: $0.106 for a daily, $0.109 for a weekly, with about 50
  tickets in the facts). Nothing runs until you press Generate.

The figures are measurements from one setup, not quotes. **Spend today** in the
rail adds up what these turns cost.

## Security

- The server listens on 127.0.0.1, and only same-origin POSTs are accepted, so
  another website cannot drive the agents.
- The dashboard is read-only on the watched repo, with ONE exception, off by default: **Send**. Turned on
  and with a send PIN set (on the **Settings** page, or `node tools/factory.mjs pr-pin` in a terminal), a
  click on **Open pull request** with that PIN runs `git push <remote> <sha>:refs/heads/<branch>`
  (never forced, never retried, no tags) and `gh pr create`. Nothing else: no commits, merges, checkouts,
  branch deletes, rebases or `gh pr merge`. What protects what:
  - **Your send PIN** stops anything that drives the page for you: the chat agent's browser, a website that
    points its own name at 127.0.0.1, a tab you left open. Each send needs it typed; five wrong tries lock
    Send for ten minutes. Only its scrypt hash is kept (`pr.pinHash`); the PIN is never stored, logged or shown.
    Type it only in your own browser, never in a window an agent is driving.
  - **A system window confirms** the changes that would let a page driver send: setting the first PIN,
    resetting a forgotten one, turning sending on, and changing the branches. That Yes/No window comes from
    the operating system, outside the browser, where a page cannot click.
  - **The Host and Origin checks** stop ordinary websites: the server answers only `127.0.0.1:<port>` and
    `localhost:<port>`, and the send route needs that page's own Origin.
  - **The review is bound to what you saw**: the click carries the commit and a digest of the title and text;
    if either changed since, the send is refused (`Changed since you reviewed it. Review again.`), and the push
    is exactly that commit (`<sha>:refs/heads/<branch>`). A base, `HEAD` or a `pr.protect` branch is never sent.
  - **A process with a shell on this machine** (a coding agent) could always run `git push` and `gh` itself,
    or edit config.json: Send gives it nothing new, and the PIN does not stop it. Run only agents you trust.
    `pr-pin` refuses a PIN piped in only so that a script cannot set one by accident.
  The dashboard never reads gh's token, and any credential in what git or gh print is removed before it is
  shown or stored. Keep the `--blocked-origins` advice below as an extra layer.
- **QA's push** is not the server's: the QA agent runs `flow qa-push` in its own shell (QA and the pipeline,
  below). It pushes only a flow QA passed, exactly the commit QA tested, to a branch that is not protected, never
  forced, never retried, and only with `--by` set to the QA label. Like Send, it gives an agent with a shell nothing
  it could not do already; it makes the one push the pipeline expects easy to see and to check.
- The Subagents page asks GitHub for the state of the subagents' pull requests with `gh pr view --json` (the `pr.gh`
  command): read only, at most once a minute per pull request. It never runs a gh command that writes.
- A request with no Origin header (not from a browser) is accepted, so any local process on this
  machine can call the dashboard's routes as you: only run agents and tools you trust here.
- The chat agent is limited to a listed set of commands: reading git (log, show, diff, status and a few
  more), the dashboard CLI, and its read tools. It has no edit or commit tool, but treat it as trusted and
  constrained, not sandboxed: `git diff`, `log` and `show` accept `--output=<file>`, which writes a file.
  Every tool call it makes is shown.
- ⚠️ Its Playwright browser is same-origin to the dashboard, so a prompt-injected
  chat agent could tick **verified** or answer an ask by driving this page. Add
  `--blocked-origins 127.0.0.1:4317` to the Playwright MCP server's arguments in
  your user-level MCP config (more under The Ask drawer below).
- The Prompt generator **Context** panel sends what you attach (the orchestration brief, a live session's latest talk, your
  notes) only to your own clean Prompt generator run: no tools, no settings, nothing else sees it. The brief is built from
  labels and settings and scrubbed of paths, ids, emails and tokens; a live session is your own conversation, so
  pick one only when you are happy for that text to go to the model. Its routes take same-origin writes only, and
  the model is told the context is background, never instructions.
- `config.json` and everything under `data/` (flows, evidence, ticket snapshots,
  the chat transcript, spend, the Prompt generator context and its run log of your last 50 ideas and their prompts, and
  the stand-up archive in `data/standup/`) stay on your machine and are git-ignored. A stand-up holds your commit
  subjects and ticket titles as the model wrote them up; it goes only to your own clean run. Clear the run log with `DELETE /api/script/log` or from the page.

## Configuration

The pages sit in a rail on the left, in four groups: **Work** (Home, Flows, Tickets, Generators), **Agents**
(Agents, Subagents, Orchestration bank, Routing), **Quality** (QA, Lessons, Learn) and **History** (Timeline,
Flow archive, Glossary), with Settings at the foot (one agent's live view opens from Agents or Subagents). Pages
refresh themselves; the Refresh button in the page header rebuilds at once.

`config.json` stays on your machine (it is in `.gitignore`):

| Key | What it is |
| --- | --- |
| `repo` | Absolute path of the git repo the sessions work in (required) |
| `port` | Port on 127.0.0.1 (default 4317, or `PORT`) |
| `sessionCwdMatch` | A session counts when its working folder contains this (default: the repo folder name) |
| `coordinator` | The SESSION NAME of the session that hands out work and merges it (default "Coordinator"; any name works, so an older config that says "Master" keeps working) |
| `coordinatorLabel` | What the pages call that session. Left out: the label `codingAgents` or `aliases` gives it, else "Coordinator" |
| `codingAgents` | Session name -> label, for sessions that write code |
| `aliases` | Session name -> label, for any other session |
| `stopHour` | Local hour to stop at, or null |
| `ticketPrefixes` | Ticket id prefixes in rank order, such as `["ABC", "XYZ"]` (see Assumptions about your repo and tracker). Left out: taken from the collections and the ticket sources |
| `pr` | Send to the base branch, off by default: `{ "enabled": false, "remote": "origin", "bases": ["dev"], "gh": "gh" }`. `enabled` must be `true` to turn it on, and is honoured only with a `pinHash` (set it on the Settings page or with `node tools/factory.mjs pr-pin`, never by hand); these keys are read again whenever config.json changes, so no restart; `protect` lists the branches never sent from (default `["main", "master", "stage", "prod", "production", "release/*", "release-*"]`, `*` matches anything); `remote` is the remote to push to; `bases` are the branches a flow may be sent into; `gh` is the GitHub CLI command (signed in with `gh auth login`). A bad value turns the feature off with a warning in the server log |
| `pipeline` | The orchestration (QA and the pipeline, below): `{ "qa": "QA", "producers": null, "protectedBranches": ["dev", "stage", "main", "master"], "maxReworks": 3 }`. `qa` is the dashboard label of the agent that tests every code change last and is the only one that pushes; `producers` the labels that write code (`null`: every `codingAgents` label but the coordinator's and QA's); `protectedBranches` the branches QA never pushes to (any case, `*` matches anything; `pr.protect` and `pr.bases` are refused too); `maxReworks` how many times a failure goes back to its producer before the flow stops (QA and Security failures together). Three optional keys add agents: `planner`, `security` and `senior`, each a dashboard label or null (left out is null: no box; see The planner and Security, and Human task and Senior, below). A bad key keeps its default, with a warning |
| `levels` | The branches the levels compare: `{ "work": "followup", "dev": "origin/dev", "stage": "origin/stage", "prod": "origin/main" }` (these are the defaults). A bad value keeps its default, with a warning |
| `reminders` | Reminders at a local time, once a day: `[{ "at": "17:55", "days": "weekdays", "text": "Wrap up: commit or park your work." }]`. `days` is `weekdays` (Monday to Friday) or `daily`; `[]` turns them off. Left out, there are none. `at` is a real time, 00:00 to 23:59, and one reminder per time. A bad or repeated entry is left out with a warning in the server log |
| `standup` | The Standup creator, every key optional: `{ "author": "", "name": "", "project": "", "base": "", "ticketUrl": "https://app.switchboardpm.ai/stories/{id}" }`. `author` is whose commits count (left out: the repo's `git config user.name`); `name` and `project` fill the weekly header (left out: the author and the repo folder name); `base` is the default branch merges are read from (left out: `origin/HEAD`, else `levels.dev`); `ticketUrl` is the ticket link pattern, http(s) with `{id}`. A bad value warns and uses the default |
| `outputs` | The sign-off reminders (Completed, below): `{ "max": 7, "warnAfterDays": 2 }`. `max` finished flows waiting for Completed make the Ask drawer, Pass a task and `flow new` remind you; `warnAfterDays` whole days (24 hours each) unmarked makes one overdue. Each a whole number (`max` 1 to 1000, `warnAfterDays` 1 to 365); a bad value keeps its default with one warning. Read at startup |
| `tokens` | Pipeline tokens' prices: `{ "prices": { "<model id or prefix>": { "input": 4, "output": 20, "cacheWrite": 5, "cacheWrite1h": 8, "cacheRead": 0.2 } } }`, dollars per million tokens (`cacheWrite` is the 5 minute cache write, `cacheWrite1h` the 1 hour one, optional: without it 1 hour writes are priced at `cacheWrite`). Your entries go over the built-in defaults: one adds or replaces a model. `null` means no price for that id and for every id under it that has no price of its own: it never falls back to a shorter id (`"claude-opus-5-5": null` leaves Opus 5.5 unpriced, not at Opus 5 rates). An entry with a rate missing or not a number is named on the page and has no price either. A model takes its exact id, else the longest id it starts with. **Prices change, and keeping them current is yours**: the defaults were read from https://platform.claude.com/docs/en/about-claude/pricing on 2026-11-25 for the models the transcripts held (Opus 5.5, Opus 5, Sonnet 5.5, Fable 5.2, Fable 5.1); Haiku 5.5 has none, as its price depends on the prompt length. Read at startup |

### Keep it running

Run `tools\keep-alive.cmd` (Windows) instead of `npm start` to have the dashboard come back by itself: it
starts `node server.mjs` from the repo root, and starts it again 5 seconds after it stops for any reason.
Its output goes to `%LOCALAPPDATA%\yz-agent-orchestration\server.log`. Close its window to stop it. A stop at
`stopHour` is restarted too, so leave `stopHour` null when you use it. Run only one: a second copy (or any
dashboard already on the port) waits up to 15 seconds for the port, stops, and tries again 5 seconds later,
filling the log. To start it at login, press Win+R, open `shell:startup`, and put a shortcut to
`tools\keep-alive.cmd` in the folder that opens. A project switch (below) stops the server with exit code 75,
which the loop starts again at once instead of after 5 seconds.

### Fonts

Inter for the interface (built for screens: tall x-height, clear at small
sizes, with the alternates that tell I, l and 1 apart) and JetBrains Mono for
ids, branches, commands and diffs. Both are bundled in `public/fonts/` under
the SIL Open Font License (the licence files sit next to them), so the page
works offline. Every text colour meets 4.5:1 contrast in both themes.

The server serves any file in `public/` by its extension, so adding a page
file needs no restart; paths outside `public/` are refused.

### Theme

The theme button at the foot of the rail is ONE toggle: a sun in dark mode, a
moon in light mode. Until you click it the page follows the OS (a small dot
under the icon says so); each click moves Light → Dark → System, and the choice
is remembered in this browser. `public/theme.js` runs in `<head>`, so the page
never flashes the wrong theme. Every colour is a token in `styles.css`; dark
mode is `:root[data-theme="dark"]`.

## The shell

`public/shell.js` and `shell.css` draw the frame every page shares.

- **The rail** (56 px, icons only): the brand mark and the Project menu, then the pages in four groups,
  Work (Home, Flows, Tickets, Generators), Agents (Agents, Subagents, Orchestration bank, Routing), Quality
  (QA, Lessons, Learn) and History (Timeline, Flow archive, Glossary), and at the foot Ask, Alerts, Spend,
  Phone on (while phone access is on), Settings and Theme. A thin line marks each group; open, the group's
  name sits on it, and a screen reader hears it as a heading. Hover it for 300 ms,
  or Tab into it, and it opens to 200 px with labels; the pin at the top keeps
  it open (remembered). On a short window only the groups scroll, inside the rail; the foot stays put.
  Under 720 px wide the rail is a bar along the bottom with only Home, Flows, Tickets, Agents, Ask and
  **More**; More opens a sheet with every other page in its group, then Alerts, Spend today, Phone on,
  Settings and Theme (`public/rail-more.js`, the bar's pages in `RailGroups.bar`).
  **One place orders the pages:** `public/rail-groups.js`. A new page adds its link by group and by name,
  `RailGroups.add('agents', { view, href, label, icon }, { after: 'subagents' })`, never by appending to the
  rail; a group that does not exist puts it in a final More group with a console warning, and
  `test/rail-groups.test.mjs` fails while a page in the shell has no rail link. The palette lists the same groups.
  The routes are `#/` (Flows, the landing page), `#/flows` (the same page, so old links keep working),
  `#/home`, `#/qa` (and `#/qa/<flow id>` for one ticket), `#/generators` (and `#/generators?tool=standup` for the Standup creator; `#/brainstorming` and `#/script` still land there),
  `#/tickets`, `#/timeline`, `#/agents`, `#/subagents`, `#/glossary`, `#/settings`
  and `#/agent/<id>[/<subagent>]`; anything else goes to `#/`.
  Old links still work: `#/factory` goes to `#/tickets` and opens the Ask
  drawer (the old page always showed the chat), `#/flow` to `#/timeline`.
- **The page header** (one row): the page name, ` · N` when the page counts
  something (`Flows · 2`, `Agents · 4`), ONE status chip on the right
  (`fetched 3m`, `Switchboard 12m · auto 20m`) and at most two actions. A dot
  and `N waiting on you` shows on every page while an ask is open; it opens the
  asks on the Flows page.
- **The `?` popovers** (`public/help.js`): a card head is a name and a number,
  and anything longer (what the number counts, a legend, the rest of the
  chip's meta, how an empty list fills up) sits behind a small `?`. Click it,
  or press Enter or Space on it; Escape, a click outside or scrolling the page closes it.
- **The Ask drawer** (380 px, right; remembered open or closed): Ask in the
  rail opens it, and a dot on Ask shows while the chat agent works. It pushes
  the page aside on wide windows and covers it under 900 px. The chat is a real
  Claude Code session (`factory.chat`, by default "Independent" on Opus 5.5).
  How a chat starts is `factory.chat.mode`, shown next to the model in the
  drawer head:
  - `"brief"` (the default, **light**): the first message starts a fresh
    session whose system prompt is the chat brief (the drawer, the factory CLI,
    the tools). The first message costs about $0.45 and a later short one a
    few cents (measured 2026-11-13: $0.46, then $0.04).
  - `"fork"` (**forked**): the first message forks `forkFrom`, so the chat
    starts with that session's whole context. That first message is the
    expensive one, once (about $7 measured 2026-11-12); later turns cost only
    their own delta, a few tenths of a dollar, since the context is cached.

  Each turn's cost is its own: the CLI reports a resumed session's running
  total, so the dashboard records the rise over the total it saw last turn.

  Independent's state shows everywhere as a dot and one word: **Working**
  while a turn runs, **Waiting** when one of its flows has an open ask or its
  last reply ended with a question, **Idle** otherwise. That is the dot on
  Ask in the rail (green while it works, amber while it waits), the drawer
  head, and a small Independent card on Home and the Agents page (a click
  opens the chat). When a turn writes a flow, an **Open flow** button under
  the reply opens it on the Flows page, chart and evidence included; the
  drawer never jumps there by itself. If the stored conversation is gone from
  Claude's files, the chat says so and runs the same message once as a new
  light chat.

  The **New chat** menu offers **New chat** (in the configured mode) and
  **Start from my session (costs more)**, which forks `forkFrom` for the next
  chat only (the head reads `forked next` until you send). Later messages
  resume the chat's own session either way, so a forked chat stays forked
  until the next New chat. It runs in the repo with the repo's
  CLAUDE.md, settings and hooks, and may read code (Read, Grep, Glob and a
  listed set of git read commands), read Switchboard, list and message other
  agents, run `tools/factory.mjs`, and drive a browser with the Playwright
  tools to check something and attach the screenshot as evidence. It has no
  edit, commit or general shell tool; the listed git commands can still write
  a file through `--output=<file>`, so see Security above. Every turn shows
  its tool calls and cost.

  ⚠️ Its Playwright browser is same-origin to the dashboard, so a prompt-injected chat agent (say, by a web
  page it reads) could tick **verified** or answer an ask by driving this page. To close that, add
  `--blocked-origins 127.0.0.1:4317` (and `127.0.0.1:4318` while a worktree server runs) to the Playwright MCP
  server's arguments in your user-level MCP config. Until then, every tool call it makes is shown on the page.
- **Alerts** (the bell in the rail, `public/notify.js`): the count on the bell,
  the header dot and the tab title say how many asks wait on you. A toast comes
  for each new ask (Answer opens the flow at that node), for a flow that turns
  blocked or done, quietly for new proof while you are on another page, when an
  agent stops working, when the chat answers while the drawer is closed, and
  with Retry when an answer could not be delivered. Retry delivers every
  undelivered answer in that flow again (each is a new relay turn, so the cost
  under Flows) and says how it went. The bell opens a panel of the last 50
  alerts this browser showed, newest first, each with its time and the action
  its toast had; they are kept in `localStorage` (`alerts.history`) and never
  sent anywhere. The panel's foot holds the desktop notifications switch.
- **Reminders** (`public/reminders.js`, `reminders` in `config.json`): at each
  reminder's local time, on the days it names, a sticky toast and a desktop
  alert (when that switch is on), once a day. There are none until you add
  some; the example config has one at 17:55 on weekdays. The list rides on `/api/pulse`, so
  there is no route of its own; a fired reminder is marked in `localStorage`
  (`reminder.<date>.<HH:MM>`), so a reload the same day stays quiet and a page
  left open overnight fires again the next day. A page opened after the time
  still shows that day's reminder once.
- **Spend today** (`public/spend.js`, `spend.mjs`): above Theme, the amount (its
  label, Spend today, beside it when the rail is open; the exact sum in its tooltip)
  is what the dashboard's OWN headless turns cost today: the chat, the answer
  relay, the explainer, the ticket refreshes, the Prompt generator and the Standup creator. It is hidden while today is
  zero, and the closed rail shows the short amount (`$4.20`, `$12`). Click it
  for the total by kind and the last 20 turns with how long ago. Each turn's
  `total_cost_usd` is appended as one line to `data/spend.jsonl` (`{ at, kind,
  usd }`, append-only); today is your local calendar day; amounts are rounded to
  cents on the page, and under half a cent reads `<$0.01`. It polls
  `GET /api/spend` every 60 s, and at once after an explain or a chat turn.
  Your own terminal sessions and the agents are not counted: only the turns
  this dashboard starts.
- **Command palette** (`public/palette.js`): `Ctrl+K` (`Cmd+K` on a Mac; the
  Ask tooltip names it) opens one box from any page. Type to filter the pages,
  the flows by title, the tickets of the current collection by id or title
  (`abc-10` or just `101` finds ABC-101), the agents by label (opens the live
  view), and the actions Ask, Refresh (on Tickets it is Refresh tickets,
  which reads every ticket from its source, with that button's hover as its
  hint), `Theme: light`, `Theme: dark`, `Theme: system` and Mark read (while
  the Since card shows). It never opens over the report modal. Prefix matches
  come first, then text found anywhere in the name or its hint, 12 at most;
  an empty box lists every page under the rail's group names, then Settings and the actions. Up and Down choose, Enter
  opens, Escape closes. It makes no request: it searches what the pages
  already loaded, so tickets show once the Tickets page has loaded them, and
  flows once Home or Flows has. `Ctrl+K` while you type in another field is
  left to that field.
- **Keyboard:** Tab from the top of the page opens the rail and walks it.
  Escape closes the top-most thing: the command palette, a `?` or explain popover, then the
  alerts panel, then the drawer. A report modal or the Timeline's popover
  takes the Escape before the drawer does, so one Escape never closes both.
  Enter or Space opens a focused card, `?` or underlined term.
- **Look and motion:** flat, hairline borders, one 6 px radius (`--radius`),
  one accent, no shadow except the drawer, popovers, menus and the alerts
  panel. Hovering a rail icon lifts it and its neighbours a little (transform
  only, nothing shifts); the brand mark is the one thing with a sheen. Cards
  light their edge where the pointer is, lists fade in once on their first
  render (never on a poll), and counts count up when they change
  (`public/motion.js`). Under `prefers-reduced-motion` all of that is off.
- **Copy:** a card head is a name and a number, buttons are verbs, an empty
  state is one line, time is short and relative (`now`, `3m`, `2h`, `5d`, all
  from `Shell.ago`), and a state is a dot and one word: Idle, Working,
  Waiting, Blocked or Done. What a working agent runs (tests, say) is in the
  hover.

### Explain any term


Two kinds of words explain themselves: the words the pages print in labels and headers (agent states, proof
states, levels, node and evidence types, the page title) have a dotted underline, and the technical words an
agent marked in a flow are shown on a soft tinted background (below). Hover one for a quarter of a second, or
focus it with the keyboard, and a small card opens with the word, its plain explanation, a **More** paragraph for
some, a tiny tag saying where it came from (`built-in`, `learned`, `from the agent`, `yours`), and two actions:

- **Ask the agent**: inside a flow, sends the word and the sentence it sits in to the agent that wrote it, as
  ONE message (about $0.30); the card then says `sent to <agent>`. When the flow belongs to the chat agent, or
  the word is not in a flow, the question goes into the Ask drawer instead, for you to send.
- **Edit**: turns the explanation into a small text box; **Save** keeps your wording, Escape cancels.

Moving away closes the card after a moment unless the pointer is on it; a click keeps it open until Escape or
a click elsewhere. The rail labels are not marked, since a click there follows the link; the page title
explains the page. Every card reads from one copy of the glossary the page loads once (`GET /api/glossary`).

Select any page text (2 to 500 characters, outside inputs and the chat) and an **Explain** bubble appears. A
selection the glossary knows shows its entry for free. Anything else is one short headless turn
(`factory.explainModel`, default `claude-haiku-5-5`) with no tools at all: `--tools ""` removes the built-ins and
`--strict-mcp-config` loads no MCP servers (`--tools` alone leaves your user-level MCP servers running). It has no
repo access (it runs in the temp folder) and no saved session; the popover shows its three-sentence answer and its real cost, about a
cent or less. If the turn fails or takes over 20 seconds the popover says *Couldn't explain that*, with the Ask link.
The route is `POST /api/explain` (`{ text }`, same-origin only, at most 500 characters).


### Plain story, marked words, and the glossary

Agents tell each flow in a few plain lines (`flow say`) and put technical words in square brackets
(`[idempotency]`); the page shows those words tinted and explains them on hover, looks up the new ones by
itself (one small turn per flow, a fraction of a cent), and keeps them all on the **Glossary** page. The whole
story, the rules and the costs are in the user guide: [Plain story, marked words, and the glossary](docs/USER_GUIDE.md#plain-story-marked-words-and-the-glossary).

## The pages

### Home (#/home)

Home moved from `#/` to `#/home` when Flows became the landing page; it is the first link of the rail's Work group, and the brand mark at the top opens it too.

Zones, top to bottom: **Since 23:10** (only when something happened since you
last pressed its `Mark read`: flows that changed status, answers delivered,
tickets that reached a new level or changed on their source, commits per agent;
at most eight lines, no model involved; it stays across reloads until marked
read, and a new browser starts from its first visit; see `since.mjs`),
one line of how many things need you, from Human review (`#homeHuman`, `human-review.js`: `N things need you`, what
they are, and **Open Human review**, which opens the box on the Agents page), **Agents · N** (the agent cards in a compact form: name,
state, last action, up to four tickets; click one to watch it live), **Subagents · N running** (only when a subagent ran
today: N is how many have not finished; the rows are the subagents still running, six at most, then the latest
four finished, each a link to its live view with its state, model, time and pull request; **All subagents** opens
the page; read from `GET /api/subagents` every 30 seconds while Home shows) and
**Messages · N** (who is talking to whom, below). The status chip says when git
last fetched; its `?` holds how far followup is ahead of dev and how old the
ticket snapshot is.

### Flows (#/flows)

The landing page: `#/` opens Flows (and so does `#/flows`). Every request is a flow with a route from the Request to
the Output (Flow types and routes, below), and this page shows each one as that path. The working page for what
agents do and what waits on you. Every agent narrates its work as a flow, one JSON
file per flow in `data/flows/`, written with the `flow` commands below. Top to bottom on the page:

- The questions across flows are not on this page: they are in the **Human review** box on the Agents page
  (below). Under each question, everywhere an ask shows, is **why** it is asked: the agent's `--why`, or, when
  it gave none, a fainter line saying which flow and step the ask follows (the opened flow's Story, Status and
  node drawer, the chart's tooltip, the alert toast, and Human review).
- **The board**, a card per flow still on its way, grouped by agent in the grid's column order. On its way is
  by **route, not status** (`FlowBoard.groups`): open and blocked flows, and a done flow whose route has a current
  step (QA passed and Push waiting is done by status and still at Push), which keeps its full card and `at Push`.
  The page head's `Flows · N` counts these cards. A card says only where
  the flow stands: the title, ONE line of story (the latest line the agent wrote, or the first the dashboard
  made from the steps, cut at a word to fit), ONE state chip (**waiting on you**, **blocked**, **ready to
  send**, **PR open**, **merged** or **done**), its **route** as a compact strip (below), the agent, and a thin
  progress bar with `13/18`. The strip is the flow's type and its current step (`build · at QA`) over every step
  from Request to Output by name: the current one in the accent, done ones neutral filled, upcoming ones outlined,
  skipped ones faint; green and red only on the QA step, for QA passed and failed. An open flow whose route is
  inferred adds a quiet `route not set`. Tickets, env
  and times live inside the flow. Flows that reached the Output collapse into a Done row; dropped ones hide behind
  Show dropped. Their small tiles keep the path too: the title, the type beside a smaller strip of the steps, the
  agent and the time, so no flow card lacks its route. Home, the palette, the Since card and the alerts still go by
  the flow's status (a flow turning done is still announced as done).
  With no open flow the board is one line, with how flows start behind its `?`.
- **An opened flow's head**: its title with the view tabs on the same row, the why (its first sentence and
  **more** when it is long), then ONE muted line of agent · tickets (three, then `+N`) · env · status · when it
  changed. The flow's status and **Drop** sit in the `⋯` menu at the end of that line. Where QA stands is one
  more word on that line, after the status: **QA passed** (green), **QA failed** (red), **QA testing**, or
  **waiting for QA** (a done flow that changed code and has no QA record yet); nothing while QA has no part in it.
  Under it, the **path from Request to Output** as a step line in the same states (`Agent 3 ×2` after a rework);
  a click on a step opens its detail: an agent's node (with this flow lit) on Agents, QA and Push on the QA page,
  the Output on the Output tab. When QA failed, a line under it says what became of sending it back: `Sent back to Agent 3 · sent`,
  `· sending…`, or `· not delivered` with **Retry** (`POST /api/flows/<id>/rework`); when QA stopped it
  (`qa-failed`), that nothing was sent and you decide.
- **Four views of an opened flow**, as tabs beside its title (Left and Right move between them; the page
  remembers the last one you used):
  - **Output** (the default) is one column you can read in ten seconds, told as a story: the **Story** leads,
    with no head and no card around it (who did what and why, one line each: a coloured name once per run of
    lines by the same person, the sentence, and *Why?* under it when there is a reason; a small `auto` tag in
    its corner when the dashboard made it from the steps, at most 3 lines with the decision waiting on you
    credited to You), then **Before → Now** in a slim block of its own when the agent said what changed,
    **Picture** (one visual, below), **How to test** (cards in a row
    joined by arrows, each with a picture, what to do, what you should **Expect**, and your **I saw this**
    tick; a step with no screenshot shows a quiet numbered placeholder), and **Details**, folded away: the
    long summary and its commits and diffs under **Changes · N** (it stays open once you open it), and last the
    **Send** bar when the agent recorded a pull request (below). The opened
    flow's one `?` says what each block is. The agent fills it with `flow say`, `flow result`, `flow diagram`,
    `flow summary` and `flow test-step` (below). Until it does, the page fills what it can from the flow
    itself (its latest screenshot, the commits in its evidence) and says `auto`; an empty block is one line.
  - **A visual is a must**: the Picture is never empty, and shows ONE thing at a time, full width and
    centred. In this order: the result **screenshots** (large, with the caption, the others as thumbnails);
    else the agent's diagram, **How it works**; else a summary chart the dashboard draws from the flow
    itself (tagged `auto`). With one view the block has no head at all; with both screenshots and a diagram,
    a small **Screens | How it works** switch picks one (remembered in this browser).
  - **Before and after**: when the agent recorded how it was (`flow result --before`, `flow change`,
    `flow diagram --before`, below), a slim block under the Story says **Before** and **Now** in one line each,
    and Screens shows the before and the after side by side, each labelled (a `‹ 1/3 ›` stepper when there
    are several pairs; a shot with no partner sits under its own label). **Compare** lays the after over the
    before with a handle to slide between them (drag it, or ArrowLeft and ArrowRight, Home and End), offered
    only when both shots are pictures, and the switch offers only the views that exist. A diagram of how it
    worked before sits beside **How it works** on a wide stage, above it when narrow. A pair needs the
    whole width, so How to test goes under it. The summary chart is high level on purpose, at most 7 shapes: a run of done
    steps is ONE solid box (its first step, with `+N more` under it), the work left in a
    run is ONE dashed box (`3 left`, orange with `1 blocked` under it when something is blocked), and each ask
    is a diamond with your answer on the arrow out of it (`Yes`, `No`, the first words of a text answer; an
    open one is orange and unlabelled). No proof marks: Status and Process carry the proof. Skipped steps,
    notes and the branches inside a run are left out (Process has the full chart);
    over 7 shapes, the middle merges into one `N steps and M decisions` box. One line of counts sits under it
    (`7 done · 5 left · 2 decisions`), and a click on a box opens that step on Status. Charts read left to
    right like a sentence and wrap into even rows joined by one continuous line return through the gap between
    them, rather than shrink their text; labels wrap between words and are never cut mid-word, diamonds are sized
    to their question, arrow labels of up to 24 characters are drawn whole, and arrows into the same box enter
    it a few px apart. A narrow box (the Ask drawer open) first holds the shapes smaller and cuts long arrow
    labels after a word (the whole label is in the tooltip); only a box too narrow for even that draws top to
    bottom. The test cards wrap onto more rows in a narrow box (a small
    window, or the Ask drawer open beside it). Each test step has an **I saw this** box: that is your own checklist, kept in
    this browser only (`localStorage`), never written to the flow, with a count like `1/2 checked` in the
    head once you tick the first one. A tick belongs to that recording of the step: steps the agent records
    again start unchecked.
  - **Request visuals**, a quiet link in the Picture's corner while the flow has neither a screenshot nor a
    diagram: the same request, asking the agent for a result screenshot if there is something to see, else a
    diagram, then the steps.
  - **Request test steps** (or **Ask again** once there are steps), a quiet link in the How to test head, opens a small form
    with an optional note (500 characters at most). Send asks the flow's agent, through the relay below, to
    drive the app (Playwright if it has it) and record each step with a screenshot. It is one relay turn,
    about $0.30, batched with any answers for that agent; the head shows `requested 3m` until a step arrives
    or half an hour passes, or `not sent` (the reason on hover) when the relay could not deliver it or the
    dashboard restarted first, with the button saying **Ask again**. When the flow belongs to the chat agent itself, nothing is sent: the request goes
    into the Ask drawer, and you send it.
  - **Explain** is the flow told like a short presentation: ONE slide at a time, full width, with `‹ 2/5 ›`
    to step (ArrowLeft and ArrowRight while the slides have the focus) and a row of small labelled dots to jump.
    A slide shows only when the flow has its data:
    - **What and why** (always): the title, the why and the Story lines.
    - **Before and after**: the before and after screenshots side by side, or the **Slider** laid one over the
      other (the same as Output's Compare), when there is a pair; the Before / Now lines when the agent wrote them.
    - **How it works**: the agent's diagram, with how it worked before beside it when there is one.
    - **Path through the agents** (always): this flow's route from its own `progress` (no request of its own), in
      the one accent colour: the steps it took, the one it is on marked with its state (`now: testing`), the steps
      still ahead as a dashed outline, the ones it went round left out. A rework is an arrow back (`failed`,
      `failed ×2`). A line under it says `Now at QA · testing · sent back once` or `Reached the Output`. A dropped
      flow says so in one line instead.
    - **QA result**: passed or failed, the attempt, the tested commit, the branch and the push, QA's summary,
      the rework line, and **How to test**, which opens the ticket on the QA page.
    `FlowsView.explain(flowId)` opens any flow on this tab from another page (the Agents page, the QA page).
  - **Status** is a summary line (done, waiting, verified), then **Built** (one line per done step: its proof
    mark, the verified tick, and an env pill only when it differs from the flow's; click the row to unfold its
    evidence: commits and diffs folded again, a screenshot as a thumbnail that opens full size), **Left**
    (what is not done, and why when it waits on an ask), **Decisions** (the asks, answerable there),
    **Notes**, and **Proof** (every screenshot). Click a title to
    see that step in the Process chart. A link that opens a flow at one step (show in flow, a toast) lands
    here, on that row, even when you last used Output.
  - **Process** is the chart below.
- **Send to the base branch**: when an agent's work is ready, it records the pull request with `flow pr`
  (the branch, the base, a plain title and a body that follows the repo's pull request template). The last
  block of Output is then one quiet bar: `feature/dark-mode → dev · 8 commits · ready` and **Send to dev**
  (the base is in the label). Before it says ready the dashboard checks, on request and at most every 20
  seconds (fetching the remote at most once a minute): the branch exists and is ahead of its base, it merges
  cleanly, no commit message, title or body credits an AI tool, gh is installed and signed in, no pull
  request is already open for the branch (its link shows instead), and, for a flow that changed code, QA passed
  it (`QA has not passed: …`) at the very commit being sent (`QA tested a different commit …`). Any of those is a **blocker**: the bar says
  **blocked**, lists each reason on its own line, and the button is off. Being behind the base, CI never
  having run on the commits (the branch is not on the remote yet) and more than 50 commits are **warnings**.
  The button opens a review in place (not a dialog): the title with its commit and file counts, the body, the
  commits, the warnings, and `This pushes <branch> to <remote> and opens a pull request into <base>. It does
  not merge anything.` Type your **Send PIN**, then **Open pull request** pushes exactly the commit you reviewed
  and opens it (if the branch or the text changed since, it asks you to review again); the bar becomes `PR #12 open · checks passing · updated 2m`
  (a link, in a new tab), its state and checks read again at most once a minute while the flow is open, and
  `Merged into dev` once merged. A refused push shows the plain reason and **Try again**; a push that worked
  with no pull request says `Pushed, no pull request yet`; an open pull request someone made for the branch is
  picked up and shown. A push is never forced. Turn it on with `pr.enabled` in config.json and a send PIN
  (Configuration); until then the bar says `Sending is off: set a send PIN (see the guide)`.
- **The chart** of an opened flow: its title, agent, tickets, env, status and why, then the nodes top to
  bottom (branches side by side, joins merged), each one line with a status glyph, an env pill when it differs
  from the flow, and an evidence count. Asks are diamonds with Yes and No on them until answered. A rail on
  the left is coloured per environment, so Local, Dev, Stage, Prod read as bands. Click a node for its
  drawer: the why, each piece of evidence (a commit with its subject and diff, a test line, a screenshot,
  a link), the verify tick, and "Ask Independent about this step". The chart zooms and fits like the Timeline.
- **Proof states** of a done node: **unproven** (no evidence), **claimed** (evidence, not ticked), **verified**
  (you ticked it; only you can, there is no command for it). Nodes after an open ask, or after a No, show
  **pending** until the agent picks up again.
- **Answers are pushed** to the agent that asked: a short headless turn (`factory.relayModel`, default
  `claude-sonnet-5-5`, allowed only ListAgents and SendMessage) sends that agent the flow, the question and
  your answer. Answers to the same agent within 30 seconds go as one message. The node then shows **sent**,
  or **not delivered · retry** when the agent is not running or its name does not resolve. Until then it
  shows **sending…**, and **not sent yet · retry** if it is still unsent after two minutes; an answer the
  dashboard was restarted before sending is marked not delivered, never re-sent on its own. A status you set
  by hand on a node after an ask goes to the agent the same way, in the same batch, and so does a
  **Request test steps** from the Output view (one line per flow, with your note). Each delivery
  costs roughly $0.30 and ten seconds.

### Archive, Delete and the flow archive (#/archive)

Flows are the one thing the dashboard keeps of its own, so they are the one thing you can put away. Each card on the
board, and an opened flow's `⋯` menu, has **Archive** and **Delete**. **Archive** hides a flow from the board, the
palette and the alerts without changing it; a new question from its agent brings it back. **Delete** moves it to
`data/trash/<id>.json` (the folder keeps its old name, so entries an older version wrote still show); a flow its agent
may still be working on asks first, and that agent is told to stop. Nothing is removed by a timer: both wait in the
**flow archive** (`#/archive`, `archive-page.js`, `GET /api/archive`), in an Archived and a Deleted group with a search
by title or ticket id. A title opens the flow read-only (a banner, every control that would change it hidden and
refused); **Restore** puts it back, and **Delete for good** (Deleted only, asked in the row) removes it with its
evidence files. Archived flows count in the pipeline score; deleted ones do not. Only you archive or delete: agents
have no command for either, and any command on a deleted flow is refused.

### Completed: the sign-off on an output

A flow that reached the Output waits for your sign-off (`completed.mjs`, `completed-routes.mjs`,
`public/completed-view.js`, `public/pipeline-output.js`, `completed.css`). **Completed** (at the end of the flow's
Output tab, the tick on its row in the Agents page's Output list, or **Mark all completed** there and in the
reminders) asks once in place, then sets `completedAt` and `completedBy: "you"` on the flow and archives it in the same
write (`POST /api/flows/<id>/complete`, the page's own Origin required and present, like the by-hand tick). Only a
finished flow can be completed (done, or standing at the Output); the write keeps `updatedAt`, so the pipeline score,
Pipeline time and Pipeline tokens count it exactly as before, and the Log gains one `completed` event by You. A
completed flow leaves the Flows board, the Agents diagram and its lists, Human review, Home, the Tickets page's flow
chips and the Log's default view (its **Completed** chip shows them); it waits in the flow archive as **Completed
<date>**, opens read-only from there, and **Uncomplete** puts it back (`{ "completed": false }`, both marks off, one
`uncompleted` event). Unarchive refuses a completed flow. Only you complete a flow: agents have no command for it, and
`flow write` keeps or drops the stored mark exactly as it does `archivedAt`. Every press is kept in the flow's
`signoff` history (`[{ at, did: "completed" | "uncompleted" }]`, the newest 100), which a rewrite keeps too, so the Log
shows every sign-off; `completedAt` is the current mark. A new question that reopens a completed flow clears the mark
and adds `{ at, did: "reopened", by: <the agent> }`: the Log says A question from that agent reopened this. Archiving is not a sign-off: a flow at the
Output that is archived but not completed still waits (it counts, the Output list shows it with an Archived mark and its
tick, and so does its archive row).

While outputs wait, the Agents page (over the diagram) and Home say `N outputs wait for your sign-off` with **Show
them**; after `outputs.warnAfterDays` (2) days the line is a notice and the Output box counts the overdue. Once
`outputs.max` (7) wait, the Ask drawer and Pass a task on the Tickets page show `N outputs wait for your sign-off. Mark
them completed before a new request.` with Mark all completed, and `flow new` prints the same line on stderr (exit 0),
so an agent tells you; nothing is blocked. `GET /api/outputs` answers `{ waiting: [{ id, title, agent, finishedAt,
overdue }], counts: { waiting, overdue }, max, warnAfterDays, piled, builtAt }`.

### QA (#/qa)

The tickets QA passed, newest first (`GET /api/qa?status=passed`, read on every visit and every 30 seconds while the page shows; the last list stays
  on show while it reads).
Each row is a green dot and the word **Passed**, the title, the ticket ids, the agent, the tested commit's short
sha, and when QA pushed it (`pushed 3m`, or `not pushed yet`). With none it is one line saying how a ticket gets
here. A click opens the ticket at `#/qa/<flow id>`, a link you can share or reopen:

- the QA state, the attempt, the agent, the tickets, and the **commit** and the **branch**, each a link to its
  GitHub page in a new tab when the repo's remote is on GitHub, else plain text, and the push;
- QA's summary, then the **Report**, drawn with the same safe Markdown as the flow summaries (nothing in it is
  rendered as HTML; a report over 64 KB says so and links to the whole file). The `---` block QA puts at the top
  (ticket, result, tested, screenshots, commit) is taken off the text, and its result, tested rungs and commit
  show above it as a small list;
- the **Screenshots** as thumbnails that open full size, and **How to test**: QA's steps as the same cards as
  Output's How to test (the step, what you should see, its screenshot), without the checklist;
- the earlier attempts, one line each, **Open flow** (the flow itself, the source of truth for the ticket) and
  **Explain in Flows**, which opens the flow on its Explain tab. Under the meta line, the flow's path from Request to
  Output, the same step line as an opened flow's head.

`QaPage.gotoFlow(flowId)` opens a ticket from another page. A ticket that did not pass (one opened from the
Explain tab after a failure) opens too, red and marked **Failed**, with its rework line. A ticket QA never saw
is never red: the page says, in plain words, that it has not been through QA and why (it changed no code, it is
still being worked on, it waits for QA, or it was dropped), with **Explain in Flows**, and **How to test in Flows** (the
flow's Output tab) only when that flow has test steps. A link straight to `#/qa/<flow id>` reads that ticket at once, beside the list.

### Generators (#/generators)

Two writing tools on one page, picked with two pills at the top: **Prompt generator** and **Standup creator**. The page
always opens on the Prompt generator; `#/generators?tool=standup` opens the Standup creator. Switching keeps the
address in step, and a run in the other tool goes on while it is hidden. The page was Brainstorming, and SCRIPT
before that: `#/brainstorming` and `#/script` still land here, and the prompt tool's files, its `/api/script/` routes
and its data files keep the word script, so saved History and Context keep working.

#### Prompt generator

SCRIPT is now only the name of its six-part method.

Write a rough idea in **Your thoughts** and press **Generate** (or Ctrl+Enter, Cmd+Enter on a Mac). It comes back as a
prompt for any AI, ready to paste, in one code block with six labelled parts: **S**ituation, **C**haracter,
**R**equest, **I**ntent, **P**resentation and **T**one. It never does the task itself. Every assumption it made is
listed under the block, as quiet notes you can overrule. **Copy** copies only what is inside the block (no fences, no assumptions line) and says
**Copied** for a moment; it stays off until a block exists.

- **How it calls the model:** one headless Claude Code turn, like the chat, never the raw API (no API key is needed):
  Opus 5.5 (`claude-opus-5-5`) at high effort, with the system prompt in `script-prompt.mjs`: the user's own rules for building a prompt (the six
  parts, reading the context first, a silent gap scan, questions scaled to the task, only the facts you gave, plan
  first for code), taken from their method document, each rule and the exact text tested. The run is clean: `--tools ""` and `--strict-mcp-config` give it no tools and no MCP servers,
  `--setting-sources ""` loads none of your settings (without it your `~/.claude/CLAUDE.md` and plugin hooks rode
  along), it runs in a fresh empty temp folder with `--no-session-persistence`, and `--name SCRIPT` stops the CLI's
  own session-title call. The CLI still adds its short environment note and your account email; no flag removes them.
  Your text goes on stdin. The route is `POST /api/script/generate` (`{ text }`, 1 to 8000 characters, same-origin
  only), streamed back as NDJSON: `delta` lines, then one `done` or `error` line. One run goes at a time (a second
  gets 409). Closing the tab stops the run; going to another page does not, and the result is there when you come back.
- **The brainstorming skill** (`/superpowers:brainstorming`): when the superpowers plugin is installed in the account
  folder the run uses (`CLAUDE_CONFIG_DIR`, else `~/.claude`), `script-skill.mjs` finds it through that folder's
  `plugins/installed_plugins.json` and reads its `SKILL.md` at run time (it is never copied into this repo). The system
  prompt carries it after the rules and a short mapping onto this page: its questions go in the pop-up as one numbered
  list, its design is the six-part prompt, its spec file, commits and plan do not apply, and the rules win where the
  two differ. Tools stay off. Without the plugin the page works on the built-in rules alone, and the line under the
  output says `Left out: Brainstorming skill (It was not found on this machine, ...)`. Invoking it as a slash command
  (`--plugin-dir` and the command on stdin) also works, but measured twice the cost, so it is not used (`script.mjs`
  says why).
- **What it costs** (measured 2026-11-25, the orchestration brief attached, no live session): the first run in an hour
  writes the rules and the skill to the prompt cache, about 10 cents ($0.096 for a full prompt). Runs after it within
  the hour read them back at a tenth of the price: $0.045 for a set of questions. On main before the skill, the same
  full prompt cost $0.051. Each run counts in **Spend today** as Prompt generator.
- **The layout:** two equal columns, each a head row of the same height, a box, and a foot row. Both boxes share one
  height that fits the window, so they start and end on the same line before, during and after a run; the output
  scrolls inside its box. The page is as wide as the banner above it. Under 900 px the columns stack.
- **The output:** clean text, never raw marks. Bold and code show as bold and code, numbered and bulleted lines as
  real lists, and the code block as a prompt card with one row per section (its letter, its label, its text), with
  no fence lines. The assumptions under it are small quiet notes. It is drawn from text only, never as HTML
  (`script-render.js` splits the answer into parts, `script-view.js` draws them and only patches what changed).
- **The letters:** S C R I P T sit above the output. While the model thinks (no text yet) they ripple in a slow wave
  and the line says **Thinking…**. Each lights in the accent with a small pop as its section starts streaming, read
  from the text itself; the one being written keeps a soft pulsing ring, its row eases in, and a thin caret blinks
  where the text arrives. When the last section finishes (Tone, then the closing fence, or a good end with all six
  seen), the letters settle with a small bounce one after another (all in under 400 ms), the box glows once, and a
  short soft pop plays. Under reduced motion nothing moves or loops: each of these is a short fade.
- **Restart** (next to Generate) starts the page over: it stops a run that is going (the server then stops the
  model), and clears your text, the answers, the output, the letters and any error. **Started over.** with **Undo**
  shows for 6 seconds and puts your text back (answers come back under your thoughts); the output does not come back.
  A stopped run never shows an error, pops, or adds late text.
- **The pop and mute:** the pop is made in the browser with the Web Audio API (no sound file): a 115 ms sine that
  falls from 620 to 300 Hz, at a low volume. The speaker button by the letters mutes it; the choice is kept in this
  browser (`script.muted`). Muted, the letters and the glow still show.
- **When it asks questions:** an idea with gaps that matter gets a few short questions instead of a prompt, highest
  impact first: none or one or two for a small clear ask, at most 5 at a time, and at most two rounds (the second
  round sends the first round's answers again, since the model remembers nothing). Say *just do it* or *skip the
  questions* in your idea and it writes the prompt at once, with its assumptions listed. They show in the output box, the letters stay dark (the line says **Questions first**),
  nothing pops, and your text is left as it was. A pop-up opens over **Your thoughts**, `The Prompt generator has 3 questions`,
  with each question and its own answer field (text with no numbered or bulleted items gets one field). Choices the
  model offers as bullets under a question show under that question and get no field of their own. **Answer and
  generate** (or Ctrl+Enter in it) needs at least one answer and sends your text, then `Answers to your questions:`,
  the questions and your answers as a numbered list, `(no answer)` for any you skipped. **Later**, Escape or × closes
  it and keeps what you typed in the **Your answers** box under your thoughts; **Show the questions** opens it again.
  You can also answer in that box and press **Generate again**.
- **History**, under the two columns, closed by default (this browser remembers open or closed): the runs the
  dashboard logged (`GET /api/script/log`, newest first), each with when, the first line of the idea, what came back
  (Prompt, Questions, Stopped or Did not finish), the cost and the **Sent with** titles. Click a run to bring it back
  as it finished (no pop and no glow; questions open the answers box, not the pop-up); not while a run is going.
  **Remove** drops one, **Clear history** asks once on the page, then drops all. A dashboard without the log hides it.
- **When it fails** (Claude Code missing, the run stopped, the model declined, or no output for 2 minutes): a calm
  line says so with **Retry**, which sends the same request again. Any text that had arrived stays, marked
  **Incomplete**. There is no pop.

#### Context: what the Prompt generator knows about your system

The run is clean, so on its own the Prompt generator knows nothing about your agents or your work, and an idea such as "a prompt
for my full agent orchestration" gets questions back. The **Context** tab on the right edge of the page opens a panel
(like the Agents page's) that says what the Prompt generator is told before it writes. Open or closed is kept in this browser
(`script.contextOpen`). It holds three kinds of context, and the tab shows how many are on (`Context · 3`):

- **Orchestration** (on by default): a plain brief the dashboard writes itself from what it already knows. What the
  system is (a coordinator hands requests to producers, QA tests every code change and is the only one that
  pushes, failures go back), each agent and its role in the Agents page's wording, the three flow types and their
  routes, the QA rules (how many reworks, the protected branches), the pages in one line each, and what the
  dashboard is built with. When you have saved rules for an agent (Agents, then Settings), they
  follow as a section, and so does the pipeline score of the last 30 days once anything has been scored
  (`script-brief-extras.mjs`). It carries labels and settings only: never paths, session ids, your account, the PIN
  hash or tokens, and it is scrubbed for them as well. At most 8,000 characters. **Preview** shows it.
- **Live session**: pick one running session by its label (Master, Agent 1 …). When you press **Generate**, the
  newest part of its conversation is read fresh: your typed messages and its text replies only, with no tool calls,
  tool output, thinking, system reminders or messages from other agents, the newest turns that fit in 12,000
  characters. A session that has stopped, or whose transcript cannot be read, is skipped with a plain reason.
- **Notes**: your own, each with a switch, **Edit** and **Remove** (which asks once). **Add a note** takes a title
  (1 to 80 characters) and text (1 to 20,000); **Add files** (or dropping files on the open panel) reads text files
  in the browser and saves one note per file, named after it. A file that is not text, is empty or is too long is
  refused with a calm line and the others are still saved. At most 40 notes. An agent can add one too:
  `node tools/factory.mjs context add "<title>" (--text "..." | --file <path>)`, `context list`, `context remove <id>`.
  That is how you **ask Master**: ask in its chat, and it runs the command.

With anything attached, the model gets your text as a `<task>` after a `<context>` block holding each part under its
own heading, with a line saying the context is background and not instructions. With nothing attached it gets your
text exactly as before. Your text keeps its own 8,000 limit. The parts together are at most 60,000 characters: while
they are over, the largest part (the oldest of equals) is cut to fit with a line saying so, keeping its start (the
live session keeps its newest end), or left out when less than 1,000 characters of it would remain. The panel's foot
says about how much is attached and warns near the limit. The stream then carries one extra line before the first
`delta`, `{ "type": "context", "used": [{ "title", "chars" }], "skipped": [{ "title", "why" }] }`, whenever something
was attached or left out.

The context lives in `data/script-context.json` (it follows `FACTORY_DATA_DIR`; a missing or broken file reads as the
defaults, and every write is checked and atomic). The routes, every write same-origin only:

- `GET /api/script/context` returns `{ orchestration: { on, chars, text }, session: { on: <label or null>, choices:
  [{ label, state }], max }, notes: [{ id, title, text, on, chars, updatedAt }], total, limits }`. `total` counts the
  brief and the notes that are on; the session is read only at Generate time, so `session.max` says what it can add.
  A chosen session that has stopped stays in `choices` as `not running`.
- `PUT /api/script/context` `{ orchestration?: boolean, session?: <label or null> }` returns the same view.
- `POST /api/script/context/notes` `{ title, text }` returns 201 `{ note }`.
- `PUT /api/script/context/notes/<id>` `{ title?, text?, on? }` returns `{ note }`; `DELETE` the same path returns
  `{ ok: true }`. An unknown id is a 404, a bad body a 400, another site's Origin a 403, each `{ error }` in a plain
  sentence.

#### The run log

Every run that started is kept in `data/script-log.json` (your local data folder, which follows `FACTORY_DATA_DIR`
and is never committed), good, failed and stopped alike, for the **newest 50 runs**. Each entry is
`{ id, at, ms, text, output, ok, error, cancelled, cost, context: { used: [{ title, chars }], skipped: [{ title, why }] } }`:
your own text exactly as you sent it (never the context wrapped around it), the model's text as it streamed (at most
40,000 characters), the plain message of a failed or stopped run, the cost when there was one, and what was attached
by title and size only. The context's own text is never kept in the log. The stream's last `done` or `error` line
carries `"run": "<id>"`. The log is written after the answer is out; a log that cannot be written never fails a run.

- `GET /api/script/log` returns `{ runs: [...], limits: { runsMax: 50, outputMax: 40000 } }`, newest first.
- `DELETE /api/script/log/<id>` removes one run (`{ ok: true }`, or 404); `DELETE /api/script/log` clears it all
  (`{ ok: true, removed: <n> }`). Both are same-origin only. Clearing from the page's History list does the same, or
  delete the file while the dashboard runs.

### Standup creator (#/generators?tool=standup)

Writes the stand-up you send each day, in your own format, from what the dashboard can already read. Pick **Daily** or
**This week**; the line beside the pills says what it covers (`Covers Tue 24 Nov to now`) before anything runs. Press
**Generate**: the stand-up streams into the box as plain text, and **Copy** copies exactly that text.

- **Daily** covers 00:00 of the last working day until now (on a Monday it starts on Friday), and is written as three
  sections: `Stand up, Tue 24 Nov` with each ticket as `ID: title — link` and short bullets under it, then
  **Blockers** (only what needs someone else or something outside your hands; `None` when there is none), then
  **What's next**.
- **This week** covers the last seven days and follows the weekly template: `Name:`, `Project:`, `This week — done:`,
  `Done Nov 19–25:` with one line per ticket and the merged pull requests, **Blockers**, and `This week — committing
  to:` with the next seven days.
- **What it reads** (`standup-facts.mjs`, read only): in `repo`, every commit by the author in that time on every
  branch (merges left out), the pull requests merged into the default branch whose branch has the author's work, and
  the author's branches not merged yet (and whether they are pushed); the SAVED ticket list (the factory sources under
  `data/sources/`, never a live Switchboard call, so its date is shown: refresh it on Tickets when it is old); the
  flows touched in that time; and what waits on you (Human review) as Blocker candidates. Ticket ids come from the
  commit subjects and branch names with your ticket prefixes. The server builds every ticket line and link (pattern
  `standup.ticketUrl`); the model only copies them. The facts are capped at 30,000 characters (the oldest commits go
  first), and a source that cannot be read is left out and named: `Read: 6 commits, 1 merged pull request, 52 tickets,
  ticket list from 13 Nov` and `Left out: Flows (it could not be read).`
- **The run** is the prompt generator's clean headless run (`script.mjs`, the same flags, temp folder and 2-minute idle
  stop), with the stand-up prompt in `standup-prompt.mjs`, Opus 5.5 at **medium** effort, session name `STANDUP`, one
  stand-up at a time. Its cost counts in **Spend today** as Standup creator: about 11 cents a run ($0.106 daily,
  $0.109 weekly, measured 2026-11-25).
- **Resets every day:** each view shows the newest stand-up of its kind made today (the server's local day), so a
  reload keeps it; on a new day both views are empty, and nothing runs until you press Generate.
- **Date archive** (under the box): every stand-up is kept for good, one file per day in
  `data/standup/<YYYY-MM-DD>.json` (at most 20 runs a day; each output at most 40,000 characters), plus
  `data/standup/index.json`, which is rebuilt from the day files when it is missing or out of step. Days are listed
  newest first under their month, each with its Daily and Week entries and their first line; **Go to a day** jumps to
  one (a day with nothing says so); a click shows that stand-up read-only, with `Made Wed 25 Nov 09:24 · Covers Tue
  24 Nov` over the box and **Back to today** under it.
- **Ticket log:** each saved stand-up records the tickets it mentions (the facts' tickets its text names, and any other
  id in it with your prefixes). Type an id in **Ticket** (`FLA-886`) to list every day it came up, newest first, with
  its title, its link and the lines about it. `#/generators?tool=standup&day=2026-11-25` and `&ticket=FLA-886` open
  those from the address.
- **Routes:** `POST /api/standup/generate { mode: "daily" | "week" }` (NDJSON: one `facts` line, the deltas, then one
  `done` or `error` line; the page's own Origin only; 409 while one is being written), `GET /api/standup/log` (today's
  stand-ups and what each view covers), `GET /api/standup/days`, `GET /api/standup/day/<YYYY-MM-DD>` and
  `GET /api/standup/ticket/<ID>` (the day and the id are checked before any path is built).

### Settings (#/settings)

The gear above Theme in the rail. Two sections:

- **Sending**: a switch `Send to <base>`, the branches it may open pull requests into, and your **send PIN**
  (set it with two fields and **Set PIN**; once set, **Change PIN** with the current one, or **Forgot it?
  Reset**). Setting the first PIN, a reset, turning sending on and new branches open a Yes/No window from the
  operating system: confirm there, outside the browser. Where no such window can open (a machine with no
  desktop), the page says what to do instead: `node tools/factory.mjs pr-pin` in a terminal, or edit the `pr`
  block of config.json. A wrong current PIN counts toward the same lock as sending.
- **Your setup**, read-only: the watched repo, where config.json is, the session labels, the chat, the ticket
  prefixes and the reminders. Change these in config.json, then restart the dashboard.

Each person sets their own PIN on their own machine: it lives in that machine's config.json, which is never
committed. When Send is off or has no PIN, the Send bar under a flow's Output says `Sending is off` with a link
here.

### Projects and the Orchestration bank (#/bank)

The **Project menu** at the top of the rail shows the project the dashboard watches, with the orchestration it
last took from the bank under its name. Choose another project and the WHOLE dashboard switches: its repo,
sessions, tickets, flows, evidence, scores and agent rules. **Add a project…** asks for a name, the top folder of
its git repository, how its sessions are recognised (default: the folder name) and the orchestration it starts
with (the same as the current project, or one from the bank). **Rename or remove…** removes a project from the
list only; its data and its repo stay.

- `projects.json` (beside config.json, gitignored; in FACTORY_DATA_DIR when that is set) holds
  `{ active, projects: [{ id, name, primary?, config }] }`. The first project is config.json itself and keeps
  `data/` exactly where it is; any other has `data/projects/<id>/` and takes nothing per-project from config.json
  (repo, sessionCwdMatch, ticketPrefixes, coordinator, labels, aliases, pinnedAgents, pipeline, levels, the
  ticket collections, the chat name and fork). Machine settings (port, claudeDirs, models, `pr`, reminders) stay
  shared. With no projects.json the dashboard works exactly as before (project-store.mjs).
- A switch writes `active` and restarts the server so every module loads fresh (restart.mjs): under
  keep-alive.cmd with exit code 75; started by hand, it starts its own hidden replacement on the same port and
  exits. A switch is refused while the Ask chat is answering, an answer waits in the relay queue, or another
  write is still being answered. Agents' commands (`tools/factory.mjs …`) run from inside a project's repo
  write to that project, whichever one the page shows; `YZ_PROJECT=<id>` names one outright.
- The **Orchestration bank** saves orchestration styles for every project, in `data/orchestration-bank.json`:
  the pipeline block (whole), the coordinator and agent labels, the chat agent's name, and each agent's
  specification and rules, never a repo, session id, pin or ticket setting. **Use on this project** saves the
  style in use first, writes the new one (config.json in place for the first project, projects.json for any
  other; the rules file of the project) and restarts. The first read of an empty bank saves the current style
  once. Limits: names of 60 characters, 50 entries, 256 KB each. A new per-agent store joins a style as one
  line in `STYLE_PARTS` (orchestration-parts.mjs).

### Tickets (#/tickets)

The page for a ticket collection (`factory.collections` in config.json, below). The page title is the
collection's name (a picker shows when there are several); the chip says when Switchboard was last read, with
the range, the count and any failure behind its `?`, and Refresh reads it now.

- **Orchestration · N:** agents across (Coordinator, Agent 1, 2, 3), levels down (Local, Dev, Stage, Prod), and in
  each cell the tickets that agent built which got that far and no further. Prod is origin/main (squash bodies
  included), Stage and Dev are their origin branches, Local is committed work on followup or any worktree
  (detached included) that dev does not have. The builder is the agent on the worktree, else the plan's wave
  column (A1, A2, A3), else Coordinator. A ticket a **subagent** built (it is in the branch name, a commit subject or the
  task name of a builder from the last 7 days, the newest one winning) is credited to that subagent, not to the
  session that started it: its chip carries the subagent's short name after the number, it sits in that
  session's column, and its hover says `Built by <the subagent's task name> · subagent of <session>` with a link to
  watch it. Hover a ticket for its review, plan, the commit at each level and the open
  flows it is in; click it to open its row. Each column head says whether the agent is working, idle or
  waiting, its last action, and opens its **progress report** (from its transcript) and its live view. The
  legend is behind the card's `?`.
- **Tickets · N** (folded, remembered), in board order: Current Sprint, then Backlog, then Icebox, by
  position. Each row shows the board state, the owner, whether the plan marks it as a must for launch, and a
  **code review mark**: Code reviewed (with a verdict), Needs review, No code yet, or Not from codebase.
  Filters are checkbox dropdowns; the stat chips filter too.
- **Per-ticket actions:** review the code with the chat agent (it records the mark itself), explain the ticket,
  or pass a task to a live agent. Select several rows to do it in bulk. Each one goes through the chat agent
  (`POST /api/chat/send`) and names the flow it starts: a review flow, an ask flow, or, for a task passed on, a
  build flow the receiving agent starts with its own `--by` and follows to QA.
- **Worktrees · N** (folded, remembered): every worktree with its branch, agent, uncommitted files, how far it
  is from its remote and from dev, whether followup, dev and stage have it, and its last commit.

### Subagents (#/subagents)

A subagent is one Agent tool call of a session, usually the coordinator handing a task to a fresh
context. The page lists every subagent of the watched repo's sessions (those whose working folder matches
`sessionCwdMatch`, in every folder of `claudeDirs`), whether the session that started it still runs or has
ended, for a window you pick: **Today** (the default), 2, 3 or 7 days. It reads Claude Code's own files and
nothing else: each subagent's small `agent-<id>.meta.json` and the last 4 MB of its transcript, once per change
of that file. It runs no model and costs nothing.

- **Builders | Lookups**, with a count each. A **builder** worked in a worktree or made a git commit that ran
  without an error; a **lookup** only read, searched or asked (a sweep, a triage). Builders show first, and
  the choice is remembered in this browser. A worktree is a path under `.claude/worktrees/` in a tool call,
  a folder the subagent made with `git worktree add`, or a folder it moved into (`cd`, `git -C`) that git lists
  as a worktree of the repo; the main checkout never counts.
- **A card per subagent**, newest first: its task name, its state, then its model, the session that started it
  (or `ended session`) and when it last wrote; its worktree and branch; its tickets (the ones in its branch
  name, its commit subjects or its task name; for a lookup, the last four it looked at); and its pull
  requests: the links in its final report, in what a `gh pr create`, `view`, `merge`, `checks` or `status`
  command it ran printed, and in its own words. A link in a file it read, wrote or searched, or in any other
  output (a test run, a file body), is never its pull request.
- **State**, a dot and one word: **Working** (not finished, and its transcript was written in the last
  15 minutes), **Stuck** (not finished, and nothing written for 15 minutes or more), **Done** (it handed back
  a final report with SubagentHandback), **Stopped** (amber: it ended without a handback and without an
  error, so it may need resuming) and **Failed** (its last reply was an API error). A stopped or failed
  card shows its last words.
- **Pull request state**: `PR #12 merged`, `open · checks passing`, `open · checks failing`, `closed`. It
  comes from `gh pr view <n> --repo=<owner/name> --json=state,isDraft,statusCheckRollup` with the `pr.gh`
  command, read only, at most once a minute per pull request and never again once merged, a few at a time,
  each call given 8 seconds. The list never waits more than 2.5 seconds for gh: a state that is late shows
  on the next poll, and when gh is missing, signed out or fails, the card shows the plain link.
- **Report** unfolds a finished subagent's final report in full, drawn as Markdown with everything escaped,
  with **Copy**. It is read on demand (`GET /api/subagents/report`), so the list stays small.
- **Flow** opens the flow that tells the subagent's work: a flow it wrote (its `--by` is the subagent's task
  name, or it ran its flow commands on that flow, whatever name it signed with), else one whose recorded pull request starts from its branch, else one that names a ticket it built.
  A quiet **no story** marks a builder that is done, failed, stopped or stuck (never one still working) with no flow, or whose flow has no story (`flow say` lines) or no
  picture (a result screenshot or a diagram); the hover says which.
- **Click a card** to watch that subagent in the live view (below), also when its session has ended. A click on
  a link, a button or inside an open report stays on the page.

The routes are `GET /api/subagents?days=1..7` (anything else reads as the nearest allowed value) and
`GET /api/subagents/report?session=<id>&sub=<id>`; the page polls the first every 15 seconds while it shows.
The code is `subagents.mjs` (the listing), `subagent-prs.mjs` (gh), `subagent-routes.mjs` and
`public/subagents-page.js`. Limits: only the last 4 MB of a transcript is read, so a very long subagent's early
work (a worktree it left, a first commit) can be missed; a subagent whose session was killed stays **Stuck**;
and ticket and flow matching are heuristics, a strong hint and not a record.

### Agents writing flows

Every agent that works in the repo gets the same brief. Paste this paragraph into the briefs you give agents
(the chat agent's system prompt already carries it):

> Every request gets a flow FIRST, before you change anything: `flow new <id> "<title>" --type build|review|ask`
> (or `flow write` with `"route": { "type": "build" }`). The type sets its route from the Request to the Output:
> build for a code change (Request, the coordinator, you, QA, Push, Output), review for a code review of a ticket
> (the chat agent's), ask for a question, an explanation or an investigation (Request, you, Human task, Output). Follow that
> route. If the plan changes, say so with `flow route <flow> --type ...`: the old route stays visible.
> Narrate your work on the dashboard as a flow: `node <abs path>/tools/factory.mjs flow …`.
> Start with `flow new --type` or `flow write` before you change anything, keep
> statuses current with `flow status`, attach proof with `flow evidence` (the
> commit sha, a test line, a screenshot), and put any choice that is the
> user's as `flow ask` instead of asking in prose, then stop at that step: the
> answer arrives as a message. Never act on another system (a tracker, a live
> site, a deploy) before the ask is answered Yes.
> Always pass `--why` on `flow ask`: one plain sentence on why you need this answer now (what it unblocks,
> what each choice leads to). The user reads it under the question everywhere the ask shows; an ask without
> one prints a warning, and the dashboard can then only say which flow and step it follows.
> When a piece of work is finished, record its output: a result screenshot (`flow result`), a short summary
> with the commits (`flow summary`), and manual test steps with a screenshot each (`flow test-step`).
> Every flow needs a visual, and a flow with neither a screenshot nor a diagram is unfinished: for UI work a result
> screenshot (`flow result --shot`); for anything else (an API, a job, a deploy, an investigation) a diagram of how
> it works (`flow diagram`), the big picture only: at most 8 boxes, named the way you would to a colleague, never
> file names or commit subjects.
> Show what changed as a before and after: before you change anything visible, take a screenshot with
> `flow result <flow> --shot <file> --before` (for work with no screen, draw how it worked with
> `flow diagram <flow> "…" --before`), and when done say how it was and how it is now in one plain line each
> with `flow change <flow> --before "<how it was>" --after "<how it is now>"`.
> Record test steps one command at a time, never in parallel: each one rewrites the flow file.
> A `flow write` file with no `output` keeps the stored one; `"output": {}` clears it.
> Tell the story of each flow in a few lines with `flow say` (at most 8; the page shows them first).
> Write for a reader who was not there. Say who did what in one short plain sentence, then why.
> Not a commit message: no file names, no flags, no ticket ids in the sentence.
> Use the right technical word, and put it in square brackets the first time, like [idempotency],
> so the dashboard can explain it. If the word is unusual, define it yourself with `term`.
> When the work is ready to go to the base branch, record it with `flow pr <flow> --head <branch> --base <branch>
> --title "<plain-English title>" --body-file <file>`, the body following the repo's own pull request template.
> Never push or open the pull request yourself: when your work is ready, record `flow pr` and hand the flow to QA
> (send QA a message naming the flow). QA tests it, pushes the branch on a pass, and sends a failure back to you with
> its report: fix it and ask QA to test it again. The user then sends the pull request. The pull request text
> must not credit an AI tool (no Co-Authored-By line, no Generated with line).

The commands (`node tools/factory.mjs flow …`). Each writes the flow file atomically and prints one line;
`--by` or `FACTORY_BY` names the agent: its dashboard label (letters, digits, spaces, dots, dashes, underscores; up
to 40), which is where answers are sent. `flow new`, `flow write` (unless the file names its agent), `decide`
and the Output commands refuse to run without one. `flow new` also needs `--type`, and a new flow written whole
needs its `route` (Flow types and routes, below).

```
flow new <id> "<title>" --type build|review|ask [--tickets ABC-1,ABC-2] [--env dev] [--why "..."]
flow route <flow> --type build|review|ask   # change the planned route on purpose; the old one stays in route.history
flow step <flow> "<title>" [--id n5] [--env stage] [--why "..."] [--after n2,n3] [--status doing]
flow check <flow> "<title>" [same options]
flow ask <flow> "<question>" --why "<why you need this answer>" [--yes "..."] [--no "..."] [--text] [--after n2]
flow answered <flow> <node> --answer yes|no|"<text>" [--note "<the user's words>"]   # the user answered this open ask in your chat
flow note <flow> "<text>" [--after n2]
flow status <flow> <node> <todo|doing|done|blocked|skipped>
flow evidence <flow> <node> --commit <sha> | --diff <worktree> | --test "<line>" [--file path] | --shot <path> | --url <url> | --note "<text>" [--label "..."]
flow set <flow> --status done|blocked|dropped|open | --title "..." | --why "..." | --tickets ...
flow write <path.json>            # whole flow in one go (create or replace; keeps answers, ticks, the route, and the output when the file has none)
flow show <flow>                  # the JSON on stdout, for an agent to read back answers; an Output block on stderr
flow list [--open] [--waiting] [--agent X] [--ticket ABC-1]
flow rules                        # your specification and rules, set by the user on the Agents page; "No rules set for <label>." when none
flow result <flow> --shot <path> [--caption "..."] [--before]
flow diagram <flow> "[actor] User -> Page: clicks; Page -> [store] Storage" [--before] [--clear]
flow change <flow> --before "<how it was>" --after "<how it is now>" | --clear
flow summary <flow> "<markdown>" [--commit <sha>]... [--diff <worktree>]...
flow test-step <flow> "<do this>" --expect "<you should see>" [--shot <path>] [--id t3] [--replace]
flow test-clear <flow>
flow hand-step <flow> "<do this>" --expect "<you should see>" [--where "<path or click path>"] [--copy "<value to paste>"] [--why "..."] [--id h3] [--replace]
flow hand-clear <flow>
flow say <flow> "<what was done>" [--why "<the reason>"] [--who "<label>"] [--id s2 --replace]
flow say-clear <flow>
flow pr <flow> --head <branch> --base <branch> --title "<title>" --body-file <path> | --clear
flow qa-start <flow> [--commit <sha>] [--status testing|pending]                                  # QA only
flow qa <flow> --status passed|failed --report <file.md> --commit <sha> [--summary "..."] [--shot <file>]... [--step "<do>" --expect "<see>" [--step-shot <file>]]...   # QA only
flow qa-push <flow> [--branch <b>] [--remote origin] [--repo <path>]                              # QA only
flow plan-start <flow>                                                                            # the planner only
flow plan <flow> --file <plan.md> --to "<producer>"                                               # the planner only
flow security-start <flow> [--commit <sha>]                                                       # Security only
flow security <flow> --status passed|failed --report <file.md> --commit <sha> [--summary "..."]   # Security only
flow senior-ask <flow> "<what to review>"                                                         # any agent but Senior
flow senior-start <flow>                                                                          # Senior only
flow senior <flow> pass|fail "<what was checked / what to redo>" [--steps h1,h2]                  # Senior only
term "<word>" "<plain explanation, 1 or 2 sentences, at most 300 characters>" [--more "..."] [--flow <id>]   # not under flow
```

`flow new` prints its `--by` agent's specification and rules after its usual line, and `flow qa-start` the QA
label's, so every agent reads them at the start of every request (nothing extra when there are none; see Agents,
Settings below).

`say` and `say-clear` write the story (see "Plain story, marked words, and the glossary" above); `term`
defines a word the agent marked, for free, in `data/glossary.json`.

`ask` takes `--why`, the reason the page shows under the question. It is not required, so older briefs and
`decide` keep working, but an ask without one still goes in and prints a warning on stderr (exit code 0), and
`write` warns about each ask in the file with no `why`, by id. Without a why the page can only say
`Part of <flow title>, after: <the step the ask follows>`, drawn fainter.

The output commands fill the **Output** storyboard, the flow's `output` block. `result` appends a screenshot of the
result, copied as `<flow>/out-<name>`; with `--before` it is a screenshot of how it looked before the change
(`when: "before"` on the shot), the half the page pairs with a result shot. `change` says how it was and how it
is now, one plain line each of at most 140 characters (`output.change`, `--clear` removes it), and
`diagram --before` draws how it worked before (`output.diagramBefore`; `--before --clear` removes only that one). `diagram` draws how the work works, for work with nothing to screenshot,
from one line of a small arrow language, and REPLACES the diagram each time (`--clear` removes it):

- statements are split by `;` or new lines; each is `A -> B`, `A -> B: label` (the label of the arrow into
  `B`), a chain `A -> B -> C` (each part may carry its own `: label`), or a lone `A` that only declares a box;
- a kind in square brackets before a label sets its shape: `[actor]` a person or outside system (a pill),
  `[store]` data at rest (a box with a second top line), `[decision]` (a diamond), `[box]` (the default);
- the same label is the same box (ignoring case and spaces); ids are slugs of the labels;
- keep it high level: at most 8 boxes and 10 arrows, a box name of at most 32 characters and an arrow label
  of at most 24. A longer one is refused and says why (`keep it high level: at most 8 boxes (this has 11)`),
  like every parse error, one line each, with exit code 1.

```
flow diagram acme-report "[actor] Scheduler -> Report job: every night; Report job -> [store] Reports: saves; Report job -> [actor] Team: emails" --by "Agent 3"
```
 `summary` sets the summary (Markdown, up to 4000 characters) and
replaces the list of changes with the commits and diffs given (repeat `--commit` and `--diff`, or
comma-separate them). `test-step` appends a step with ids `t1`, `t2`… (`do` and `expect` up to 500 characters
each), its screenshot copied as `<flow>/out-<id>-<name>`; `--id t2 --replace` rewrites one step (keeping its
old screenshot unless `--shot` is given), and `test-clear` empties the list to record it again. Run them one
at a time, never in parallel: each rewrites the flow file. A screenshot ref is always one file in the flow's own
evidence folder (`<flow>/<name>`); a hand-written file that points anywhere else is refused. A worked
example, after a dark mode change:

```
flow result dark-mode --shot after.png --caption "Settings in dark mode, the moon switch on" --by "Agent 3"
flow summary dark-mode "Every colour is now a **theme token**, so one switch changes the whole page." --commit ab12cd3 --by "Agent 3"
flow test-step dark-mode "Open Settings and click the moon next to Theme." --expect "The page turns dark at once." --shot moon.png --by "Agent 3"
flow test-step dark-mode "Reload the page." --expect "It is still dark." --shot reload.png --by "Agent 3"
```

`hand-step` records work only the user can do (a human decision, CI/CD, cloud setup, a console setting) as an
ordered checklist on the flow's `hand` block (`hand-steps.mjs`): what to do (200 characters, one line), what they
should see when it worked (`--expect`, 200), the exact place (`--where`, 300), a value to paste shown with a Copy
button (`--copy`, 2000, may run over several lines) and why (`--why`, 160), at most 20 steps with ids `h1`, `h2`….
The agent records the steps and stops; it never runs that work. The user ticks each step on the flow's page (each
tick is `{ by: 'you', at }`, kept through a reload and an agent rewrite only while the step asks the same thing),
and once all are ticked marks the flow done. `--id h2 --replace` rewrites one; `hand-clear` empties them.

`flow show` prints the JSON alone on stdout (so `flow show x > x.json`, an edit, then `flow write x.json`
round-trips) and an Output block on stderr: it counts the result shots, the diagram's boxes and arrows (or says
the flow still needs a visual), says whether there is a summary, lists
the test steps (marking any with no screenshot), and says when you asked for test steps that have not come, or
that the request was not sent. `flow write` with a file that has no `output` keeps the stored storyboard whole;
`"output": {}` clears it on purpose. The request fields are the server's, like an answer, and a rewrite always
keeps them from the stored file: `output.requestedAt` (when you pressed the button), `requestSentAt` (the relay
delivered it) and `requestError` (it did not, or the dashboard restarted before it went; the page then says
`not sent` with the reason on hover, and **Ask again** sends a new one).

`pr` records the pull request the work becomes, for you to send (`output.merge`): the branch, the base, a
plain-English title of at most 120 characters on one line, and the body from a file (Markdown, at most 6000
characters) that follows the repo's own pull request template. A title or body line that credits an AI tool
(a `Co-Authored-By:` line, `Generated with`, or naming one) is refused with the line it found. The agent never
pushes or opens the pull request itself: it hands the flow to QA, which pushes the branch once it passes. What the server opened is `output.pr`, the server's like an answer:
no command sets it and a rewrite always keeps it from the stored file. `flow show` says
`send: feature/dark-mode -> dev, not sent` or `send: PR #12 open, checks passing`.

`flow write` is the fast path: an agent that already knows its plan writes the whole flow at once, then uses
`status` and `evidence` as it goes. A rewrite keeps your answer to an ask only while its question, kind, yes and
no are unchanged, and your tick only while the step title is the same and its old evidence is still there.
Screenshots from a browser are saved first, then attached with `flow evidence … --shot`, which copies each as
`<flow>/<node>-<name>` (numbered when taken, so two `shot.png` files never collide); the dashboard serves them
read-only at `/evidence/…`, images and video only (and text, PDF, and a QA report: see QA and the pipeline).

The other commands, from any shell:

```
node tools/factory.mjs mark ABC-123 reviewed --verdict check --note "what is left"
node tools/factory.mjs mark ABC-123 needs-review|no-code|not-codebase
node tools/factory.mjs decide --ticket ABC-123 --question "..." --why "..." --yes "..." --no "..."
node tools/factory.mjs show ABC-123
```

`decide` is the old command, kept so older briefs still work: it becomes a `flow ask` on a new one-ask flow, an
`ask` flow.

### Flow types and routes

Every request the dashboard sees is a flow, and every flow has a **route**: the sequence of pipeline steps it is
planned to pass through, from the **Request** to the **Output**. The flow file is the source of truth for that
request: its route is stored on it, and where it stands along the route is worked out on read from the flow alone.
The three **flow types are new** (they were added with routes), built only from the request kinds and agents that
already existed:

| Type | What it is | Route | Covers |
| --- | --- | --- | --- |
| `build` | a code change | Request -> the coordinator -> the producer -> QA -> Push -> Output; the coordinator building its own change goes Request -> coordinator -> QA -> Push -> Output (its `own changes` edge) | a tracker ticket passed to an agent from the Tickets page; a change asked of the coordinator (Master) |
| `review` | a code review of a tracker ticket, recorded as a review mark | Request -> the chat agent (Independent) -> Output | **Review the code with Independent** on the Tickets page |
| `ask` | a question, an explanation or an investigation one agent answers with no code change | Request -> that agent -> Output (a producer is reached through the coordinator, as the graph says) | the Ask drawer, **Explain this ticket**, the old `decide` command |

Answers to asks, **Request test steps**, the QA rework loop and term questions are not request types: they happen
inside a flow that already exists. The chat agent (`factory.chat.name`) is a node of the graph for this, with role
`chat`, taking requests straight from the Request and ending at the Output; rework never goes to it.

**The route block** (`flow.route`, optional on the file, `flow-route.mjs`):

```
route: { type: build|review|ask, steps: [node ids in planned order, starting request and ending outcome],
         at, by, history?: [{ type, steps, at, by }, ...the earlier routes, oldest first, at most 20] }
```

- `flow new <id> "<title>" --type build|review|ask` sets it, planned for the flow's own agent (`--by`). Without
  `--type` it is refused in one line that names the three types; so is a type the agent has no route for (a review
  is the chat agent's; the chat agent builds nothing; QA records its work on the flow it tests and has no route of
  its own). An agent that is not on the pipeline works through the coordinator, as `stageOf` places it.
- `flow write` takes `"route": { "type": "build" }` (the steps are planned for its agent) or full `steps`, which must
  be nodes of the current graph, in an order the graph's edges allow (never a rework edge), each once; a build must
  pass QA and Push, a review the chat agent. A NEW flow written with no route is refused. A rewrite keeps the
  stored route whatever the file says (with a warning when it brought another one), the way the server keeps
  `output.pr` and QA keeps `qa`; a flow from before routes needs none and may be given one.
- `flow route <flow> --type build|review|ask --by <label>` is the one way to change it: it plans again for the
  flow's agent, and the old route goes into `route.history`, so a changed plan stays visible.
- `flow show` says it on stderr: `route: build, Request -> Master -> Agent 3 -> QA -> Push -> Output; now at QA
  (testing)`, or that an older flow's route is inferred and how to set it.
- `validateFlow` checks the shape only (never the graph, so a config change never turns a stored flow invalid);
  the graph is checked when an agent sets a route.

**Progress** (`routeProgress(flow, graph)`) is derived on read: `[{ node, label, role, state, visits, status? }]`,
one per route step, `state` one of **done**, **current**, **upcoming** or **skipped**. It lays `stageOf` (below) over
the planned steps: the steps before where the flow stands are done (or skipped when it went round them, like QA and
Push for a build that changed no code), the step it stands on is current (with the stage's `status`: working,
blocked, waiting, pending, testing, rework or failed), the rest upcoming. `visits` counts how often the flow was at a
step, so a rework loop shows (`Agent 3 ×2`). A flow that reached the Output has every step done or skipped and no
current step; a dropped flow has no current step either (what it got through is done, the rest skipped). A done flow
that changed code and has no QA record is current at QA, waiting: done is not tested. A stage outside the route (an
ask flow that left a commit behind) is read as at the end once done, else at the furthest planned step it reached.

**Older flows** with no route get an **inferred** one on read, never written to the file: `build` when the flow
changed code or QA has it (never for the chat agent), `ask` otherwise, with its own agent, flagged
`inferred: true`. An open flow on an inferred route shows a quiet `route not set` on its card and head until its
agent runs `flow route`.

`GET /api/flows`, `GET /api/flows/<id>`, `GET /api/pipeline` and `GET /api/qa` all carry each flow's `route` (stored,
or inferred with `inferred: true`) and `progress`. Every page reads those; none works its own path or stage out.

**Nothing outside a defined flow:** `flow new` needs `--type`, a new `flow write` needs a route, `decide` creates
an `ask` flow, the Tickets page tells the chat agent which flow type each action starts, the chat brief and the
agent brief say a flow comes first, the board flags an inferred route, and the opt-in stop check (below) holds a
committing agent until its told flow has a route. The limits: an agent that never runs a flow command is not
stopped by any of this (the stop check only runs where you install it, and only for an agent that committed), and
an agent with a shell can still write a flow file by hand (it is then validated on read).


### QA and the pipeline

Who hands work to whom is ONE graph, `pipeline.mjs`, drawn from config.json (`coordinator`, `codingAgents` and
`pipeline`):

```
Request -> Coordinator -> Agent 1 | Agent 2 | Agent 3 -> QA -> Push -> Output
```

The coordinator hands each request out; the producers (Agent 1, 2, 3) write the code; **QA** is the last stage
before the push for every flow that changed code, and the only agent that pushes. A flow changed code when a step
has commit or diff evidence, its summary lists a commit or diff, or it recorded a pull request (`flow pr`). A flow
that changed none (an investigation, a plan, an ask) goes to the **Human task** box (the user) and on to the
Output: it waits there only when it has by-hand steps (see Human task and Senior). The chat agent (Independent) sits
beside the coordinator: it takes questions, explanations and reviews straight from the Request and its work ends at
the Output. The end node keeps its id `outcome` (stored paths and routes name it); its label reads **Output**.

1. A producer finishes, records `flow pr`, and messages QA (its brief says so; it never pushes).
2. QA runs `flow qa-start`, runs the repo's tests and Playwright checks of the change with screenshots, writes a
   short Markdown report, and records `flow qa … --status passed|failed`. Its brief is `docs/qa-agent-brief.md`.
3. **Passed**: the flow is done. QA runs `flow qa-push`, which checks the tested commit is in the repo, then runs
   `git -C <repo> push <remote> <sha>:refs/heads/<branch>` with that full sha: never forced, no `+`, no tags, never
   retried, never a branch in `pipeline.protectedBranches`, `pr.protect` or `pr.bases`, or `HEAD` (any case). With a
   recorded pull request the branch defaults to, and must be, its head. It records `qa.pushedAt`, or `qa.pushError`
   with the reason. You then open the pull request with **Send** and your PIN, as before: Send now refuses a flow
   that changed code unless QA passed it at the very commit being sent.
4. **Failed**: the flow goes back to the producer that made the change (the flow's agent). The dashboard notices
   the failure within 15 seconds and sends that agent ONE relay message (about $0.30): the flow, the attempt, QA's
   summary, and the absolute paths of the report and screenshots, asking it to fix the change and ask QA to test
   again. The result is `qa.rework.sentAt`, or `qa.rework.error` when it could not be delivered. A failure queued
   when the dashboard stopped is marked `not sent: the dashboard restarted` and never sent again on its own;
   `POST /api/flows/<id>/rework` sends it again. A failure QA recorded while the dashboard was down was never
   queued, so it is sent once the dashboard is back.
5. **Stopped**: a failure whose agent is not a producer, or a flow that already went back `pipeline.maxReworks`
   times, becomes `qa-failed`: the flow is **blocked** and nothing is sent. You decide what happens next.

The QA commands run only with `--by` equal to `pipeline.qa`. A flow's `qa` block is QA's, as `output.pr` is the
server's: no other command writes it, and a producer's `flow write` keeps it from the stored file, so no producer
can drop a failure or forge a pass:

```
qa: { status: pending|testing|passed|failed|qa-failed, attempt, by, startedAt, at, commit, report, shots, steps:
      [{ do, expect, shot? }], summary, branch, remote, repo, pushedAt, pushError,
      rework: { to, queuedAt, sentAt, error } | null, attempts: [the earlier attempts, oldest first] }
```

`qa-start` begins attempt n+1 (the last result moves into `attempts`), or updates the same attempt before a
result is in; it opens a done or blocked flow again and refuses a dropped one. `qa` copies the report into the
flow's evidence folder as `<flow>/qa-<n>-report.md` (a `.md` or `.txt` file; HTML is refused), the screenshots as
`<flow>/qa-<n>-<name>` and the step shots as `<flow>/qa-<n>-step<i>-<name>`, exactly like `flow result --shot`.
`/evidence/` serves a QA report as `text/plain` with `nosniff`, so nothing in it is ever rendered or run; any other
`.md` and every `.html` stays a 404. `flow show` says where QA stands (`qa: failed, attempt 1 at cd34ef5, back to
Agent 3 (sent)`).

#### The planner and Security

Two optional agents, each an ordinary Claude Code session you open in the editor, matched to its label through
`codingAgents` like the producers, and each drawn only when `pipeline.planner` or `pipeline.security` names it (a
label that is already the coordinator, QA, a producer or the chat agent draws no second box). Neither is ever a
producer. Both always run on Opus at high effort: the dashboard cannot switch an editor session, so their window on
the Agents page shows it as fixed, their print says it every time they start, and the window warns when the
session's newest reply ran on another model.

```
Request -> Coordinator -> Planner -> Agent 1 | Agent 2 | Agent 3 -> QA -> Security -> Push -> Output
```

- **The planner** (`docs/planner-agent-brief.md`, the skill `/superpowers:writing-plans`) sits between the
  coordinator and the producers. It plans and hands out tasks and writes no code: `flow plan-start` (the flow stands
  on the planner), then `flow plan <flow> --file plan.md --to "Agent 1"`, which copies the plan into the flow's
  evidence as `<flow>/plan-<n>.md`, makes the flow that producer's (its answers and any failure go to it), and plans
  a build route again through the planner. The record is `flow.plan = { status: planning|handed, by, startedAt, at,
  to, file, history }` (`flow-plan.mjs`), the planner's alone. The coordinator's own changes still go straight to QA.
- **Security** (`docs/security-agent-brief.md`, the skill `/superpowers:requesting-code-review`) sits after QA. A QA
  pass no longer finishes the flow: Security reviews the very commit QA passed with `flow security-start` and
  `flow security <flow> --status passed|failed --report security.md --commit <sha>`. Its verdict lives in the QA
  attempt it reviewed (`qa.security`, `flow-security.mjs`), so a new QA attempt needs a new review. A pass finishes
  the flow; `flow qa-push` and Send refuse, with one plain sentence, until Security passed that same commit. A failure
  goes back to the producer by the same relay path as a QA failure (`qa.security.rework`), and QA and Security
  failures share the one `pipeline.maxReworks`; past it the flow stops (`security-failed`, blocked). Security never
  pushes and never changes the code: it reports, and the producer fixes.
- A build route (`flow new --type build`) goes through both when they are configured; review and ask routes do not
  change. The scorecard counts a Security failure as caught; with Security a code flow is delivered only when QA and
  Security both passed it, and finished without a Security pass it slipped through. The Log tags Security verdicts
  (`security`) and the planner's hand-outs (`planned`) as their own kinds, with Plans and Security filters.

#### Human task and Senior

The **Human task** box (node id `human`, role `human`) is always drawn: it is the user, not an agent, so it has no
settings window and no model. Every `no code changes` edge of the coordinator and the producers ends there (one
label, on the outermost lane); the chat agent's still ends at the Output. With **Senior** (`pipeline.senior`, a
dashboard label; null or left out is none) the graph goes on:

```
... -> Agent 1 | Agent 2 | Agent 3 -> Human task -> Senior -> Output      (no code changes)
                                       ^-- redo --'
```

Without Senior, Human task goes straight to the Output (`done by hand`). Senior is never a producer, its id is taken
after every other agent's, and it always runs on Opus at high effort (`docs/senior-agent-brief.md`). It reviews work
with no code to test: CI/CD setup, cloud console changes, commands run in a terminal, settings in a third-party
account. It never runs Terraform and never changes a live project itself.

- A no-code flow with **no by-hand steps** passes both boxes and ends at the Output exactly as before: an answer or
  an investigation never waits on anyone (its route shows them as skipped).
- A flow **with by-hand steps** (`flow hand-step`) waits at Human task until the user ticked every step; then, with
  Senior, it waits at Senior (`flow senior-start`, then `flow senior <flow> pass|fail "<text>" [--steps h1,h2]`).
  A pass finishes the flow. A fail sends it back to Human task: the named steps (all when none is named) are
  unticked, the text shows at the top of the flow's by-hand checklist and in Human review, and once ticked again it
  waits at Senior. Senior failures share `pipeline.maxReworks`; past it the flow stops (`senior-failed`, blocked).
- An agent can send a no-code flow to Senior on purpose: `flow senior-ask <flow> "<what to review>"` (a CI change made
  through a web console with its own tools, say).
- The record is `flow.senior = { status: asked|reviewing|passed|failed|senior-failed, by, startedAt, at, ask, summary,
  redo, history }` (`flow-senior.mjs`), written only by the Senior commands; only the Senior label may record a
  review. With Senior on, the flow page offers no Mark the flow done for such a flow, and the status route refuses
  done until Senior passed it.
- The scorecard counts a flow Senior gates as delivered only at Senior's pass, and each Senior failure as caught;
  flows finished before Senior existed are judged as before. The Log shows each Senior review start and verdict
  (kind `senior`, with a Senior filter).
- Stored routes that go straight from an agent to `outcome` still read and check as before (the graph makes that hop
  through the by-hand boxes); a new ask route names Human task (and Senior).

Where each flow stands is derived, never stored (`stageOf`): a dropped flow has no node; an open one sits on its
agent (an agent not in the graph sits on the coordinator; the chat agent's flow sits on the chat agent, straight from
the Request, and is at the Output once done); a done one that changed no code is at the Output past Human task (with
by-hand steps it waits at Human task, then Senior, as above), and one that did waits on QA; pending and testing sit on QA; a failure sent back sits on its producer
(`rework`); `qa-failed` sits on QA (`failed`); passed and not pushed sits on Push (`failed` when the push was
refused); passed and pushed is the Output. The path lists every node the flow went through, one QA visit per
attempt and one producer visit per rework.

Routes:

- `GET /api/pipeline` returns `{ graph: { nodes: [{ id, kind: start|agent|step|end, label, role:
  request|coordinator|producer|chat|qa|push|outcome }], edges: [{ from, to, label?, kind: main|branch|rework|skip }] },
  tickets: [{ id, title, agent, tickets, status, stage: { node, status, path, reworks }, route, progress, qa, codeProducing,
  hasOutput, archived, updatedAt }], builtAt }`. Open and blocked flows always, done and dropped ones changed in the
  last 14 days, archived ones flagged, deleted ones never. `qa` is the current attempt in full and the earlier ones as
  an outline. Node ids are slugs of the labels (`agent-1`); the edges also carry the coordinator's own changes going
  to QA and its `no code changes` skip.
- `GET /api/qa[?status=passed]` returns `{ qa: <label>, flows: [{ id, title, agent, tickets, status, archived,
  updatedAt, stage, route, progress, qa, report: { ref, url, text, truncated } | null, shots: [{ ref, url }], links: { repo, commit,
  branch } }], remotes: { repo, dashboard }, builtAt }`, for a QA page: every flow QA recorded, newest first (at most
  100), with the report text (at most 64 KB) and the GitHub pages of the tested commit and the pushed branch, read
  from `git remote get-url` (github.com https and `git@` addresses; anything else is null; never the raw address,
  which may hold a token). The links name the repo that holds the tested commit: `qa.repo` when QA pushed with
  `--repo`, else the watched repo when `git cat-file -e <sha>^{commit}` finds it there, else the dashboard's own
  folder (its origin), else no commit or branch link. Which repo holds a commit is remembered per sha.
- `POST /api/flows/<id>/rework` sends a failure back again after it was not delivered.
- `GET /api/agents/rules` returns `{ agents: { "<label>": { spec, rules: [{ id, text, addedAt }], updatedAt } }, changes:
  { "<label>": [{ at, text }] }, limits: { spec: 2000, rule: 300, rules: 30 } }` for every agent of the graph now (the
  coordinator, the producers, the chat agent, QA), with an empty spec and no rules when none are saved; `changes` is
  each agent's last ten saved changes, newest first, each one plain sentence.
- `PUT /api/agents/rules/<label>` (the label URL-encoded) with `{ spec?: string, rules?: [string] }` replaces what is
  given and returns `{ ok, label, agent, changes }`. Only from the dashboard page (its own Origin, never a missing one); 404 for
  a label that is not an agent of the graph; 400 `{ error: "<plain sentence>" }` for a limit problem. A rule whose
  text did not change keeps its id. Stored in `data/agent-rules.json` (`agent-rules.mjs`); rules of a label that
  left the graph stay in the file, unshown. Every save that changed something adds one line to
  `data/agent-rules-log.jsonl` (`{ at, label, spec: set|changed|cleared|null, added: [text], removed: [text] }`,
  append-only, written after the store, the newest 500 kept); a save that changed nothing writes no line and leaves
  the store as it was. `agent-rules.mjs` also exports `rulesText(store, graph)` (every agent's specification and rules
  as plain text), `readLog()` and `ruleEvents(lines, { now, days })` (the log as events, newest first:
  `{ at, kind: 'rule', agent, flow: null, cell: null, text }`).
- `GET /api/agents/settings` returns `{ agents: { "<label>": { role, model, effort, fixed, files: [{ id, title, kind:
  file|note, name, chars, on, addedAt }], chars, updatedAt } }, changes: { "<label>": [{ at, text }] }, models, efforts,
  fixed, limits: { chars: 20000, files: 20, total: 60000, title: 100 }, chat: { model } }`: what the user set in each
  agent's window (`agent-settings.mjs`, `data/agent-settings.json`). `PUT /api/agents/settings/<label>` with
  `{ model?, effort? }` (null clears one; the planner, Security and the chat agent refuse), `POST /api/agents/files/<label>`
  with `{ title, text, kind: file|note, name? }`, and `PUT` (`{ on }`) or `DELETE /api/agents/files/<label>/<id>`
  change it, each only from the dashboard page (its own Origin), each refusal one plain sentence (text only, 20,000
  characters each, 20 per agent, 60,000 in all). Every change adds one sentence to `data/agent-settings-log.jsonl`,
  shown under Changes. What is saved is printed to the agent after its rules (`flow new`, `flow qa-start`,
  `flow plan-start`, `flow security-start`, `flow rules`): the wanted model and effort in one sentence, then each
  switched-on file or note under its title, cut with a visible `[cut: N more characters]` line past 60,000.
- `GET /api/score[?days=7|30|all]` returns the pipeline scorecard (`score.mjs`) over every flow file, archived ones
  too: `{ window: { days, from, stallDays }, counts: { delivered, slipped, missed, caught }, lists: { slipped: [{ id,
  title }], missed: [{ id, title, why: dropped|stopped|stalled }] }, precision, recall, accuracy (each { value, top,
  bottom }), f: { 1: { value, beta }, 4: { value, beta } }, correctness: { value, right, judged }, agents: [{ label,
  handed, firstTime, sentBack }], inFlight, builtAt }`. A value is null when its bottom number is 0. Left out, the
  window is 30 days; any other value is a 400 with one plain sentence.
- `GET /api/log[?days=7|30|all&cell=delivered|caught|missed|slipped&kind=<kind>]` returns `{ events: [{ at, kind,
  flow: { id, title } | null, agent, text, cell }], total, window, builtAt }`: the orchestration log (`score-log.mjs`),
  newest first, at most 300 events (`total` counts every match). `kind` is started, route, handed, passed, failed,
  pushed, done, dropped, stopped, stalled or rule. `cell` marks the event that put a count in that scorecard cell,
  from the same rule as `/api/score` (`score.mjs cellOf`), so the `total` for each cell equals that window's count.
  Left out, the window is 30 days; a bad window, cell or kind is a 400 with one plain sentence.
- `GET /api/time[?days=7|30|all]` returns Pipeline time (`time-stats.mjs`, `time-stages.mjs`) over the same flow
  files, never cached: `{ window: { days, from, to, dayCount, bucket: day|week, activeHours, clockHours }, finished:
  { tickets, jobs, flows }, rates: { perDay, perHour, perClockHour }, took: { median, mean, fastest, slowest, flows },
  waiting: { median, mean, share, flows, undated }, stages: [{ key, label, median, mean, flows, undated }], bars: [{
  day, count }], agents: [{ label, tickets, jobs, flows, median, perDay, sentBack }], left: { slipped, dropped,
  stopped, stalled }, fewer, builtAt }`. Times are ms; a number with nothing to count is null. The period is whole
  local days (7 or 30 to today; All from the first flow event). A bad window is the score's 400.
- `GET /api/tokens[?days=7|30|all]` returns Pipeline tokens (`token-usage.mjs`, `token-index.mjs`,
  `token-routes.mjs`), never cached and never waiting on the transcripts: `{ window, totals: { input, output,
  cacheWrite, cacheRead, all, responses }, cost: { usd, unpriced, unpricedTokens, w1hAtWriteRate }, perJob: { jobs,
  tickets, otherJobs, tokens, usd } | null, cacheShare, spend: { usd, turns }, agents: [{ label, sessions, input,
  output, cacheWrite, cacheRead, all, responses, usd, unpriced, share, models, subs: { files, ..., usd } }], models:
  [{ model, ..., cacheWrite5m, cacheWrite1h, usd, price: { match, input, output, cacheWrite, cacheWrite1h, cacheRead } | null }], bars: [{ day,
  tokens, usd }], skipped, dupes, special, files, building, progress, prices: { source, errors, given }, builtAt,
  lastRead }`. Dollars are null with no price; `building` is true with a `progress` from 0 to 1 until the first read
  of the transcripts is done. A bad window is the score's 400.

Each agent on `/api/status` carries `pushesOutsideQa`: how many `git push` commands it ran in the last 24 hours,
read from the same transcript scan (0 for QA), so a page can flag a push that did not go through QA.

### The stop check

`tools/flow-gate.mjs` is a small script for a Claude Code **Stop** or **SubagentStop** hook: an agent that
made a git commit is not let go until its work is told. The hook hands it its JSON on stdin
(`transcript_path`, `stop_hook_active`, and `agent_id` for a subagent). When the agent committed in that
transcript and no flow of its own has both a story (`flow say`) and a visual (`flow result` or
`flow diagram`), it prints

```
{"decision":"block","reason":"Record your flow before finishing: flow say, flow diagram or flow result, flow test-step (node <abs path>/tools/factory.mjs flow ... --by \"<its name>\")."}
```

and Claude Code gives the agent that reason instead of stopping. When its flow is told but has no route (a flow
from before routes), the reason is to set it, in the same style:

```
{"decision":"block","reason":"Set your flow's route before finishing: flow route <flow> --type build|review|ask (node <abs path>/tools/factory.mjs flow ... --by \"<its name>\")."}
```

It still fails open, as below. The name is the one its card goes by, so the
flow links to it: a subagent's task name, a session's name from the harness's session list, else a name it
already signed a flow with; with none of those the line ends at `flow ...).` A flow is the agent's own when its agent is
a name the agent passed as `--by` (or `FACTORY_BY`), for a subagent also its task name, or when the agent ran
a flow command on it. A dropped flow does not count, nor one last written before the work in the transcript
began.

It never blocks when `stop_hook_active` is true (the agent was already sent back once, so one reminder is
all it gets), when nothing was committed, or on any error: bad input, a transcript it cannot read, a missing
`config.json`. It always exits 0 and prints nothing else, so a broken check never traps an agent. It only
reads (the tail of the transcript, a subagent's meta file and `data/flows`), runs no model and costs nothing.

**This repo does not install it.** To turn it on, add it yourself to the settings file of the repo your
agents work in (`.claude/settings.json` there, or your user settings), with the absolute path of this
dashboard:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node C:/path/to/yz-agent-orchestration/tools/flow-gate.mjs" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node C:/path/to/yz-agent-orchestration/tools/flow-gate.mjs" }] }
    ]
  }
}
```

Use only `SubagentStop` to hold subagents to it and leave your own sessions alone. To try it without a hook:
`echo '{"transcript_path":"<a session .jsonl>","stop_hook_active":false}' | node tools/flow-gate.mjs`.

### Sessions waiting on you (the waiting hook)

The dashboard only sees a question an agent writes down (`flow ask`). A session that simply stopped, for a
permission prompt or for your reply in its terminal, was invisible. `tools/waiting-hook.mjs` is a small script
for Claude Code **Notification**, **PermissionRequest** and **Stop** hooks that fixes that (the VS Code extension sends
no Notification, so the other two carry it there: a permission dialog, and a reply that ends with a question): each time a session stops to wait on you, it records
the session, why and when in `data/waiting/<session>.json` (one file per session) (`waiting.mjs`). The dashboard then shows it:

- the session's card (Home and the Agents page) gets an amber edge and a line above its Now line:
  **Needs your OK:** (a permission prompt) or **Asked you:** (its last reply ended with a question);
- **Human review** gets a row of kind **Session** (a **Sessions** chip filters them); its title opens that
  session's live view, where you can see what it asked;
- the page head's `N waiting on you`, the rail's Agents count and Home's line count it;
- a NEW wait raises a sticky toast, and a desktop notification when the window is not in focus.

**Reply from the dashboard.** A session that asked a question gets a reply box, on its Human review row and above
Live activity on its own page. **Send** (or Enter; Shift+Enter adds a line) delivers your text to that session as ONE
message, on the relay's path (`session-replies.mjs`, `POST /api/sessions/<id>/reply`, a short paid turn that uses
SendMessage). The row then says Sending, Sent, or Not delivered with **Retry**. Only the dashboard page may send it: a
call without the page's Origin (an agent, say) is refused, so no agent can answer as you. A permission prompt has no
box: a message cannot press Approve or Deny, so it says to answer in VS Code.

A wait clears by itself: once the session's transcript gets a real user line after it (your typed reply, or the
tool result that follows an approved or denied permission), it no longer stands. Hook notes and meta lines do not
count. A closed session's wait never shows, and the hook drops waits older than a week.

An idle session counts only when its last reply ends with a question mark, the same rule the Ask chat uses, so a
session that finished its work and went quiet is not "waiting". A question phrased without one is missed: for
decisions an agent needs while it keeps working, it should still record a `flow ask`.

Add it to your user settings (`~/.claude/settings.json`), next to any hooks you already have on those events:

```json
{
  "hooks": {
    "Notification": [{ "hooks": [{ "type": "command", "command": "node <path to this clone>/tools/waiting-hook.mjs" }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "node <path to this clone>/tools/waiting-hook.mjs" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node <path to this clone>/tools/waiting-hook.mjs" }] }]
  }
}
```

It fails open: bad input, an unreadable transcript or any error exits 0 with no output, so it never gets in a
session's way. To try it without a hook:
`echo '{"session_id":"x","transcript_path":"<a session .jsonl>","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}' | node tools/waiting-hook.mjs`.

### Questions answered in the chat (the open-asks hook)

You often answer an agent's `flow ask` in its chat instead of on the dashboard. Only the agent can tell whether a
message answers one, so `tools/open-asks-hook.mjs` (a `UserPromptSubmit` hook) reminds it: each time you send a
session a message, the session gets a short note listing its asks that still wait (asks on open flows whose agent
is the session's name, from the harness's session registry), with the command that records a chat answer:

```
flow answered <flow> <node> --answer yes|no|"<text>" --note "<the user's words>"
```

The ask then leaves Human review, the flow's story says "Answered in the chat", and the chart and drawer show
"answered in chat" where a delivery state would be. The relay never sends it back, since the agent already has the
answer. Only an OPEN ask can be recorded this way: an answer you gave on the dashboard is never overwritten, and
answering or reopening it on the dashboard replaces the chat record. A session with no open asks gets no note.

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node <path to this clone>/tools/open-asks-hook.mjs" }] }]
  }
}
```

It fails open like the waiting hook: any error exits 0 with no output, so your message always goes through. To
try it: `echo '{"session_id":"<a live session id>"}' | node tools/open-asks-hook.mjs`.

### Collections by kind

A collection is any list of tickets, from any tracker or none. Every collection ends up as
`data/sources/<id>.json` in one shape,
`{ fetchedAt, me, tickets: { ID: { id, title, state, column, owner: "me|other|none", order, labels, url } } }`,
and the grid, the table, the marks and the plan all read only that file. The server cannot call a tracker
itself: the refresh button (and the timer) runs one short headless Claude turn, and how the file gets written
depends on the collection's `kind`:

- `kind: "switchboard"`: the turn calls the one listed MCP tool and returns the path of what it saved; a Node
  converter (`sources/switchboard.mjs`) builds the file. The model never writes ticket data, so nothing can be
  dropped or misstated. Safe on the timer.
- `kind: "agent"`, for trackers with no converter: the turn gets the collection's `ask` and the instruction to
  write the file, with exactly the tools the collection lists in `tools` plus a write to its own source file.
  For a board only a browser can read, or a new tracker (Linear, GitHub) until someone writes a converter.

```json
{ "id": "main", "name": "Main board", "kind": "switchboard",
  "project": "YOUR_PROJECT_ID", "tools": ["mcp__switchboard-claude__list_stories"],
  "filter": { "prefix": "ABC", "range": [100, 199], "extras": [] },
  "plan": "C:/path/to/your-repo/docs/plan.md", "refreshMinutes": 20 }
{ "id": "beta", "name": "Beta board", "kind": "agent",
  "ask": "Open https://example.com/board in the browser and read every card (id, title, column, owner).",
  "tools": ["mcp__playwright__*"], "refreshMinutes": 0 }
```

**The timer rule:** `refreshMinutes` is per collection (0 means the button only). A collection whose `tools`
include anything that can act (the browser tools, or any tool not matching `list_*`, `get_*`, `search_*` or
`read_*`) refreshes by button only: the server refuses a timer on it at load and says why. `filter` (a prefix,
an id range, extra ids) is optional; without it the collection is whatever the source returns. `plan` is an
optional markdown plan whose tables start with the ticket id. A converter for a new tracker is one small module
under `sources/` that turns that tool's output into the shape above.

Changing a tracker (deliver, comment, assign) is not a dashboard feature: an agent puts it to you as an ask,
and after Yes does it with its own tools.

### Accounts, data and safety

Sessions are read from `~/.claude`, from `CLAUDE_CONFIG_DIR` if the server runs under one, and from every folder
in `claudeDirs` (a second account, for example), so agents on two accounts show side by side.

Flows, evidence, ticket sources, marks and the chat transcript live in `data/` (git-ignored). Only same-origin
POSTs are accepted, so another website cannot drive the agents. The old global `claude` on PATH may be too old
for new models, so headless turns use the newest Claude binary bundled with an IDE extension (`claudeBin`
overrides it).

## Assumptions about your repo and tracker

- **Ticket ids.** Set `ticketPrefixes` in `config.json` (for example `["ABC", "XYZ"]`). Then only those
  prefixes count, in any case: `ABC-123` or `abc-123` in commit subjects, tool calls and paths, and `abc-123`
  anywhere in a branch name, where more numbers after it are more tickets (`fix/abc-120-122-login` is ABC-120
  and ABC-122). The ticket list ranks tickets in that prefix order. Left out, the prefixes are the collection
  filters plus the prefixes of the ids in `data/sources/*.json`.
- **No prefixes known** (`ticketPrefixes: []`, or no collections or sources yet): a generic guess
  (`ticket-ids.mjs`). In text, an upper-case prefix of letters, a dash and a number without a leading zero; in a
  branch name, the same at the start of a path segment only. Standards, runtimes and step words (`UTF-8`,
  `HTTP-2`, `CVE-2024`, `GPT-4`, `node-20`, `step-2`, `release-2026-11`) are left out. Its limits:
  lower-case ids in text never count, an id in the middle of a branch segment (`feat/login-abc-12`) is missed,
  and an unusual word with a number can still read as a ticket. Set `ticketPrefixes` to avoid all three.
- File paths are shown relative to the watched repo, by its folder name (the last part of `repo`).

Still fixed in code, and next on the list to move into `config.json`:

- The only ticket converter is for Switchboard (`sources/switchboard.mjs`); any other tracker is an `agent` collection until it has one.

## Where the data comes from

| What | Source | How fresh |
| --- | --- | --- |
| Worktrees, branches, uncommitted files, ahead/behind | `git` in the repo and each worktree, with `GIT_OPTIONAL_LOCKS=0` so it never takes a lock | every build (at most once per 45 s) |
| On dev / on stage | `git fetch origin` every 5 minutes, then ancestry and ticket ids in commit subjects | 5 minutes |
| Agents and what they last touched | `~/.claude/sessions/*.json` (name, status) and each session transcript: worktree paths and ticket ids in its tool calls only, not tool output | every build; transcripts are read once, then only new bytes |
| Ticket title, state, owner | `data/sources/<id>.json` of every collection, merged (see Collections by kind) | when refreshed (below) |
| Subagents, their state, worktree, tickets and final report | `~/.claude/projects/<folder>/<session>/subagents/agent-<id>.meta.json` and the last 4 MB of `agent-<id>.jsonl`, for live and ended sessions | every poll (15 s on the page, 30 s on Home), each file read once per change |
| Pull request state on a subagent card | `gh pr view --json` (read only) | at most once a minute per pull request |
| Flows, asks, evidence | `data/flows/<id>.json`, written by agents with `tools/factory.mjs flow …` | every poll (15 s) |

Read only: the only command that writes anything is `git fetch origin`
(remote-tracking refs). No checkout, stash, reset or commit, and nothing is
written inside the repo or any worktree.

## Agents (#/agents): the pipeline diagram

Under the diagram sits the **Human review** box (`human-review.js`, `GET /api/human`, `human.mjs`): everything
that cannot go on without the user, newest first, each row with the flow (or ticket) title, the agent waiting,
how long it has waited and one reason: an unanswered **question** (answered in the box with the usual controls, on
the usual answer route), **by hand** work (a flow with by-hand steps that is not finished, or an open flow for a
ticket marked `no-code` or `not-codebase`), a **blocked** flow, and a marked **ticket** no live flow carries (its
**Ask for steps**, `POST /api/tickets/<id>/request-hand`, starts `<ticket>-by-hand` with the agent that marked it,
else the coordinator, and asks for by-hand steps on the relay). Its head gives the split by kind and chips filter
it (remembered in `localStorage` `human.filter`); the rail's Agents count and the page head's `N waiting on you`
are questions plus by-hand work. It is
not a node of any route: `pipeline-view.js` hands it each layout and it places itself under every box, arrow and
label, its left and right edges on the outermost boxes, inside the canvas; with many rows it scrolls inside
itself. Its count is also on the rail's Agents entry and on Home; the page head's `N waiting on you` and
`#/agents?human` bring it into view. A title opens the flow at the question (`gotoFlow` at its node), at its
by-hand steps (`#/flows?flow=<id>&at=hand`), or the ticket on Tickets. On the Agents page no `N asks waiting`
toast is raised: the box already says it.

The Agents page draws the orchestration as a diagram, from a **Request** node to an
**Output** node, built only from the `pipeline` setting and the chat agent's name (see QA and the pipeline):
Request, the coordinator and the chat agent (Independent), each producing agent, **QA**, **Push**, Output. Arrows
follow the real order. The coordinator fans out to the producers. Dashed arrows marked
`no code changes` go to the **Human task** box (the user: `pipeline-human.js`), drawn level with Agent 1 in QA's
column, and on to the Output (`done by hand`), through **Senior** when there is one, level with it in Security's
column; the chat agent's goes straight to the Output. Human task shows what waits on the user (the Human review
split, one line per kind) and up to three flows standing there; a click or Enter on it scrolls to Human review and
focuses its heading. Return arrows marked `failed` run from QA back to each
producer (rework). It reads left to right when there is room, else top to bottom, and is
read again with every status refresh without redrawing.

- **Tickets on the nodes**: each node carries chips for the flows standing there now
  (at most 4, then `+N`). Green is passed, red is failed, sent back or stopped by QA;
  the rest are neutral. Click a chip to open its explanation (the Explain tab in Flows).
- **Click a node** for its details below the diagram. For an agent this is its card, the
  same card the old tree drew: state, what it is doing, who it last talked to, recent
  tickets and branch, Progress report and its subagents. Request, Push and Output get a
  short description. An agent that ran `git push` outside QA in the last day gets a red
  dot and the line `Pushed N times outside QA today`.
- **Click an agent** (the coordinator, the planner, a producer, QA, Security, the chat agent) and its settings
  open as a WINDOW in the middle of the screen (`agent-window.js`, `agent-window-view.js`, `agent-window.css`):
  its card, then **Model** (a Claude model and an effort, saved and told to the agent; the dashboard cannot switch
  an editor session, so you switch it there; fixed at Opus, high effort, for the planner, Security and Senior; the config
  model, read only, for the chat agent), **Subagents** (the ones running under it now, their kind and how long),
  **Specification and rules** (the editor below, moved into the window), **Files and context** (text files picked
  or dropped, and typed notes, each with a switch and Remove) and **Changes**. Esc or Close closes it; a click
  outside closes it too, unless something is not saved, and then the window asks first. The address names it
  (`#/agents?agent=Agent%201`), so it opens from a link. Request, Push and Output keep the pane.
- **The green pill** on an agent box (`3 running`) counts the subagents running under it now; it sits on the box's
  bottom edge, centred, and on its top corner as the count alone when the diagram runs top to bottom.
- **Specification and Rules**: an agent's details also show what it is for, in your words, and a numbered list of
  rules. With no specification saved, its role line stands in, marked Default. **Settings** in the head (next to
  Watch live and Close; agents only, never Request, Push or Output) turns both into an editor in place: the
  specification with a character count (at most 2,000), each rule with Remove, an **Add a rule** field (Enter
  adds; a rule is 1 to 300 characters, at most 30), Save and Cancel. Escape cancels the editor before it clears
  anything else. A failed save says so in one line and keeps what you typed. Under Rules, a quiet **Changes**
  disclosure lists the agent's last ten saved changes: when, and what changed in one sentence. The editor stays exactly as it is
  through every refresh of the page, typing, focus and cursor included. Agents read these when they start a
  request: `flow new` and `flow qa-start` print them, and `flow rules` shows them any time.
- **The side panel** slides out from the right edge (the slim tab, remembered in this
  browser). **Tickets** lists every flow with its type, its current step (`build · QA`) and its
  status, the ones needing attention first. **Outputs** lists finished ones with **Explain** (Flows) and
  **How to test** (QA). **Log** is the orchestration log (below). Select a row to light that flow's route from its own `progress`: the steps
  it has taken and the one it is on in the accent colour, a rework's return arrow too, and the steps
  still ahead as a dashed accent outline; select it again, or press Escape, to clear. The chips sit
  on each flow's current step from the same `progress`. A step clicked in a flow's head opens this
  page on that node, with that flow lit (`AgentsPage.showNode`).
- **Pipeline score**, a strip above the diagram (`score.mjs`, `GET /api/score`, `score-strip.js`, `score-view.js`):
  the whole orchestration scored the way a machine-learning model is. The pipeline makes one call on each piece of
  work, let it through to the Output or hold it back, and four counts follow:

  |                    | The work was good                                      | The work was not good                                       |
  | ------------------ | ------------------------------------------------------ | ----------------------------------------------------------- |
  | Went to the Output | **Right, delivered**: QA passed it, or it finished with no code changes | **Wrong, slipped through**: it finished with code changes QA never tested |
  | Held back          | **Wrong, missed**: dropped, stopped at QA, or no update for 7 days | **Right, caught**: each time QA failed the work (every attempt) |

  Five tiles: **Precision** (delivered over delivered plus slipped: of everything delivered, how much was checked
  and right), **Recall** (delivered over delivered plus missed: of everything that should have been delivered, how
  much was), **F-score** (both in one number; a switch picks F1, both the same, or F4, recall far more),
  **Accuracy** (delivered plus caught over all four: how often the pipeline made the right call) and
  **Correctness** (flows QA passed with no failure on the way, over flows QA passed or stopped: right the first
  time). Each tile shows the percent, the fraction it came from and its plain meaning; with nothing to count it says
  Not enough data yet. A window switch counts the last 7 days, 30 days (the default) or all time: a QA verdict by
  its own time (so a flow QA passed or stopped counts at that final verdict), a stalled flow from the day it
  stalled, any other flow by its last update; anything with no stored time is never counted. Flows still on their
  way are not counted; archived ones are, deleted ones never. **How it is counted** opens the four boxes with the live
  counts, each with **See these in the log** (the side panel opens on Log with that filter), the flows that slipped
  through or were missed (each a link to the flow), the sums, and a By agent table (handed to QA, passed first
  time, sent back). The window, F1 or F4, and the strip collapsed to one line are remembered in this browser; the
  strip is read again with the diagram.
- **Pipeline time**, a block under the score (`time-stats.mjs`, `time-stages.mjs`, `GET /api/time`, `time-strip.js`,
  `time-view.js`): how much work finishes and how long it takes, counted only from times the flow files store.
  Finished is the score's delivered cell (`score.mjs cellOf`), so the two never disagree on what finished. Five
  tiles line up under the score's: **Finished** (tickets, a ticket finished twice once, and other jobs: flows with no
  ticket), **Per day** (over the days of the period, today included), **Per hour** (over the active hours: clock hours
  in which a flow recorded an event of the Log, so idle nights do not dilute it; the round-the-clock rate beside it),
  **Time per job** (the median from createdAt to the finish over every finished flow, with the mean, fastest and slowest) and **Waiting on
  you** (each question to its answer, each by-hand step to its tick, overlaps once). Then a stacked bar of the median
  time at each stage the files can date (coordinator and planner, producer, QA, Security, Human task, Senior,
  reworks) with a table, bars of work finished per day (per week for All) with a text list and arrow keys, a By agent
  table and How it is counted, which names what cannot be dated. The period is whole local days; the score's window
  switch drives both blocks. A Minutes, Hours, Days or Auto switch sets every duration (under a minute is whole seconds in
  every unit; a fixed unit shows at most 2 decimals and drops to the next smaller unit rather than read 0). The
  rates keep their basis, Per day a day and Per hour an hour; in Minutes their small line adds `1 every 95 min`. It and the block folded are remembered in this browser. Under 3 finished flows says Too few to
  trust; none is an empty state, never a 0.
- **Pipeline tokens**, a block under Pipeline time (`token-usage.mjs`, `token-index.mjs`, `GET /api/tokens`,
  `token-strip.js`, `token-view.js`, `tokens.css`): what the project's Claude Code sessions spent in tokens, counted
  from the transcripts only (read only, every folder of `claudeDirs`, the sessions whose folder holds
  `sessionCwdMatch`, worktrees and subagents included). Each reply counts once: one reply is written as several
  records with the same message id (and, while it streams, a partial one first: the final numbers count), and a
  session moved to the other account's folder or forked carries a copy of its history, counted once for the file
  read first. A record with no usage is skipped and counted. Five tiles line up under the others: **Tokens used**
  (with new input, output, cache writes and cache reads), **Estimated cost** (at API prices from `tokens.prices`,
  the unpriced models named; with no price at all there is no dollar figure), **Per finished job** (an average:
  every token of the period over the tickets and other jobs Pipeline time counts as finished), **Cache share** (cache
  reads over all input) and **The dashboard's own runs** (the exact dollars of `data/spend.jsonl` for the period,
  never added to the estimate). Then tokens or dollars per day (per week for All) with a list and arrow keys, a
  By model table with the price used, a By agent table (one row per dashboard label, with the subagents' part under
  it) and How it is counted. Sessions are named by the live name when config maps it, else the transcript's own
  title, else the live name; a renamed session keeps one row. Speed: `data/token-index.json` keeps, per transcript,
  its size, time, identity, the offset read to and its per day per model totals, so a refresh reads only what was
  added (whole lines only; a file that shrank or was replaced is read again, a file that is gone dropped). On
  2026-11-25 the first build of 507 files (2.1 GB) took about 11 s and a warm refresh about 0.15 s; it runs in the
  background after startup, and the block says how far it got until it is done.
- **Log**, the side panel's third choice (`score-log.mjs`, `GET /api/log`, `pipeline-log.js`): one timeline of what
  happened, newest first. Each event is a time (as the pages show times, the exact one on hover), one plain
  sentence ("QA failed this and sent it back to Agent 1."), the flow's title, and, when it put a count in a score, a
  quiet tag such as **Counted: right, caught**. The events: a flow started, its route planned or changed, work handed
  to QA, each pass and failure (earlier attempts too), QA's push, a flow finished with no QA record, dropped, stopped
  at QA, stalled, and every saved change to an agent's specification or rules. A refused push is not shown: the flow file keeps
  no time for it. The tags sit on the very events the scorecard counts, so the events tagged in a window add up to
  its four counts. Chips filter it: All, Delivered, Caught, Missed, Slipped through, Rules. It counts over the
  scorecard's window. Click an event to select its flow, as on Tickets. A refresh reads it again with the diagram
  and keeps the filter, the scroll position and the focused row.

Home still shows the agents as compact cards. A state is a dot and one word
(hover it for the detail, click the word for its meaning):

- **Working**: the harness says busy, or its transcript changed in the last minute. When its latest tool call runs tests or checks (vitest, jest, tsc, eslint, playwright test, flutter test or analyze, dart test, npm or pnpm test, lint and typecheck, still running or finished under two minutes ago) the hover says running tests and the dot is accent blue.
- **Idle**: not doing anything right now.

- **Click** a card to watch that agent live. On the Agents page, a subagent row in an
  agent's details card watches the subagent.

The diagram is `public/pipeline-layout.js` (layers from the graph), `pipeline-view.js`
(boxes over one SVG of arrows, patched in place), `pipeline-tickets.js`,
`pipeline-details.js` and `pipeline-panel.js`, styled by `pipeline.css`. The Specification and Rules sections are
`agent-rules-view.js` (pure HTML) and `agent-rules.js` (the editor, its requests, and the repaint that keeps it
in place), styled by `agent-rules.css`.

## Messages (who is talking to whom)

Built from every live transcript: your prompts (You → agent), messages sent
with SendMessage, messages received from other sessions, and subagents briefed
with the Agent tool. A message seen at both ends is listed once. A pipe address
no live session owns is shown as "an ended session". On Home, a run of
subagent dispatches from one parent folds into one row with its count.

## One agent, live

Click an agent card on Home, an agent or subagent in the Agents page details, or a card on the Subagents page. A subagent opens whatever its age, and also
when the session that started it has ended (the title then reads `Ended session › <task>`): the session is
found by its id among the repo's project folders. The left panel is its activity as it
happens (polled every 2.5 s): your prompts, its replies, each edit as a red and
green diff, files it wrote, commands with their output, messages and subagents.
The right panel is the uncommitted `git diff` of the worktree it works in
(polled every 5 s); switch worktrees with the buttons above it.

Diffs (`public/diff.js`) colour additions green and removals red, each line
with a solid edge and its sign in a gutter. When a removed line is followed by
its replacement, the part that changed inside it gets a stronger mark, so a
one-word edit reads as one word. Every edit, written file and changed file
shows **+N −N** with a five-cell bar of the same split, and the changes list
marks each file M (modified), A (added), D (deleted), R (renamed) or N (new,
not tracked yet).

**Draft report** builds a Markdown report for a window you pick (1 hour to
everything recorded): tickets, commits on its branches, files edited, tests
and checks with their outcome, messages, what is still uncommitted, and its
latest note. Nothing in it is written by a model. Edit it, then copy or
download it. The feed holds the last 4 MB of a transcript, so very old work in
a long session is not in it; the report says where its window starts.

## Timeline (#/timeline)

The **Timeline** page draws what each agent did on each task as a flowchart, from
`/api/flow?hours=2|8|24|0` (0 = everything the feeds still hold; add `refresh`
to skip the 20 s cache). The server builds it in `flow.mjs`, with
`flow-nodes.mjs` (nodes and their details) and `flow-git.mjs` (branches,
landings, commits). The page draws it as plain SVG in `public/flow.js`, with no
library, so it works offline.

- **Lanes:** one per coding session in `codingAgents`, the coordinator first.
  Inside a lane, one row per task (a ticket id, or a worktree whose branch names
  none) and one row per subagent, under the task it was spawned for.
- **Which task an event belongs to:** a worktree path in it (its branch's
  tickets), else a ticket id it names (prompts, messages, commands, file paths;
  never the agent's own prose), else the task of the event before it. A prompt
  that names nothing takes the task of what comes right after it.
- **Nodes:** Briefed (your prompt, or a message from the coordinator), Heard
  from (a message from anyone else), Explored (reads, searches, plain
  commands), Edited (Edit and Write, plus `sed -i` and scripts that write
  files), Tested (pass or fail from the output, or from the log the agent reads
  later when the run was in the background), Messaged, Spawned subagent,
  Committed, `git merge`, Pushed. Runs of one kind collapse: 14 edits become
  "Edited 6 files".
- **From git**, on the row of the agent that did most of the work: commits
  naming the ticket that no transcript shows, when the task's branch landed in
  followup, on dev and on stage (the first first-parent commit there that
  contains it), and a dashed node for the next level it has not reached, or
  for uncommitted files in its worktree.
- **Arrows between rows:** the coordinator briefing an agent and an agent
  reporting back (a SendMessage matched to the message the other session
  received), a subagent being spawned and reporting back, a message to a
  subagent, and a `git merge` landing a branch in followup.
- **Reading it:** hover or focus a node for its details, click (or Enter) to
  pin them, Esc to close. Click a ticket id on the left to show only that
  ticket. "By time" puts every lane on one time axis, with quiet stretches over
  30 minutes cut out and marked; "Compact" packs each row from the left.

Limits: each transcript's feed holds its last 4 MB (about 500 events), so a
busy coordinator's lane covers fewer hours than the agents'. A hand-off is only
drawn when both ends are in the buffers. Task attribution is a heuristic.

### Zoom and pan

Busy windows get wide (a full day can be 20 000 px at 100%), so the chart
zooms from 4% to 175% (`public/flow-zoom.js`):

- **− 100% +** in the toolbar, or the keys **+**, **−** and **0**.
- **Fit** (or **F**) scales the whole window to the width and keeps fitting as
  the window resizes.
- **Ctrl + scroll** (or a trackpad pinch) zooms around the pointer.
- **Drag the chart background** to pan.

Below 75% node text is too small to read, so nodes become coloured blocks:
the shape of the day and every hand-off arrow stay visible, and hovering a
block still opens its details. Rows shrink with the zoom; lane headers and the
time axis keep their size, and axis labels that would overlap are dropped.

Edit nodes show the lines they added and removed (**+N −N**), counted on the
server from each edit's old and new text (`lineDelta` in `flow-nodes.mjs`). A
Write counts every line as added, because the transcript does not keep what
the file held before.

## Levels

- **yes**: every branch for the ticket is merged there, and nothing for it is still waiting in followup (or, for stage, on dev).
- **partly**: commits naming the ticket are there, but more work is not (an earlier round shipped, or the current branch is unmerged).
- **no**: nothing there names the ticket.

"Agent" on a ticket is the coding agent (Agent 1, 2 or 3) that most recently
touched its worktree, or Coordinator if only Coordinator did. It is inferred from
transcripts, so treat it as a strong hint, not a record.

## Refresh the tickets

The server cannot call a tracker itself. The Refresh button on the Tickets page (and the timer of a collection
whose tools only read) runs one short headless Claude turn per collection that rewrites
`data/sources/<id>.json`; see Collections by kind above. Home warns when the newest source is more than
6 hours old.

## Quality: lessons, the self-check, the second opinion and risk labels

Right first time was about a third of flows, so most rework was the same few findings again. Four small features aim
at that. Each model run is ONE short headless turn on Sonnet 5.5 at low effort (the same clean run as the Generators,
`script.mjs`), one at a time, its cost recorded in the spend chip; a model never changes a lesson, a flow or a setting
by itself.

**The lessons library** (`#/lessons`, in the rail's Quality group; `data/lessons.json`, `quality-lessons.mjs`). A
lesson is one plain sentence of at most 160 characters in one area (tests, ui, routes, data, docs, process, infra,
general; `quality.areas` adds more), with how often it was seen and the flows that taught it. When QA, Security or
Senior records a failure, one run (`quality-extract.mjs`) reads its summary and report and proposes up to 3 lessons;
it sees the lessons you have and says `SAME L3` instead of writing a duplicate. Every proposal waits on the Lessons
page for **Accept**, **Edit** or **Reject**; a same-as one, accepted, adds one to that lesson's count. You can type a
lesson too, and **Retire** or **Restore** any. With `quality.autoLessons` on (the default) the server reads each NEW
failure on its own, one per 30 seconds; failures from before the library started wait for **Extract lessons**.
Measured on 2026-11-25: $0.013 to $0.014 a run.

**Lessons in the brief.** `flow new`, `flow rules [<flow>]` and the planner's `flow plan` print the active lessons
that match the task after the agent's rules, under *Lessons from earlier work*: at most 7, those in an area the task's
title, ticket labels or files (named in the plan, or touched by its commits) point at, most seen first, then the
general ones, each with its area and why.

**The self-check before QA** (`quality-selfcheck.mjs`, `flow.selfcheck`). `flow self-check <flow>` prints a checklist:
the house rules (tests first and passing, check and tests run on the last commit, no stray server, no debug output,
docs updated, and for work with a screen, screenshots looked at) and this flow's lessons.
`flow self-check <flow> --done "<id>=ok" --done "<id>=no:<what is missing>" ...` records every answer; a no needs a
note. QA sees it at `flow qa-start`. With `pipeline.requireSelfCheck: true`, QA cannot start a code flow that has
none. The flow page shows each tick, and the scorecard's Correctness tile shows right first time with and without a
self-check (Too few to trust under 5 flows a side).

**The second opinion on the plan** (`quality-critic.mjs`, `flow.critic`). After the planner hands out a plan, one run
reads the plan, the request, the matching lessons and the risk label, and lists up to 5 concrete concerns: a missing
test plan, an edge the request names, a step that needs a person, a risky area with no Security or Senior step.
`quality.critic`: `off`, `manual` (the default: a **Second opinion** button on the flow page) or `auto` (once per
plan). It is shown on the flow page and printed to the producer with `flow rules <flow>` and `flow self-check`. It
never blocks. Measured on 2026-11-25: $0.008 to $0.010 a run.

**The risk label** (`quality-risk.mjs`, `flow.risk`). Plain rules, no model: the request and plan text, the tickets'
labels and the files the change touched give low, medium or high, every reason, and what it asks for: a Security
review, a Senior review, a deeper QA pass. The defaults cover sign-in and user sessions, payments, secrets and
settings files, infrastructure and CI, the database schema and migrations, deleting data, and public pages;
`quality.riskRules` replaces them (`{ "match": { "words": [], "paths": [], "labels": [] }, "level", "needs", "why" }`;
one bad entry keeps the defaults with one warning). A card shows a Medium or High risk chip, the Agents diagram chip's
tooltip names it, QA reads it at `qa-start` (with one extra line for a deeper pass), and the flow page says when a
review it asks for is not on the pipeline, or is not one this kind of route passes. When Security or Senior is on the
pipeline and the label asks for it, the planned route includes it.

Routes: `GET /api/lessons`; `POST /api/lessons`, `/api/lessons/<id>/retire|restore`,
`/api/lessons/candidates/<id>/accept|reject`, `/api/lessons/extract { key }`, `/api/quality/critic/<flow>` (each needs
the page's own Origin; 409 while a run is going); `GET /api/quality/flow/<flow>`. The Lessons page opens on one area
with `#/lessons?area=tests`, or on one proposal's Edit form with `#/lessons?edit=<id>`.

## Predict and warn

Estimates, alerts and what each flow really cost, all worked out from what the flow files and the transcripts'
token counts already record. **No model is run**: nothing here costs anything.

- **What a flow cost.** A flow's Output tab has a **Cost** block: `Tokens: 12.4M, about $4.10`. A reply counts for
  a flow when its session's label is on the flow and its time falls inside that agent's stretch on it (the
  producer until QA starts, each QA attempt, each Security review, each fix after a failure, the planner, Senior),
  shared evenly when the same agent had several flows open at once. Subagents count with the session that started
  them. The token index keeps per hour totals, so an hour is taken as spent evenly. Pipeline tokens gains one line:
  how much of the period is on flows and how much is not on any flow (the chat, sessions on no flow, time between
  flows). `predict-flow-tokens.mjs`, `predict-spans.mjs`.
- **Estimates.** When a flow starts work the server stores `estimate` on it once (the server's, like
  `archivedAt` is the user's: an agent rewrite can neither add, change nor drop it): the median time, cost and
  tokens of the nearest 3 to 8 similar finished flows, with the range. Similar is the same route type first, then
  shared ticket labels and type, the same agent, the same risk level (when a risk provider gives one) and title words
  in common. Only flows that finished before it started count. Fewer than 3: `No estimate yet: too few similar
  flows`, never a number. An open ticket on the Tickets page shows one worked out on the fly. Once a flow finishes,
  its Cost block sets the estimate against the actual, and **How good the estimates have been** (folded inside
  Pipeline time) gives the median error, `Too few to trust` under 5. `predict-estimate.mjs`.
- **Alerts.** One line at the top of the Agents page, above Pipeline score (Home shows the count), the rows folded
  under it; one agent holding 3 or more flows past their usual time is ONE row with **Dismiss all for today** and
  its flows folded under it, and a flow alert can be **snoozed for a week** (it returns after 7 days, or at once when
  the flow moves to another step: for long-lived tracking flows). **Taking long**:
  an open flow at its step more than `alerts.stuckFactor` (3) times that step's median over 30 days and at least
  `alerts.stuckMinMinutes` (60); with fewer than 5 past flows for the step, the plain `alerts.stuckHours` (24).
  A step that waits on you says so. **Token spike**: a session's last hour above `alerts.spikeFactor` (4) times its
  median active hour over 7 days and above `alerts.spikeMinTokens` (20 million). **Long history**: a live session
  whose last 10 replies re-read more than `alerts.contextTokens` (400,000) tokens of history each; it says what a
  turn costs, marks the agent's box on the diagram, and offers **Copy handover request** (it copies a sentence and
  sends nothing). **Daily limit**: `alerts.dailyUsd` and `alerts.dailyTokens`, off by default. **Dismiss for
  today** hides one until midnight, or until it gets half as bad again (`data/alerts-state.json`). No sound, no
  pop-up. `predict-alerts.mjs`, `predict-stage.mjs`, `predict-state.mjs`.
- **Routes.** `GET /api/alerts`, `POST /api/alerts/dismiss` (the page's own Origin), `GET /api/predict/flow?id=`,
  `GET /api/predict/ticket?id=`, `GET /api/predict/accuracy?days=7|30|all` (`predict-routes.mjs`). The token
  index is version 3 (per hour totals and each file's newest replies), so a saved index rebuilds once.
- **Settings.** `alerts` and `estimates` in `config.json` (see `config.example.json`). A bad value keeps its
  default with one warning at start.
- **For other features.** `predict-signals.mjs signals({ since })` lists the alerts raised and the estimate misses
  in a window; `predict-flow-tokens.mjs flowTokens(flowId)` gives one flow's tokens.

## Routing (#/routing) and ticket intake

The **Routing** page (in the rail's Agents group) holds plain rules that SUGGEST who does a task and on what: the first rule
that fits the task's type, risk and size names an agent, a model and an effort, with a one-line why. Defaults live
in `routing-rules.mjs` (small wording fixes go to Sonnet 5.5 at medium effort); the page saves your own list to
`routing.rules` in `config.json` after a plain confirm, every other line of the file kept. A list with any bad rule
keeps the defaults and warns once. The planner, Security and Senior always run on Opus at high effort: no rule
suggests them down.

- **Task type** (`routing-type.mjs`): wording, style, small fix, feature, refactor, tests, docs, data, infra,
  investigation, review or by hand, from the words, labels and story type, with a confidence (certain, likely,
  unsure) and the reason. Unsure fits only a rule with Any type. Correct it on the Routing page (a flow) or in an
  opened ticket row; your correction always wins.
- **Where the suggestion shows**: Pass a task on the Tickets page; `flow new` and the planner's `plan-start` and
  `plan` note it on stderr when a rule fits. It is a suggestion, never an order: nothing is switched by itself.
- **The record** on each flow (`flow.routing`, `routing-flow.mjs`): type, size, risk, the suggestion, what was used
  (the agent that got the work and the model and effort set for it on the Agents page at that time) and whether the
  suggestion was followed. An agent rewrite keeps the stored record.
- **What happened** (`data/routing-outcomes.jsonl`, `routing-outcomes.mjs`): one line per finished flow (delivered,
  slipped, stopped or dropped, as the scorecard says), written once, from stored records only. The page sums them
  per task type and model (right first time, median time, median cost) and says Too few to trust under 5 flows,
  with the count against the 100 a later learning method needs. No learning method is built. Tokens and cost come
  from another feature's per-flow provider when one is wired; without it they are left out and marked missing.
- **Ticket intake** (`routing-intake.mjs`): every ticket is sorted into code, no code or needs a person, with the
  reason, and likely duplicates show as `Looks like FLA-761` with a Not a duplicate button that is remembered. A
  Sort chip row and facet filter the Tickets page. Human review's Tickets list reads the sure sorts: a ticket sorted
  as code leaves it, one sorted no code or needs a person joins it. With `routing.intakeModel` set (off by default),
  the Routing page's **Sort the unsure tickets** runs ONE cheap model turn over up to 30 unsure open tickets (about a
  cent with Haiku 5.5, recorded as Ticket sorting spend); its answers are stored as the model's and you can correct
  any. Corrections live in `data/factory-state.json`.

Routes: `GET /api/routing`, `PUT /api/routing/rules`, `POST /api/routing/flows/<id>`, `GET /api/routing/tickets`,
`POST /api/routing/tickets/<ID>`, `POST /api/routing/intake/run` (writes need the page's own Origin).

## Learn (#/learn): retrospectives, the weekly Learn step, a verdict on every rule change

**Retrospectives.** When you mark a flow **Completed**, one small run (Sonnet at low effort, about 1 cent)
writes three lines on it: what went right, what went wrong, what to do differently. The server gathers the facts
first (the story, the route, every QA attempt with its verdict text and the report of each failure, Security and
Senior verdicts, reworks, the time per stage, the by-hand steps, the questions asked) and the model writes from
those alone; the server checks the three lines (each at most 200 characters) and keeps them on the flow as `retro`.
Never for a dropped or unfinished flow. They show on the flow's Output tab under the Story, with **Write the
retrospective** (or **Write it again**), and folded in its flow archive row. Runs go one at a time; Mark all
completed queues them. `learn.autoRetro: false` stops the automatic one. An agent may read a retrospective with
`flow show`; only the server writes one (an agent's `flow write` keeps the stored one).

**The Learn page.** **Run Learn** builds an evidence pack from the dashboard's own records since the last run (7
days without one; at least 14 when fewer than 5 flows finished): right first time, the median time per job, the
estimated cost per job, QA failures per flow, the score cells, every flow of the window, reworks per agent, each
agent's current rules, the open verdicts, ideas you rejected before, every retrospective and the QA, Security and
Senior failure texts. A source that cannot be read is left out and named. One run (Opus at high effort; about 11
cents on a week of 16 flows) proposes at most 3 changes, each with its target, the exact rule text, the evidence,
the expected effect and how to tell in two weeks. The server drops a proposal that names no flow of the pack, an
unknown agent, a rule the agent already has, a change to a rule it does not have, or an idea you rejected. Each
proposal is a card: **Accept** saves the rule through the same path as your own edit on the Agents page, marked
From Learn; **Edit then accept** saves your wording; **Reject** keeps an optional reason for the next run. A
settings proposal is text you apply by hand: Learn never writes `config.json`. A line reminds you when the last
run is 7 days old; `learn.weekly: true` runs it by itself on opening the page, at most once a week. Every run is
kept in `data/learn/<YYYY-MM-DD>.json`.

**A verdict on every rule change.** Every rule change, yours or from Learn, records the four numbers of the 14
days before it (`data/learn/verdicts.json`; changes made before this existed are worked out later from the stored
flows, and say so). After `learn.verdictAfterDays` (14) a **Verdict due** card compares them with the days since:
a number moved when right first time changes by 10 points, the time or the cost by 20 percent, QA failures by a
quarter per flow. Better: one or more got better and none worse; Worse: the other way; No clear change; or Too few
flows to tell (fewer than 3 finished on either side). **Keep**, **Revert** (puts back the exact text, through the
rules path) or **Wait two more weeks**. Nothing reverts by itself. Every change is listed with its verdict.

Routes: `GET /api/learn`; `POST /api/learn/run`, `/api/learn/weekly`, `/api/learn/runs/<id>/<n>`
`{ do: accept|reject, text?, reason? }`, `/api/learn/retro/<flow>`, `/api/learn/changes/<id>` `{ do: keep|wait|revert }`,
each POST with the page's own Origin. Spend kinds `retro` and `learn`. Settings (all optional): `learn.enabled`
(false: no Learn or retrospective runs at all), `autoRetro`, `weekly`, `verdictAfterDays`, `model`, `retroModel`.

## How Quality, Predict, Routing and Learn feed each other

Each of the four works alone; `smart-wiring.mjs` connects them (in `server.mjs`, and for Routing in
`tools/factory.mjs` too):

- **Learn's evidence pack** gets the active lessons (Quality) and the alerts and estimate misses (Predict) of its
  window, as the LESSONS LEARNED and ALERTS AND ESTIMATES sections.
- **Estimates** count the same risk level as one more point of likeness (Quality's label stored on the flow, else
  worked out from the flow).
- **Routing** reads the same risk level for its rules (so high-risk work is suggested the strongest model) and each
  finished flow's tokens and cost (Predict) for its outcome line. A command-line process has no token index, so
  there the tokens are left out.

A feature that fails to answer never breaks the one that reads it: Learn names the section as left out, the others
carry on without that part.

## Pull requests (the list that fades into fog)

Every pull request an agent opened for a flow and that is still open on GitHub, as a small block titled
**Pull requests** at the top of the Agents page, under the Alerts line (`#/agents?prs` scrolls to it), and on Home
under the lines at the top. Nothing shows while there is none.

- **What is on it.** A flow names its pull request by the link Send stored (`output.pr`), or by the branch the agent
  recorded with `flow pr` (`output.merge`), so one an agent opened itself is found too (`gh pr list --head`). Open
  and draft ones are listed, newest first; two flows naming the same pull request show it once. An item **leaves**
  when its pull request is merged or closed on GitHub (within about a minute), or when you mark its flow
  **Completed**; archiving alone is not enough. `prlist-items.mjs`.
- **The fog.** No numbers, no bullets. The newest is full size and clear, with a small line under it: the agent, how
  long ago it opened, its checks (passing, failing, running, none), and whether it needs you (`waiting for your
  review`, or `ready for you to merge` when it is mergeable and green; a small accent dot marks it). Each one under
  it is a little smaller, shows less of its title and fades further (opacity 1, 0.62, 0.38, 0.22, 0.12, a mask
  thinning each line towards its end, fading to the page's own background in light and dark). At most 5 show, then
  `and 3 more`, which unfolds the rest. Point at a faded one, or reach it with the keyboard, and it comes back into
  full view. Every title is a real link to the pull request (a new tab), each with **Open the flow**; a screen reader
  hears a plain list with the full titles. `public/prlist-view.js`, `public/prlist.css`.
- **The move up.** When the first leaves it fades up and out while the rest slide up one place, each growing to its
  new step, over about 400 ms; a new one fades in at the top. With reduced motion the list simply redraws.
  `public/prlist.js`.
- **Route.** `GET /api/prs` (no-store): `{ items, checkedAt, problem }`, answered at once from memory. The server
  reads the states in the background with `gh pr view` and `gh pr list` (read only, never anything that writes),
  at most once a minute, four at a time with an 8 s limit each, and never reads a merged or closed one again. A read
  that fails keeps the last good state and the block says so under the list. The page asks every 30 s while the tab
  is visible, and at once when you come back to it. `prlist-store.mjs`, `prlist-routes.mjs`. No setting.

## Phone access

A phone view of the dashboard, so you can see what needs you and talk to the coordinator from your phone. It
is **off** until you turn it on, and with no `remote` block in `config.json` nothing changes at all: the
dashboard keeps listening on `127.0.0.1` only.

**Set it up** (each step in your own terminal, in this folder):

1. Install [Tailscale](https://tailscale.com) on this PC and on the phone and sign in to the same account, or
   put both on your home Wi-Fi.
2. `node tools/factory.mjs phone-setup`: pick one of this PC's addresses (a Tailscale one is listed first and
   recommended: it encrypts the link and follows you between networks), read what it opens, and type `yes`. It
   writes `remote.enabled`, `remote.bind` and the network it was set up on (`iface`, `mac`, `cidr`).
3. `node tools/factory.mjs phone-pin`: type a phone PIN of 8 to 12 digits, twice, nothing shown. It must differ
   from your send PIN. Only its scrypt hash is kept (`remote.pinHash`), and every phone is signed out.
4. Within a few seconds a running dashboard listens (no restart needed). On the phone, open the address it prints (`http://<address>:4318/phone`), sign in,
   and add the page to the home screen.

**What the phone can do**, and nothing else: see how many things need you, and on the Agents tab the pipeline from
Request to Output with each agent's state, the flows standing at each box (a tap opens a read-only sheet), the
alerts and the open pull requests (the same list as the desktop Pull requests block, read from its memory, so the
list adds no GitHub read; opening one reads it, below) (`GET /phone/api/orchestration` and `/phone/api/flow?id=`, read only); answer
an open question (once: changing an answer stays on the PC); tick a by-hand step; mark a finished output
Completed; and chat with the coordinator. The chat is one thread shared by every phone signed in with the PIN (they
are all you): the last 30 messages, each with the coordinator's written replies that followed it, so it survives a
new sign-in. Replies written before the first phone message are never shown, nor anything but its written words
(no tool calls, results or thinking). Each message reaches the coordinator after a fixed first line, the same rule
`docs/agent-brief.md` gives it under Phone messages: it came from the phone, so nothing destructive, pushed,
deployed or live, and no settings change, until you confirm at the PC. There is no delete, archive,
settings, rules, config, Finish without Senior, Send or Generate on the phone. An answer and a message each go
through the answer relay's short paid turn on your PC, a few cents each (`phone` in Spend today for messages).

**Reading a pull request on the phone.** A tap on an open pull request (the Agents tab list, or a flow sheet)
opens it in a sheet on the phone: its title, `repo #number`, Open or Draft, the branch going into the base, who
opened it and when; the checks in one plain line (`22 passed, 1 failing, 1 running`) with each failing or running
check by name; who a review is asked of, who approved and who asked for changes; the description, folded after 40
lines; the files changed with their counts, each unfolding its changes in a block that scrolls sideways on its own
(added and removed lines tinted, their `+` and `-` kept); and the latest comments, newest last. **Open on
GitHub** and **Open the flow** are at the bottom. It is read only: there is no merge, approve, review or comment
on the phone (`GET /phone/api/pr?flow=<id>` or `?n=<number>`, phone-pr.mjs). Only a pull request the desktop's
Pull requests list holds can be read, and the repository and number gh is given come from that list, never from
the phone: any other address, or one that names a repository or a link, is a 404. It runs `gh pr view` and `gh pr
diff`, keeps a copy of each pull request for a minute (Refresh within the minute shows that copy and says when it
was read), and never runs more than two gh calls at once. What GitHub returns is treated as hostile text: escaped,
the description and comments drawn by the chat's own safe renderer (only github.com links are tappable, no images,
no HTML), the invisible direction-changing characters taken out of names and shown as `[U+202E]` in changes. Long
pull requests are cut, and each cut is said with GitHub as the way on: the description at 20,000 characters, 100
files, 300 lines of changes a file and 1,500 in all, the 30 latest comments of 2,000 characters each. When GitHub
cannot be read, the sheet keeps the last copy with one plain line. The gear at the top of the phone opens
**Options**: `Open pull requests: Here | On GitHub` (Here by default; On GitHub keeps the old links). The phone
page stores nothing itself, so the choice is kept on the phone's sign-in (`POST /phone/api/prefs`, which accepts
only `{ "prLinks": "here" | "github" }` and changes nothing else) and lasts until that phone signs out.

The block, in config.json (`config.example.json` has it, off):
`"remote": { "enabled": false, "bind": "", "port": 4318, "pinHash": "", "sessionHours": 4 }`

| Key | What it does |
| --- | --- |
| `enabled` | Only `true` turns it on, and only with a valid `bind`, `port` and `pinHash`. Anything wrong keeps it off with one warning. |
| `bind` | ONE address of this PC: a private one (10.x, 172.16-31.x, 192.168.x) or Tailscale (100.64-127.x), on a network this PC is on now. `0.0.0.0`, `::`, public, loopback and IPv6 addresses are refused. |
| `port` | 1024 to 65535, not the desktop `port`. Default 4318. |
| `pinHash` | Written by `phone-pin`; never type a PIN here. `pinSetAt` says when and `pinDigits` how long it is: a PIN under 8 digits, or one set before that rule, keeps phone access off until you set a new one. |
| `sessionHours` | How long a phone stays signed in, 1 to 168. Default 4. |
| `iface`, `mac`, `cidr` | Written by `phone-setup`: the network it was set up on. The listener opens only while the bind address is on that interface, adapter and subnet, and closes within 5 s when it is not. |

**The honest limits.** This is plain HTTP on your private network: no TLS, no tunnel, nothing public. Over home
Wi-Fi the PIN and the session can be read by someone who can see the traffic, and anyone on that network can reach
the sign-in page; Tailscale removes that, because it encrypts the link. The phone PIN is the only lock, and it
guards the ability to instruct a coding agent: treat it like a password. Five wrong tries lock phone sign-in for 15
minutes for every device (kept on disk, so a restart does not reset it), and 3 lockouts within 24 hours turn phone
access off until you turn it on at the PC. It opens only on the network it was set up on; two home routers that
hand out the same subnet cannot be told apart, which Tailscale avoids. **Never forward the port on your router.**

Nothing about it happens quietly: the Settings page's **Phone** card shows whether it is on, the address, when the
PIN was set, recent sign-ins and lockouts, **Sign out everywhere** and **Turn phone access off**; while it is on,
the rail's foot shows a **Phone on** badge above Settings. Every sign-in, lockout, PIN change and change of `remote.enabled`,
`bind` or the PIN hash in config.json raises a desktop notice and a line in the Log, and a PIN that `phone-pin`
did not write is called out as changed outside the setup command. Turning it on is only ever done in a terminal,
which is no wall against a local agent that can write config.json: these notices are how you would see it.

The phone listener serves only `/phone`, its own files, sign-in and sign-out, and the phone's own API: every
desktop page, `/api/*` route, evidence file and config is a 404 there. Each write needs the session cookie
(HttpOnly, SameSite=Strict), the page's own Origin and a per-session CSRF token; requests are rate limited per
session and per address, and every answer carries a strict Content-Security-Policy. The API is `no-store`. The
page's own files are cacheable: the page links each with a version of its content (`?v=`), which the browser keeps
for a year, and the page itself is checked with its ETag. A `304` (nothing changed) does not count against the
per-address limit, so reloading the page never uses it up (it used to: a `429` on one script left a blank page).

## License

MIT, see `LICENSE`. The bundled fonts in `public/fonts/` keep their own SIL Open Font License.
