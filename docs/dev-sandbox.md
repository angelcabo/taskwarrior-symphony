# Driving agents through dev-sandbox (Docker)

Symphony can run its coding agents inside disposable Docker sandboxes instead of
directly on the host, by pointing a driver's `command:` at the
[dev-sandbox](https://github.com/) `sandbox` wrapper (`sandbox claude …` /
`sandbox codex …`). Each task's per-issue workspace is direct-mounted into a
sandbox, the agent runs there, and its file edits appear back on the host
workspace exactly as with a local agent.

Everything here is **opt-in**: with `command: claude` / `command: codex` Symphony
runs the agent directly and none of the sandbox machinery is engaged.

---

## TL;DR

One daemon runs **both** agents — each task picks its driver via the `agent:`
UDA (`agent:claude` / `agent:codex`); you don't start Symphony per agent. With
both on Bedrock they share one token (the wrapper applies the right region per
agent):

```sh
# 1. one-time: build node-pty's native bits (npm does this via postinstall)
npm install                      # runs scripts/fix-node-pty-perms.mjs

# 2. resolve the Bedrock token on the host (1Password / Touch ID). Used by BOTH
#    claude and codex — a detached daemon can't unlock op, so resolve it here.
DS=~/Developer/personal/dev-sandbox
source "$DS/config.local.sh"; source "$DS/lib/bedrock_token.sh"
export AWS_BEARER_TOKEN_BEDROCK="$(dev_sandbox_bedrock_resolve_token)"
export AWS_REGION="$(dev_sandbox_bedrock_region)"   # claude region; codex's is set by the wrapper
export SANDBOX_ON_EXISTING=attach                   # don't prompt on re-attach (continuations)

# 3. start one daemon; tasks tagged agent:claude and agent:codex run together
symphony start -w WORKFLOW.sandbox.md
```

---

## Prerequisites

- **dev-sandbox** installed with `sandbox` and `sbx` on your `PATH`, Docker
  running, and the `dev-sandbox:latest` image built (`sandbox build`).
- **node-pty** — a native dependency Symphony uses to give the wrapped agent a
  PTY (see "Why a PTY" below). `npm install` runs a `postinstall`
  (`scripts/fix-node-pty-perms.mjs`) that fixes a macOS prebuilt-binary perms
  bug; if you ever see `Error: posix_spawnp failed`, run `npm install` again.
