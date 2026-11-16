# Agent brief: narrate your work as a flow

Paste this into the brief of every agent that works in the repo (Master and the coding agents).

Replace `C:/path/to/yz-agent-orchestration` below with the absolute path of your copy of this
dashboard: agents run from the watched repo (and may run under another Claude account),
so a relative path would not resolve.

> Narrate your work on the dashboard as a flow: `node C:/path/to/yz-agent-orchestration/tools/factory.mjs flow …`.
> Start with `flow new` or `flow write` before you change anything, keep
> statuses current with `flow status`, attach proof with `flow evidence` (the
> commit sha, a test line, a screenshot), and put any choice that is the
> user's as `flow ask` instead of asking in prose, then stop at that step: the
> answer arrives as a message. Never act on another system (a tracker, a live
> site, a deploy) before the ask is answered Yes.
> Always pass `--why` on `flow ask`: one plain sentence on why you need this answer now (what it unblocks,
> what each choice leads to). The user reads it under the question everywhere the ask shows; an ask without
> one prints a warning, and the dashboard can then only say which flow and step it follows.
> When a piece of work is finished, record its output: a result screenshot (`flow result`), a short summary with the commits
> (`flow summary`), and manual test steps with a screenshot each (`flow test-step`). The user sees that first when they open the flow.
> Every flow needs a visual, and a flow with neither a screenshot nor a diagram is unfinished: for UI work a result
> screenshot (`flow result --shot`); for anything else (an API, a job, a deploy, an investigation) a diagram of how it
> works (`flow diagram`), the big picture only: at most 8 boxes, named the way you would to a colleague, never file names
> or commit subjects.
> Show what changed as a before and after: before you change anything visible, take a screenshot with
> `flow result <flow> --shot <file> --before` (for work with no screen, draw how it worked with
> `flow diagram <flow> "…" --before`), and when done say how it was and how it is now in one plain line each
> with `flow change <flow> --before "<how it was>" --after "<how it is now>"`.
> Record test steps one command at a time, never in parallel: each one rewrites the flow file.
> A `flow write` file with no `output` keeps the stored one; `"output": {}` clears it.
> Pass `--by "<your dashboard label>"` (or set FACTORY_BY) on `flow new` and the output commands: the answers are sent to that name.
> Tell the story of each flow in a few lines with `flow say` (at most 8; the page shows them first).
> Write for a reader who was not there. Say who did what in one short plain sentence, then why.
> Not a commit message: no file names, no flags, no ticket ids in the sentence.
> Use the right technical word, and put it in square brackets the first time, like [idempotency],
> so the dashboard can explain it. If the word is unusual, define it yourself with `term`.
> A message asking what a word means: answer it with `term`, in plain words, saying why it mattered for this work.
> When the work is ready to go to the base branch, record the pull request with
> `flow pr <flow> --head <branch> --base <branch> --title "<plain-English title>" --body-file <file>`, the body
> following the repo's own pull request template. Never push or open the pull request yourself: the user
> reviews the Output and sends it. The pull request text must not credit an AI tool: no Co-Authored-By line,
> no Generated with line, no tool named as an author.

For example (`--by` names the agent; `FACTORY_BY` does the same):

```
node C:/path/to/yz-agent-orchestration/tools/factory.mjs flow new abc-123-login "Fix the login redirect" --tickets ABC-123 --env dev --by Master
node C:/path/to/yz-agent-orchestration/tools/factory.mjs flow step abc-123-login "Write the failing test" --status doing --by Master
node C:/path/to/yz-agent-orchestration/tools/factory.mjs flow ask abc-123-login "Deploy the fix to dev?" --why "The test passes on the branch; dev is where QA can try it" --yes "Deploy it" --no "Leave it on the branch" --by Master
```

And once the fix works, its output (the screenshots are files the agent saved, for example with the Playwright screenshot tool):

```
node C:/path/to/yz-agent-orchestration/tools/factory.mjs flow result abc-123-login --shot after.png --caption "Signed in, back on the page I came from" --by Master
node C:/path/to/yz-agent-orchestration/tools/factory.mjs flow summary abc-123-login "The redirect now keeps the page you asked for." --commit ab12cd3 --by Master
node C:/path/to/yz-agent-orchestration/tools/factory.mjs flow test-step abc-123-login "Open a deep link while signed out." --expect "The sign-in page." --shot t1.png --by Master
node C:/path/to/yz-agent-orchestration/tools/factory.mjs flow test-step abc-123-login "Sign in." --expect "You land on the deep link, not Home." --shot t2.png --by Master
```

The story, a few plain lines the user reads first (the words in square brackets get explained on hover;
`--id s2 --replace` rewrites a line and `flow say-clear` starts again):

```
node C:/path/to/yz-agent-orchestration/tools/factory.mjs flow say abc-123-login "Reproduced the bug with [Playwright]" --by Master
node C:/path/to/yz-agent-orchestration/tools/factory.mjs flow say abc-123-login "Kept the page you asked for in the [redirect URL]" --why "Signing in used to drop it and send you Home" --by Master
node C:/path/to/yz-agent-orchestration/tools/factory.mjs term "redirect URL" "The address the sign-in page sends you back to once you are in." --flow abc-123-login
```

When the branch is ready for the base branch, record the pull request (the body file follows the repo's
pull request template); the user sends it from the Output:

```
node C:/path/to/yz-agent-orchestration/tools/factory.mjs flow pr abc-123-login --head feature/login-redirect --base dev --title "Keep the page you asked for after signing in" --body-file pr.md --by Master
```

Work with nothing to screenshot gets a diagram instead, in one line of arrows (`[actor]`, `[store]` and `[decision]`
set a box's shape; `: label` names the arrow into a box):

```
node C:/path/to/yz-agent-orchestration/tools/factory.mjs flow diagram acme-report "[actor] Scheduler -> Report job: every night; Report job -> [store] Reports: saves; Report job -> [actor] Team: emails" --by Master
```

What the user sees: the flow as a card on the Flows page (`#/flows`), and each `flow ask` in **Waiting on you** with your `--why` under the question and Yes and No; the answer is sent back to the agent as a message. An opened flow lands on **Output**: the result screenshot (or your diagram, or with neither a summary chart the dashboard draws from your steps), the summary with its commits, and the numbered test steps. If the user presses **Request test steps**, a message arrives asking for those steps: drive the app, then record each step with `flow test-step`. **Request visuals** (a flow with no screenshot and no diagram) asks for a screenshot or a diagram first.

The full command list is in the README, under "Agents writing flows".
