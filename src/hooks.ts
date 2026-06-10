/**
 * Workspace hooks (Execution Layer, SPEC §"Workspace Hooks").
 *
 * Hooks run in a shell with the workspace as cwd and a bounded timeout. Failure
 * semantics are decided by the caller (the runner):
 *   after_create  -> fatal to workspace creation
 *   before_run    -> fatal to the current attempt
 *   after_run     -> logged, ignored
 *   before_remove -> logged, ignored
 */

import { spawn } from "node:child_process";
import type { Issue } from "./domain.js";
import { Logger } from "./logger.js";

export interface HookResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class HookError extends Error {
  constructor(
    readonly hookName: string,
    readonly result: HookResult,
  ) {
    super(`hook "${hookName}" failed (exit=${result.code}${result.timedOut ? ", timed out" : ""})`);
    this.name = "HookError";
  }
}

/** Environment exposed to hooks (and inherited by agent subprocesses). */
export function buildIssueEnv(
  issue: Issue,
  workspacePath: string,
  attempt: number | null,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    SYMPHONY_ISSUE_ID: issue.id,
    SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
    SYMPHONY_ISSUE_TITLE: issue.title,
    SYMPHONY_ISSUE_STATE: issue.state,
    SYMPHONY_ISSUE_AGENT: issue.agent ?? "",
    SYMPHONY_BRANCH: issue.branchName,
    SYMPHONY_WORKSPACE: workspacePath,
    SYMPHONY_ATTEMPT: attempt === null ? "" : String(attempt),
  };
}

const MAX_LOG = 4_000; // SPEC: truncate hook output in logs.

function truncate(s: string): string {
  return s.length > MAX_LOG ? s.slice(0, MAX_LOG) + `…(+${s.length - MAX_LOG} bytes)` : s;
}

/** Run a single hook command (`bash -lc <cmd>`) with a timeout. */
export function runHook(
  name: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  log: Logger,
): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result: HookResult = { code, stdout, stderr, timedOut };
      log.debug(`hook ${name} finished`, {
        hook: name,
        code,
        timedOut,
        stdout: truncate(stdout.trim()),
        stderr: truncate(stderr.trim()),
      });
      resolve(result);
    });
  });
}

/** Run a hook and throw HookError on non-zero exit (used for fatal hooks). */
export async function runHookOrThrow(
  name: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  log: Logger,
): Promise<void> {
  const result = await runHook(name, command, cwd, timeoutMs, env, log);
  if (result.timedOut || result.code !== 0) throw new HookError(name, result);
}