- **Amazon Bedrock token** in 1Password — used by **both** agents when run on
  Bedrock (see [Bedrock token](#bedrock-token)). claude uses `us-west-2`; codex
  uses `us-east-1` + `openai.gpt-5.5` (must be enabled in the Bedrock console).
- **codex (ChatGPT alternative):** if you run codex *without* `--bedrock`, run
  `codex login` on the host once instead — its `~/.codex/auth.json` is streamed
  into the sandbox and no token is needed.

## Why the config looks the way it does

`sbx run` (what the wrapper calls) behaves differently from a plain local
process, and the driver options exist to bridge the gap:

| `sbx` behaviour | Consequence | Handled by |
| --- | --- | --- |
| Does **not** forward host stdin | The prompt (normally piped to stdin) never arrives | `prompt_arg: true` — deliver the prompt as a positional CLI arg |
| Streams the agent's full stdout **only to a TTY** (a pipe gets only a terminal-title escape) | Without a TTY, every `session_id`/tool/usage event is lost | Symphony runs wrapped commands under a **PTY** (node-pty), automatically |
| The PTY introduces a leading OSC title escape + trailing CR on the first line | A strict JSON parse drops the `init` line carrying `session_id` | tolerant line parser, automatically |
| `<wrapper> --version` is meaningless / can crash | Dispatch preflight would wrongly fail | preflight just checks the wrapper is on `PATH`, automatically |
| Re-attaching to an existing sandbox prompts `[A]ttach / [r]ecreate / [q]uit?` on the (now-TTY) stdin | Continuations/resumes hang until timeout | `SANDBOX_ON_EXISTING=attach` (clean) **and** a built-in PTY auto-answer (safety net) — see [Continuations](#continuations--re-attach) |

You only ever *set* `prompt_arg` (and the trust flags); the PTY, parsing, and
preflight handling are automatic whenever `command:` has extra arguments.

---

## WORKFLOW config

### claude on Bedrock

```yaml
agent:
  default_driver: claude

claude:
  # `--bedrock` is consumed by the wrapper (not claude); selects Bedrock + model.
  command: sandbox claude --bedrock
  # Docker is the isolation boundary, so run claude unattended inside it.
  permission_mode: bypassPermissions
  # sbx doesn't forward stdin — deliver the prompt as a positional arg.
  prompt_arg: true
```

### codex

```yaml
agent:
  default_driver: codex

codex:
  # `--bedrock` (a wrapper flag) runs codex on Amazon Bedrock with the SAME token
  # as claude (region us-east-1, openai.gpt-5.5). Drop it to use host ChatGPT auth
  # instead. The trailing `--` stops the wrapper from treating codex's `exec`
  # subcommand as a repo path.
  command: sandbox codex --bedrock --
  # Docker is the isolation boundary; codex's own landlock/seatbelt isn't
  # available in-container, so bypass its OS sandbox + approvals.
  dangerously_bypass: true
  skip_git_repo_check: true
  prompt_arg: true
```

> ChatGPT-auth variant (no token): `command: sandbox codex --` (run
> `codex login` on the host first).

`-C <workspace>` (first turn) resolves inside the container because `sbx`
direct-mounts the workspace at the **same absolute path**. Continuations use
`codex exec resume <thread_id>` / claude `--resume <session_id>`, which re-attach
the same sandbox to preserve the resumable session.

> **Workspace naming:** the sandbox name is derived from the workspace directory
> basename, and `sbx` rejects underscores. Symphony's identifier-based workspace
> dirs (e.g. `SYM-1a2b…`) are fine; just avoid `_` if you customize the layout.

---

## Running both agents in one daemon

Symphony is agent-agnostic at the orchestration layer: a **single daemon** polls
one tracker and dispatches every task, choosing the driver **per task** from the
`agent:` UDA (`agent:claude` / `agent:codex` / `agent:mock`), falling back to
`agent.default_driver`. One WORKFLOW holds both the `claude:` and `codex:`
blocks, so "codex on Bedrock, claude on Bedrock" (or codex on host ChatGPT) is
just how you fill those two blocks in — you do **not** run Symphony per agent.

Concurrency is global: up to `agent.max_concurrent_agents` agents run at once,
mixing claude and codex freely (optionally capped per task *state* via
`agent.max_concurrent_agents_by_state`). There is no per-*agent* cap today.

```sh
task add "fix flaky test" state:todo agent:codex
task add "write the RFC"  state:todo agent:claude
# the same daemon runs both, side by side
```

---

## Bedrock token

Both agents on Bedrock need `AWS_BEARER_TOKEN_BEDROCK`. The wrapper can read
it from 1Password via `op`, **but `op` blocks on Touch-ID and a detached daemon
can't satisfy that** — so resolve the token in your foreground shell and export
it into the daemon's environment (the wrapper and Symphony both read it
env-first; Symphony forwards its `process.env` to the agent):

```sh
DS=~/Developer/personal/dev-sandbox
source "$DS/config.local.sh"        # provides the OP item/vault config
source "$DS/lib/bedrock_token.sh"
export AWS_BEARER_TOKEN_BEDROCK="$(dev_sandbox_bedrock_resolve_token)"   # unlock 1Password / Touch ID
export AWS_REGION="$(dev_sandbox_bedrock_region)"
[ -n "$AWS_BEARER_TOKEN_BEDROCK" ] && echo "token ok (len ${#AWS_BEARER_TOKEN_BEDROCK})"
```

The token lives in the 1Password **Work** vault item
`AWS Staging fonts-bedrock-service`; make sure that account is unlocked in your
`op` session before resolving. The **same token serves both agents** — the
wrapper applies each agent's region (claude `us-west-2`, codex `us-east-1`), so
you export it once. codex only skips this if you run it in ChatGPT-auth mode
(`sandbox codex` without `--bedrock`).

---

## Continuations / re-attach

A continuation re-runs the agent in the **same** workspace, so the wrapper
re-attaches the persisted per-workspace sandbox (preserving the agent's
resumable session). On re-attach `sandbox` would otherwise prompt
`Sandbox '<name>' exists. [A]ttach / [r]ecreate / [q]uit?` and block. Two layers
prevent the hang:

1. **`SANDBOX_ON_EXISTING=attach`** (recommended) — a dev-sandbox env var that
   skips the prompt and attaches. Set it in the daemon's environment. Also
   accepts `recreate` / `quit`.
2. **Built-in auto-answer** — even without the env var, Symphony watches the PTY
   for that prompt and answers `a` (attach). This is a safety net for older /
   unmodified dev-sandbox installs; setting the env var is cleaner.

`attach` (not `recreate`) is the right choice — the resumable session/thread
lives **inside** that sandbox, so recreating it would break `--resume`.

---

## Verifying a run

A healthy wrapped run logs (with `SYMPHONY_LOG_LEVEL=debug SYMPHONY_LOG_PRETTY=1`):

```
INFO  dispatch          driver=claude continuation=false state=todo
DEBUG launching claude  bin=sandbox args=claude --bedrock -p …
DEBUG claude: non-JSON line   line=[sandbox] launching claude in dev-sandbox:latest
INFO  session started   session_id=…            ← stream parsed through the PTY
DEBUG tool call         name=Write
INFO  attempt finished  outcome=Succeeded
```

On a continuation you'll see a second `dispatch` with `continuation=true` that
**resumes the same `session_id`** and streams its own events — that confirms
re-attach is working.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `posix_spawnp failed` at startup | node-pty prebuilt helper lost its exec bit — re-run `npm install` (postinstall fixes it). |
| Agent exits 1 immediately, no events | Missing `prompt_arg: true` (prompt never reached the agent). |
| Run "succeeds" but no `session started` / no events | Command isn't actually wrapped (no PTY). Ensure `command:` has extra args (e.g. `sandbox claude …`). |
| claude: `Bedrock requested but no token was found` | `AWS_BEARER_TOKEN_BEDROCK` not exported into the daemon env — see [Bedrock token](#bedrock-token). |
| Continuation turn hangs ~until `stall_timeout_ms` | The re-attach prompt — set `SANDBOX_ON_EXISTING=attach` (the built-in auto-answer should also catch it). |
| `sbx` rejects the sandbox name | Workspace basename contains an underscore — rename. |
