# Yz Agent Orchestration

**New here? Read the [user guide](docs/USER_GUIDE.md).**

A local web page that shows what each Claude Code session is building in one
git repo: per ticket, per agent and per worktree, at three levels (local
branch, the integration branch on the remote, and the release branch on the
remote). It reads git and Claude Code's own session files and never changes
the repo, with one opt-in exception you turn on yourself: **Send**, which pushes a
branch and opens a pull request when you click it (see Send to the base branch). Agents can also narrate their work as **flows** (steps, checks,
questions for you, and proof), which the page draws and lets you answer.

It was built for one person running a coordinating session ("Master") and
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
example first.

## A quick tour

- **Home**: what changed since you last looked, open questions from agents, a
  compact card per agent, and who is messaging whom.
- **Flows**: every agent's work as a flow. **Output** is meant to be read in ten
  seconds: a plain **Story** of who did what and why, one **Picture** (a screenshot
  of the result, the agent's diagram of how it works, or a summary chart drawn from
  the flow), and **How to test** it by hand, step by step, with the long summary
  folded under **Details**; **Status** lists what is built, missing and waiting on
  you; **Process** shows the chart of steps.
  Answer an agent's question inline; the answer is pushed back to that agent.
- **Tickets**: a ticket collection from your tracker, an orchestration grid of
  which agent took which ticket how far (local, dev, stage, prod), the ticket
  table with code review marks, and every worktree.
- **Timeline**: what each agent did on each task as a zoomable flowchart, built
  from the transcripts and git.
- **Agents**: the agents as a tree of cards, with a live view of one agent (its
  feed, its edits as diffs, its uncommitted changes) and a draft progress report.
- **The Ask drawer**: a chat with a Claude Code session ("Independent") that can
  read the code, write flows, message agents and drive a browser.
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

Reading git and transcripts is free. These features run headless Claude Code
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
- `config.json` and everything under `data/` (flows, evidence, ticket snapshots,
  the chat transcript, spend) stay on your machine and are git-ignored.

## Configuration

