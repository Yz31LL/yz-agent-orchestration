# User guide

This guide is for someone who has never seen Yz Agent Orchestration. It covers what the dashboard is, how to
start it, what each page shows, and what to do when something looks wrong. The README has the full
reference.

## 1. What it is, and what it is not

Yz Agent Orchestration is a local web page about the Claude Code sessions that work in **one** git repo on your
machine. It shows which agent is doing what, on which ticket and worktree, how far each piece of work has
got (your machine, dev, stage, prod), and the questions agents are waiting on you to answer.

- **It reads; it does not write to your repo.** It reads Claude Code's session files (`~/.claude`) and runs
  read-only git commands. The only git command that changes anything is `git fetch`, which updates
  remote-tracking refs. It never commits, checks out, stashes or edits a file in your repo.
- **One exception, and only when you turn it on and type your PIN:** **Send** (below, under Flows) pushes a
  branch that an agent says is ready and opens a pull request for it with the GitHub CLI. It never forces a
  push, never merges, and is off until you set `pr.enabled` in `config.json` and a send PIN (section 9).
- **It is for one person on one machine.** The server listens on 127.0.0.1 only. There are no accounts and no
  sharing.
- **It is not a tracker.** It can read tickets from one, but it never changes a ticket by itself.

## 2. What you need

- **Node 20 or newer.** There are no npm dependencies, so there is nothing to install.
- **git**, and the repo your Claude Code sessions work in.
- **Claude Code**, installed and logged in. The dashboard finds sessions in `~/.claude`. The chat, the answer
  relay, the explainer and ticket refreshes run headless Claude Code turns; by default they use the newest
  Claude Code binary bundled with an IDE extension (set `claudeBin` to use another).
- Optional: an **MCP server for your tracker** (the built-in converter is for Switchboard), and the
  **Playwright MCP server** if you want the chat agent to check things in a browser.

## 3. Install and first run

```
git clone https://github.com/Yz31LL/yz-agent-orchestration.git
cd yz-agent-orchestration
cp config.example.json config.json
```

Edit `config.json`. Only `repo` is required; anything you leave out uses its default.

| Setting | What it means | A sensible value |
| --- | --- | --- |
| `repo` | Absolute path of the git repo your sessions work in | `"C:/code/my-app"` or `"/home/me/my-app"` |
| `port` | The port on 127.0.0.1 (the `PORT` environment variable overrides it) | `4317` |
| `sessionCwdMatch` | A session counts when its working folder contains this text | Left out: the repo folder name |
| `coordinator` | The session name of the session that hands out work and merges it | `"Coordinator"` |
| `coordinatorLabel` | What the pages call that session; left out, the label `codingAgents` gives it, else Coordinator | `"Coordinator"` |
| `codingAgents` | Session name -> the label shown, for the sessions that write code | `{ "Coordinator": "Coordinator", "my-session": "Agent 1" }` |
| `aliases` | Session name -> label, for any other session | `{}` |
| `stopHour` | Local hour (0 to 23) at which the server stops itself, or `null` | `null` |
| `ticketPrefixes` | Your ticket id prefixes, in the order the ticket list ranks them | `["ABC"]` |
| `reminders` | Daily reminders: `{ "at": "HH:MM", "days": "weekdays" or "daily", "text": "..." }` | `[]` (none) |
| `claudeDirs` | More Claude config folders to read sessions from (a second account) | `[]` |
| `claudeBin` | Path of the Claude Code binary for headless turns | `""` (find it) |
| `factory.collections` | Your ticket collections (section 6) | `[]` until you connect a tracker |
| `factory.me` | Your user id in the tracker, for "mine" | `""` |
| `factory.chat` | The chat agent: `name`, `model`, `mode` (`"brief"` or `"fork"`), `forkFrom` (a session id to fork) | the defaults |
| `factory.relayModel` | Model for the short turn that delivers your answers | `"claude-sonnet-5-5"` |
| `factory.explainModel` | Model for the one-off explanations | `"claude-haiku-5-5"` |

Then:

```
npm start
```

and open http://127.0.0.1:4317.

**What you see when nothing is running yet:** Home says "No agents running." and "No messages yet.", Flows
says "No open flows.", and Tickets says "No collection" until you add one. Start a Claude Code session in your
repo and it appears within a minute.

## 4. A tour of the pages

The rail on the left holds the pages, in four groups. A thin line marks where each group starts; hover the rail
(or press Tab) to see the labels and the group names; the pin keeps it open.

| Group | Pages | What they are for |
| --- | --- | --- |
| **Work** | Home, Flows, Tickets, Generators | what you hand out and follow |
| **Agents** | Agents, Subagents, Orchestration bank, Routing | who does the work, and how it is shared out |
| **Quality** | QA, Lessons, Learn | checking the work, and learning from it |
| **History** | Timeline, Flow archive, Glossary | what happened, and the words for it |

At the foot, always in view: **Ask**, the **Alerts** bell, **Spend today**, **Phone on** (only while phone access
is on), **Settings** and the theme switch. On a short window the groups scroll inside the rail and the foot stays
put. **Ctrl+K** lists the same pages under the same group names.

On a narrow window (under 720 px, such as a phone) the rail becomes a bar along the bottom with only the pages
used most: Home, Flows, Tickets and Agents, then Ask and **More**. More opens a sheet with every other page in its
group, then Alerts, Spend today, Phone on, Settings and the theme switch. Escape, Close or a tap outside closes it.

### Home

Home is at `#/home` (the first link in Work; the brand mark at the top of the rail opens it too); the dashboard
opens on Flows.

- **Since** (only when something happened since you last pressed **Mark read**): flows that changed status,
  answers delivered, tickets that reached a new level or changed in the tracker, and commits per agent.
- One line saying how many things need you (questions, work only you can do, blocked flows), with **Open Human
  review**, which takes you to the box on the Agents page.
- **Agents**: one compact card per agent with its state, last action and tickets. Click a card to watch it live.
- **Subagents** (only when a subagent ran today): the subagents still running and the latest finished, each a link
  to its live view; **All subagents** opens the page.
- **Messages**: who is talking to whom: your prompts, messages between sessions, and subagents being started.

### Flows

The landing page (`#/`). A flow is an agent's account of one request: steps, checks, questions for you, and
notes, each with an environment and proof (section 5). Every flow has a **route**, the agents it passes through
from the Request to the Output: **build** for a code change (the coordinator, the agent, QA, Push), **review** for a
code review by the chat agent, **ask** for a question or an investigation. Each card shows that route as a strip of
steps, done, current (in the accent) and upcoming, and an opened flow shows it under its title; click a step to see
it on Agents, on the QA page, or on the Output. A flow started before routes says **route not set** until its agent
sets one.

- The questions agents ask are not listed here: they are in **Human review** on the Agents page. An open flow
  still asks its own questions on its Output and Status.
- **The board** has a card per open flow, grouped by agent. A card is short on purpose: the title, one line
  of what happened last, one word for where it stands (**waiting on you**, **blocked**, **ready to send**,
  **PR open**, **merged** or **done**), the agent and a thin progress bar. Click one to open it.
- An opened flow shows its title with three view tabs beside it, then the why (shortened to its first
  sentence with **more** when it is long), then one quiet line: agent, tickets, env, status, when it changed.
  The flow's status and **Drop** are in the `⋯` menu at the end of that line.
