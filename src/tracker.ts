/**
 * Integration Layer contract (SPEC §5).
 *
 * The orchestrator depends only on this interface; swapping Linear for
 * Taskwarrior (or anything else) means implementing `Tracker`. The three fetch
 * operations mirror the SPEC's "Required Operations" exactly.
 */

import type { Issue } from "./domain.js";

/** Current state of an issue, used during reconciliation (SPEC §"Part B"). */
export interface IssueStateSnapshot {
  id: string;
  identifier: string;
  /** Workflow state, or null if the issue no longer exists / has no state. */
  state: string | null;
  /** Whether the issue still exists in the tracker. */
  exists: boolean;
  /** State ∈ terminal_states, or the underlying record is closed. */
  terminal: boolean;
  /** State ∈ active_states. */
  active: boolean;
}

export interface Tracker {
  readonly kind: string;

  /** Issues currently in active states for the configured project/filter. */
  fetchCandidateIssues(): Promise<Issue[]>;

  /** Issues currently in the given states (used for startup cleanup). */
  fetchIssuesByStates(states: string[]): Promise<Issue[]>;

  /** Current state for each id (used for reconciliation). */
  fetchIssueStatesByIds(ids: string[]): Promise<Map<string, IssueStateSnapshot>>;

  /**
   * Transition an issue into a state. The SPEC has the *agent* perform tracker
   * writes; the orchestrator uses this only for the optional dispatch lock
   * (tracker.dispatch_transition) — its own lifecycle bookkeeping.
   */
  transitionState(id: string, state: string): Promise<void>;

  /** Validate the tracker is reachable/usable (dispatch preflight, SPEC §3). */
  preflight(): Promise<void>;
}