Five pages sit in a rail on the left: **Home**, **Flows**, **Tickets**,
**Timeline** and **Agents** (one agent's live view opens from Agents). Pages
refresh themselves; the Refresh button in the page header rebuilds at once.

`config.json` stays on your machine (it is in `.gitignore`):

| Key | What it is |
| --- | --- |
| `repo` | Absolute path of the git repo the sessions work in (required) |
| `port` | Port on 127.0.0.1 (default 4317, or `PORT`) |
| `sessionCwdMatch` | A session counts when its working folder contains this (default: the repo folder name) |
| `coordinator` | The session that merges everyone's work (default "Master") |
| `codingAgents` | Session name -> label, for sessions that write code |
| `aliases` | Session name -> label, for any other session |
| `stopHour` | Local hour to stop at, or null |
| `ticketPrefixes` | Ticket id prefixes in rank order, such as `["ABC", "XYZ"]` (see Assumptions about your repo and tracker). Left out: taken from the collections and the ticket sources |
| `pr` | Send to the base branch, off by default: `{ "enabled": false, "remote": "origin", "bases": ["dev"], "gh": "gh" }`. `enabled` must be `true` to turn it on, and is honoured only with a `pinHash` (set it on the Settings page or with `node tools/factory.mjs pr-pin`, never by hand); these keys are read again whenever config.json changes, so no restart; `protect` lists the branches never sent from (default `["main", "master", "stage", "prod", "production", "release/*", "release-*"]`, `*` matches anything); `remote` is the remote to push to; `bases` are the branches a flow may be sent into; `gh` is the GitHub CLI command (signed in with `gh auth login`). A bad value turns the feature off with a warning in the server log |
| `levels` | The branches the levels compare: `{ "work": "followup", "dev": "origin/dev", "stage": "origin/stage", "prod": "origin/main" }` (these are the defaults). A bad value keeps its default, with a warning |
| `reminders` | Reminders at a local time, once a day: `[{ "at": "17:55", "days": "weekdays", "text": "Wrap up: commit or park your work." }]`. `days` is `weekdays` (Monday to Friday) or `daily`; `[]` turns them off. Left out, there are none. `at` is a real time, 00:00 to 23:59, and one reminder per time. A bad or repeated entry is left out with a warning in the server log |

### Keep it running

Run `tools\keep-alive.cmd` (Windows) instead of `npm start` to have the dashboard come back by itself: it
starts `node server.mjs` from the repo root, and starts it again 5 seconds after it stops for any reason.
Its output goes to `%LOCALAPPDATA%\yz-agent-orchestration\server.log`. Close its window to stop it. A stop at
`stopHour` is restarted too, so leave `stopHour` null when you use it. Run only one: a second copy (or any
dashboard already on the port) fails with EADDRINUSE and tries again every 5 seconds, filling the log. To
start it at login, press Win+R, open `shell:startup`, and put a shortcut to `tools\keep-alive.cmd` in the
folder that opens.

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

- **The rail** (56 px, icons only): the brand mark (Home), Flows, Tickets,
  Timeline, Agents, Glossary, and at the foot Ask, Alerts, Spend and Theme. Hover it for 300 ms,
  or Tab into it, and it opens to 200 px with labels; the pin at the top keeps
  it open (remembered). Under 720 px wide the rail is a bar along the bottom.
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
- **Spend today** (`public/spend.js`, `spend.mjs`): above Theme, `$12.40 today`
  is what the dashboard's OWN headless turns cost today: the chat, the answer
  relay, the explainer and the ticket refreshes. It is hidden while today is
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
  an empty box lists the pages and the actions. Up and Down choose, Enter
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

### Home (#/)

Zones, top to bottom: **Since 23:10** (only when something happened since you
last pressed its `Mark read`: flows that changed status, answers delivered,
tickets that reached a new level or changed on their source, commits per agent;
at most eight lines, no model involved; it stays across reloads until marked
read, and a new browser starts from its first visit; see `since.mjs`),
**Waiting on you** (only while an ask is open: answer it inline), **Agents · N** (the agent cards in a compact form: name,
state, last action, up to four tickets; click one to watch it live) and
**Messages · N** (who is talking to whom, below). The status chip says when git
last fetched; its `?` holds how far followup is ahead of dev and how old the
ticket snapshot is.

### Flows (#/flows)

The working page for what agents do and what waits on you. Every agent narrates its work as a flow, one JSON
file per flow in `data/flows/`, written with the `flow` commands below. Top to bottom on the page:

- **Waiting on you**, one strip across all flows: every unanswered ask, newest first, one line each (agent,
  flow title, the question) with Yes and No (or a text box) inline and a link to show it in its flow.
  Under each question is **why** it is asked: the agent's `--why`, or, when it gave none, a fainter line
  saying which flow and step the ask follows. The same `Why?` line sits under the question wherever an ask
  shows: the opened flow's Story, Status and node drawer, the chart's tooltip, and the alert toast.
  Answering here is the same as answering on the node. While a flow is open, its own asks leave the strip
  (its Story and Status ask them), and the strip disappears when nothing is left in it. On the Flows page no
  `N asks waiting` toast is raised: the header dot and the strip already say it.
- **The board**, a card per open flow, grouped by agent in the grid's column order. A card says only where
  the flow stands: the title, ONE line of story (the latest line the agent wrote, or the first the dashboard
  made from the steps, cut at a word to fit), ONE state chip (**waiting on you**, **blocked**, **ready to
  send**, **PR open**, **merged** or **done**), the agent, and a thin progress bar with `13/18`. Tickets, env
  and times live inside the flow. Done flows collapse into a Done row; dropped ones hide behind Show dropped.
  With no open flow the board is one line, with how flows start behind its `?`.
- **An opened flow's head**: its title with the view tabs on the same row, the why (its first sentence and
  **more** when it is long), then ONE muted line of agent · tickets (three, then `+N`) · env · status · when it
  changed. The flow's status and **Drop** sit in the `⋯` menu at the end of that line.
