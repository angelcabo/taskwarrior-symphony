/**
 * Coordination Layer — the single-authority orchestrator (SPEC §3 +
 * §"Polling & Scheduling Logic" + §"Orchestrator Runtime State").
 *
 * In-memory scheduler state only (SPEC §"Key Distinctions" #5): there is no
 * database. On restart, recovery is tracker- and filesystem-driven — Taskwarrior
 * holds the durable task state, and workspaces persist on disk.
 *
 * Poll tick sequence (SPEC):
 *   1. reconcile running issues (stall + tracker state) — see reconciler.ts
 *   2. validate dispatch preflight (tracker usable, agent command exists)
 *   3. fetch candidate issues in active states
 *   4. sort by priority (asc), then created_at (oldest first)
 *   5. dispatch eligible issues while slots remain
 *   6. notify observers (logged tick summary)
 */

import {
  type AgentTotals,
  type Issue,
  type RunPhase,
  type RunResult,
  type RuntimeEvent,
  addUsage,
  emptyTotals,
} from "./domain.js";
import type { Config, Workflow } from "./config.js";
import type { Tracker, IssueStateSnapshot } from "./tracker.js";
import { AgentRegistry } from "./agent.js";
import { WorkspaceManager } from "./workspace.js";
import { RetryQueue, type RetryEntry } from "./retry.js";
import { runAttempt } from "./runner.js";
import { reconcile } from "./reconciler.js";
import { Logger } from "./logger.js";

export type AbortReason = "stall" | "terminal" | "neither" | "shutdown";

interface DispatchOptions {
  attemptIndex: number;
  promptAttempt: number | null;
  sessionId?: string;
}

export interface RunningEntry {
  issue: Issue;
  driverName: string;
  /** State at selection time; per-state concurrency is keyed off this. */
  dispatchState: string;
  startedAt: number;
  lastActivityTs: number;
  sessionId?: string;
  phase: RunPhase;
  attempt: number;
  abort: AbortController;
  abortReason: AbortReason | null;
  done: Promise<void>;
}

export interface OrchestratorOptions {
  workflow: Workflow;
  tracker: Tracker;
  registry: AgentRegistry;
  logger: Logger;
}

export class Orchestrator {
  readonly tracker: Tracker;
  readonly registry: AgentRegistry;
  readonly log: Logger;

  private _config: Config;
  private _promptTemplate: string;
  private workspaces: WorkspaceManager;
  private readonly retryQueue: RetryQueue;

  // Runtime state (SPEC §"Orchestrator Runtime State").
  private readonly running = new Map<string, RunningEntry>(); // active issues
  private readonly claimed = new Set<string>(); // running OR retrying
  private readonly continuationCounts = new Map<string, number>();
  private readonly totals: AgentTotals = emptyTotals();

  private interval: NodeJS.Timeout | null = null;
  private ticking = false;
  private startedAt = 0;
  private driverAvailable: { ok: boolean; detail?: string } = { ok: true };
  private readonly maxContinuations: number;

  constructor(opts: OrchestratorOptions) {
    this._config = opts.workflow.config;
    this._promptTemplate = opts.workflow.promptTemplate;
    this.tracker = opts.tracker;
    this.registry = opts.registry;
    this.log = opts.logger;
    this.workspaces = new WorkspaceManager(this._config.workspace.root, this.log);
    this.retryQueue = new RetryQueue(this._config.agent, this.log);
    this.maxContinuations = Number(process.env.SYMPHONY_MAX_CONTINUATIONS ?? 25);
  }

  get config(): Config {
    return this._config;
  }

