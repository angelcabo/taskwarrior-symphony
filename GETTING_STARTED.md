# Getting started: running Symphony on a repo

A practical, end-to-end guide to pointing Taskwarrior Symphony at one of your
repositories and driving autonomous coding work through it. For the architecture
and spec mapping, see [README.md](./README.md).

---

## Mental model (read this first)

Two ideas make everything else make sense:

1. **Symphony never edits your working copy.** For each task it creates an
   **isolated clone** of your repo in its own workspace directory, runs the agent
   there, and the agent commits to a branch in that clone. You review that
   workspace — your checkout is untouched.

2. **There are two state axes.** Taskwarrior's built-in `status`
   (`pending`/`completed`) is storage; the **`state` UDA** is the workflow lane
   *you* drive. You manage tasks by setting the `state` UDA. **Symphony only ever
   works states listed in `active_states`** (the example uses `todo` + `active`);
   anything else it ignores — which is how the `triage` staging lane works.

```
   intake           you review      Symphony        agent          you
   triage   ─────►   todo   ─────►   active  ─────►  review  ────►  done
   (staged,         (released)      (working,       (needs you)    (approved)
    ignored)                         auto-set)
                       ▲                                             │
                       └──────────────── todo ◄─────────────────────┘  (rework)
```

   `triage` is **not** in `active_states`, so Symphony leaves it alone until you
   promote it to `todo`. You don't set `active` yourself — Symphony sets it when
   it picks a task up (the visible lock).

---

## Prerequisites

- **Node ≥ 20** and **Taskwarrior 3.x** (`brew install task`)
- An agent CLI on your `PATH`: **`claude`** and/or **`codex`** (logged in)
- A git repo you want worked on

---

## One-time setup

```sh
# 1. Build Symphony and put the `symphony` command on your PATH
cd /path/to/taskwarrior-symphony
npm install && npm run build
npm link                       # now `symphony` works globally
                               # (or skip and use `node dist/index.js <cmd>`)

# 2. Add the UDAs Symphony needs to your Taskwarrior config (state / agent / branch)
./scripts/setup-taskwarrior.sh

# 3. (optional but recommended) a TUI board to watch/manage tasks
brew install taskwarrior-tui
task config report.board.columns id,state,agent,priority,project,description
task config report.board.labels  ID,State,Agent,P,Project,Description
task config report.board.sort    state+,priority-
task config report.board.filter  status:pending
# then:  task board     (CLI report)   or   taskwarrior-tui   (full TUI)
```

---

## Per-project setup

### 1. Add a `WORKFLOW.md` to your repo

`WORKFLOW.md` is the Policy Layer — **commit it to the repo** so it's versioned
with the code. Copy the example from this project as a starting point:

```sh
cp /path/to/taskwarrior-symphony/WORKFLOW.md ~/code/webapp/WORKFLOW.md
```

Then edit the fields you care about (full reference in the example file):

```yaml
tracker:
  filter: "status:pending project:webapp"   # scope this daemon to one project
  active_states: [todo, active]              # what Symphony will run
  terminal_states: [done, canceled]
  dispatch_transition: active                # visible lock; null = in-memory only

workspace:
  root: ~/.symphony/workspaces               # one subdir per task

agent:
  default_driver: codex                      # or claude (overridable per task)
  max_concurrent_agents: 2                   # how many agents at once

codex:
  sandbox: workspace-write                   # read-only | workspace-write | danger-full-access
  # dangerously_bypass: true                 # full autonomy (also lets the agent write back to Taskwarrior)

claude:
  permission_mode: acceptEdits               # or bypassPermissions for full autonomy

http:
  enabled: true
  port: 4517
```

### 2. Tell the clone hook which repo to clone

Each workspace is created by the `after_create` hook, which clones
`$SYMPHONY_REPO_URL`. Point it at your repo (a local path is fine for fast local
iteration; use the git remote if you want the agent to push branches / open PRs):

