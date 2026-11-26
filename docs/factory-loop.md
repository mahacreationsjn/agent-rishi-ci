# How the factory loop works

What the software factory and the dark factory do between the events you see: when work starts, how pull requests merge, what "Loop building" means, and what still comes to you. Every number here is the default; most can be changed in the factory **Settings**. For the full reference (every setting, merge check and API route) see [The software factory and the dark factory](software-factory.md).

```text
 Issue: yours, a trusted author's
 or (dark factory) the scout's
   │
   ▼
 Identify type
   │  waits for a free agent
   ▼
 ┌──────────────────────────────┐
 │ Bug: Reproduce ► Create fix  │
 │ Feature: Analyze ► Implement │
 │ Docs: Implement docs change  │
 └──────────────────────────────┘
   │  opens a pull request
   ▼
 Review, merge checks, CI ◄───┐
   │  changes asked ► Revise ─┘
   ▼  approved, every check green
 Merge: by you, or the queue
   │
   ▼
 Watch CI on main
```

## The factory loop

The factory is a loop on the Agent Rishi server. It runs a **pass every 30 seconds**, and also right after something happens: a factory agent finishes a turn, a pull request changes, or you press a button. The panel's last line says when the last pass ran.

One pass, in order:

1. **Kill switch.** If one is on, the pass stops here: nothing moves and nothing merges.
2. **A new day.** At midnight (local time) it writes the daily digest, resets today's merge count, and lifts a pause caused by the daily budget.
3. **Tidy up.** Work whose issue was closed on GitHub is settled, and work that failed for a reason outside its code (a session that died, a provider that dropped out) is put back.
4. **Per-item cap.** With a per-item cap set, work that has spent it stops: its running sessions are stopped and it waits for you (see [Spend per item](#spend-per-item)).
5. **Move every item one step:** CI watched on the default branch after a merge, builds, reviews and merge checks, then **the merge queue**: every pull request that is ready merges.
6. **Clean up.** Pull requests replaced by newer ones are closed, and finished work's sessions are archived.
7. **Budget.** If today's spend reached the daily budget, the loop pauses.
8. **Intake.** New issues become work items, and up to 3 per pass are sorted into a pipeline.
9. **Free agents** get work (see [Agent slots and priority](#agent-slots-and-priority)).
10. **The scout** (dark factory only) starts a round if one is due.

### What the header says

The chip in the factory panel and the Factory view shows the loop's state as **Loop** and one of:

| State | Means |
|---|---|
| **Verifying** | Something is in review, in the merge queue, or having CI watched on the default branch. This wins over Building. |
| **Building** | Agents are building, and nothing is in review. |
| **Scouting** | Only the scout's round is running (dark factory). |
| **Idle** | Nothing in flight. The loop still runs its pass every 30 seconds. |
| **Paused** | The loop paused itself. The reason is shown with it. |
| **Stopped** | A kill switch is on (the project's or the global one). |

The loop **pauses itself** for one of these reasons:

- **The daily budget is spent** ("daily budget reached ($10.00 of $10.00)"). It resumes by itself the next day.
- **Failures in a row**: 3 failed items or reverts in a row ("3 failed merge checks or reverts in a row").
- **A regression**: CI on the default branch failed after an automatic merge, and a revert pull request is open. The loop resumes by itself once the revert merged and CI on the default branch is green again, or, when no revert is on its way any more (you closed it and fixed the branch yourself, or merged it on GitHub), once CI on the default branch is green again (see [Watching main after a merge](#watching-main-after-a-merge)).

While paused, work already in flight keeps moving (builds and reviews finish), but nothing merges except a revert. Nothing new starts: no intake, no new builds, no scout round, no automatic recovery or re-review, except for a revert, which starts again and is put back as usual. **Resume** clears the pause and the failure count.

**Finishing open work (2 of 2 PRs open)** beside the state means the open pull request limit is reached (see [Agent slots and priority](#agent-slots-and-priority)).

## The pipelines

### Intake and classification

- **What's taken on.** An issue opened on GitHub after you switched the factory on, or one labelled `agent-rishi-factory`. Only issues by **trusted authors** are taken on: the GitHub account Agent Rishi uses, and the logins under **Trusted authors**. Everyone else's are listed as ignored, untouched, until you click **Let in**.
- **Identify type.** A GitHub label decides it (`bug`, `enhancement` or `feature`, `documentation` or `docs`). Otherwise one quick call to the utility model sorts it, and with no model available, keywords do. The issue gets a `factory:bug`, `factory:feature` or `factory:docs` label and a comment with its pipeline.
- **Waiting for an agent.** The item is queued until an agent is free.

### Reproduce or analyze, then implement

Each item gets its own agent session in its own worktree.

- **Bug.** The agent writes a failing test (or a probe) that shows the bug. If it can't, the work stops and the issue asks for what's missing. Otherwise the same agent makes the test pass and keeps it as a regression test.
- **Feature.** The agent checks whether it already works and fits the vision, then posts a spec with acceptance criteria on the issue. A request that already works, is unclear or is out of scope stops with a comment. Otherwise the same agent builds it to the spec.
- **Docs.** The agent makes the change straight away.

Every pull request carries its test results, and screenshots when UI files changed.

### Review

- **The independent reviewer** is a separate agent session, on a different provider from the builder when one is available (see [Reviewers and providers](#reviewers-and-providers)). It checks the pull request against the issue, the spec and the vision. A docs change that touches only documentation (prose and images) skips it; one that also touches config, manifests, lock files, workflows, tests or code does not.
- **The merge checks** run beside it: protected areas, size, CI, review, tests, test results, security and screenshots. CI on the pull request is the authority for the full test suite.
- **Revise rounds.** A review that asks for changes, or a failed check, sends the work back to the same builder to fix in the same branch: up to **2 revise rounds**. After that the item stops (see [When things go wrong](#when-things-go-wrong)).
- **Lessons.** With its verdict, a reviewer can record up to three general rules for the repository (a convention, a recurring mistake, a test to run or avoid). New builders and reviewers get the 20 most recent in their briefs, so a finding that keeps coming back stops costing a revise round. The panel lists them under **Lessons**, where **Forget** removes one for good. Only reviews of trusted work that nobody outside the trusted set commented on teach the factory, each new lesson is listed in the daily digest and waits a day before it goes into briefs, and **Learn from reviews** in the settings turns it off (see [Lessons](software-factory.md#lessons-the-factory-learns-from-its-reviews)).
- **An approval covers one head commit.** The reviewer approves the commit it was asked to review, and only that commit merges on the approval. If new commits land on the pull request after it (from the builder, a conflict resolution or anyone else), the review check goes back to waiting and the reviewer reviews only what changed since the approved commit. The item says why: "New commits since the approval (abc1234 → def5678): re-review running". Merging the default branch in, or a rebase that brings only its commits in, leaves the pull request's own changes as they were, so the approval stands.
- **Blocking findings and follow-ups.** A security concern the reviewer lists **blocks** the merge, so an approval can't list one: the reviewer asks for changes, or, when it can wait, makes it a **follow-up**. Follow-ups (up to 5 per review, each a title with an optional severity and area) never hold up the merge and never send the work back to the builder. Once the pull request merges:
  - **Dark factory:** low and medium follow-ups are **held for the scout** instead of filed. In its next round the scout weighs them with its area reviewers' findings, by severity and value against the vision, and files at most **Issues per round** in total, so follow-ups never grow the work faster than the scout's limit. A follow-up with `high` severity or in the `security` area is filed at once as an issue (labelled `agent-rishi-factory` and `agent-rishi-follow-up`, linked to the pull request) and doesn't count toward the round's limit. With scheduled scout rounds off (**Review when fewer than** 0) every follow-up is filed at once.
  - **Software factory:** they're listed on the item page under **Follow-ups**, each with a **File issue** button.

  A follow-up whose title matches an open issue is linked to that issue instead of filed again, and none is filed twice. See [Dark factory](#dark-factory) for how the held list is kept short.

### Merge

With every check green:

- **Auto-merge off** (the default): the pull request is **ready for you**. You get an inbox item and a comment on the pull request, and it waits in **Needs you** until you merge it on GitHub.
- **Auto-merge on**: trusted work joins [the merge queue](#the-merge-queue). Work let in from an untrusted author always waits for you.

### Watching main after a merge

After an automatic merge the factory watches CI on the default branch for up to **120 minutes**:

- **Green**, or no CI after 10 minutes, or still running after 120 minutes: the work counts as merged. A revert waits for green (see below).
- **Red**: a regression. The factory opens a revert pull request, counts a failure, pauses the loop and raises an inbox item.

**The revert** has its own merge rules, so nobody has to merge it by hand:

- **Test results:** its own CI run is the evidence (its description says so). It merges only once that CI is green.
- **Screenshots:** none needed. It restores UI that was reviewed with screenshots before.
- **Size:** not counted.
- **Review:** when the revert is exactly the inverse of the merge (checked by comparing the trees: the commit before the merge and the revert's own), an automated check stands in for the reviewer. A revert that isn't (an agent had to resolve conflicts to write it, or something else changed) gets the normal review.
- **Order:** it goes first in the merge queue. Neither the pause nor **Auto-merges per day** holds it.

Once the revert merged and CI on the default branch is green again:

- the regression's inbox item is resolved, and the loop resumes by itself;
- the reverted work goes back to its builder as a revise round, with the checks that failed on the default branch. The item's note says so ("Revise round 1 after the revert: CI on main failed after #42 merged (test); reverted in #43"). The builder brings its change back on top of the default branch, fixes it and opens a new pull request. This happens once per item: reverted a second time, it stays reverted.

Only a green run on the revert's merge commit resumes the loop by itself. When CI on the default branch doesn't say green there, the loop stays paused and you hear it in the regression's inbox item:

- **No CI after 10 minutes, or still running after 120 minutes:** the factory checks once more 10 minutes later. Still nothing, and the item becomes "main is red or unverified after revert #43: CI didn't report" (or "didn't finish"). The revert is still watched, so a late green run resumes the loop and sends the work back as above.
- **Red:** the revert didn't fix it. The item becomes "main is still red after revert #43: CI fails on its merge commit (test)".

Get the default branch green and **Resume** the loop: the reverted work goes back to its builder then, once, as if CI had turned green.

**A revert that can't merge** (CI red on the revert too, conflicts that still aren't resolved after 3 requests, other failed checks, or the agent writing it giving up) stops there. You get one inbox item, "main is red and the revert can't merge: CI failed on the revert too (test)", and the loop stays paused until you get the default branch green and resume it.

**A revert that couldn't start.** When GitHub can't open the revert by itself (the default branch moved on), an agent writes it. If that agent can't start (say, the runner timed out opening its session on a busy machine), or its session fails before it opened the pull request, the revert goes back to the queue and starts again on the next check, on the first free agent, ahead of all other work. A revert is never dropped because its issue was closed: it carries the reverted work's issue, which the merge it undoes usually closed. After 3 failed starts you get one inbox item, "main is red and the revert of #42 couldn't start: <reason>": **Retry** the revert, or fix the default branch yourself and resume the loop.

**When no revert is on its way any more** (you closed the revert pull request and fixed the default branch another way, or merged the revert yourself on GitHub), the loop doesn't wait for one: it resumes by itself once CI on the default branch is green again. The reverted work goes back to its builder only if its revert merged; otherwise its merge stands, and its note says so.

## The merge queue

With auto-merge on, a pull request whose checks all pass joins a queue, and on every pass the factory merges **every pull request that is ready**, seconds apart:

- **Order:** a revert goes first, then the pull request whose checks passed first.
- **Ready** means CI is green on its head commit, the review's approval covers that exact commit, and GitHub reports no merge conflict. The factory checks all three again right before each merge. If the head moved, nothing merges until the new commits are reviewed.
- **Behind the default branch?** It merges anyway, on its own green CI, the way it would if you merged it on GitHub yourself. GitHub reports a conflict when the two changes can't be combined, and CI on the default branch is watched after every merge (see [Watching main after a merge](#watching-main-after-a-merge)).
- **A pull request that waits doesn't hold up the others.** One whose CI is still running, or that waits for a re-review or a rebase, is passed over, and the ready ones behind it merge.
- **Seconds apart.** Each merge is a squash merge pinned to the head commit. After one, GitHub needs a moment to work out the next pull request against the new default branch, so the factory waits a couple of seconds and reads it again.
- **Held** while the loop is paused and when today's merges reached **Auto-merges per day** (5), reverts excepted, and while a kill switch is on.

**When is a pull request re-tested first?** Only when merging on its own CI could hide a clash that Git can't see:

- **Two dependency changes, or two migrations.** The pull request and the commits it is missing both changed dependency files (a lockfile, a `package.json`), or both changed database migrations. Git merges those without a conflict, but the result can be broken, so the pull request is tested on top of the other change.
- **The default branch is red.** Until CI there is green again, nothing merges on top of it untested.
- **Branch protection requires up-to-date branches**, or **Merge policy** is set to **Strict**. In both cases every pull request is re-tested, one at a time.

To re-test, the factory asks GitHub to update the pull request (**Update branch**, pinned to its current head commit). No agent is needed, and no new review while the pull request's own changes stay the same; only when the default branch changed lines right next to them does the reviewer look at the new head first. CI runs on the new head and the pull request merges once it is green. Its note says why: "Re-testing against main (it and main both changed database migrations ...)". The other pull requests keep merging meanwhile. One that changes the same kind of files waits for it ("merges after #12") and is then tested on top of it.

**How long a merge takes.** Seconds after the last check passes, plus up to 30 seconds for the next pass to see it. Five pull requests that are ready together merge within about a minute. A re-test adds one CI run of your repository, for that pull request only.

**What if two changes pass alone but break together?** Then CI on the default branch fails after the merge. The factory reverts the merge that broke it, pauses until the default branch is green again, and sends the work back to its builder (see [Watching main after a merge](#watching-main-after-a-merge)). That is rare, and it costs far less than testing every pull request twice.
**Merge conflicts** aren't a queue problem. The pull request's builder is asked to rebase and resolve them (this isn't a revise round), up to 3 times. If it still conflicts, the work is rebuilt once from the latest default branch.

## Agent slots and priority

**Agents at once** (2) caps every factory agent working at the same time: builders, reviewers, the scout and its area reviewers. Work in progress is never interrupted; only the next free agent is decided. When an agent is free it goes, in this order, to:

1. the agent writing a revert, started again after its start failed;
2. a reviewer for a pull request whose CI passed;
3. a rebase, a conflict resolution or a revise round;
4. a reviewer for a pull request whose CI is still running;
5. a builder carrying on after a failure outside its code;
6. a new build from the queue;
7. the scout and its area reviewers.

Within each, what waited longest goes first. **Reviews, fixes and rebases come before new builds**, so open work finishes before more starts. (Merging needs no agent: the loop does it.)

**The build queue's order:** a fix for a failing check on the default branch (and a revert) first, then the issues you and trusted authors filed, then the issues the scout filed. Within each, by priority, then oldest first. An item whose issue names files that an open factory pull request changes waits behind items that don't.

**PRs open at most** (the open pull request, or work-in-progress, limit: by default the same as Agents at once). With this many factory pull requests open, no new build starts and the scout files nothing; free agents go to reviews, fixes and rebases until one merges or closes. Builds that haven't opened their pull request yet count too. A fix for the default branch still starts. Pull requests of failed or escalated work, which wait for you, don't count.

**Auto-merges per day** (5) also limits builds: with auto-merge on, today's merges plus trusted work being built or verified stay under it.

## Reviewers and providers

**Who reviews.** With the reviewer provider on **Automatic** (the default), the review runs on a different provider from the builder's: Codex reviews Claude Code's work and Claude Code reviews Codex's, or any other available provider. With only one provider installed, the review runs on it and the item notes that. You can pick a provider and model in the factory **Settings**, under **Agents**.

**Available** means a provider can take new work now. It isn't when:

- it isn't installed, or the runner doesn't offer it;
- its CLI is older than Agent Rishi needs;
- it's signed out;
- it's at its usage limit (until the reset, or an hour when the reset time isn't known);
- a factory session failed on it because of the provider:
  - **it couldn't sign in** (an expired or revoked login, such as OpenCode's `Request failed: 401`): it's skipped until its login changes. That's when a later check sees a different login (it was signed out and in again, another account, a new expiry), when you press **Check now** on the factory panel or **Retry** a failed run on that provider, or after 6 hours, in case the change can't be seen (an expired token can look the same as a fresh one);
  - its CLI is too old, or the session couldn't start: it's skipped for 30 minutes, then tried again.

Providers are checked again every few minutes. These skips are kept across a restart.

**A provider that isn't signed in** gets one inbox item, such as "OpenCode isn't signed in (openai/gpt-5.5): run `opencode auth login`", instead of a "Run failed" item for each failed session. Later failures update that item (counting the attempts), and it closes by itself once a factory session on that provider completes a turn. After signing in, press **Check now** to use the provider again at once.

**When the reviewer's provider isn't available,** the **When the reviewer's provider is unavailable** setting decides:

- **Review on the builder's provider and model** (the default), in a fresh session;
- **Review on any available provider**;
- **Wait until it is available again**.

With no provider available at all, the review waits, and the item says until when.

**Builders** whose provider isn't available start on another one: the project's provider, then the agent role's, then any available one.

## When things go wrong

### Revise rounds and stopped work

- **After 2 revise rounds** the item stops with its pull request still open, and counts toward the [pause](#what-the-header-says).
- **Too large** is different: a revise round can't shrink work without cutting scope, so it skips revise rounds and doesn't count toward the pause. The project manager (PM) splits it into smaller issues, or allows it when it can't be split.
- **A reviewer whose checkout can't run the tests** says so instead of blaming the code. It gets the CI result and reviews again; if it happens a second time, a fresh reviewer takes over in a clean worktree.

### Automatic re-review and Retry

A stopped item's pull request often moves on: its builder resolves a conflict or fixes a last finding. When it has **new commits since its last review and green CI**, the factory sends it back to a fresh review by itself, up to **3 times per item** (never while paused). Approved, it merges as usual.

- **Retry** on a stopped item with an open pull request sends that pull request back to a fresh review with fresh revise rounds.
- **Rebuild** starts over from the first step; the old pull request is closed once the new one is open. Without an open pull request, Retry rebuilds.
- **Dismiss** marks failed work without a pull request as rejected.

### Infrastructure recovery

Failures outside the work's code never count toward the pause. The factory puts the item back by itself once the cause is gone, up to **3 times per item**:

- the builder's or reviewer's session died, or its provider dropped out: it goes back once a provider can work again;
- the builder's session is gone: a fresh builder picks the work up, or an integrator looks after its open pull request;
- **CI never started** on the head commit within 10 minutes: the factory starts it again (updating the branch, or pushing an empty commit).

### Spend per item

Every item shows what it **cost so far** on its Factory view card, its side sheet and its page. The figure covers every session that worked on it (builders, reviewers, integrators, earlier attempts) since it started, from the same ledger and with the same labels as the [usage reports](usage-and-costs.md): "≈" for estimates, "API-equivalent" for a subscription login.

The daily budget only stops new work: work in flight carries on even while the loop is paused. To stop one item from spending the day's budget by itself, set a **per-item cap** (USD and/or tokens) in the factory settings. The cap stops agent turns, not the steps that cost nothing. Each pass, an item in the queue, building or verifying that has spent its cap:

- has its running sessions stopped;
- in the queue or building, stops as **stuck** ("Spend cap reached: $5.10 of $5.00 for this item"), in your inbox (a recorded decision in a dark factory). It doesn't count toward the pause;
- in verification, keeps moving through the steps that start no agent turn: an approved pull request still waits on CI, joins the merge queue, is brought up to date by GitHub and merges. The review is often the turn that goes over, so finished work isn't thrown away. It stops as stuck only before a step that would start an agent turn: a revise round, a review or re-review, a rebase or an integrator;
- once stopped, gets no more agent turns while it waits: no rebases, integrators or automatic re-reviews. Its note says why.

**Retry** gives it a fresh allowance: the cap counts again from the retry, while its cost still shows everything it spent. The cap is checked each pass, so an item can go over it by what its sessions spend in one pass. The cards turn pink from 80% of the cap.

### What needs you

The **Needs you** lane in the Factory view, and the header's **need you** count, list only what a person has to move:

- **Review and merge PR #n**: a pull request that passed every check and that the factory doesn't merge itself (auto-merge off, an untrusted author), or an **escalation** because it touches a protected area.
- **Retry: stopped after N review rounds**: stopped work whose pull request is still open.
- **Retry or dismiss: stopped without a pull request**: work that stopped in the last day without one.
- **Answer the agent's question**: an agent asked you something or wants an approval.
- **Approve the spec**: with [Approve specs before building](software-factory.md#approve-specs-before-building) on, a feature's spec waits for you after Analyze. Approve it and the agent builds it, or ask for changes and it revises the spec. While it waits it holds no agent and no room under **PRs open at most**.

Your **inbox** also gets: specs to approve, pull requests ready for you, escalations, a paused loop (except for the budget), a regression (and a revert that can't merge), and work that's **stuck**: still conflicting after its one rebuild, refused by GitHub three times, waiting on CI that can never run (GitHub Actions off, or no workflow), or at its **per-item spend cap**.

**The factory handles by itself:** merge conflicts and rebases, pull requests behind the default branch, infrastructure failures, re-reviews after new commits, CI that never started, issues closed on GitHub, and changes that are too large (the PM's call).

## The two modes, side by side

| | Software factory | Dark factory |
|---|---|---|
| **Work comes from** | Issues by you and trusted authors | The same, plus the **scout** |
| **Who merges** | You, unless auto-merge is on | The same |
| **The PM** | Keeps up, asks you when unsure | Decides alone, records why |
| **Agents' questions** | Reach you | Answered at once |

### Software factory

You stay in the loop: work comes from issues you (and the people you trust) file, and with auto-merge off you merge every pull request. The PM hears about work that's ready, escalated or stuck. It retries stopped work, splits a change that's too large or allows it, and asks you when it's unsure. It lets in an untrusted author's issue only when you ask it to.

### Dark factory

The **scout** reviews the app against the vision and files the work itself. A round starts when fewer than **2** items wait and **6 hours** have passed since the last one (or right away with **Run scout now**):

1. **Plan.** The scout picks up to **2 review areas** for the round, out of eight: features, UI and UX, performance, code quality, test gaps, security, bugs and docs.
2. **Review.** Each area gets an **area reviewer**, a long-lived agent that keeps what it learned between rounds.
3. **File.** The scout files up to **3 issues** per round, already typed. They go down the pipelines like any trusted issue.

A round that runs over 3 hours is closed. No round starts at the open pull request limit, and the scout gets a free agent last.

**Held review follow-ups.** The low and medium [follow-ups](#review) of merged pull requests wait for the scout as findings. They count toward the round's **Issues per round** like its area reviewers' findings, and the scout may file from them alone without planning any review areas. The list stays short: a follow-up whose title matches an open issue or one already held isn't held twice, at most 50 are kept (the oldest low-severity ones are dropped first), and one the scout hasn't filed after 14 days is dropped. The scout's card on the factory panel shows how many are held; its list shows each with its source pull request and severity, with **File now** and **Dismiss**. The daily digest says how many were held, filed and dropped.

**Nobody waits on you.** The PM and the factory's agents never stop to ask: a question is answered with "decide from the vision", and an approval is denied. Each judgement call is recorded with `factory_record_decision` and lands in your inbox as **Factory decided** (low priority) and in the daily digest.

**What still comes to you:**

- **Protected areas** from the vision (and **Protected paths**): a pull request that touches one is escalated and never merged automatically. To keep design decisions with you, protect their files.
- **Deploy and release files** are protected unless you turn on **Allow deploy and release changes**, and agents are told never to deploy or release.
- **Work from untrusted authors** runs only when you let it in, and is never merged automatically.
- **Flagged decisions** (a protected area, a missing or contradictory vision, anything irreversible outside the code) arrive as **Factory needs you**, at high priority.
- **Stuck work**, regressions and a paused loop.

## Controls

| Control | What it does |
|---|---|
| **Kill switch** (factory panel or Factory view) | Stops the project's loop and every factory session: builders, reviewers, the scout and its area reviewers. Builds without a pull request go back to the queue; work with one keeps its place. Nothing moves or merges until you turn it off. |
| **Global factory kill switch** (Settings → General) | The same for every project. |
| **Resume** | Shown while the loop is paused. Clears the pause and the failure count. There is no manual pause: use the kill switch. |
| **Check now** | Runs a pass right away instead of waiting up to 30 seconds. Providers skipped because they [weren't signed in](#reviewers-and-providers) are tried again, and checked again in the background. |
| **Run scout now** | Dark factory: starts a scout round now, skipping the interval and the backlog threshold. Not while a round runs, the loop is paused or over budget, at the open pull request limit, without a free agent, or with a kill switch on. |
| **Digest** | Today's digest, now, in your inbox. |
| **Settings** | The limits below, the merge checks, the agents and the scout. |

The limits that shape the loop:

| Setting | Default |
|---|---|
| Daily budget (USD and/or tokens) | Required. The loop pauses until the next day when it's spent |
| Per-item cap (USD and/or tokens) | Off. An item that spends it stops and waits for you |
| Agents at once | 2 |
| PRs open at most | Same as Agents at once |
| Auto-merges per day | 5 |
| Pause after failures | 3 in a row |
| Revise rounds | 2 |
| Watch main CI | 120 minutes |
| Scout: Review when fewer than / Every | 2 waiting / 6 hours |
| Scout: Review areas / Issues per round | 2 / 3 |

## Glossary

- **Item.** One piece of work: an issue on its way through a pipeline, with its pull request, checks and sessions.
- **Step.** Where an item is in its pipeline: Identify type, Reproduce, Analyze, Implement, Review, Merge.
- **Pass.** One run of the loop, every 30 seconds.
- **Area reviewer** (a **lens** in the code). A long-lived agent that reviews one area of the app for the scout.
- **Scout round.** One pass of the scout: plan, review, file issues.
- **Revise round.** The builder fixing what the reviewer or a failed check asked for, on the same branch.
- **Merge check.** One of the checks a pull request must pass before it merges: protected areas, size, CI, review, tests, test results, security, screenshots.
- **Merge queue.** Pull requests that passed every check, merged in order, seconds apart.
- **Escalated.** Touches a protected area, so only you merge it.
- **Stopped.** Work that ended without merging: not reproduced, declined, out of revise rounds or dismissed. Retry runs it again.
- **Stuck.** Work the factory can't settle by itself; it's in your inbox.
