/**
 * Retry queue with exponential backoff (Coordination Layer, SPEC §"Retry &
 * Backoff Strategy").
 *
 *   Continuation retries (clean non-terminal exit): fixed delay, attempt resets
 *     to 1, resume the same agent session.
 *   Failure-driven retries: delay = min(base * 2^(attempt-1), cap); fresh
 *     session (full prompt re-rendered).
 *
 * One timer per issue. Scheduling a new retry for an issue cancels its existing
 * timer first (SPEC). The fire callback receives the entry; the orchestrator
 * then refetches candidates, re-checks eligibility, and dispatches or requeues.
 */

import type { AgentConfig } from "./config.js";
import { Logger } from "./logger.js";

export type RetryKind = "continuation" | "failure";

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  kind: RetryKind;
  error?: string;
  /** Present for continuations: the session to resume. */
  sessionId?: string;
  dueAtMs: number;
}

type FireFn = (entry: RetryEntry) => void;

interface Scheduled {
  entry: RetryEntry;
  timer: NodeJS.Timeout;
}

export class RetryQueue {
  private readonly queue = new Map<string, Scheduled>();

  constructor(
    private cfg: AgentConfig,
    private readonly log: Logger,
  ) {}

  /** Allow the orchestrator to push a reloaded config (dynamic reload). */
  updateConfig(cfg: AgentConfig): void {
    this.cfg = cfg;
  }

  /** SPEC failure backoff: min(base * 2^(attempt-1), cap). */
  failureDelay(attempt: number): number {
    const raw = this.cfg.baseRetryMs * 2 ** Math.max(0, attempt - 1);
    return Math.min(raw, this.cfg.maxRetryBackoffMs);
  }

  private schedule(entry: RetryEntry, delayMs: number, onFire: FireFn): RetryEntry {
    this.cancel(entry.issueId); // cancel any existing timer for this issue
    const timer = setTimeout(() => {
      this.queue.delete(entry.issueId);
      onFire(entry);
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
    this.queue.set(entry.issueId, { entry, timer });
    this.log.debug("retry scheduled", {
      issue_identifier: entry.identifier,
      kind: entry.kind,
      attempt: entry.attempt,
      delay_ms: delayMs,
    });
    return entry;
  }

  scheduleContinuation(
    issue: { id: string; identifier: string },
    sessionId: string | undefined,
    onFire: FireFn,
  ): RetryEntry {
    const delay = this.cfg.continuationDelayMs;
    const entry: RetryEntry = {
      issueId: issue.id,
      identifier: issue.identifier,
      attempt: 1, // resets per SPEC
      kind: "continuation",
      sessionId,
      dueAtMs: Date.now() + delay,
    };
    return this.schedule(entry, delay, onFire);
  }

  scheduleFailure(
    issue: { id: string; identifier: string },
    attempt: number,
    error: string | undefined,
    onFire: FireFn,
  ): RetryEntry {
    const delay = this.failureDelay(attempt);
    const entry: RetryEntry = {
      issueId: issue.id,
      identifier: issue.identifier,
      attempt,
      kind: "failure",
      error,
      dueAtMs: Date.now() + delay,
    };
    return this.schedule(entry, delay, onFire);
  }

  /** Reschedule an entry unchanged (used when no concurrency slot is free). */
  requeue(entry: RetryEntry, delayMs: number, onFire: FireFn): RetryEntry {
    const next: RetryEntry = { ...entry, dueAtMs: Date.now() + delayMs };
    return this.schedule(next, delayMs, onFire);
  }

  cancel(issueId: string): void {
    const s = this.queue.get(issueId);
    if (s) {
      clearTimeout(s.timer);
      this.queue.delete(issueId);
    }
  }

  has(issueId: string): boolean {
    return this.queue.has(issueId);
  }

  entries(): RetryEntry[] {
    return [...this.queue.values()].map((s) => s.entry);
  }

  size(): number {
    return this.queue.size;
  }

  clearAll(): void {
    for (const s of this.queue.values()) clearTimeout(s.timer);
    this.queue.clear();
  }
}
