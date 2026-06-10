/**
 * Agent driver abstraction (Execution Layer, SPEC §"Coding-Agent Integration").
 *
 * The SPEC hardcodes Codex; this adaptation makes the coding agent pluggable so
 * a task can choose its driver via the `agent:` attribute (agent:claude /
 * agent:codex / agent:mock). The orchestrator interacts only with this
 * interface and the RuntimeEvent stream — it never knows which agent ran.
 */

import type { Config } from "./config.js";
import type { Issue, RunResult, RuntimeEvent } from "./domain.js";
import { Logger } from "./logger.js";

export interface AgentRunContext {
  issue: Issue;
  /** Absolute workspace cwd (already validated for containment). */
  workspacePath: string;
  /** Full issue prompt on the first turn; guidance-only on continuations. */
  prompt: string;
  /** null on the first run, an integer on retries (SPEC `attempt`). */
  attempt: number | null;
  /** Present on continuation turns: resume this agent session/thread. */
  sessionId?: string;
  /** Environment for the agent subprocess (includes SYMPHONY_* issue context). */
  env: NodeJS.ProcessEnv;
  config: Config;
  /** Aborted by the runner on stall, turn timeout, or reconciliation cancel. */
  signal: AbortSignal;
  /** Emit a runtime event (advances last-activity for stall detection). */
  onEvent: (event: RuntimeEvent) => void;
  log: Logger;
}

export interface AvailabilityResult {
  ok: boolean;
  detail?: string;
}

export interface AgentDriver {
  readonly name: string;
  /** Run one attempt to completion; reject with AbortError if the signal fires. */
  run(ctx: AgentRunContext): Promise<RunResult>;
  /** Optional dispatch-preflight check (SPEC: "codex command exists"). */
  checkAvailable?(config: Config): Promise<AvailabilityResult>;
}

/** Raised by drivers when the run is aborted; mapped to an outcome by the runner. */
export class AgentAbortError extends Error {
  constructor() {
    super("agent run aborted");
    this.name = "AgentAbortError";
  }
}

export class AgentRegistry {
  private readonly drivers = new Map<string, AgentDriver>();

  register(driver: AgentDriver): void {
    this.drivers.set(driver.name, driver);
  }

  has(name: string): boolean {
    return this.drivers.has(name);
  }

  get(name: string): AgentDriver {
    const d = this.drivers.get(name);
    if (!d) {
      throw new Error(`no agent driver registered for "${name}" (have: ${[...this.drivers.keys()].join(", ")})`);
    }
    return d;
  }

  /** Resolve the driver for an issue: its `agent:` attribute or the default. */
  resolve(issue: Issue, defaultDriver: string): AgentDriver {
    return this.get(issue.agent ?? defaultDriver);
  }

  names(): string[] {
    return [...this.drivers.keys()];
  }
}

/** Shared helper: split a shell-ish command string into argv tokens. */
export function splitCommand(command: string): { bin: string; args: string[] } {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const cleaned = tokens.map((t) => t.replace(/^['"]|['"]$/g, ""));
  const [bin, ...args] = cleaned;
  return { bin: bin ?? command, args };
}
