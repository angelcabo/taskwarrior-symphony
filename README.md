# Taskwarrior Symphony

A local, autonomous coding-agent orchestrator. It implements the
[OpenAI Symphony specification](https://github.com/openai/symphony/blob/main/SPEC.md)
— a long-running daemon that polls an issue tracker, creates an isolated
workspace per issue, and orchestrates coding-agent sessions — but swaps the
Linear integration for **Taskwarrior**. The result is a tight, fully-local loop:
no SaaS, no network latency, all state on your disk.

> The orchestrator is a *scheduler/runner*, not a workflow engine. The business
> logic lives in the prompt (`WORKFLOW.md`) and in the agent's tools. Symphony
> decides **what** to run and **when**; the agent decides **how**.

## Requirements

A local Node daemon that drives a coding-agent CLI — **this guide assumes your agent CLI
already works** (installed, on your `PATH`, authenticated). From absolute zero you need:

| Need | Why | Check |
|---|---|---|
| **Node ≥ 20** | runs the daemon | `node -v` |
| **Taskwarrior ≥ 3.4** | the issue tracker + durable store — `brew install task` | `task --version` |
| **`claude` and/or `codex`**, on `PATH` and logged in | does the actual coding | `claude --version` |
| **git** | every task runs in an isolated clone | `git --version` |

> Prefer a live visual board to the `task` CLI? The companion **taskwarrior-kanban** app
> renders this whole loop in the browser — see its README to run the two together.

## Install (from zero)

```sh
git clone https://github.com/angelcabo/taskwarrior-symphony.git
cd taskwarrior-symphony
npm install
npm run build
npm link            # puts `symphony` on your PATH (optional — otherwise use `node dist/index.js`)

# one-time: add the UDAs Symphony relies on (state / agent / branch).
# Writes to your real ~/.taskrc by default; prefix TASKRC=… TASKDATA=… to use an isolated store.
./scripts/setup-taskwarrior.sh

symphony validate   # sanity check — parses the example WORKFLOW.md and prints a summary
```

That is the entire install. The next section runs the full loop in 60 seconds with a mock
agent (no real work); **[GETTING_STARTED.md](./GETTING_STARTED.md)** covers pointing it at a
real repo, the review/approval flow, and the **one-daemon-per-repo** model.

## How it maps to the spec

The spec's six layers are preserved exactly; only the Integration Layer changed.

| Spec layer | This implementation |
|---|---|
| **Policy** | [`WORKFLOW.md`](./WORKFLOW.md) — prompt body + team rules, versioned with code |
| **Configuration** | [`src/config.ts`](./src/config.ts) — YAML front matter, typed defaults, `$VAR`, live reload |
| **Coordination** | [`src/orchestrator.ts`](./src/orchestrator.ts) + [`reconciler.ts`](./src/reconciler.ts) + [`retry.ts`](./src/retry.ts) — in-memory polling loop, eligibility, concurrency, backoff |
| **Execution** | [`workspace.ts`](./src/workspace.ts), [`hooks.ts`](./src/hooks.ts), [`prompt.ts`](./src/prompt.ts), [`runner.ts`](./src/runner.ts) |
| **Integration** | [`taskwarrior.ts`](./src/taskwarrior.ts) — **replaces the Linear GraphQL adapter** |
| **Observability** | [`logger.ts`](./src/logger.ts) (structured logs) + [`http.ts`](./src/http.ts) (`/api/v1/*`, incl. live per-task SSE) + `symphony watch <id>` |

**Coordination Layer choice:** the spec says no database is required — "recovery
is tracker- and filesystem-driven after restart." Taskwarrior *is* the durable
store, so the orchestrator is a lean in-memory poller. On restart it reconciles
from `task` + the workspace directories. (Temporal/Restate would add durable
execution but aren't necessary here, since Taskwarrior already persists state.)

## The Taskwarrior model

Symphony's tracker model maps onto Taskwarrior like this:

| Symphony | Taskwarrior |
|---|---|
| `Issue.id` | `uuid` (stable) |
| `Issue.identifier` | `SYM-<uuid8>` (synthesized, sanitized for paths/branches) |
| `Issue.state` (workflow axis) | the **`state` UDA** (`todo`/`active`/`review`/`done`/…) |
| agent driver selector | the **`agent` UDA** (`claude`/`codex`/`mock`) |
| `Issue.labels` | `tags` (lowercased) |
| `Issue.blockedBy` | `depends` (resolved to terminal/non-terminal) |
| `Issue.priority` | `H`/`M`/`L` → `1`/`2`/`3` (lower = more urgent) |

Two state axes coexist: Taskwarrior's `status` (pending/completed/deleted) is the
storage lifecycle; the **`state` UDA** is the Symphony workflow state. A task is a
candidate only when it is `status:pending` **and** its `state` is in
`active_states`. A task opts into Symphony by having a `state` (and usually an
`agent`) — nothing is picked up implicitly.

## 60-second demo (mock agent — no real work)

Installed (above)? Watch the whole loop run end-to-end with the **mock** driver, against a
throwaway store so your real `~/.task` is never touched:

```sh
export TASKRC=/tmp/symphony-demo.taskrc TASKDATA=/tmp/symphony-demo.task
./scripts/setup-taskwarrior.sh        # UDAs, in the throwaway store
./scripts/seed-demo.sh                # a few agent:mock tasks (simulated, safe)

SYMPHONY_LOG_PRETTY=1 symphony start  # run the daemon — watch tasks flow

# from another pane, inspect or poke the running daemon:
symphony state                  # all tasks in flight (one-shot JSON)
symphony state -f               # …or a live top-style overview (refreshes every 2s)
symphony watch SYM-ab12cd34     # one task: state header + recent log, then exit (id, uuid, or prefix)
symphony watch -f SYM-ab12cd34  # …or follow it live (tail -f); add -n N to cap the lines shown
symphony refresh                # poll + reconcile now
```

Point it at **real** work — your own repo, a real agent — by giving the clone hook a repo
and adding a `todo` task with a real `agent`:

```sh
export SYMPHONY_REPO_URL="$HOME/code/your-repo"   # the after_create hook clones this
task add "Fix the date parser off-by-one" state:todo agent:claude priority:H
```

> Full per-project setup, the review/approval flow, the one-daemon-per-repo model, and
> Taskwarrior management live in **[GETTING_STARTED.md](./GETTING_STARTED.md)**.

## Agent drivers (Execution Layer)

The agent is pluggable and chosen **per task** via the `agent` UDA (the
adaptation suggested by `task +PENDING agent:codex` / `agent:claude`):

- **`claude`** — runs `claude -p --output-format stream-json …` in the workspace,
  parses streamed events, resumes sessions with `--resume` on continuation turns.
  This is the path exercised end-to-end in this environment.
- **`codex`** — runs `codex exec --json` (the stable headless surface; the
  spec's `codex app-server` is experimental). Parses the real JSONL event stream
  (`thread.started`/`turn.*`/`item.*`), resumes threads via `codex exec resume`,
  and maps `session_id = thread_id`. Verified live against codex-cli 0.135.0.
- **`mock`** — simulates a run with no side effects; use it to review the full
  loop. Knobs: `SYMPHONY_MOCK_STEPS`, `SYMPHONY_MOCK_STEP_MS`,
  `SYMPHONY_MOCK_FAIL=1`, `SYMPHONY_MOCK_STALL=1`.

## Lifecycle & safety

- **Claiming / locking.** The single-authority orchestrator claims issues
  in-memory. With `tracker.dispatch_transition: active` it *also* moves the task
  to `active` so the lock is visible in `task` and survives restarts.
- **Handoff.** The agent (not Symphony) writes to the tracker. The example
  workflow hands off by setting `state:review` — a state that is neither active
  (so Symphony stops) nor terminal (so the workspace is preserved for a human).
- **Reconciliation** runs each tick: stall detection (`stall_timeout_ms` of
  inactivity → terminate + retry) and tracker-state refresh (terminal → clean
  workspace; active → keep; neither → terminate without cleanup).
- **Retries.** Failures back off exponentially (`min(base·2^(n-1), cap)`); clean
  non-terminal exits get a fast continuation that resumes the agent session.
- **Workspace safety (all enforced):** per-issue dirs, key sanitization
  (`[^A-Za-z0-9._-]` → `_`), and path confinement under the workspace root.

## Notable adaptations / deviations from the spec

- **Tracker writes for the dispatch lock.** The spec keeps claiming purely
  in-memory; `dispatch_transition` optionally writes the `active` state so the
  lock is visible locally (set it to `null` for spec-exact behavior).
- **Per-state concurrency** keys off the task's state *at selection time*, so the
  dispatch transition doesn't distort the counts.
- **Continuation cap** (`SYMPHONY_MAX_CONTINUATIONS`, default 25) guards against
  hot continuation loops if an agent never reaches a terminal/handoff state — a
  safety addition beyond the spec, which assumes the agent always hands off.
- `stall_timeout_ms` / `turn_timeout_ms` live under `agent` (driver-agnostic);
  the spec nests them under `codex`. Both spellings are accepted.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run build       # -> dist/
npm run dev -- validate   # run from source via tsx
npm test            # node --test (unit tests)
```

## Layout

```
src/
  config.ts        Configuration Layer: WORKFLOW.md parsing, $VAR, live reload
  domain.ts        Normalized Issue, run lifecycle, runtime events, token totals
  tracker.ts       Integration Layer contract
  taskwarrior.ts   Taskwarrior adapter (the only Taskwarrior-aware file)
  workspace.ts     Per-issue workspaces + safety invariants
  hooks.ts         Workspace hooks + issue environment
  prompt.ts        Strict prompt renderer (unknown var/filter => failure)
  agent.ts         Pluggable AgentDriver interface + registry
  drivers/         claude.ts, codex.ts, mock.ts
  runner.ts        One attempt: prepare -> hooks -> prompt -> agent -> finish
  retry.ts         Exponential-backoff + continuation retry queue
  reconciler.ts    Stall detection + tracker state refresh
  orchestrator.ts  Single-authority polling loop, eligibility, concurrency
  taskstream.ts    Per-task event pub/sub + replay buffer (powers `symphony watch`)
  http.ts          /api/v1/{state,<id>,<id>/stream,refresh}
  index.ts         CLI: start | validate | state | refresh | watch
```

## License

MIT — see [LICENSE](./LICENSE).

This is an **independent** implementation of the [OpenAI Symphony spec](https://github.com/openai/symphony),
not affiliated with or endorsed by OpenAI. The spec explicitly invites third-party
implementations; this one swaps the reference Linear integration for Taskwarrior.