- The three views:
  - **Output** (the default) is one column, made to be read in ten seconds, like a story:
    - **Story**, first and largest: who did what, and why, one plain line each (*Agent 1 · Did Playwright
      testing.*), with *Why?* under a line that has a reason. A small `auto` in its corner means the agent
      wrote none and the dashboard made it from the steps.
    - **Before → Now**: how it was and how it is now, one line each, when the agent said so.
    - **Picture**: one visual, always (below).
    - **How to test**: cards in a row joined by arrows, each with a picture (the step's screenshot, or a
      quiet numbered placeholder), what to do, what you should **Expect**, and **I saw this**.
    - **Details**, folded away: the agent's full summary and its commits under **Changes**. It stays open
      once you open it.
    - **Send**, last, when the agent says the work is ready for the base branch (below).
    The `?` beside the view tabs says what each block is. Until the agent records its output, the page shows
    what the flow's own proof has, tagged `auto`.
  - There is always a picture, full width and centred. The agent's screenshots of the result; with no
    screenshot, **How it works**, the agent's diagram (boxes and arrows, a pill for a person or outside
    system, a box with a double top line for stored data, a diamond for a decision); with neither, a summary
    chart the dashboard draws from the flow, tagged `auto`: a solid box for done work (its first step,
    `+3 more` under it), a dashed box for the work left (`3 left`, orange with `1 blocked` when something is
    stuck), a diamond for each question with your answer on its arrow (orange and unlabelled while it waits on
    you), never more than 7 shapes, and one line of counts under it. With both screenshots and a diagram, a
    small **Screens | How it works** switch picks one. Charts read left to right, wrap to a second row joined
    by one continuous line, and never cut a word in half. Click a box of the summary chart to see that step on
    Status.
  - Tick **I saw this** on a test step as you try it. It is your own checklist: it stays in this browser
    only and never changes the flow. Steps the agent records again start unchecked.
  - **Request visuals** sits in the Picture's corner while the flow has no screenshot and no diagram: it asks the
    agent for one (a screenshot if there is something to see, else a diagram), then the test steps.
  - **Request test steps** (or **Ask again**) asks the flow's agent to drive the app and record each step
    with a screenshot. Add a note if you like, then **Send**. It costs one relay turn (section 7). The head
    then says `requested 3m`, or `not sent` (hover it for why) if the agent could not be reached; press
    **Ask again** then. If the flow belongs to Independent, the request goes into the Ask drawer instead,
    and you send it yourself.
  - **Status** lists what was **Built** (one line each with its proof mark; click a row to see its proof),
    what is **Left** and why, the **Decisions**, notes, and every screenshot. A link that opens a flow at one
    step lands here.
  - **Process** shows the chart of steps.
- **Send** (off until you turn it on and set a send PIN on the **Settings** page): when an agent has finished and recorded the pull
  request its work becomes, the last line of Output reads like `feature/dark-mode → dev · 8 commits · ready`
  with a **Send to dev** button. Read the Output above it first: that is the review. The button opens the pull
  request's title, text and commits right there, with what it will do: *This pushes the branch and opens a
  pull request into dev. It does not merge anything.* Type your **Send PIN** and **Open pull request** does it
  (if the branch or its text changed since you opened the review, it asks you to review again); the line then says
  `PR #12 open · checks passing` (a link to it). If something is wrong (the branch would not merge cleanly, a
  commit credits an AI tool, the GitHub CLI is not signed in, a pull request is already open), the line says
  **blocked** with each reason, and the button stays off. A refused push shows why, with **Try again**; it is
  never forced.
- **Proof states** of a finished step: **unproven** (no evidence), **claimed** (evidence, not checked by you),
  **verified** (you ticked it). Only you can tick a step; no command can.
- **Answering:** click Yes or No (or type an answer). The answer is sent to the agent that asked (section 7
  has the cost). The step then shows **sent**, or **not delivered · retry** if that agent is not running.

#### Do this by hand

Some work no agent can do for you: a decision, CI/CD settings, cloud setup, a console switch, a billing change.
The agent writes it out as steps and stops.

- An open flow shows **Do this by hand** above its views, with how many steps you have done (**2 of 5 done**).
- Each step says what to do, why, the exact place (a path, a page or the clicks to get there) and what you should
  see when it worked. A value to paste sits in a box with a **Copy** button.
- Tick each step when it is done. Your ticks are saved on the flow, so they survive a reload and the agent
  rewriting the flow. If the agent changes what a step asks, that step waits for you again.
- When every step is ticked, **Mark the flow done** finishes it. With Senior on the pipeline it says
  **Senior reviews it next** instead: the flow is done once Senior passed it.
- A flow that needs you but has no steps yet says so, with one button: **Ask the agent for steps**. It sends the
  agent a message the same way as Request test steps (about $0.30). The page never makes up a step.

#### Archive, Delete and the flow archive

- Every card on the board has **Archive** and **Delete** at its foot; an open flow has them in its `⋯` menu too.
- **Archive** puts a flow away without changing it. It leaves the board and the alerts. If its agent asks you
  something new, it comes back by itself.
- **Delete** also takes a flow off the board, and its agent is told to stop. If that agent may still be working on
  it, the card (or the menu) asks first. A toast offers **Undo**.
- Nothing is lost by either. Both go to the **flow archive** (**Flow archive** in the rail, or **Flow archive · N**
  under the board), in two groups: **Archived** and **Deleted**. Nothing leaves it by a timer.
- In the archive, a search box filters by title or ticket id. Click a title to read the flow: it opens with a
  banner saying it is archived or deleted, and nothing in it can be changed. **Restore** puts a flow back.
- **Delete for good** (Deleted only) removes the flow and its screenshots. It asks first in the row, naming the
  flow, and cannot be undone.
- The pipeline score still counts archived flows. Deleted flows are left out.
- Only you archive or delete flows. Agents cannot.

#### Completed: your sign-off on an output

- A flow that reached the **Output** waits for your sign-off. Its card, its chip on the Agents diagram and its row in
  the Output list carry an amber dot and the words **Mark it completed**.
- Mark it with **Completed**: at the end of the flow's **Output** tab (after Send), or with the tick on its row in the
  Output list (open **Outputs** on the right of the Agents page). **Mark all completed** does every waiting one at
  once. Each asks once, in place, before it does anything.