  // --- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    this.startedAt = Date.now();
    await this.refreshDriverAvailability();
    await this.startupCleanup();
    await this.pollTick();
    this.interval = setInterval(() => {
      this.pollTick().catch((err) => this.log.error("poll tick error", { error: String(err) }));
    }, this._config.polling.intervalMs);
    this.log.info("orchestrator started", {
      interval_ms: this._config.polling.intervalMs,
      max_concurrent: this._config.agent.maxConcurrentAgents,
      default_driver: this._config.agent.defaultDriver,
      drivers: this.registry.names().join(","),
      workspace_root: this.workspaces.rootPath,
    });
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.retryQueue.clearAll();
    for (const entry of this.running.values()) {
      if (entry.abortReason === null) {
        entry.abortReason = "shutdown";
        entry.abort.abort();
      }
    }
    await Promise.allSettled([...this.running.values()].map((e) => e.done));
    this.log.info("orchestrator stopped", {});
  }

  /** Apply a reloaded workflow (SPEC §"Configuration Reload"). */
  reload(workflow: Workflow): void {
    const prevInterval = this._config.polling.intervalMs;
    const prevRoot = this._config.workspace.root;
    this._config = workflow.config;
    this._promptTemplate = workflow.promptTemplate;
    this.retryQueue.updateConfig(workflow.config.agent);
    if (workflow.config.workspace.root !== prevRoot) {
      this.workspaces = new WorkspaceManager(workflow.config.workspace.root, this.log);
    }
    this.refreshDriverAvailability().catch(() => undefined);
    if (this.interval && workflow.config.polling.intervalMs !== prevInterval) {
      clearInterval(this.interval);
      this.interval = setInterval(() => {
        this.pollTick().catch((err) => this.log.error("poll tick error", { error: String(err) }));
      }, workflow.config.polling.intervalMs);
      this.log.info("polling cadence updated", { interval_ms: workflow.config.polling.intervalMs });
    }
  }

  private async startupCleanup(): Promise<void> {
    try {
      const terminal = await this.tracker.fetchIssuesByStates(this._config.tracker.terminalStates);
      for (const issue of terminal) {
        if (await this.workspaces.exists(issue.identifier)) {
          try {
            await this.workspaces.remove(issue.identifier);
            this.log.info("startup: removed stale workspace", { issue_identifier: issue.identifier });
          } catch (err) {
            this.log.warn("startup: workspace removal failed", {
              issue_identifier: issue.identifier,
              error: String(err),
            });
          }
        }
      }
    } catch (err) {
      this.log.warn("startup terminal cleanup failed; continuing", { error: String(err) });
    }
  }

  // --- poll tick -----------------------------------------------------------

  async pollTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // 1. reconcile
      await reconcile(this);

      // 2. dispatch preflight
      const pf = await this.preflight();
      if (!pf.ok) {
        this.log.error("dispatch preflight failed; skipping new dispatches this tick", { reason: pf.detail });
        return;
      }

      // 3. fetch candidates
      let candidates: Issue[];
      try {
        candidates = await this.tracker.fetchCandidateIssues();
      } catch (err) {
        this.log.warn("candidate fetch failed; skipping dispatch this tick", { error: String(err) });
        return;
      }

      // 4. sort: priority ascending (urgent first), then oldest first
      candidates.sort(comparePriorityThenAge);

      // 5. dispatch eligible while slots remain
      let dispatched = 0;
      for (const issue of candidates) {
        if (this.availableGlobalSlots() <= 0) break;
        if (this.eligible(issue)) {
          this.dispatch(issue, { attemptIndex: 1, promptAttempt: null });
          dispatched++;
        }
      }

      // 6. notify (tick summary)
      this.log.debug("poll tick", {
        candidates: candidates.length,
        dispatched,
        running: this.running.size,
        retrying: this.retryQueue.size(),
        claimed: this.claimed.size,
      });
    } finally {
      this.ticking = false;
    }
  }

  private async preflight(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.tracker.preflight();
    } catch (err) {
      return { ok: false, detail: `tracker unavailable: ${String(err)}` };
    }
    if (!this.driverAvailable.ok) {
      return { ok: false, detail: `default agent "${this._config.agent.defaultDriver}": ${this.driverAvailable.detail}` };
    }
    return { ok: true };
  }

  private async refreshDriverAvailability(): Promise<void> {
    const name = this._config.agent.defaultDriver;
    if (!this.registry.has(name)) {
      this.driverAvailable = { ok: false, detail: "no such driver registered" };
      return;
    }
    const driver = this.registry.get(name);
    if (driver.checkAvailable) {
      this.driverAvailable = await driver.checkAvailable(this._config);
      if (!this.driverAvailable.ok) {
        this.log.warn("default agent driver unavailable", { driver: name, detail: this.driverAvailable.detail });
      }
    } else {
      this.driverAvailable = { ok: true };
    }
  }

  // --- eligibility & concurrency ------------------------------------------

  /** Full eligibility for a fresh dispatch from the poll loop. */
  private eligible(issue: Issue): boolean {
    return this.canDispatch(issue, false);
  }

  /**
   * SPEC "Candidate Eligibility Rules". `allowSelfClaim` lets a retry-fired
   * issue (which is in `claimed` by virtue of being scheduled) dispatch itself.
   */
  private canDispatch(issue: Issue, allowSelfClaim: boolean): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    const cfg = this._config.tracker;
    if (!cfg.activeStates.includes(issue.state)) return false;
    if (cfg.terminalStates.includes(issue.state)) return false;
    if (this.running.has(issue.id)) return false;
    if (this.claimed.has(issue.id) && !allowSelfClaim) return false;
    // Blocker rule: only the todo state is gated by non-terminal blockers.
    if (issue.state === cfg.todoState && issue.blockedBy.some((b) => !b.terminal)) return false;
    if (this.availableGlobalSlots() <= 0) return false;
    if (this.availableStateSlots(issue.state) <= 0) return false;
    return true;
  }

  private availableGlobalSlots(): number {
    return Math.max(this._config.agent.maxConcurrentAgents - this.running.size, 0);
  }

  private runningCountByState(state: string): number {
    let n = 0;
    for (const e of this.running.values()) if (e.dispatchState === state) n++;
    return n;
  }

  private availableStateSlots(state: string): number {
    const override = this._config.agent.maxConcurrentAgentsByState[state];
    if (override === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(override - this.runningCountByState(state), 0);
  }

  // --- dispatch & worker lifecycle ----------------------------------------

  private dispatch(issue: Issue, opts: DispatchOptions): void {
    const cfg = this._config;
    const abort = new AbortController();
    const driverName = issue.agent ?? cfg.agent.defaultDriver;
    const entry: RunningEntry = {
      issue,
      driverName,
      dispatchState: issue.state,
      startedAt: Date.now(),
      lastActivityTs: Date.now(),
      sessionId: opts.sessionId,
      phase: "PreparingWorkspace",
      attempt: opts.attemptIndex,
      abort,
      abortReason: null,
      done: Promise.resolve(),
    };
    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);

    const logc = this.log.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    logc.info("dispatch", {
      driver: driverName,
      attempt: entry.attempt,
      continuation: Boolean(opts.sessionId),
      state: issue.state,
    });

    entry.done = (async () => {
      try {
        // Optional dispatch lock (adaptation): make the claim visible in `task`.
        if (cfg.tracker.dispatchTransition && issue.state !== cfg.tracker.dispatchTransition) {
          try {
            await this.tracker.transitionState(issue.id, cfg.tracker.dispatchTransition);
            entry.issue.state = cfg.tracker.dispatchTransition;
          } catch (err) {
            logc.warn("dispatch transition failed", { error: String(err) });
          }
        }

        const result = await runAttempt(
          { workspaces: this.workspaces, registry: this.registry, log: logc },
          {
            config: cfg,
            issue,
            attempt: opts.promptAttempt,
            sessionId: opts.sessionId,
            promptTemplate: this._promptTemplate,
            signal: abort.signal,
            onEvent: (e) => this.onEvent(entry, e),
            setPhase: (p) => {
              entry.phase = p;
            },
          },
        );
        await this.handleOutcome(entry, result);
      } catch (err) {
        logc.error("worker crashed", { error: String(err) });
        await this.handleOutcome(entry, {
          outcome: "Failed",
          error: String(err),
          runtimeSeconds: (Date.now() - entry.startedAt) / 1000,
        });
      }
    })();
  }

  private onEvent(entry: RunningEntry, event: RuntimeEvent): void {
    entry.lastActivityTs = event.ts || Date.now();
    if (event.type === "session_started") entry.sessionId = event.sessionId;
    const logc = this.log.child({
      issue_identifier: entry.issue.identifier,
      session_id: entry.sessionId,
    });
    if (event.type === "turn_failed") logc.warn("agent turn failed", { error: event.error });
    else if (event.type === "tool_call") logc.debug("tool call", { name: event.name });
    else if (event.type === "session_started") logc.info("session started", { pid: event.pid });
  }

  private async handleOutcome(entry: RunningEntry, result: RunResult): Promise<void> {
    const { issue } = entry;
    this.running.delete(issue.id);

    // Accounting (SPEC §"Token Accounting" / §"Runtime Accounting").
    addUsage(this.totals, result.usage);
    this.totals.runtimeSeconds += result.runtimeSeconds;

    const reason = entry.abortReason;
    let outcome = result.outcome;
    if (outcome === "CanceledByReconciliation" && reason === "stall") outcome = "Stalled";

    const logc = this.log.child({
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      session_id: entry.sessionId,
    });
    logc.info("attempt finished", {
      outcome,
      reason: reason ?? undefined,
      runtime_s: result.runtimeSeconds.toFixed(1),
      error: result.error,
    });

    if (reason === "shutdown") {
      this.releaseClaim(issue.id);
      return;
    }
    if (reason === "terminal") {
      await this.finalizeTerminal(entry, true);
      return;
    }
    if (reason === "neither") {
      await this.finalizeTerminal(entry, false);
      return;
    }

    if (outcome === "Failed" || outcome === "TimedOut" || outcome === "Stalled") {
      this.scheduleFailureRetry(entry, result.error ?? outcome);
      return;
    }

    // Natural success — decide between continuation and terminal handoff.
    await this.handleSuccess(entry);
  }

  private async handleSuccess(entry: RunningEntry): Promise<void> {
    const { issue } = entry;
    const logc = this.log.child({ issue_id: issue.id, issue_identifier: issue.identifier });

    let snap: IssueStateSnapshot | undefined;
    try {
      snap = (await this.tracker.fetchIssueStatesByIds([issue.id])).get(issue.id);
    } catch (err) {
      logc.warn("post-success state check failed; scheduling continuation", { error: String(err) });
    }

    if (snap && snap.terminal) {
      await this.finalizeTerminal(entry, true);
      return;
    }
    if (snap && (!snap.exists || !snap.active)) {
      await this.finalizeTerminal(entry, false);
      return;
    }

    // Still active: continuation retry (resume session), capped to avoid hot loops.
    const count = (this.continuationCounts.get(issue.id) ?? 0) + 1;
    this.continuationCounts.set(issue.id, count);
    if (this.maxContinuations > 0 && count > this.maxContinuations) {
      logc.warn("continuation cap reached without terminal handoff; releasing for next poll", {
        continuations: count,
      });
      this.releaseClaim(issue.id);
      this.continuationCounts.delete(issue.id);
      return;
    }
    this.claimed.add(issue.id);
    this.retryQueue.scheduleContinuation(issue, entry.sessionId, (e) => this.onRetryFire(e));
  }

  private scheduleFailureRetry(entry: RunningEntry, error: string): void {
    this.claimed.add(entry.issue.id); // retrying => claimed
    this.retryQueue.scheduleFailure(entry.issue, entry.attempt, error, (e) => this.onRetryFire(e));
  }

  private async finalizeTerminal(entry: RunningEntry, cleanup: boolean): Promise<void> {
    const { issue } = entry;
    const logc = this.log.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    this.continuationCounts.delete(issue.id);
    this.retryQueue.cancel(issue.id);
    if (cleanup) {
      try {
        await this.workspaces.remove(issue.identifier);
      } catch (err) {
        logc.warn("workspace cleanup failed", { error: String(err) });
      }
    }
    this.releaseClaim(issue.id);
    logc.info("issue finalized", { workspace_cleaned: cleanup });
  }

  private releaseClaim(issueId: string): void {
    this.claimed.delete(issueId);
  }

  /** Retry timer fired: refetch, re-check eligibility, dispatch or requeue. */
  private async onRetryFire(entry: RetryEntry): Promise<void> {
    const logc = this.log.child({ issue_id: entry.issueId, issue_identifier: entry.identifier });
    const requeueDelay = Math.min(this._config.polling.intervalMs, 5_000);

    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues();
    } catch (err) {
      logc.warn("retry: candidate fetch failed; requeueing", { error: String(err) });
      this.retryQueue.requeue(entry, requeueDelay, (e) => this.onRetryFire(e));
      return;
    }

    const issue = candidates.find((c) => c.id === entry.issueId);
    if (!issue) {
      // No longer an active candidate. Clean up if it reached a terminal state.
      let cleaned = false;
      try {
        const snap = (await this.tracker.fetchIssueStatesByIds([entry.issueId])).get(entry.issueId);
        if (snap?.terminal) {
          await this.workspaces.remove(entry.identifier);
          cleaned = true;
        }
      } catch {
        /* best-effort */
      }
      this.releaseClaim(entry.issueId);
      this.continuationCounts.delete(entry.issueId);
      logc.info("retry: issue no longer active; finalized", { workspace_cleaned: cleaned });
      return;
    }

    if (!this.canDispatch(issue, true)) {
      const blockedByPolicy =
        this.availableGlobalSlots() > 0 && this.availableStateSlots(issue.state) > 0;
      if (blockedByPolicy) {
        // Ineligible for a non-capacity reason (blockers / state) → release.
        this.releaseClaim(issue.id);
        this.continuationCounts.delete(issue.id);
        logc.info("retry: no longer eligible; released claim", {});
      } else {
        this.retryQueue.requeue(entry, requeueDelay, (e) => this.onRetryFire(e));
        logc.debug("retry: no concurrency slot; requeued", {});
      }
      return;
    }

    if (entry.kind === "continuation") {
      this.dispatch(issue, { attemptIndex: 1, promptAttempt: 1, sessionId: entry.sessionId });
    } else {
      this.dispatch(issue, { attemptIndex: entry.attempt + 1, promptAttempt: entry.attempt + 1 });
    }
  }

  // --- methods used by the reconciler -------------------------------------

  listRunning(): RunningEntry[] {
    return [...this.running.values()];
  }

  abortWorker(issueId: string, reason: AbortReason): void {
    const entry = this.running.get(issueId);
    if (!entry || entry.abortReason !== null) return;
    entry.abortReason = reason;
    entry.abort.abort();
    this.log.child({ issue_identifier: entry.issue.identifier }).info("terminating worker", { reason });
  }

  updateRunningState(issueId: string, state: string): void {
    const entry = this.running.get(issueId);
    if (entry) entry.issue.state = state;
  }

  // --- observability snapshots --------------------------------------------

  liveTotals(): AgentTotals {
    const now = Date.now();
    let activeRuntime = 0;
    for (const e of this.running.values()) activeRuntime += (now - e.startedAt) / 1000;
    return { ...this.totals, runtimeSeconds: this.totals.runtimeSeconds + activeRuntime };
  }

  stateSnapshot(): Record<string, unknown> {
    const now = Date.now();
    return {
      started_at: new Date(this.startedAt).toISOString(),
      uptime_seconds: Math.round((now - this.startedAt) / 1000),
      running: [...this.running.values()].map((e) => ({
        id: e.issue.id,
        identifier: e.issue.identifier,
        title: e.issue.title,
        state: e.issue.state,
        driver: e.driverName,
        phase: e.phase,
        attempt: e.attempt,
        session_id: e.sessionId,
        started_at: new Date(e.startedAt).toISOString(),
        idle_ms: now - e.lastActivityTs,
      })),
      retry_queue: this.retryQueue.entries().map((r) => ({
        identifier: r.identifier,
        kind: r.kind,
        attempt: r.attempt,
        due_in_ms: Math.max(r.dueAtMs - now, 0),
        error: r.error,
      })),
      claimed: this.claimed.size,
      totals: this.liveTotals(),
    };
  }

  issueSnapshot(identifier: string): Record<string, unknown> | null {
    const entry = [...this.running.values()].find((e) => e.issue.identifier === identifier);
    const retry = this.retryQueue.entries().find((r) => r.identifier === identifier);
    if (!entry && !retry) return null;
    let workspacePath: string | null = null;
    try {
      workspacePath = this.workspaces.pathFor(identifier);
    } catch {
      workspacePath = null;
    }
    return {
      identifier,
      workspace_path: workspacePath,
      running: entry
        ? {
            id: entry.issue.id,
            state: entry.issue.state,
            driver: entry.driverName,
            phase: entry.phase,
            attempt: entry.attempt,
            session_id: entry.sessionId,
            started_at: new Date(entry.startedAt).toISOString(),
            idle_ms: Date.now() - entry.lastActivityTs,
          }
        : null,
      retry: retry
        ? { kind: retry.kind, attempt: retry.attempt, due_in_ms: Math.max(retry.dueAtMs - Date.now(), 0), error: retry.error }
        : null,
    };
  }

  /** Force an immediate poll + reconcile cycle (HTTP POST /api/v1/refresh). */
  async refreshNow(): Promise<void> {
    await this.pollTick();
  }
}

/** SPEC sort: priority ascending (urgent first; null last), then oldest first. */
export function comparePriorityThenAge(a: Issue, b: Issue): number {
  const pa = a.priority ?? Number.POSITIVE_INFINITY;
  const pb = b.priority ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}
