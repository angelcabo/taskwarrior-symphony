#!/usr/bin/env bash
# Seed a few demo tasks for Symphony to pick up. Uses agent:mock so nothing is
# actually executed against a repo — safe for a first end-to-end run.
#
# Target an isolated store to avoid touching your real tasks:
#   TASKRC=/tmp/demo.taskrc TASKDATA=/tmp/demo.task ./scripts/seed-demo.sh
set -euo pipefail

TASK="${TASK_BIN:-task} rc.confirmation=off rc.verbose=nothing"

$TASK add "Add a /health endpoint that returns 200 OK" \
  state:todo agent:mock priority:H +backend >/dev/null
$TASK add "Document the configuration layer in the README" \
  state:todo agent:mock priority:L +docs >/dev/null
$TASK add "Investigate flaky integration test" \
  state:todo agent:mock priority:M +ci >/dev/null

echo "Seeded demo tasks:"
${TASK_BIN:-task} rc.verbose=nothing state.not: '' list 2>/dev/null || \
  ${TASK_BIN:-task} rc.verbose=nothing list
