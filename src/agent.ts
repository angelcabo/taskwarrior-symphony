/**
 * Agent driver abstraction (Execution Layer, SPEC §"Coding-Agent Integration").
 *
 * The SPEC hardcodes Codex; this adaptation makes the coding agent pluggable so
 * a task can choose its driver via the `agent:` attribute (agent:claude /
 * agent:codex / agent:mock). The orchestrator interacts only with this
 * interface and the RuntimeEvent stream — it never knows which agent ran.
 */

import { accessSync, constants as fsConstants } from "node:fs";
import { spawn as cpSpawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import * as pty from "node-pty";
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

/**
 * Parse one line of an agent's stdout as a JSON event, tolerating leading or
 * trailing terminal-control noise. Some agent wrappers — notably PTY-allocating
 * Docker sandbox runners — prefix the first line with an OSC title escape, e.g.
 * `\x1b]0;[title]\x07{"type":"system",…}`. A strict JSON.parse would drop that
 * line, and with it the session_id needed to resume the agent. On a failed
 * parse we retry on the substring spanning the first `{` to the last `}`.
 * Returns null for a line that carries no JSON object (a plain log line), which
 * the caller skips as before.
 */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const attempt = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = attempt(trimmed);
  if (direct) return direct;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return attempt(trimmed.slice(start, end + 1));
  return null;
}

/**
 * Resolve an executable by name against $PATH (or check an explicit path)
 * without executing it. A lightweight availability probe for commands that
 * route through a wrapper (e.g. `sandbox claude`), where running
 * `<bin> --version` would be meaningless or would spin up a sandbox.
 */
export function resolveOnPath(bin: string): string | null {
  const isExecutable = (p: string): boolean => {
    try {
      accessSync(p, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (bin.includes("/")) return isExecutable(bin) ? bin : null;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** A spawned agent process, abstracting over a PTY (wrapper mode) and a plain pipe. */
export interface LineProcess {
  readonly pid: number | undefined;
  kill(signal?: NodeJS.Signals): void;
}

/** Auto-answer an interactive prompt a wrapper prints to the PTY (no human present). */
export interface PtyAutoRespond {
  /** Tested against recent raw PTY output (prompts often lack a trailing newline). */
  match: RegExp;
  /** Written to the PTY when `match` first hits (e.g. "a\r" = answer "a" + Enter). */
  send: string;
}

/**
 * Auto-answer the dev-sandbox "sandbox exists" prompt under a PTY. When a wrapped
 * agent command (`sandbox claude …` / `sandbox codex …`) re-attaches to the
 * persisted per-workspace sandbox — which happens on every continuation/resume —
 * `sbx` prints `Sandbox '<name>' exists. [A]ttach / [r]ecreate / [q]uit?` and
 * blocks on `read`. That prompt is gated solely by stdin being a TTY, and the PTY
 * we allocate so `sbx` will stream the agent's stdout makes it one — so without
 * an answer the turn hangs. Answer "a" (attach) to PRESERVE in-sandbox state: the
 * agent's resumable session/thread lives inside that sandbox, so recreating it
 * would break `--resume`/`exec resume`. Irrelevant in pipe mode (non-TTY stdin
 * already auto-attaches), so drivers pass this only for wrapped commands.
 */
export const SANDBOX_ATTACH_AUTORESPOND: PtyAutoRespond[] = [{ match: /exists\.\s*\[A\]ttach/, send: "a\r" }];

export interface SpawnLinesOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * Run the agent under a pseudo-terminal. Required in wrapper mode: a Docker
   * sandbox runner (`sbx run`) only forwards the agent's full stdout when a TTY
   * is attached — with a plain pipe it emits only a terminal-title escape, so we
   * would lose every stream-json event (session_id, tool calls, usage).
   */
  usePty: boolean;
  /** PTY-mode only: auto-answer interactive wrapper prompts (e.g. sandbox re-attach). */
  autoRespond?: PtyAutoRespond[];
  /** Prompt for the agent's stdin (pipe mode only). null => write nothing. */
  stdin: string | null;
  /** Called for each newline-delimited stdout line. */
  onLine: (line: string) => void;
  /** Called once on exit. `tail` is recent output, for error messages. */
  onExit: (code: number | null, tail: string) => void;
  /** Called if the process fails to launch. */
  onError: (err: Error) => void;
}

/**
 * Spawn an agent and deliver its stdout line by line. In PTY mode (wrapper
 * commands) stdout+stderr are merged onto the pty; in pipe mode (direct binary)
 * stderr is kept separate and surfaced via the exit `tail`. The caller's line
 * parser must tolerate the terminal-control noise a PTY introduces — leading OSC
 * title escapes and trailing CR (see parseJsonLine, which strips both).
 */
export function spawnLines(opts: SpawnLinesOptions): LineProcess {
  let buf = "";
  let tail = "";
  const addTail = (s: string): void => {
    tail = (tail + s).slice(-2000);
  };
  const feed = (s: string): void => {
    buf += s;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      opts.onLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  };
  const flush = (): void => {
    if (buf.trim() !== "") {
      const last = buf;
      buf = "";
      opts.onLine(last);
    }
  };

  if (opts.usePty) {
    // node-pty rejects undefined env values; pass only defined strings.
    const env: { [key: string]: string } = {};
    for (const [k, v] of Object.entries(opts.env)) if (v !== undefined) env[k] = v;
    let proc: pty.IPty;
    try {
      proc = pty.spawn(opts.bin, opts.args, { name: "xterm-256color", cols: 200, rows: 50, cwd: opts.cwd, env });
    } catch (err) {
      queueMicrotask(() => opts.onError(err as Error));
      return { pid: undefined, kill: () => undefined };
    }
    // Auto-answer interactive wrapper prompts (sandbox re-attach). Prompts are
    // printed without a trailing newline, so match raw output, not whole lines;
    // keep a small rolling window and fire each responder at most once.
    const responders = (opts.autoRespond ?? []).map((r) => ({ ...r, fired: false }));
    let promptScan = "";
    proc.onData((d) => {
      addTail(d);
      if (responders.some((r) => !r.fired)) {
        promptScan = (promptScan + d).slice(-1024);
        for (const r of responders) {
          if (!r.fired && r.match.test(promptScan)) {
            r.fired = true;
            try {
              proc.write(r.send);
            } catch {
              /* process already exited */
            }
          }
        }
      }
      feed(d);
    });
    proc.onExit(({ exitCode }) => {
      flush();
      opts.onExit(exitCode, tail);
    });
    return {
      pid: proc.pid,
      kill: (signal) => {
        try {
          proc.kill(signal);
        } catch {
          /* already exited */
        }
      },
    };
  }

  const child: ChildProcess = cpSpawn(opts.bin, opts.args, { cwd: opts.cwd, env: opts.env });
  child.stdout?.on("data", (c: Buffer) => feed(c.toString()));
  child.stderr?.on("data", (c: Buffer) => addTail(c.toString()));
  child.on("error", (err) => opts.onError(err));
  child.on("close", (code) => {
    flush();
    opts.onExit(code, tail);
  });
  try {
    if (opts.stdin !== null) child.stdin?.write(opts.stdin);
    child.stdin?.end();
  } catch {
    /* child may have exited; exit handler settles */
  }
  return {
    pid: child.pid,
    kill: (signal) => {
      child.kill(signal);
    },
  };
}
