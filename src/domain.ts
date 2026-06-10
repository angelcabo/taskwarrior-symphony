/**
 * Core domain model (Symphony SPEC §"Core Domain Model").
 *
 * These types are tracker-agnostic. The Integration Layer (Taskwarrior adapter)
 * is responsible for normalizing raw tracker records into the `Issue` shape
 * below; nothing downstream of the adapter knows about Taskwarrior.
 */

/** A single blocking relationship, normalized from the tracker's "blocks" graph. */
export interface Blocker {
  /** Stable id of the blocking issue. */
  id: string;
  /** Human-friendly identifier, if known. */
  identifier?: string;
  /** Workflow state of the blocker, if known. */
  state?: string;
  /**
   * Whether the blocker is in a terminal state. The adapter resolves this at
   * fetch time so the orchestrator's blocker rule stays tracker-agnostic.
   */
  terminal: boolean;
}

/**
 * Normalized issue (SPEC: "Issue Entity").
 *
 * `agent` is a Taskwarrior adaptation: the SPEC hardcodes Codex, but the local
 * model selects a driver per-task via the `agent:` attribute (e.g. agent:claude
 * / agent:codex). It is optional; the orchestrator falls back to a default.
 */
export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  /** Lower = more urgent (Linear semantics). Non-integer priorities normalize to null. */
  priority: number | null;
  state: string;
  branchName: string;
  url: string | null;
  labels: string[];
  blockedBy: Blocker[];
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  /** Adaptation: chosen agent driver name, from the task `agent:` attribute. */
  agent?: string;
  /** Original tracker record, retained for debugging/observability only. */
  raw?: unknown;
}

/**
 * Run-attempt lifecycle phases (SPEC: "Run Attempt Lifecycle"). These describe
 * how far a single worker run has progressed; they are not tracker states.
 */
export type RunPhase =
  | "PreparingWorkspace"
  | "BuildingPrompt"
  | "LaunchingAgentProcess"
  | "InitializingSession"
  | "StreamingTurn"
  | "Finishing";

/** Terminal outcomes for a run attempt (SPEC: "Terminal states"). */
export type RunOutcome =
  | "Succeeded"
  | "Failed"
  | "TimedOut"
  | "Stalled"
  | "CanceledByReconciliation";

export const TERMINAL_OUTCOMES: readonly RunOutcome[] = [
  "Succeeded",
  "Failed",
  "TimedOut",
  "Stalled",
  "CanceledByReconciliation",
];

/** Token usage reported by a coding agent for a turn or thread. */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  /** USD cost when the agent reports it (e.g. Claude Code result events). */
  costUsd?: number;
}

/**
 * Runtime events streamed by an agent driver (SPEC: "Emitted Runtime Events").
 * The orchestrator consumes these to update last-activity timestamps (for stall
 * detection), capture the session id, and accumulate token totals.
 */
export type RuntimeEvent =
  | { type: "session_started"; ts: number; sessionId: string; threadId?: string; turnId?: string; pid?: number }
  | { type: "turn_started"; ts: number }
  | { type: "turn_completed"; ts: number; usage?: TokenUsage }
  | { type: "turn_failed"; ts: number; error: string }
  | { type: "turn_cancelled"; ts: number }
  | { type: "approval_auto_approved"; ts: number; what: string }
  | { type: "unsupported_tool_call"; ts: number; name: string }
  | { type: "tool_call"; ts: number; name: string }
  | { type: "log"; ts: number; level: "debug" | "info" | "warn" | "error"; message: string }
  | { type: "usage"; ts: number; usage: TokenUsage };

/** Final result of a single run attempt. */
export interface RunResult {
  outcome: RunOutcome;
  sessionId?: string;
  error?: string;
  usage?: TokenUsage;
  /** Wall-clock runtime of the attempt in seconds. */
  runtimeSeconds: number;
}

/** Aggregate accounting kept in orchestrator state (SPEC: "codex_totals"). */
export interface AgentTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  runtimeSeconds: number;
}

export function emptyTotals(): AgentTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 };
}

export function addUsage(totals: AgentTotals, usage: TokenUsage | undefined): void {
  if (!usage) return;
  totals.inputTokens += usage.inputTokens ?? 0;
  totals.outputTokens += usage.outputTokens ?? 0;
  totals.totalTokens +=
    usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  totals.costUsd += usage.costUsd ?? 0;
}