- A completed flow goes to the **flow archive**, labelled **Completed** with its date, and leaves every board: Flows,
  the Agents diagram, Human review, Home and the Log (the Log's **Completed** chip shows them). The pipeline score,
  Pipeline time and Pipeline tokens still count it exactly as before.
- Changed your mind? **Uncomplete** in the flow archive puts it back on the boards.
- Archiving is not a sign-off. An output you archive without marking it completed still counts as waiting: it stays
  in the Output list (with an **Archived** mark) and in the reminders, and its archive row has the **Completed** tick.
- Only you mark a flow completed. Agents cannot, and they never ask you to.
- The reminders: while outputs wait, the Agents page (over the diagram) and Home say how many, with **Show them**.
  After 2 days unmarked the line becomes a notice and the Output box says how many are overdue. Once 7 wait, the Ask
  drawer and **Pass a task** on the Tickets page remind you to mark them before a new request (you can still send).
  The two numbers are `outputs.warnAfterDays` and `outputs.max` in `config.json` (see the README).

### Generators

Two tools that write for you, picked with the two pills at the top of the page (the rail's **Generators**, or
`#/generators`). It always opens on the first one.

- **Prompt generator** (it was called Brainstorming): write a rough idea, press **Generate**, and get back a prompt for
  any AI in six labelled parts, ready to paste.
- **Standup creator** (`#/generators?tool=standup`): press **Generate** and it writes your stand-up, in the format you
  send: each ticket as its name and link with a few short lines under it, then **Blockers** (only what needs someone
  else), then **What's next**. Pick **Daily** (the last working day until now; on a Monday that starts on Friday) or
  **This week** (the last seven days, in your weekly template with Name, Project and the dates). It reads your commits
  on every branch, the pull requests merged into dev, your branches not merged yet, the SAVED ticket list (its date is
  shown, so refresh it on Tickets when it is old) and the flows. **Copy** copies the stand-up exactly as shown.
- Each view starts empty every day and keeps today's stand-up across a reload. Every stand-up is kept in the **Date
  archive** under the box: days by month, **Go to a day** to jump to one, and **Ticket** (type `FLA-886`) to see every
  day a ticket came up, with the lines about it. The files are on your machine, one per day, in `data/standup/`.
  Set your name, project and ticket link pattern in config.json's `standup` block (the README lists the keys).

### Tickets

The page for a ticket collection from your tracker (section 6). The chip says when it was last read;
**Refresh** reads it now.

- **Orchestration grid:** agents across, levels down (Local, Dev, Stage, Prod). Each cell holds the tickets
  that agent built which got that far and no further. Hover a ticket for its commits and flows.
- **Tickets** (folded): the table, with the board state, the owner, and a **code review mark** (Code reviewed,
  Needs review, No code yet, Not from codebase). Filters are checkbox dropdowns.
- **Worktrees** (folded): every worktree with its branch, agent, uncommitted files and how far it got.

### Timeline

What each agent did on each task, as a flowchart built from the transcripts and git: prompts, reads, edits,
tests, messages, commits and merges. Pick a window (2, 8 or 24 hours, or everything), zoom with Ctrl and the
scroll wheel, and click a node for details.

### Agents

The orchestration as a pipeline diagram, from **Request** to **Output**: the coordinator, each producing
agent, **QA** and **Push**, with every ticket as a chip on the step it stands at now. Click a step for its
details below the diagram; for an agent that is its card, with its subagents and a **Progress report**.

- **Human task** is you. It sits to the right of Agent 1, in the same row. Work with no code changes goes there
  (the dashed `no code changes` lane). A flow with by-hand steps waits there until you tick them all; anything else
  passes straight through to the Output. The box says what waits on you (for example **8 questions**, **2 by hand**)
  and shows up to three flows standing there. Click it, or press Enter on it, to jump to **Human review**.
- **Senior** (only when config.json sets `pipeline.senior`) sits to the right of Human task. It reviews work with no
  code to test: CI/CD setup, cloud console changes, commands run in a terminal, account settings. Once you ticked every
  step, send Senior a message naming the flow. A pass sends the flow to the Output. A failure sends it back to you:
  its reason shows at the top of the flow's **Do this by hand**, and the steps to redo say **Do again**. Senior always
  runs on Opus at high effort, and never changes anything itself. Click
an agent's card on Home, or a subagent row in its details card, for its **live view**: its activity as it happens, each
edit as a diff, the uncommitted changes in its worktree, and **Draft report**, a Markdown summary of a time
window built from the transcript and git (no model writes it).

#### Pipeline time

Under the **Pipeline score**, **Pipeline time** says how much work the agents finish and how long it takes. It counts
over the same period as the score: the score's **7 days | 30 days | All** switch sets both.

- **Finished**: tickets finished in the period, and other jobs (finished flows with no ticket). Finished means what
  the score calls delivered. A ticket finished twice counts once.
- **Per day**: finished work divided by the days in the period, today included.
- **Per hour**: finished work divided by the hours in which the agents did something, so nights and weekends with
  no work do not lower it. The line under it gives the rate round the clock as well.
- **Time per job**: from when a flow was started to when it finished, over every finished flow (jobs with no ticket
  included). The big number is the median (half the finished jobs took less), so one very slow job does not hide
  many quick ones; the mean, the fastest and the slowest are under it.
- **Waiting on you**: how long flows waited on your answers and by-hand steps.
- **Where the time goes**: one bar of how long work spends with the coordinator and planner, the producer, QA,
  Security, Human task, Senior and in reworks, with a table of the same numbers.
- **Finished per day**: a bar for each day (each week for All). Hover or focus a bar for its day and count; the left
  and right arrow keys move along the bars. **As a list** shows the same as text.
- **By agent**: what each agent finished, its time per job, per day, and how often its work was sent back.

**Minutes | Hours | Days | Auto** shows every time in that unit (Auto picks the one that fits); anything under a
minute shows in seconds whatever you pick. The rates do not change: Per day always counts a day and Per hour an
hour with work. In Minutes their small line adds how often one finishes, for example **1 every 95 min**. The choice, and the block folded to one line, are remembered in this
browser. With fewer than 3 finished flows the numbers say **Too few to trust**; with none, the block says nothing
finished yet instead of showing zeros. Every number comes from times the flow files store; **How it is counted**
says how, and names what cannot be timed.

#### Pipeline tokens

Under **Pipeline time**, **Pipeline tokens** says how many tokens this project's Claude Code sessions used, and what
those tokens would cost at API prices. The score's **7 days | 30 days | All** switch sets it too. It reads the
sessions' own records (the transcripts) and never changes them.

- **Tokens used**: every token in the period, with the four kinds under it: new input, output (what the agents
  wrote, their thinking included), cache writes and cache reads (input stored in, and read back from, the prompt
  cache).
- **Estimated cost**: what the API would charge for those tokens, from a price per model. On a subscription plan
  you are not charged per token, so read it as a yardstick, not a bill. A model with no price is named here and left
  out; with no price for any model there is no dollar figure.
- **Per finished job**: every token in the period divided by the tickets and other jobs Pipeline time counts as
  finished. It is an average: work not finished yet is in it too.
- **Cache share**: how much of the input was read back from the cache. Cached input costs a tenth of new input or
  less, so a high share keeps the cost down.
- **The dashboard's own runs**: what the dashboard's own chat, relay, refreshes and Generators cost, in real dollars.
  These are exact; the tiles before it are estimates, and the two are never added together.
- **Per day**: a bar for each day (each week for All), in **Tokens** or **Dollars**. Hover or focus a bar for its
  day and value; the arrow keys move along the bars, and **As a list** shows the same as text.
- **By model**: the tokens and estimated cost of each model, and the price used.
- **By agent**: one row for each agent the dashboard shows (Master, Agent 1, QA, Security and the rest), counting
  its own replies and those of the subagents it started; the line under it says how much of that was subagents.
  Hover any number for the exact count.

Numbers read like **12.4K**, **3.1M** and **1.2B** (thousand, million, billion). The first time the dashboard
starts it reads every transcript once, which takes a few seconds; until it is done the block says how far it got,
and after that it reads only what was added. **How it is counted** says what counts, what does not, and where the
prices come from.

**Prices change.** The built-in prices were read from Anthropic's public pricing page on 2026-11-25. To keep them
current, or to add a model, set `tokens.prices` in `config.json` (see the README) and restart the dashboard.

#### Human review

Under the diagram, the **Human review** box lists everything that cannot go on without you, newest first. Its head
says how many of each kind wait (for example **13 questions · 2 by hand · 60 tickets**), and the chips under it
(**All**, **Questions**, **By hand**, **Blocked**, **Tickets**) show one kind at a time. It opens on Questions while
there are any, and remembers your choice in this browser. The number on **Agents** in the rail and the page head's
**N waiting on you** count questions and by-hand work only: what keeps an agent waiting. Clicking the pill opens
the box.

- **Question**: an agent asked something. Answer it right in the box with Yes and No (or type an answer).
- **By hand**: work only you can do (CI/CD, cloud setup, a console setting), with how many steps are done.
- **Blocked**: a flow its agent marked blocked.
- **Ticket**: a ticket marked no code yet or not codebase work that no flow covers yet. **Ask for steps** starts a
  flow for it and asks the agent to write the steps for you (one message, about $0.30); they then show under
  By hand.

Each row says which agent waits, for how long, and why in one line. Click a title to open it at the right place:
the question in its flow, the by-hand steps, or the ticket, which lands at the top of the screen. The address
then names the flow, so a reload opens it again. When nothing waits on you the box says so in one line. With many
rows it scrolls inside itself.

### Subagents

Every subagent a session started to do one task, from sessions that still run and ones that have
ended, for today or up to the last 7 days. **Builders** worked in a worktree or made a commit; **Lookups**
only read or searched. Each card shows the task, its state (**Working**, **Stuck** after 15 quiet minutes,
**Done**, **Stopped** when it ended without a final report and may need resuming, or **Failed** when its
last reply was an error), its worktree, branch, tickets and pull
requests with their state from GitHub. **Report** unfolds a finished subagent's final report with **Copy**,
**Flow** opens the flow that tells its work, and a quiet **no story** marks a builder that recorded none.
Click a card to watch that subagent in the live view. Home shows the subagents still running and the latest
finished in a small strip, and the Tickets grid names the subagent that built a ticket on its chip.

### Settings

The gear above Theme opens **Settings**. It has two parts:

- **Sending**: the switch `Send to dev`, the branches it may open pull requests into, and your **send PIN**.
  With no PIN yet, type one twice and press **Set PIN**. Once one is set you can **Change PIN** (the current
  one, then the new one twice) or, if you forgot it, **Forgot it? Reset**.
- **Your setup**: what the dashboard watches and what your sessions are called, read-only. Change these in
  config.json, then restart the dashboard.

**Why a system window asks you to confirm.** The PIN keeps anything that drives the page (an agent's
browser, a website, a tab left open) from sending. So the changes that could let such a thing send (setting
the first PIN, resetting it, turning sending on, changing the branches) are confirmed in a Yes/No window from
your operating system, outside the browser, which a page cannot click. The page says *Waiting for you to
confirm in the window that just opened…* until you answer. If no such window can open on that machine, the
page tells you to use the terminal instead (`node tools/factory.mjs pr-pin`).

Each person sets their own PIN on their own machine; it is kept there (only as a hash) and never shared.
Type it only in your own browser, never in a window an agent is driving.

### Projects and the Orchestration bank

The box at the top of the rail shows the project you are looking at, such as **Flinki v2**, and under it the
orchestration it uses. Open it to switch to another project: everything on the dashboard changes to that
project, and the page reloads by itself once the dashboard has restarted (a second or two). If something is
still running (the Ask chat answering, an answer on its way to an agent), the switch does not happen and the
page says what is still running, so you can try again once it has finished.

**Add a project…** asks for a name, the folder of its git repository, how its sessions are recognised (left
empty, the folder name) and which orchestration it starts with: the same as the project you are in, or one
saved in the bank. **Rename or remove…** renames a project or takes it off the list; its flows, rules and
evidence stay on disk and its repository is not touched. The first project, the one in config.json, and the one
you are looking at cannot be removed.

The **Orchestration bank** in the rail keeps the ways your agents work together: who hands out the work, who
writes code, who tests, and each agent's specification and rules. Save the current one under a name, open one
to see its diagram and rules, rename, duplicate or delete it, or **Use on this project**. Before it switches, the
page says what will change, saves the orchestration in use now to the bank under a dated name (so you can
always switch back), and names any agent that has no session in this project yet.

### Glossary

Every word the dashboard can explain, searchable, with your own wording when you write one. Section 5 has the
details ("Plain story, marked words, and the glossary").

### The Ask drawer

**Ask** in the rail opens a chat with a Claude Code session (by default called "Independent"). It can read
the code, read your tracker, message other agents, write flows and drive a browser.

- **New chat** starts a **light** chat: a fresh session with a short brief. Cheap.
- **Start from my session (costs more)** forks the session named in `factory.chat.forkFrom`, so the chat
  starts with all of that session's context. The first message is expensive.
- When a reply wrote a flow, an **Open flow** button under it opens that flow.
- Its state shows as a dot and a word: **Working** while it answers, **Waiting** when it asked you something,
  **Idle** otherwise.

### Alerts, help and the rest

- **Alerts** (the bell): toasts and, if you switch them on, desktop notifications for new questions, flows that
  are blocked or done, new proof, an agent that stopped, and answers that could not be delivered (with
  **Retry**). The bell keeps the last 50.
- **The `?` buttons** explain a card: what its number counts, a legend, how it fills up.
- **Click to explain:** click any underlined term for a short explanation, or select any text and press
  **Explain**. Terms in the built-in glossary cost nothing; anything else is one small paid turn.
- **Ctrl+K** (Cmd+K on a Mac) opens the command palette: jump to a page, flow, ticket or agent, or run an action.
  Before you type, it lists every page under the rail's group names.
- **Spend today** (above Theme in the rail) shows what the dashboard's own headless turns cost today. Click it
  for the breakdown.
- **Reminders** pop up at the times in `reminders`, once a day.

## 5. Getting agents to narrate their work

Agents write flows with the dashboard's CLI. Paste this paragraph into the brief of every agent that works in
the repo, with `C:/path/to/yz-agent-orchestration` replaced by the absolute path of your copy:

> Every request gets a flow FIRST, before you change anything: `flow new <id> "<title>" --type build|review|ask`
> (or `flow write` with `"route": { "type": "build" }`). The type sets its route from the Request to the Output:
> build for a code change (Request, the coordinator, you, QA, Push, Output), review for a code review of a ticket
> (the chat agent's), ask for a question, an explanation or an investigation (Request, you, Human task, Output). Follow that
> route. If the plan changes, say so with `flow route <flow> --type ...`: the old route stays visible.
> Narrate your work on the dashboard as a flow: `node C:/path/to/yz-agent-orchestration/tools/factory.mjs flow …`.
> Start with `flow new --type` or `flow write` before you change anything, keep statuses current with
> `flow status`, attach proof with `flow evidence` (the commit sha, a test line, a screenshot), and put any
> choice that is the user's as `flow ask` instead of asking in prose, then stop at that step: the answer
> arrives as a message. Never act on another system (a tracker, a live site, a deploy) before the ask is
> answered Yes. When a piece of work is finished, record its output: a result screenshot (`flow result`), a
> short summary with the commits (`flow summary`), and manual test steps with a screenshot each
> (`flow test-step`). Every flow needs a visual: a screenshot for UI work, else a diagram of how it works
> (`flow diagram`), the big picture in at most 8 boxes, never file names. Show what changed as a before and
> after: a screenshot before you change anything visible (`flow result --before`), and one plain line each
> for how it was and how it is now (`flow change`). When the work is ready for the base branch, record the
> pull request with `flow pr` (the branch, the base, a plain-English title, and a body file that follows the
> repo's own pull request template); never push or open it yourself: hand the flow to QA. QA tests it, pushes
> the branch on a pass, and sends a failure back to you with its report; fix it and ask QA to test it again. The
> user then reviews the Output and sends it. The pull request text must not credit an AI tool. Pass `--by "<your dashboard label>"` (or set FACTORY_BY) on `flow new` and the output
> commands: the answers are sent to that name.

**`--by` must be the agent's label on the dashboard** (as in `codingAgents`, for example `Agent 1`): that is
where answers are delivered. `flow new`, `flow write`, `decide` and the output commands (`flow result`,
`flow summary`, `flow test-step`, `flow test-clear`) refuse to run without one. `flow new` also refuses to run
without `--type`, and a new flow written whole needs its `route`: nothing happens outside a defined flow.

A worked example (from any shell; `CLI` stands for `node C:/path/to/yz-agent-orchestration/tools/factory.mjs`):

```
CLI flow new dark-mode "Add a dark mode toggle" --type build --tickets ABC-101 --env dev --by "Agent 1"
CLI flow step dark-mode "Add the theme tokens" --status doing --by "Agent 1"
CLI flow status dark-mode n1 done
CLI flow evidence dark-mode n1 --commit ab12cd3
CLI flow check dark-mode "The toggle remembers the choice" --env dev --by "Agent 1"
CLI flow evidence dark-mode n2 --shot C:/temp/toggle.png
CLI flow ask dark-mode "Ship dark mode to dev now?" --yes "Turn it on for everyone" --no "Keep it behind the toggle" --by "Agent 1"
```

Each command prints one line, such as `dark-mode n3: waiting on the user`. On the page, the question appears
in **Human review** on the Agents page (and in the flow itself). Click **Yes**: the dashboard sends "Agent 1" a message with the
question and your answer, and the agent carries on. It can read everything back with `CLI flow show dark-mode`.

When the work is done, the agent records its **output**, which is what you see first when you open the flow
(the screenshots are files it saved, for example with the Playwright screenshot tool):

```
CLI flow result dark-mode --shot C:/temp/after.png --caption "Settings in dark mode" --by "Agent 1"
CLI flow summary dark-mode "Every colour is now a theme token, so one switch changes the whole page." --commit ab12cd3 --by "Agent 1"
CLI flow test-step dark-mode "Open Settings and click the moon." --expect "The page turns dark at once." --shot C:/temp/t1.png --by "Agent 1"
CLI flow test-step dark-mode "Reload the page." --expect "It is still dark." --shot C:/temp/t2.png --by "Agent 1"
```

Work with nothing to screenshot (an API, a job, a deploy, an investigation) gets a diagram instead, written
as one line of arrows; `[actor]`, `[store]` and `[decision]` set a box's shape, and `: label` names the arrow:

```
CLI flow diagram acme-report "[actor] Scheduler -> Report job: every night; Report job -> [store] Reports: saves" --by "Agent 1"
```

Keep it to the big picture: at most 8 boxes and 10 arrows with short names; a bigger one is refused and the
command says why. Each call replaces the diagram, and `--clear` removes it.

`flow summary` replaces the list of changes each time (repeat `--commit`, or comma-separate the shas).
`flow test-step --id t2 --replace` rewrites one step, and `flow test-clear` empties the steps to record them
again; record steps one command at a time, never in parallel. A `flow write` file with no `output` keeps the
stored storyboard (`"output": {}` clears it). If the steps are missing, press **Request test steps** on the
Output view and the agent gets a message asking for them (**Request visuals** when there is no picture yet).

When the work is ready to go to the base branch, the agent records the pull request; you send it from the
Output (section 4, Send):

```
CLI flow pr dark-mode --head feature/dark-mode --base dev --title "Add a dark mode to Settings" --body-file C:/temp/pr.md --by "Agent 1"
```

The body file follows your repo's pull request template. A title or body that credits an AI tool (a
Co-Authored-By line, Generated with, or naming one) is refused. `flow pr dark-mode --clear` removes it.

The other commands: `flow note`, `flow set` (status, title, why, tickets), `flow write <file.json>` (a whole
flow at once) and `flow list`. The README lists every option under "Agents writing flows".

### Plain story, marked words, and the glossary

**What agents write.** Each flow can open with a short story: a few plain lines of who did what, and why,
for a reader who was not there. For example *Agent 1: Ran the checkout with [Playwright]* and *Agent 1: Made
the payment call [idempotent]. Why? A double click could charge twice.* Agents add a line with
`flow say <flow> "<what was done>" --why "<the reason>"` (at most 8 lines, 140 characters each and 160 for a
why; a longer line is refused with *say it shorter*), rewrite one with `--id s2 --replace`, and start again
with `flow say-clear`. It is not a commit message: no file names, flags or ticket ids. A flow with no story
still gets one, at most 3 lines made from its own steps without any model: what is finished, what is being
worked on, and the decision waiting on you, which is credited to **You** (*You · To decide: Turn off the old
scheduler now?*). A dropped flow says *Dropped this work*. The name You is kept for what you did: an agent
cannot write a line as You.

**How words get explained.** An agent puts a technical word in square brackets the first time it uses it, in a
story line, the summary, a test step, a step title or the flow's why: `[idempotency]`. A word is letters,
digits, spaces and `. - _ + # /` only, 2 to 40 characters, never starting with a dash; anything else in brackets
stays plain text.
The page shows it without the brackets,
on a soft tinted background. **Hover it** (or Tab to it) and a small card shows what it means, where the
explanation came from (`built-in`, `learned`, `from the agent`, `yours`), and two buttons:

- **Ask the agent** sends the word and its sentence to the agent that wrote the flow, as one message (about
  $0.30), and the card says `sent to <agent>`. For Independent's own flows, and for words outside a flow, the
  question goes into the Ask drawer for you to send.
- **Edit** lets you write the explanation your way; **Save** keeps it, Escape cancels.

A click keeps the card open until you press Escape or click elsewhere. Words get their explanation in one of
four ways:

- the agent defines it itself, for free: `node tools/factory.mjs term "<word>" "<1 or 2 plain sentences>"`;
- the dashboard learns it **by itself**: the first time you open a flow with words the glossary does not know,
  the page asks once, and those words go to ONE small headless turn (`factory.explainModel`, Haiku by default,
  no tools at all), which is given the sentences the words came up in and the 5 nearest entries the glossary
  already has, so new explanations match the old ones. Meanwhile the word's underline breathes and its card
  says *Looking this up…*. If it fails, the card offers **Explain it** and **Ask the agent**. It asks at most
  once per flow every 10 minutes, and a word that failed is not asked again the same day;
- **Ask the agent** gets the agent to define it with `term`; the page picks the answer up on its next poll;
- you select 1 to 4 words anywhere and press **Explain**; that answer is kept too when it holds a real word
  (one of 4 or more letters that is not a common word like *ready* or *there*).

The dashboard's own words (*verified*, *claimed*, *unproven* and the rest of the built-in list) cannot be
redefined by an agent or by learning; only you can put one your way.

**The Glossary page** (the book in the rail, `#/glossary`) lists every word: search as you type (press `/`),
filter by **All**, **Learned**, **From agents**, **Yours** or **Built-in**, **Add a word**, and **Edit** or
**Remove** one (it asks *Remove?* first; built-in words cannot be removed). Each row says where it came from,
opens its **More** paragraph when it has one, and links to the first flow it came up in.

**What is saved, and where.** The built-in words stay in `public/glossary.json`. Everything learned or written
since lives in `data/glossary.json` (git-ignored, never committed), one entry per word with its explanation,
where it came from (`learned`, `agent` or `you`) and the last 20 flows it came up in. `GET /api/glossary` lists
both, merged.

**What it costs.** Learning a flow's words is one turn for up to 12 words, a fraction of a cent. At most 200
words and 100 turns a day; past that, learning stops until tomorrow (words already known still show). A word
the glossary knows costs nothing to show.

**Correcting an explanation.** Your own wording wins over everything: save it with **Edit**, on a card or on
the Glossary page (`POST /api/glossary/term`), and no agent or learning turn will overwrite it. Editing the short
explanation keeps its **More** paragraph. Removing a saved word
(`POST /api/glossary/remove`) brings back the built-in one if there was one; built-in words cannot be removed.

## 6. Connecting a ticket tracker

Add a collection under `factory.collections` in `config.json`. Each one ends up as
`data/sources/<id>.json` in one shape, and the Tickets page reads only that file. The dashboard cannot call
a tracker itself: **Refresh** runs one short headless Claude turn per collection.

- `"kind": "switchboard"`: the turn calls the one MCP tool listed in `tools`, and a converter in this repo
  builds the file, so the model never writes ticket data. Needs `project`.
- `"kind": "agent"`: for any other tracker. The turn gets your `ask` (for example "Open the board in the
  browser and read every card") and the tools you list, and writes the file itself.
- `filter` (optional): a `prefix`, a `range` of numbers and `extras`, to show only part of a tracker.
- `refreshMinutes`: `0` refreshes only when you press the button. A timer is allowed only when every tool in
  `tools` only reads (names like `list_*`, `get_*`, `search_*`, `read_*`); browser tools are button only.
  Every refresh is a paid turn.

Set **`ticketPrefixes`** to your id prefixes (for example `["ABC"]`). Then `ABC-123` and `abc-123` in commits,
commands and branch names count as tickets, and nothing else does. Without it the dashboard uses the prefixes
of your collections and sources, and failing those, a generic guess that can miss or invent a ticket now and
then (the README lists its limits).

## 7. What costs money

Reading git and transcripts is free. These run headless Claude Code turns, billed like any other session.
The sizes below were measured on one setup; yours will differ.

| What | When | About |
| --- | --- | --- |
| The chat | Every message you send in the Ask drawer, and the per-ticket actions on Tickets that go through it | $0.46 for a light chat first message, then a few cents; about $7 for the first message of a chat started from your session |
| The answer relay | Every answer delivered to an agent (and every Retry), and every Request test steps | $0.30 |
| Explain | A selection the glossary does not know | $0.001 |
| Learning words | A flow's marked words the glossary does not know, up to 12 per turn, at most 200 words a day | a fraction of a cent |
| Ticket refresh | Every press of Refresh, and every timer tick (the watchdog pauses a timer after 3 failures in a row) | one short turn per collection |
| Urgent notes to Master | Only with `insight.notifyMaster: "urgent"`: a failing health check or a gate stop, at most one every 30 minutes | $0.01 to $0.03 |
| Prompt generator | Every Generate on Generators | about $0.10 for the first run in an hour, then about $0.05 |
| Standup creator | Every Generate on Generators › Standup creator (nothing runs by itself) | about $0.11 (Opus 5.5, medium effort) |

**Spend today** in the rail adds up these turns. Your own terminal sessions are not counted.

## 8. Keeping it running

On Windows, run `tools\keep-alive.cmd` instead of `npm start`. It starts the server and starts it again 5
seconds after it stops. Its log is `%LOCALAPPDATA%\yz-agent-orchestration\server.log`; close its window to stop it.
To start it at login, press Win+R, type `shell:startup`, and put a shortcut to `tools\keep-alive.cmd` in the
folder that opens. Leave `stopHour` at `null` when you use it, or it restarts after every stop. Switching
project restarts the server on purpose; the loop starts it again at once.

On macOS or Linux, use your own service manager (launchd, systemd, or a terminal multiplexer) to run
`npm start` in this folder.

## 9. Security notes

- The server listens on 127.0.0.1, and only same-origin POSTs are accepted, so another website cannot answer
  your questions or drive the agents.
- A request with no Origin header (not from a browser) is accepted, so any local process on this machine can
  call the dashboard's routes as you. Only run agents and tools you trust here.
- The server answers only requests addressed to `127.0.0.1:<port>` or `localhost:<port>`, so a website that
  points its own name at your machine is refused.
- **Send** is the only thing that writes outside your machine, and it is off by default. Turn it on and set
  your send PIN on the **Settings** page (section 4). Without a browser, the terminal does the same:
  `node tools/factory.mjs pr-pin` (at least 6 characters, asked twice, nothing shown) and `"enabled": true`
  in the `pr` block of config.json. No restart is needed either way. What protects what:
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
    or edit config.json: Send gives it nothing new, and the PIN does not stop it. `pr-pin` refuses a PIN piped
    in only so a script cannot set one by accident; it is not a wall against an agent with a shell. Run only
    agents you trust.
  It runs a plain `git push` (never forced) and `gh pr create`, nothing else, and never reads or shows gh's token.
- The chat agent is limited to a listed set of tools: Read, Grep, Glob, a few read-only git commands, the
  dashboard CLI, messaging other sessions, your tracker read tools and the browser. It has no edit or commit
  tool. Treat it as trusted but constrained, not sandboxed: `git diff`, `log` and `show` can still write a
  file with `--output=<file>`. Every tool call it makes is shown in the drawer.
- Its Playwright browser can open the dashboard itself, so a chat agent misled by a web page could tick
  **verified** or answer a question. Add `--blocked-origins 127.0.0.1:4317` to the Playwright MCP server's
  arguments in your user-level MCP config.
- `config.json` and everything under `data/` (flows, screenshots, ticket snapshots, the chat transcript,
  spend) are git-ignored. They may hold private tracker data, so do not commit or share them.

## 10. Troubleshooting

- **No agents show up.** Check that the sessions run in your repo (or a worktree of it): a session counts when
  its working folder contains `sessionCwdMatch` (by default the repo folder name). Sessions run under another
  Claude account need that account's folder in `claudeDirs`. Sessions show under their own names unless
  `codingAgents` or `aliases` gives them a label, and only sessions in `codingAgents` get a branch on the
  agent tree and a column in the grid (the rest sit under Other sessions).
- **A banner says the repo folder does not exist.** Fix `repo` in `config.json` and restart.
- **The chat says "No conversation found".** The stored chat session is gone from Claude's files. The
  dashboard runs the same message once as a new light chat, so the next message works.
- **The port is in use** (`EADDRINUSE`). Another dashboard, or another program, is on that port. Stop it, or
  set another `port` (or `PORT`).
- **An answer shows "not delivered".** The agent that asked is not running, or its `--by` label does not match
  a live session. Start it again and press **retry** on the step (or **Retry** on the toast).
- **The tests fail with "config.json is missing".** The tests read `config.json`. Copy
  `config.example.json` to `config.json` first.
- **The dashboard stops by itself at a set hour.** That is `stopHour`. Set it to `null` to keep it running.

## 11. Lessons, the self-check and risk labels

These four help the agents get work right the first time.

- **Lessons** (the open book in the rail's Quality group, `#/lessons`). When QA, Security or Senior fails a piece of work, a
  small model run reads what it found and proposes up to 3 short lessons, such as *Write the failing test before the
  code*. They wait under **Waiting for you**: **Accept** keeps one, **Edit** lets you reword it first, **Reject** drops
  it. When a proposal repeats a lesson you already have, it says *Counts again as L3*, and accepting it adds one to
  that lesson's count. You can type your own under **Add a lesson**. **Retire** takes a lesson out of use; **Restore**
  brings it back. A run costs about $0.015. New failures are read on their own; older ones wait under **Failures not
  read yet** for **Extract lessons**. To stop the automatic runs, set `"quality": { "autoLessons": false }` in
  `config.json`.
- **Lessons in the brief.** When an agent starts a flow, it is shown up to 7 accepted lessons that match the task,
  most seen first, each with why it was picked.
- **The self-check.** Before an agent hands its work to QA, it answers a short checklist made of the house rules and
  those lessons, and says what is missing for any it could not tick. QA reads the answers and tests the claims. An
  opened flow shows the checklist with its ticks. The **Correctness** tile on the Agents page scorecard shows how often
  work with a self-check was right the first time, against work without one (it says *Too few to trust* until there
  are 5 of each). To make the self-check a rule, set `"pipeline": { "requireSelfCheck": true }`: QA then refuses to
  start testing code that has none.
- **Second opinion on the plan.** When the Planner hands out a plan, an opened flow shows **Second opinion**. Press it
  and a cheap model run (about $0.01) lists up to 5 things the plan may have missed, such as a missing test plan or a
  step that needs you. The builder sees them too. It never blocks anything. `"quality": { "critic": "auto" }` runs it
  once for every plan; `"off"` hides it.
- **Risk label.** Each flow gets a label from simple rules on what it touches: sign-in, payments, secrets, the cloud
  and CI, the database, deleting data, public pages. A card shows **Medium risk** or **High risk**, with the reasons
  when you hover it, and an opened flow says what the label asks for (a Security review, a Senior review, a deeper QA
  pass), and says so when that reviewer is not set up. You can write your own rules in `quality.riskRules`; the README
  shows the shape.

## 12. Predict and warn: estimates, alerts and what a flow cost

Nothing here asks a model or costs anything: every figure comes from what the flow files and the transcripts
already record.

- **What a flow cost.** Open a flow: its Output tab has a **Cost** block with its tokens and about what they cost at
  your configured prices (`Tokens so far` while it is open). The ? at the top of the flow says how it is counted.
  On the Agents page, Pipeline tokens says how much of the period is on flows and how much is not on any flow.
- **Estimates.** When a flow starts, the dashboard works out how long it will take and what it will cost from the
  most similar flows that finished before it: `about 1 h 10 min and $40, based on 5 similar flows`, with the range
  from the fastest to the slowest. With fewer than 3 similar flows it says **No estimate yet: too few similar
  flows**. Open a ticket on the Tickets page to see one for work not started yet. When the flow finishes, its Cost
  block sets the estimate against what it really took. **How good the estimates have been**, folded inside Pipeline
  time, shows how far off they were; under 5 flows it says Too few to trust.
- **Alerts.** A line at the top of the Agents page, and on Home, says how many there are; **Show them** opens the
  list. When one agent holds 3 or more flows far past their usual time, they are one alert: **Dismiss all for today**
  hides them together, and **The N flows** opens them one by one.
  - **Taking long**: a flow has stood at a step far longer than that step usually takes.
  - **Waiting on you**: the same for a question, a blocked flow or steps only you can do.
  - **Token spike**: a session used far more tokens in the last hour than it usually does.
  - **Long history**: a session re-reads a very long conversation on every turn, so each turn costs more. Its box
    on the diagram gets a small amber dot. **Copy handover request** copies a sentence you can paste to that agent,
    asking it to write a short handover note; then start a fresh session from that note.
  - **Daily limit**: only when you set one.

  **Dismiss for today** hides an alert until midnight; it comes back sooner only if it gets half as bad again.
  **Snooze for a week** is for a flow meant to stay open a long time, such as a tracking flow for a checklist: it
  stays quiet for 7 days, and comes back at once if the flow moves to another step.
- **Settings** (`config.json`): `alerts` (`stuckFactor`, `stuckMinMinutes`, `stuckHours`, `spikeFactor`,
  `spikeMinTokens`, `contextTokens`, `dailyUsd`, `dailyTokens`, `enabled`) and `estimates` (`enabled`,
  `nearest`). Restart the dashboard after a change.

## 13. Routing: suggestions for who does what

Open **Routing** in the rail's Agents group. Each rule says: when a task is this type, this risk or this size,
suggest this agent, this model and this effort, because of this reason. The first rule that fits wins, so put the
narrow ones first. Change a rule in place, move it up or down, add or remove one, then **Save rules** and confirm.

A suggestion is never an order. You see it in **Pass a task** on the Tickets page, and the agents see it when they
start a flow or the planner hands one out. Nothing is switched by itself. The planner, Security and Senior always
stay on Opus at high effort.

**What happened** counts the finished flows and shows, per task type and model, how often the work was right the
first time, the usual time and the usual cost. A row with fewer than 5 flows says Too few to trust. Cost shows only
when the dashboard records it per flow.

**Latest flows** shows each flow's task type. If it is wrong, pick the right one: your choice always wins.

**Sorting tickets.** On the Tickets page every ticket carries a small tag: Code, No code, Needs a person or Unsure,
with the reason when you point at it. The Sort chips filter by it. Open a row to correct the sort or the task type,
or to say a ticket flagged `Looks like FLA-761` is not a duplicate. Human review lists the tickets sorted as no code
or needs a person, and leaves out the ones sorted as code. To let a cheap model sort the unsure ones, set
`routing.intakeModel` in config.json (for example `claude-haiku-5-5`) and press **Sort the unsure tickets** on the
Routing page. One run costs about a cent.

## 14. Learn: what the work taught

- **Retrospective.** Mark a flow **Completed** and, half a minute later, its Output tab shows three lines under the
  story: what went right, what went wrong, what to do next time. About 1 cent each. A finished flow without one has
  **Write the retrospective**. The flow archive row folds them away under **Retrospective**.
- **Learn** (the light bulb, last in the rail's Quality group). Press **Run Learn** about once a week. It reads the scores, the QA
  reports and the retrospectives since the last run and proposes up to 3 rule changes, each with its evidence.
  **Accept** saves the rule as if you typed it on the Agents page; **Edit then accept** lets you reword it first;
  **Reject** asks why (optional), and the next run will not propose it again. A settings change is shown as text:
  apply it yourself. A run costs about 10 to 20 cents.
- **Verdict due.** Two weeks after any rule change, yours too, a card compares right first time, time, cost and QA
  failures before and after, and says Better, Worse, No clear change or Too few flows to tell. Choose **Keep**,
  **Revert** (the old text comes back) or **Wait two more weeks**. Nothing changes by itself.
- To switch it all off, set `"learn": { "enabled": false }` in `config.json`. `"autoRetro": false` stops only the
  retrospective on Completed; `"weekly": true` runs Learn by itself when you open the page, once a week at most.

## 15. Phone access

Use the dashboard from your phone: see what needs you, answer, tick, sign off, and talk to the coordinator. It
is off until you set it up, and only reachable on your own private network.

**Set it up once**, at the PC, in a terminal in the dashboard folder:

1. Install Tailscale on the PC and on the phone, and sign in to the same account on both. (Or keep both on your
   home Wi-Fi. Tailscale is better: it encrypts the link and works away from home.)
2. Run `node tools/factory.mjs phone-setup`. Pick the address it lists (the Tailscale one says so), read what it
   tells you, and type `yes`.
3. Run `node tools/factory.mjs phone-pin`. Type a PIN of 8 to 12 digits twice. Pick one you do not use for your
   send PIN.
4. Wait a few seconds: a running dashboard starts listening by itself, no restart needed.
5. On the phone, open the address `phone-setup` printed, such as `http://100.101.102.103:4318/phone`. Sign in
   with the PIN. Then add it to the home screen: on an iPhone, Share, then Add to Home Screen; on Android, the
   browser menu, then Add to Home screen.

**On the phone** there are four tabs at the bottom:

- **Agents**: how many things need you (questions, by-hand steps, outputs to sign off), the alerts (how many, and
  the first two), the open pull requests (the same list as the Pull requests block on the PC; a tap opens it on
  the phone, see below), and the pipeline as a list from Request to Output:
  each box with its agent's state (a green dot for busy, grey for idle, a ring for no session) and the flows standing
  there. Tap a flow to see its tickets, where it stands, its route, its open questions (with Yes and No), its last
  QA result, its story and its pull request. Close it with Close, Escape or a tap outside. Read only, apart from
  answering. At the bottom, how many flows finished today.
- **Needs you**: each open question with Yes and No (or a box for a written answer), and each by-hand flow with
  its steps to tick. An answer reaches the agent through a short paid turn on your PC, a few cents each. A
  question you have answered cannot be changed from the phone; do that at the PC.
- **Outputs**: finished work waiting for your sign-off, with its story. **Completed** asks once to confirm.
- **Master** (your coordinator's name): a chat. Your messages are on the right, its replies under each one on the
  left, newest at the bottom. A message is handed to the coordinator on your PC by a short paid turn (the line
  under the box says about how much), and it answers when it gets to it. The PC must be on. Each message says
  Sending, then Delivered to Master, or Not delivered with the reason and a **Try again** that puts your text back
  in the box. After delivery, **Master is working…** shows until a reply comes (for up to 10 minutes). One message
  at a time. The thread is the same on every phone signed in with your PIN: the last 30 messages, each with the
  replies that followed it, so it is still there after you sign in again. Replies written before your first phone
  message are never shown, and only its written words reach the phone, never its tools or files. Each message
  arrives with a fixed first line saying it came from your phone, and the coordinator then does nothing
  destructive, nothing that pushes, deploys or touches a live system, and no settings change until you confirm
  at the PC.

**Reading a pull request on the phone.** Tap an open pull request, on the Agents tab or in a flow, and it opens in
a sheet on the phone instead of leaving for GitHub:

- at the top, its title, the repository and number, Open or Draft, the branch going into its base, who opened it
  and when, and when it was read from GitHub, with a small **Refresh**;
- **Checks**: one plain line such as `Failing: 22 passed, 1 failing, 1 running`, then each failing or running
  check by name;
- **Review**: who a review is asked of, who approved, who asked for changes;
- **Description**: folded after 40 lines, **Show more** opens the rest;
- **Files changed**: the totals (`5 files, +324 −19`) and each file with its own; tap a file to see its changes,
  in a block that scrolls sideways on its own. Added lines are green and start with `+`, removed ones are red and
  start with `-`;
- **Conversation**: the latest comments and reviews, newest at the bottom;
- **Open on GitHub** (a new tab) and **Open the flow** at the bottom. Close, Escape or a tap outside closes it.

It is for reading only: approving, commenting and merging stay on GitHub. A long pull request is cut (the
description at 20,000 characters, 100 files, 300 lines of changes a file and 1,500 in all, the 30 latest comments)
and the sheet says so each time, with GitHub as the way to the rest. What it shows is at most a minute old:
Refresh within the minute shows the same copy. If GitHub cannot be read, the sheet keeps what it showed before
and says so in one line.

To have pull requests open on GitHub as before, tap the **gear** at the top of the phone, then under **Open
pull requests** choose **On GitHub**. The phone itself stores nothing, so the choice is kept with your sign-in
on the PC: it lasts until that phone signs out, and each new sign-in starts at **Here**.

A quiet line at the top says when the phone cannot reach the PC. When the session ends (after 4 hours by
default), the phone asks for the PIN again.

**On the PC**, Settings has a **Phone** card: on or off, the address to open, when the PIN was set, recent
sign-ins and lockouts, **Sign out everywhere** (do this if you lose the phone) and **Turn phone access off**.
While phone access is on, the foot of the rail shows a small **Phone on** badge, above Settings, that opens the card. Every phone sign-in,
lockout, PIN change and change to phone access in config.json raises a notice on the desktop, and a line in the
Log. A PIN changed without phone-pin is called out: if that was not you, turn phone access off.

**What to know about safety:**

- It is plain HTTP on your private network. Over home Wi-Fi the PIN and the session can be read by someone who
  can see the traffic, and anyone on the same network can reach the sign-in page; Tailscale removes that, because
  it encrypts the link. Do not turn it on for a shared or public network.
- It opens only while the PC is on the network it was set up on (the same adapter and subnet), and closes within
  seconds when the PC moves. Two home routers that use the same subnet cannot be told apart: Tailscale has no
  such gap.
- The PIN is the only lock, and it guards the ability to instruct a coding agent: treat it like a password. Five
  wrong tries lock phone sign-in for 15 minutes, for every device, even after a restart;
  3 lockouts within 24 hours turn phone access off until you turn it on again at the PC. Someone on your network could cause this;
  that is the price of a lock they cannot get around.
- Never forward the port on your router. It is not built to face the internet.
- The phone can do only the five things above. It cannot delete, archive, change settings or rules, send a pull
  request or run a generator.

## 16. Pull requests

When an agent finishes a coding task and opens a pull request, it shows in a small **Pull requests** block at the
top of the Agents page (under the Alerts line) and on Home. Nothing shows when there are none.

- The newest is clear, with a line under it: which agent, how long ago it opened, whether its checks pass, and
  whether it needs you: `waiting for your review`, or `ready for you to merge` (green and mergeable). A small dot
  in the margin marks one that needs you.
- Each one under it is smaller and fainter, as if fading into fog, so your eye lands on the newest. Point at a
  faded one, or Tab to it, and it comes back into full view. At most 5 show; `and 3 more` unfolds the rest.
- Click a title to open the pull request on GitHub in a new tab, or **Open the flow** for the work behind it.
- A pull request leaves the list when it is merged or closed on GitHub (within about a minute), or when you mark its
  flow **Completed**. The next one moves up and becomes the clear one.
- The dashboard only reads GitHub here, through the `gh` command, at most once a minute. If it cannot reach GitHub
  the list keeps what it knew and says so under it.
- The address `#/agents?prs` opens the Agents page scrolled to the list.

## 17. Suggestions and Health

**Suggestions** (rail › Quality › Suggestions) are improvements Master, your coordinator, proposes after reading the
whole orchestration. Each card says what to change, the evidence it saw (numbers, flows, alerts), the kind (rule,
setting, process, fix), the agent or setting it is for, and the effort.

- **Accept** keeps it as a note for you or Master to act on. Nothing changes by itself.
- **Accept and add the rule** shows on a rule for one agent: it adds the rule to that agent, the same as your own
  edit on the Agents page, and the Learn page gives it a verdict in two weeks.
- **Reject** takes an optional reason. Master reads it in its next look and does not propose the same idea again.
- Your decision reaches Master the next time it reads its digest. No message is sent and nothing is paid.
- The Suggestions link shows how many wait; Home and the top of the Agents page say so too.

**Health** (rail › Agents › Health) is the dashboard watching itself. Each check is OK, Degraded (something is off
but work goes on) or Failing (something is broken, or costing money for nothing). It repairs only four things by
itself, each safe and reversible, and shows each in the log at the bottom:

- a paid ticket refresh that failed 3 times is **paused** (press **Resume** once it is fixed; the line at the top
  of the Agents page says what it cost since it last worked, with the real error);
- deliveries to an agent that failed 3 times are **held** with no paid turn (press **Release** to send them);
- a damaged index or store is **copied aside** and rebuilt where the dashboard can;
- a background job that went silent is **started once more**.

Other dashboard copies left running for more than 6 hours are listed with a **Stop** button; nothing stops one by
itself. Only copies in a `.worktrees` folder count: the main checkout is your live dashboard and is never listed. The disk, config, server and agents checks only tell you (**Copy a nudge** copies a sentence for you to paste
into a stuck session). Switch any check off with its **On** box. In config.json, `healing.repairs: false` makes it
report only, `healing.enabled: false` turns it off.

Master can be told about failures straight away with `insight.notifyMaster: "urgent"` (one short relay turn each,
about 1 to 3 cents, at most one every 30 minutes, only while Master's session is open). Left at `off`, Master reads
what changed in its digest, for free.
