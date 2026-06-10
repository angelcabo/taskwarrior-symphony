/**
 * Reconciliation (Coordination Layer, SPEC §"Reconciliation Logic").
 *
 * Runs at the start of every poll tick.
 *   Part A — Stall detection: if a worker has been inactive longer than
 *     agent.stall_timeout_ms, terminate it (the orchestrator schedules a retry).
 *     Skipped when stall_timeout_ms <= 0.
 *   Part B — Tracker state refresh: re-read the current state of every running
 *     issue. Terminal => terminate + clean workspace. Active => update snapshot.
 *     Neither (closed/vanished) => terminate without cleanup.
 *
 * `import type` keeps this decoupled from the orchestrator at runtime (no cycle).
 */

import type { Orchestrator } from "./orchestrator.js";

export async function reconcile(orch: Orchestrator): Promise<void> {
  const cfg = orch.config;

  // --- Part A: stall detection --------------------------------------------
  if (cfg.agent.stallTimeoutMs > 0) {
    const now = Date.now();
    for (const entry of orch.listRunning()) {
      const last = entry.lastActivityTs || entry.startedAt;
      const idle = now - last;
      if (idle > cfg.agent.stallTimeoutMs) {
        orch.log.child({ issue_identifier: entry.issue.identifier }).warn("stall detected", {
          idle_ms: idle,
          stall_timeout_ms: cfg.agent.stallTimeoutMs,
        });
        orch.abortWorker(entry.issue.id, "stall");
      }
    }
  }

  // --- Part B: tracker state refresh --------------------------------------
  const running = orch.listRunning();
  if (running.length === 0) return;

  const ids = running.map((e) => e.issue.id);
  let states;
  try {
    states = await orch.tracker.fetchIssueStatesByIds(ids);
  } catch (err) {
    // Keep workers running; retry next tick (SPEC error handling).
    orch.log.warn("reconcile: tracker state refresh failed; keeping workers", { error: String(err) });
    return;
  }

  for (const entry of running) {
    if (entry.abortReason !== null) continue; // already terminating (e.g. stalled)
    const snap = states.get(entry.issue.id);
    if (!snap || !snap.exists) {
      orch.abortWorker(entry.issue.id, "neither");
    } else if (snap.terminal) {
      orch.abortWorker(entry.issue.id, "terminal");
    } else if (snap.active) {
      orch.updateRunningState(entry.issue.id, snap.state ?? entry.issue.state);
    } else {
      orch.abortWorker(entry.issue.id, "neither");
    }
  }
}