- **Three views of an opened flow**, as tabs beside its title (Left and Right move between them; the page
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
  cleanly, no commit message, title or body credits an AI tool, gh is installed and signed in, and no pull
  request is already open for the branch (its link shows instead). Any of those is a **blocker**: the bar says
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

### Tickets (#/tickets)

The page for a ticket collection (`factory.collections` in config.json, below). The page title is the
collection's name (a picker shows when there are several); the chip says when Switchboard was last read, with
the range, the count and any failure behind its `?`, and Refresh reads it now.

- **Orchestration · N:** agents across (Master, Agent 1, 2, 3), levels down (Local, Dev, Stage, Prod), and in
  each cell the tickets that agent built which got that far and no further. Prod is origin/main (squash bodies
  included), Stage and Dev are their origin branches, Local is committed work on followup or any worktree
  (detached included) that dev does not have. The builder is the agent on the worktree, else the plan's wave
  column (A1, A2, A3), else Master. Hover a ticket for its review, plan, the commit at each level and the open
  flows it is in; click it to open its row. Each column head says whether the agent is working, idle or
  waiting, its last action, and opens its **progress report** (from its transcript) and its live view. The
  legend is behind the card's `?`.
- **Tickets · N** (folded, remembered), in board order: Current Sprint, then Backlog, then Icebox, by
  position. Each row shows the board state, the owner, whether the plan marks it as a must for launch, and a
  **code review mark**: Code reviewed (with a verdict), Needs review, No code yet, or Not from codebase.
  Filters are checkbox dropdowns; the stat chips filter too.
- **Per-ticket actions:** review the code with the chat agent (it records the mark itself), explain the ticket,
  or pass a task to a live agent. Select several rows to do it in bulk.
- **Worktrees · N** (folded, remembered): every worktree with its branch, agent, uncommitted files, how far it
  is from its remote and from dev, whether followup, dev and stage have it, and its last commit.

### Agents writing flows

Every agent that works in the repo gets the same brief. Paste this paragraph into the briefs you give agents
(the chat agent's system prompt already carries it):

> Narrate your work on the dashboard as a flow: `node <abs path>/tools/factory.mjs flow …`.
> Start with `flow new` or `flow write` before you change anything, keep
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
> Never push or open the pull request yourself: the user reviews the Output and sends it. The pull request text
> must not credit an AI tool (no Co-Authored-By line, no Generated with line).

The commands (`node tools/factory.mjs flow …`). Each writes the flow file atomically and prints one line;
`--by` or `FACTORY_BY` names the agent: its dashboard label (letters, digits, spaces, dots, dashes, underscores; up
to 40), which is where answers are sent. `flow new`, `flow write` (unless the file names its agent), `decide`
and the Output commands refuse to run without one.

```
flow new <id> "<title>" [--tickets ABC-1,ABC-2] [--env dev] [--why "..."]
flow step <flow> "<title>" [--id n5] [--env stage] [--why "..."] [--after n2,n3] [--status doing]
flow check <flow> "<title>" [same options]
flow ask <flow> "<question>" --why "<why you need this answer>" [--yes "..."] [--no "..."] [--text] [--after n2]
flow note <flow> "<text>" [--after n2]
flow status <flow> <node> <todo|doing|done|blocked|skipped>
flow evidence <flow> <node> --commit <sha> | --diff <worktree> | --test "<line>" [--file path] | --shot <path> | --url <url> | --note "<text>" [--label "..."]
flow set <flow> --status done|blocked|dropped|open | --title "..." | --why "..." | --tickets ...
flow write <path.json>            # whole flow in one go (create or replace; keeps answers, ticks, and the output when the file has none)
flow show <flow>                  # the JSON on stdout, for an agent to read back answers; an Output block on stderr
flow list [--open] [--waiting] [--agent X] [--ticket ABC-1]
flow result <flow> --shot <path> [--caption "..."] [--before]
flow diagram <flow> "[actor] User -> Page: clicks; Page -> [store] Storage" [--before] [--clear]
flow change <flow> --before "<how it was>" --after "<how it is now>" | --clear
flow summary <flow> "<markdown>" [--commit <sha>]... [--diff <worktree>]...
flow test-step <flow> "<do this>" --expect "<you should see>" [--shot <path>] [--id t3] [--replace]
flow test-clear <flow>
flow say <flow> "<what was done>" [--why "<the reason>"] [--who "<label>"] [--id s2 --replace]
flow say-clear <flow>
flow pr <flow> --head <branch> --base <branch> --title "<title>" --body-file <path> | --clear
term "<word>" "<plain explanation, 1 or 2 sentences, at most 300 characters>" [--more "..."] [--flow <id>]   # not under flow
```

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
pushes or opens the pull request itself. What the server opened is `output.pr`, the server's like an answer:
no command sets it and a rewrite always keeps it from the stored file. `flow show` says
`send: feature/dark-mode -> dev, not sent` or `send: PR #12 open, checks passing`.

`flow write` is the fast path: an agent that already knows its plan writes the whole flow at once, then uses
`status` and `evidence` as it goes. A rewrite keeps your answer to an ask only while its question, kind, yes and
no are unchanged, and your tick only while the step title is the same and its old evidence is still there.
Screenshots from a browser are saved first, then attached with `flow evidence … --shot`, which copies each as
`<flow>/<node>-<name>` (numbered when taken, so two `shot.png` files never collide); the dashboard serves them
read-only at `/evidence/…`, images and video only.

The other commands, from any shell:

```
node tools/factory.mjs mark ABC-123 reviewed --verdict check --note "what is left"
node tools/factory.mjs mark ABC-123 needs-review|no-code|not-codebase
node tools/factory.mjs decide --ticket ABC-123 --question "..." --why "..." --yes "..." --no "..."
node tools/factory.mjs show ABC-123
```

`decide` is the old command, kept so older briefs still work: it becomes a `flow ask` on a new one-ask flow.

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
- The page names the coordinator "Master" (public/app.js).

## Where the data comes from

| What | Source | How fresh |
| --- | --- | --- |
| Worktrees, branches, uncommitted files, ahead/behind | `git` in the repo and each worktree, with `GIT_OPTIONAL_LOCKS=0` so it never takes a lock | every build (at most once per 45 s) |
| On dev / on stage | `git fetch origin` every 5 minutes, then ancestry and ticket ids in commit subjects | 5 minutes |
| Agents and what they last touched | `~/.claude/sessions/*.json` (name, status) and each session transcript: worktree paths and ticket ids in its tool calls only, not tool output | every build; transcripts are read once, then only new bytes |
| Ticket title, state, owner | `data/sources/<id>.json` of every collection, merged (see Collections by kind) | when refreshed (below) |
| Flows, asks, evidence | `data/flows/<id>.json`, written by agents with `tools/factory.mjs flow …` | every poll (15 s) |

Read only: the only command that writes anything is `git fetch origin`
(remote-tracking refs). No checkout, stash, reset or commit, and nothing is
written inside the repo or any worktree.

## Agents (#/agents): the tree and states

The Agents page draws the agents as a tree of cards (Home shows the same cards
in a compact grid, in the same order): Master's card at the root,
a trunk running down from it, and each coding agent's card on its own rounded
branch. An agent's subagents branch off its card the same way. A branch turns
green while its agent works and accent blue while it tests. Sessions outside
the team (`codingAgents` in config.json) sit below under "Other sessions",
without lines.

Each card shows the agent's state, what it is doing or last did, who it last
talked to, its recent tickets and branch, and a Progress report button (the
same report the grid's column head opens). A state is a dot and one word
(hover it for the detail, click the word for its meaning):

- **Working**: the harness says busy, or its transcript changed in the last minute. When its latest tool call runs tests or checks (vitest, jest, tsc, eslint, playwright test, flutter test or analyze, dart test, npm or pnpm test, lint and typecheck, still running or finished under two minutes ago) the hover says running tests and the dot is accent blue.
- **Idle**: not doing anything right now.

- **Drag** an agent's card to reorder the branches (or the other sessions).
  The card lifts and tilts as it follows the pointer and the others spring
  aside. The order is saved in this browser (localStorage). Master stays at
  the root.
- **Click** a card to watch that agent live, or a subagent row to watch the
  subagent. A press only becomes a drag after 4 px of movement.
- **Keyboard**: Tab to a card, Alt+Up / Alt+Down moves it, Enter opens it.

The drag and drop is a small reusable component with no dependencies,
`public/card-stack.js` and `card-stack.css` (usage at the top of the file).
`public/agent-cards.js` and `agent-cards.css` build the tree on it.

## Messages (who is talking to whom)

Built from every live transcript: your prompts (You → agent), messages sent
with SendMessage, messages received from other sessions, and subagents briefed
with the Agent tool. A message seen at both ends is listed once. A pipe address
no live session owns is shown as "an ended session". On Home, a run of
subagent dispatches from one parent folds into one row with its count.

## One agent, live

Click an agent or subagent in the tree. The left panel is its activity as it
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
touched its worktree, or Master if only Master did. It is inferred from
transcripts, so treat it as a strong hint, not a record.

## Refresh the tickets

The server cannot call a tracker itself. The Refresh button on the Tickets page (and the timer of a collection
whose tools only read) runs one short headless Claude turn per collection that rewrites
`data/sources/<id>.json`; see Collections by kind above. Home warns when the newest source is more than
6 hours old.

## License

MIT, see `LICENSE`. The bundled fonts in `public/fonts/` keep their own SIL Open Font License.
