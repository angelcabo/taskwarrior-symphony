---
# ============================================================================
# WORKFLOW.md — the Policy Layer (SPEC §1). Versioned with the code it governs.
# Front matter below is the Configuration Layer (SPEC §2); everything after the
# closing `---` is the prompt template handed to the coding agent.
# `$VAR` values are resolved from the environment at load time.
# ============================================================================

tracker:
  kind: taskwarrior
  # Base Taskwarrior filter applied to every query. Keep it to pending work.
  filter: "status:pending"
  # Workflow-state axis (the `state` UDA), independent of Taskwarrior's status.
  active_states: [todo, active]      # Symphony runs agents on these
  terminal_states: [done, canceled]  # workspaces are reclaimed for these
  todo_state: todo                   # only this state is gated by blockers
  # Any state NOT in active_states is ignored by Symphony. Use one as a manual
  # staging lane: `scripts/notes-to-backlog.py` parses notes into `triage`; you
  # review and promote the ones you want to `todo` to release them to agents.
  identifier_prefix: SYM             # SYM-ab12cd34 (sanitized for branch/workspace)
  state_attr: state
  agent_attr: agent                  # selects the driver per task (agent:claude / agent:codex / agent:mock)
  # Visible lock (adaptation): move todo -> active on dispatch so `task` shows
  # what's in flight and restarts can resume interrupted work. `null` keeps
  # claiming purely in-memory, exactly as the SPEC describes.
  dispatch_transition: active

polling:
  interval_ms: 15000

workspace:
  # Expands ~ and $VAR; relative paths resolve against this file's directory.
  root: ~/.symphony/workspaces

hooks:
  timeout_ms: 120000
  # Runs once when a workspace is first created. Clone the target repo (set
  # SYMPHONY_REPO_URL in the environment) or initialize an empty repo.
  after_create: |
    set -euo pipefail
    if [ -n "${SYMPHONY_REPO_URL:-}" ] && [ ! -d .git ]; then
      git clone "$SYMPHONY_REPO_URL" .
    elif [ ! -d .git ]; then
      git init -q && git commit -q --allow-empty -m "symphony: init workspace"
    fi
  # Runs before every attempt. Put the agent on the task's branch.
  before_run: |
    set -euo pipefail
    git fetch -q --all 2>/dev/null || true
    git checkout -B "$SYMPHONY_BRANCH" 2>/dev/null || git checkout "$SYMPHONY_BRANCH"
  # Runs after every attempt (any outcome); failures are logged and ignored.
  after_run: |
    echo "symphony: attempt for $SYMPHONY_ISSUE_IDENTIFIER finished" >&2

agent:
  default_driver: claude             # used when a task has no agent: attribute
  max_concurrent_agents: 2           # global cap — don't melt the CPU
  # Per-state caps key off the task's state at selection time:
  # max_concurrent_agents_by_state:
  #   todo: 2
  max_turns: 40
  stall_timeout_ms: 300000           # 5m of agent inactivity -> terminate + retry
  turn_timeout_ms: 3600000           # 1h hard cap on a single attempt
  max_retry_backoff_ms: 300000       # failure backoff capped at 5m

claude:
  command: claude
  # Trust posture (SPEC requires documenting this). acceptEdits auto-approves
  # file edits but prompts for risky shell. For fully unattended autonomy use
  # bypassPermissions (maps to --dangerously-skip-permissions); rely on the
  # per-issue workspace for isolation.
  permission_mode: acceptEdits
  # model: claude-opus-4-8
  # allowed_tools: "Read,Edit,Write,Bash"

codex:
  command: codex                 # driver runs `codex exec --json`
  sandbox: workspace-write       # read-only | workspace-write | danger-full-access
  skip_git_repo_check: true
  # dangerously_bypass: true     # full autonomy: no sandbox, no approvals
  # model: gpt-5-codex

http:
  enabled: true
  host: 127.0.0.1
  port: 4517
---

# Engineering Task {{ issue.identifier }}

You are an autonomous coding agent working in an **isolated git workspace**.
Complete the task below end-to-end, then hand it off for human review.

## Task
**{{ issue.title }}**

{{ issue.description | default("(no additional description provided)") }}

- Labels: {{ issue.labels | join(", ") | default("none") }}
- Priority: {{ issue.priority | default("unset") }}
- Branch: `{{ issue.branch_name }}`
{{ attempt | default("") }}

## Rules of engagement
1. Work only inside this workspace. Make small, focused commits on `{{ issue.branch_name }}`.
2. Match the existing code style. Add or update tests for any behavior you change.
3. Run the project's test suite and make sure it passes before handing off.
4. Keep the change scoped to this task — do not refactor unrelated code.

## Definition of Done
- The change is implemented and committed on `{{ issue.branch_name }}`.
- The test suite passes locally.
- A one-line summary of the work is recorded on the task.

## Handoff (required)
Symphony writes nothing to the tracker on your behalf — **you** perform the handoff.
When the Definition of Done is met, record a summary and move the task to `review`
(a human-review state Symphony will not auto-continue):

```sh
task {{ issue.id }} annotate "agent: <one-line summary of the change>"
task {{ issue.id }} modify state:review
```

If you are blocked and cannot finish, record why and leave the task in its current state:

```sh
task {{ issue.id }} annotate "agent blocked: <reason>"
```

Do not stop until you have either handed off (`state:review`) or recorded a blocker.
