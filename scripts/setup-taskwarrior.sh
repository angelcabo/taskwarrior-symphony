#!/usr/bin/env bash
# Configure the Taskwarrior UDAs Symphony relies on.
#
#   state  — the workflow-state axis (todo/active/review/done/canceled)
#   agent  — which agent driver runs the task (claude/codex/mock)
#   branch — optional explicit git branch (otherwise synthesized)
#
# Respects TASKRC / TASKDATA, so you can target an isolated store:
#   TASKRC=/tmp/demo.taskrc TASKDATA=/tmp/demo.task ./scripts/setup-taskwarrior.sh
set -euo pipefail

TASK="${TASK_BIN:-task} rc.confirmation=off rc.verbose=nothing"

echo "Configuring Symphony UDAs (taskrc: ${TASKRC:-default}, taskdata: ${TASKDATA:-default})"

# Taskwarrior refuses to run with rc.confirmation=off if no rc file exists yet
# (it normally prompts to create one on first run). Create an empty one so
# `task config` has somewhere to write.
RC="${TASKRC:-$HOME/.taskrc}"
if [ ! -f "$RC" ]; then
  echo "No rc file at $RC — creating it."
  mkdir -p "$(dirname "$RC")"
  : > "$RC"
fi

$TASK config uda.state.type   string                                      >/dev/null
$TASK config uda.state.label  "State"                                     >/dev/null
$TASK config uda.state.values "triage,todo,active,review,done,canceled"   >/dev/null

$TASK config uda.agent.type   string                              >/dev/null
$TASK config uda.agent.label  "Agent"                             >/dev/null
$TASK config uda.agent.values "claude,codex,mock"                 >/dev/null

$TASK config uda.branch.type  string                              >/dev/null
$TASK config uda.branch.label "Branch"                            >/dev/null

echo "Done. UDAs configured:"
${TASK_BIN:-task} _udas