```sh
export SYMPHONY_REPO_URL="$HOME/code/webapp"        # local clone (committed state only)
# export SYMPHONY_REPO_URL="git@github.com:you/webapp.git"   # for push/PR workflows
```

### 3. Validate

```sh
symphony validate -w ~/code/webapp/WORKFLOW.md
```

---

## Adding and managing work

Feed work in by creating `todo` tasks. You normally only ever set `state:todo`
(and dependencies); Symphony and the agent drive the rest.

```sh
# add work
task add "Add a /health endpoint returning 200 OK" \
     project:webapp state:todo agent:codex priority:H +backend

# block one task on another (Symphony skips a `todo` task with unfinished blockers)
task 12 modify depends:11

# reprioritize / annotate
task 12 modify priority:M
task 12 annotate "see RFC in docs/health.md"
```

### What the states mean

| `state` | Meaning | Who sets it |
|---|---|---|
| `triage` | staged backlog — **Symphony ignores it** until you promote | **you** / intake script |
| `todo` | released; ready to be picked up (skipped while it has open `depends`) | **you** |
| `active` | Symphony is running an agent on it now | auto |
| `review` | agent handed off — waiting for your review/approval | the agent |
| `done` | finished/approved → workspace reclaimed | **you** (or agent) |
| `canceled` | abandoned (terminal) | you |

- **`triage` is your manual gate.** Stage tasks there (by hand or via the intake
  script below), review, then `task <id> modify state:todo` to release only the
  ones you want the agents to run. Symphony never touches `triage`.
- **Blocked** isn't a state — it's a dependency (`depends:`). It clears
  automatically when the blocker finishes.
- The state set is **yours to change** — edit `active_states` / `terminal_states`
  in `WORKFLOW.md` and the UDA values in your taskrc to add lanes (e.g. an
  `approved` gate). Anything not in `active_states` is ignored by Symphony.

---

## Turning raw notes into a backlog

Let an agent parse freeform notes into structured tasks — it only *triages*, it
doesn't do any engineering work. Tasks land in `triage` (which Symphony ignores),
so you review before anything runs:

```sh
PROJECT=webapp ./scripts/notes-to-backlog.py notes.md
pbpaste | PROJECT=webapp ./scripts/notes-to-backlog.py            # from clipboard
DRY_RUN=1 PROJECT=webapp ./scripts/notes-to-backlog.py notes.md   # preview only
```

Then review and release the ones you actually want worked:

```sh
task state:triage list             # or browse in taskwarrior-tui
task 14 modify state:todo          # release this one to the agents
task 15 modify priority:H +urgent  # tweak before releasing
task 16 delete                     # drop what you don't want
```

Env: `AGENT=codex|claude` (which agent parses), `TASK_AGENT` (the `agent:` UDA put
on created tasks, default `codex`), `BACKLOG_STATE` (default `triage`).

> This is an *intake* step, deliberately separate from the execution loop. Don't
> run it as a Symphony task unless you loosen the sandbox — it writes to your
> Taskwarrior DB, which the `workspace-write` sandbox blocks.

---

## Running the daemon

```sh
SYMPHONY_LOG_PRETTY=1 symphony start -w ~/code/webapp/WORKFLOW.md
```

Recommended split-pane (tmux / Ghostty), matching the local-loop workflow:

```
┌─ taskwarrior-tui (your board) ─┬─ symphony start (live logs) ─┐
│  manage state:todo / review    │  dispatch / sessions / retries│
└────────────────────────────────┴──────────────────────────────┘
```

From a third pane you can inspect or poke the running daemon:

```sh
symphony state                              # full orchestrator snapshot (JSON)
symphony refresh                            # force an immediate poll + reconcile
curl -s localhost:4517/api/v1/SYM-xxxxxxxx  # one issue: workspace path, session, retry
```

---

## Reviewing and approving results

When the agent hands off, the task moves to `state:review` and Symphony stops
touching it (but keeps the workspace). Find and review it:

```sh
task state:review list
symphony state | jq '.running, .retry_queue'      # or check the per-issue endpoint
# the workspace path is shown there, e.g. ~/.symphony/workspaces/SYM-ab12cd34
cd ~/.symphony/workspaces/SYM-ab12cd34
git log --oneline -10
git diff main...HEAD
```

Then:

```sh
task 12 done                 # approve & close  → workspace reclaimed on next cycle
# or
task 12 modify state:todo    # send back for rework → Symphony re-runs in the SAME
                             #   workspace (the agent's prior commits are still there)
```

---

## Multiple projects

Taskwarrior has one database; tasks carry a `project:`. Two patterns:

- **Shared store, one daemon per repo (recommended).** Each `WORKFLOW.md` scopes
  itself with `tracker.filter: "status:pending project:webapp"`. Run a `symphony
  start` per repo; they share one task list but only pick up their own work.
- **Fully separate stores.** Set `data_dir` / `taskrc` in each `WORKFLOW.md`
  tracker block (or `TASKDATA` / `TASKRC` env) for isolated databases per project.

---

## Sandbox / trust posture

The sandbox decides what the agent's shell commands may touch:

| Codex `sandbox` | Claude `permission_mode` | Agent can… |
|---|---|---|
| `read-only` | `plan` | read only — no writes |
| `workspace-write` *(default)* | `acceptEdits` | write inside the workspace |
| `danger-full-access` / `dangerously_bypass: true` | `bypassPermissions` | anything (write anywhere, network) |

**Handoff caveat:** the example workflow has the agent run `task <id> modify
state:review`, which writes to your Taskwarrior DB *outside* the workspace — so it
needs full access (`dangerously_bypass` / `bypassPermissions`). If you'd rather
keep the agent in the safe `workspace-write` lane, have a Symphony hook perform
the handoff instead (ask and I'll wire it up).

---

## Monitoring & logs

- `symphony state` / `GET /api/v1/state` — running sessions, retry queue, token totals
- `GET /api/v1/<identifier>` — one issue's workspace path, session id, retry detail
- `POST /api/v1/refresh` — trigger an immediate cycle
- `SYMPHONY_LOG_PRETTY=1` for human-readable logs; `SYMPHONY_LOG_LEVEL=debug` for detail

---

## Common gotchas

- **Nothing gets picked up** → the task needs a `state` in `active_states` (e.g.
  `state:todo`); a bare `task add "..."` won't be seen. Check `symphony validate`.
- **Agent can't hand off / write the tracker** → loosen the sandbox (see above).
- **`after_create` clone fails** → `SYMPHONY_REPO_URL` unset or unreachable; a local
  path only clones *committed* state.
- **Agent command not found at dispatch** → the daemon's `PATH` must include
  `claude` / `codex`; `symphony validate` and the startup preflight will flag it.
- **Stuck "active" task after a crash** → on restart Symphony reconciles from
  Taskwarrior + the workspace and resumes it; no manual cleanup needed.

---

## Quick reference

```sh
# intake: raw notes -> triage backlog, then review & release
PROJECT=P ./scripts/notes-to-backlog.py notes.md
task state:triage list                                       # review the backlog
task <id> modify state:todo                                  # release to agents

# lifecycle
task add "..." project:P state:todo agent:codex priority:H   # queue work directly
task <id> modify depends:<other>                              # block
task <id> modify state:todo                                   # requeue / rework
task <id> done                                                # approve & close
task state:review list                                        # what needs you

# daemon
symphony validate -w WORKFLOW.md
symphony start    -w WORKFLOW.md
symphony state | symphony refresh

# env
SYMPHONY_REPO_URL        repo the clone hook checks out
SYMPHONY_LOG_PRETTY=1    readable logs
SYMPHONY_LOG_LEVEL=debug verbose
TASKRC / TASKDATA        target a specific Taskwarrior store
```
