/**
 * Run-attempt worker (Execution Layer glue).
 *
 * Executes exactly one attempt of an issue and returns a RunResult. It owns the
 * per-attempt lifecycle (SPEC "Run Attempt Lifecycle"): prepare workspace →
 * run hooks → build prompt → launch agent → stream turn → finish. It holds no
 * orchestrator state; the orchestrator manages claiming, retries, and the
 * running map, and refines abort outcomes (Stalled vs CanceledByReconciliation).
 *
 * Turn timeout (agent.turn_timeout_ms) is enforced here as a hard cap on a
 * single attempt. Inactivity (stall) is enforced by the orchestrator, which can
 * abort via the provided signal.
 */

import type { Config } from "./config.js";
import type { Issue, RunPhase, RunResult, RuntimeEvent } from "./domain.js";
import { AgentAbortError, type AgentRegistry } from "./agent.js";
import { WorkspaceManager } from "./workspace.js";
import { buildIssueEnv, runHook, runHookOrThrow, HookError } from "./hooks.js";
import { buildPromptContext, renderPrompt } from "./prompt.js";
import { Logger } from "./logger.js";

const DEFAULT_GUIDANCE =
  "Continue working toward the Definition of Done from the original task. " +
  "If the work is already complete, perform the handoff described in the workflow. " +
  "Do not repeat steps you have already finished.";

export interface RunnerDeps {
  workspaces: WorkspaceManager;
  registry: AgentRegistry;
  log: Logger;
}

export interface RunParams {
  config: Config;
  issue: Issue;
  /** null on the first run; integer on retries/continuations (SPEC `attempt`). */
  attempt: number | null;
  /** Present => continuation: resume this session and send guidance only. */
  sessionId?: string;
  promptTemplate: string;
  signal: AbortSignal;
  onEvent: (event: RuntimeEvent) => void;
  setPhase: (phase: RunPhase) => void;
}

export async function runAttempt(deps: RunnerDeps, params: RunParams): Promise<RunResult> {
  const { config, issue, attempt, sessionId, promptTemplate, signal, onEvent, setPhase } = params;
  const { workspaces, registry, log } = deps;
  const started = Date.now();
  const elapsed = () => (Date.now() - started) / 1000;

  // --- Phase 1: prepare workspace -----------------------------------------
  setPhase("PreparingWorkspace");
  const ws = await workspaces.ensure(issue.identifier);
  const env = buildIssueEnv(issue, ws.path, attempt);

  try {
    if (ws.created && config.hooks.afterCreate) {
      await runHookOrThrow("after_create", config.hooks.afterCreate, ws.path, config.hooks.timeoutMs, env, log);
    }
    if (config.hooks.beforeRun) {
      await runHookOrThrow("before_run", config.hooks.beforeRun, ws.path, config.hooks.timeoutMs, env, log);
    }
  } catch (err) {
    if (err instanceof HookError) {
      return { outcome: "Failed", error: err.message, runtimeSeconds: elapsed() };
    }
    throw err;
  }

  // --- Phase 2: build prompt ----------------------------------------------
  setPhase("BuildingPrompt");
  let prompt: string;
  try {
    if (sessionId) {
      // Continuation turn: guidance only (preserve prior thread history).
      prompt = renderPrompt(DEFAULT_GUIDANCE, buildPromptContext(issue, attempt));
    } else {
      prompt = renderPrompt(promptTemplate, buildPromptContext(issue, attempt));
    }
  } catch (err) {
    return { outcome: "Failed", error: `prompt render failed: ${(err as Error).message}`, runtimeSeconds: elapsed() };
  }

  // --- Phase 3-5: launch agent, init session, stream turn -----------------
  setPhase("LaunchingAgentProcess");
  const driver = registry.resolve(issue, config.agent.defaultDriver);

  const localAbort = new AbortController();
  let timedOut = false;
  const onParentAbort = () => localAbort.abort();
  signal.addEventListener("abort", onParentAbort, { once: true });
  const turnTimer = setTimeout(() => {
    timedOut = true;
    localAbort.abort();
  }, config.agent.turnTimeoutMs);

  const wrappedOnEvent = (event: RuntimeEvent) => {
    if (event.type === "session_started") setPhase("StreamingTurn");
    onEvent(event);
  };

  let result: RunResult;
  try {
    result = await driver.run({
      issue,
      workspacePath: ws.path,
      prompt,
      attempt,
      sessionId,
      env,
      config,
      signal: localAbort.signal,
      onEvent: wrappedOnEvent,
      log: log.child({ agent: driver.name }),
    });
  } catch (err) {
    if (err instanceof AgentAbortError) {
      // Distinguish our own turn timeout from an external (stall/reconcile) abort.
      result = timedOut
        ? { outcome: "TimedOut", error: `turn exceeded ${config.agent.turnTimeoutMs}ms`, runtimeSeconds: elapsed() }
        : { outcome: "CanceledByReconciliation", runtimeSeconds: elapsed() };
    } else {
      result = { outcome: "Failed", error: (err as Error).message, runtimeSeconds: elapsed() };
    }
  } finally {
    clearTimeout(turnTimer);
    signal.removeEventListener("abort", onParentAbort);
  }

  // --- Phase 6: finish -----------------------------------------------------
  setPhase("Finishing");
  if (config.hooks.afterRun) {
    // after_run failures are logged and ignored (SPEC).
    const r = await runHook("after_run", config.hooks.afterRun, ws.path, config.hooks.timeoutMs, env, log);
    if (r.timedOut || r.code !== 0) {
      log.warn("after_run hook failed (ignored)", { issue_identifier: issue.identifier, code: r.code });
    }
  }

  return result;
}
