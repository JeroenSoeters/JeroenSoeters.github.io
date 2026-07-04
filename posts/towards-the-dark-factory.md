---
title: Towards the dark factory: Autonomous, isolated AI agents in software engineering
slug: towards-the-dark-factory
date: 2026-07-04
description: How we built "clanker infrastructure" — autonomous, network-isolated AI agents that pick up tickets, design, implement, and ship PRs through a locked-down container factory provisioned with formae itself.
image: /assets/img/dark-factory-og.jpg
banner: /assets/img/dark-factory.jpg
---

Late 2025 was an inflection point for AI in software development. Before that I spent most of my time writing code in an editor (vim of course, as God intended). I used AI mostly for auto-complete or generating small patches with the awesome [avante](https://github.com/yetone/avante.nvim) plugin. After the release of Opus 4.5 the workflow changed completely: I switched to Claude Code and never looked back.

## The human loop

On a high level my workflow looks something like this. I pick up a new task and kick off a brainstorming session with Claude, using the [superpowers](https://github.com/obra/superpowers) plugin. Claude writes a design spec, and I validate it across models by having Codex run an adversarial review of the design. I triage the findings and ask Claude to incorporate the ones worth acting on, and if the rework is substantive we rinse and repeat. Only then do I review the full spec myself. Once it holds up, Claude writes the implementation plan, and depending on complexity I either delegate the work to subagents or stay in the current session. Finished code goes through another cross-model review before I look at it myself, and then I either squash-merge the PR or send the agent back to fix what's left.

This flow works well for substantive features that benefit from an interactive design session. But at a startup with a small team touching many different technologies, which an IaC tool does by definition, a lot of the work is death by a thousand cuts. Many tickets are tiny: change the severity of a log line, fix the JSON parsing of resource X, remove some temporary migration code. The design and implementation of these is trivial, and stepping through it with a coding agent feels mechanical, not something that should need a human.

Over the last few weeks I set aside a portion of my time to tackle this, and the result is what we now call our **clanker infrastructure**. Clankers are autonomous agents that do exactly the mechanical steps outlined above.

---

## Building the machine that builds the machine

A clanker is built out of the same tools I use every day: Claude Code as the harness, a curated set of skills, various MCP servers, Codex for cross-model reviews. But instead of me orchestrating from the harness, clankers run on their own. They are triggered from our issue tracker and run headless in a container we control.

Every time a clanker does work we call this a turn. Proposing a design is a turn, opening a PR is a turn, answering a question is a turn. After each turn the clanker hands the baton back to a human. The container is disposable and nothing persists between turns; everything durable lives in our issue tracker and on the PR branch.

### The control plane

We use [Linear](https://linear.app) as our issue tracker. Linear is also the surface for our autonomous agent infrastructure. One of its features lets you provision *app users* through an OAuth app: workspace members that are @mentionable and assignable like anyone else, but backed by an app instead of a person. "Clanker" is one of these, and you hand it work exactly the way you'd hand work to a teammate, by assigning a ticket to it. Behind that single name is a fleet: every turn runs in its own fresh clanker, and many can be working in parallel.

This is what our Linear board looks like.

{{screenshot: 01-board.jpg | The board: Backlog → Design → Implementation → In Review → Done}}

When a ticket gets picked up from the backlog it first goes to "Design," where the technical design gets worked out and a tech brief is produced and attached to the Linear issue. Only once that design is approved does the ticket move to "Implementation," where the actual coding happens. Once the PR is up the ticket lands "In Review," and once merged it moves to "Done."

The column dictates *what* work Clanker will do. Assign Clanker in the "Design" column and it produces the tech brief; any blockers or decisions get escalated to the ticket owner, with Clanker commenting on the ticket and unassigning itself. Assign it in the "Implementation" column and it writes an implementation plan, delegates the coding to subagents, and opens a PR. From there you can also interact with Clanker through the PR, not just in Linear: request changes and it revises, approve and it merges the PR and moves the ticket to "Done."

{{screenshot: 02-assign-clanker.jpg | Assigning Clanker to a ticket}}

Another cool feature of Linear is agent sessions. Whenever an agent picks up work, it streams its thoughts and actions into a read-only thread on the issue, so you get a window into what's happening inside the session.

{{screenshot: 03-agent-session.jpg | The agent session thread: thoughts and actions streaming as the clanker works}}

### The Agent Bridge

Between Linear and the agents lives a small always-on orchestration service we call the Agent Bridge. It is an ECS Fargate service, and it is what turns activity on a ticket into a running agent. When you assign Clanker to a ticket, or later interact with it on its PR, that event reaches the Agent Bridge, which figures out what kind of turn to run and spawns a fresh container to run it.

Before it does, it mints a short-lived GitHub token scoped to just the repositories that turn needs, so the agent can push a branch and open a PR without ever holding a broad, long-lived credential. When the container is done it hands the baton back and exits.

{{diagram: agent-bridge-flow.svg | The Agent Bridge turns Linear and GitHub events into per-turn, disposable clanker containers}}

Each turn runs in its own container, spun up from a Docker image tailored to the Linear project the ticket belongs to, so the agent comes up with exactly what that turn needs and nothing more. Every container starts from a shared foundation: a global operating constitution, a `CLAUDE.md` that governs every turn in every project. It covers things like the turn model: one turn at a time, the auto-review pass, and the human gates it must never cross on its own. It also covers engineering practices: test-first development, matching the conventions of the surrounding code, YAGNI, and the like. And orientation: where our public and internal docs live and where to find things across our GitHub org. On top of that global base, each project layers in what *it* needs:

- the **GitHub repo or repos** associated with the Linear project;
- a **"local" `CLAUDE.md`** with repo-specific conventions, baked into the image;
- the **tools** the work requires, like the AWS CLI for the AWS plugin or Deno for our public hub, which is built on the [Fresh](https://fresh.deno.dev) framework;
- the **access** the container needs, such as credentials for a dedicated test CI account so the agent can debug failing tests there;
- the **MCP servers** scoped to that project.

The container arrives with exactly what it needs to do the job and nothing it doesn't. A formae core ticket, a formae hub ticket, and an AWS plugin ticket each get a different image, the right tooling, and the right context, selected automatically.

These containers can potentially feed attacker-influenceable text, like issue descriptions and PR comments, through an LLM that holds live credentials. That is a prompt-injection risk, so the boundary is locked down. The containers have no route to the open internet. They sit in isolated subnets, and every outbound request goes through a firewall with an explicit FQDN allowlist: the handful of endpoints the work genuinely needs (GitHub, the Anthropic and Codex APIs, Linear, the Go module proxy, AWS) and nothing else. Everything else is dropped and logged. Credentials are per-turn and least-privilege: that scoped GitHub token, a minimal IAM role, and secrets that only ever come from Secrets Manager.

> A side effect of cutting off the open internet: a clanker is useless for research tickets. We're fine with that. The clankers exist to execute well-specified work, not to wander an open solution space.

---

## Cross-model reviews

A model tends to be blind to the weaknesses in its own output, so before a design or a diff is accepted, a clanker hands it to a *different* model to review, the same on a design turn as on an implementation turn. We use Codex for this today. The findings come back, the clanker triages them, incorporates the ones worth acting on and dismisses the rest. If the resulting change was substantial, it reviews again, and keeps going until the work comes back clean. All of this runs through a custom skill we call auto-review.

We put a lot of effort into the triage step. Codex flags everything that could theoretically be a problem, whether or not it matters here, so its findings need weighing rather than blind trust. The skill carries the context to do that. It takes into account the guarantees the codebase already provides, for example that **formae** and its plugins are built on the [actor model](https://blog.platform.engineering/unlocking-concurrency-in-go-67a530807616), so a flagged race or shared-state hazard that can't occur under the actor model gets discounted. It verifies whether a feature is even live yet, so backwards-compatibility and migration findings get set aside when there are no users or data to break. The reviewer surfaces everything; the skill decides what actually matters here.

The one place we don't let that judgment soften anything is correctness and security. A finding there can't be waved away with a bare "rejected"; it clears only with a real fix, a concrete argument that it doesn't apply, or a human's sign-off. The same clanker wrote the code and decides which findings to honor, so it can't be allowed to quietly bury a serious finding about its own work.

---

## Meta-clanking

With all of this in place, I kept finding myself in the same situation. I'd be deep in a Claude Code session on some feature, for example a customer demo, and realize I needed a small change somewhere else, support for a new resource type, or a bugfix in a common library. So I'd ask Claude to file the ticket (Linear has an excellent MCP, which we've wrapped in a set of custom skills), assign Clanker, review the design it produced, move it to "Implementation," assign Clanker again, and approve the PR once I was confident it solved the problem.

That loop was itself mechanical, so it quickly became its own skill. `clank-through` takes an existing ticket and oversees a clanker end to end, walking it across the board and escalating to me only when something genuinely needs a decision. So there we are: agents delegating work to agents delegating work to agents 🤖. The dark factory as it stands: the line runs, the work ships, and a human only steps in when a clanker is genuinely blocked.

---

Of course, the entire clanker stack, the Agent Bridge, the containers it spawns, the firewall that boxes them in, is declared in Pkl and provisioned with [**formae**](https://github.com/platform-engineering-labs/formae) itself, on our own production AWS estate. The tool provisions the factory that builds the tool.
