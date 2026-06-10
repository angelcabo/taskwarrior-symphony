/**
 * Mock agent driver.
 *
 * Simulates a coding-agent run without spawning anything or touching a repo —
 * the safe way to exercise the full polling/dispatch/reconcile loop for review.
 * It performs NO tracker writes (so the layering stays honest); drive terminal
 * transitions yourself (e.g. `task <id> done`) to watch reconciliation react.
 *
 * Env knobs (for testing edge paths):
 *   SYMPHONY_MOCK_STEPS    number of simulated activity steps (default 3)
 *   SYMPHONY_MOCK_STEP_MS  delay between steps in ms (default 250)
 *   SYMPHONY_MOCK_FAIL     "1" => end with a failure (exercise retry backoff)
 *   SYMPHONY_MOCK_STALL    "1" => go silent forever (exercise stall detection)
 */

import type { RunResult } from "../domain.js";
import { type AgentDriver, type AgentRunContext, AgentAbortError } from "../agent.js";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AgentAbortError());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AgentAbortError());
      },
      { once: true },
    );
  });
}

export class MockDriver implements AgentDriver {
  readonly name = "mock";

  async run(ctx: AgentRunContext): Promise<RunResult> {
    const started = Date.now();
    const sessionId = ctx.sessionId ?? `mock-${ctx.issue.identifier}-${started}`;
    ctx.onEvent({ type: "session_started", ts: Date.now(), sessionId });

    if (process.env.SYMPHONY_MOCK_STALL === "1") {
      // Go silent; the orchestrator's stall detection should abort us.
      await sleep(60 * 60 * 1000, ctx.signal);
    }

    const steps = Number(process.env.SYMPHONY_MOCK_STEPS ?? 3);
    const stepMs = Number(process.env.SYMPHONY_MOCK_STEP_MS ?? 250);
    for (let i = 1; i <= steps; i++) {
      await sleep(stepMs, ctx.signal);
      ctx.onEvent({ type: "tool_call", ts: Date.now(), name: `mock.step_${i}` });
      ctx.onEvent({
        type: "log",
        ts: Date.now(),
        level: "info",
        message: `mock agent working on ${ctx.issue.identifier} (step ${i}/${steps})`,
      });
    }

    const runtimeSeconds = (Date.now() - started) / 1000;

    if (process.env.SYMPHONY_MOCK_FAIL === "1") {
      ctx.onEvent({ type: "turn_failed", ts: Date.now(), error: "mock failure" });
      return { outcome: "Failed", sessionId, error: "mock failure (SYMPHONY_MOCK_FAIL=1)", runtimeSeconds };
    }

    const usage = { inputTokens: 1200, outputTokens: 340, totalTokens: 1540, costUsd: 0.02 };
    ctx.onEvent({ type: "turn_completed", ts: Date.now(), usage });
    return { outcome: "Succeeded", sessionId, usage, runtimeSeconds };
  }

  async checkAvailable(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}
