/**
 * Configuration Layer (SPEC §2).
 *
 * Parses the YAML front matter from WORKFLOW.md, applies typed defaults,
 * resolves `$VAR` environment indirection, and produces a fully-typed `Config`
 * plus the Markdown prompt body. Also provides a file watcher for dynamic
 * reload (SPEC §"Configuration Reload"): on an invalid reload we keep the last
 * known-good config and surface an error.
 */

import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { Logger } from "./logger.js";

export class ConfigError extends Error {}

export type TrackerKind = "taskwarrior";

export interface TrackerConfig {
  kind: TrackerKind;
  /** TASKDATA directory; null = Taskwarrior default. */
  dataDir: string | null;
  /** TASKRC path; null = Taskwarrior default. */
  taskrc: string | null;
  /** Taskwarrior binary. */
  taskBin: string;
  /** Base filter prepended to every query (e.g. "status:pending"). */
  filter: string;
  activeStates: string[];
  terminalStates: string[];
  /** The state whose pending blockers gate eligibility (SPEC blocker rule). */
  todoState: string;
  /** Prefix used to synthesize human-friendly identifiers (SYM-ab12cd34). */
  identifierPrefix: string;
  /** UDA holding the workflow state. */
  stateAttr: string;
  /** UDA selecting the agent driver. */
  agentAttr: string;
  /** UDA overriding the synthesized branch name (optional). */
  branchAttr: string;
  /**
   * Adaptation: if set, the orchestrator transitions a task into this state on
   * dispatch, giving visible locking in `task` and durable restart recovery.
   * The SPEC keeps claiming purely in-memory; null preserves that behavior.
   */
  dispatchTransition: string | null;
}

export interface PollingConfig {
  intervalMs: number;
}

export interface WorkspaceConfig {
  /** Absolute, expanded workspace root. */
  root: string;
}

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxConcurrentAgentsByState: Record<string, number>;
  maxTurns: number | null;
  /** Base of the failure backoff formula (SPEC: 10000). */
  baseRetryMs: number;
  /** Cap on failure backoff (SPEC default 300000). */
  maxRetryBackoffMs: number;
  /** Continuation retry delay after a clean non-terminal exit (SPEC: 1000). */
  continuationDelayMs: number;
  /** Orchestrator-enforced inactivity timeout (SPEC stall_timeout_ms). */
  stallTimeoutMs: number;
  /** Hard cap on a single attempt's wall-clock runtime. */
  turnTimeoutMs: number;
  /** Driver used when a task has no `agent:` attribute. */
  defaultDriver: string;
}

export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface ClaudeConfig {
  command: string;
  permissionMode: ClaudePermissionMode;
  model: string | null;
  allowedTools: string | null;
  extraArgs: string[];
}

export interface CodexConfig {
  /** The codex binary (the driver appends `exec --json …`). */
  command: string;
  /** Sandbox policy for the first turn: read-only | workspace-write | danger-full-access. */
  sandbox: string;
  /** Skip sandbox + approval prompts entirely (full autonomy). */
  dangerouslyBypass: boolean;
  /** Pass --skip-git-repo-check (workspaces may be freshly initialized). */
  skipGitRepoCheck: boolean;
  model: string | null;
  extraArgs: string[];
}

export interface HttpConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface Config {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  claude: ClaudeConfig;
  codex: CodexConfig;
  http: HttpConfig;
}

export interface Workflow {
  config: Config;
  /** Markdown prompt body (everything after the front matter). */
  promptTemplate: string;
  sourcePath: string;
  sourceDir: string;
}

// --- $VAR resolution -------------------------------------------------------

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function resolveEnvString(value: string): string {
  return value.replace(ENV_PATTERN, (_m, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare;
    return name && process.env[name] !== undefined ? (process.env[name] as string) : "";
  });
}

function deepResolveEnv<T>(value: T): T {
  if (typeof value === "string") return resolveEnvString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepResolveEnv(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepResolveEnv(v);
    return out as unknown as T;
  }
  return value;
}

// --- typed accessors -------------------------------------------------------

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${where} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function str(obj: Record<string, unknown>, key: string, def: string, where: string): string {
  const v = obj[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== "string") throw new ConfigError(`${where}.${key} must be a string`);
  return v;
}

function optStr(obj: Record<string, unknown>, key: string, where: string): string | null {
  const v = obj[key];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new ConfigError(`${where}.${key} must be a string`);
  return v;
}

function num(obj: Record<string, unknown>, key: string, def: number, where: string): number {
  const v = obj[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ConfigError(`${where}.${key} must be a number`);
  }
  return v;
}

function optNum(obj: Record<string, unknown>, key: string, where: string): number | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ConfigError(`${where}.${key} must be a number`);
  }
  return v;
}

function bool(obj: Record<string, unknown>, key: string, def: boolean, where: string): boolean {
  const v = obj[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== "boolean") throw new ConfigError(`${where}.${key} must be a boolean`);
  return v;
}

function strArray(obj: Record<string, unknown>, key: string, def: string[], where: string): string[] {
  const v = obj[key];
  if (v === undefined || v === null) return def;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ConfigError(`${where}.${key} must be a list of strings`);
  }
  return v as string[];
}

function numMap(obj: Record<string, unknown>, key: string, where: string): Record<string, number> {
  const v = obj[key];
  if (v === undefined || v === null) return {};
  const rec = asRecord(v, `${where}.${key}`);
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(rec)) {
    if (typeof val !== "number" || !Number.isFinite(val)) {
      throw new ConfigError(`${where}.${key}.${k} must be a number`);
    }
    out[k] = val;
  }
  return out;
}

// --- path expansion --------------------------------------------------------

/** Expand `~`, `$VAR`, and resolve relative paths against `baseDir` (SPEC). */
export function expandPath(p: string, baseDir: string): string {
  let out = resolveEnvString(p);
  if (out === "~") out = os.homedir();
  else if (out.startsWith("~/")) out = path.join(os.homedir(), out.slice(2));
  if (!path.isAbsolute(out)) out = path.resolve(baseDir, out);
  return path.normalize(out);
}

// --- front matter split ----------------------------------------------------

const FRONT_MATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

export function splitFrontMatter(text: string): { frontMatter: string | null; body: string } {
  const m = FRONT_MATTER.exec(text);
  if (!m) return { frontMatter: null, body: text };
  return { frontMatter: m[1] ?? "", body: m[2] ?? "" };
}

// --- typed mapping ---------------------------------------------------------

function buildConfig(raw: Record<string, unknown>, sourceDir: string): Config {
  const trackerRaw = asRecord(raw["tracker"], "tracker");
  const kind = str(trackerRaw, "kind", "taskwarrior", "tracker");
  if (kind !== "taskwarrior") {
    throw new ConfigError(
      `tracker.kind="${kind}" is not supported by this build (Taskwarrior adaptation). Use kind: taskwarrior.`,
    );
  }

  const tracker: TrackerConfig = {
    kind: "taskwarrior",
    dataDir: optStr(trackerRaw, "data_dir", "tracker"),
    taskrc: optStr(trackerRaw, "taskrc", "tracker"),
    taskBin: str(trackerRaw, "task_bin", "task", "tracker"),
    filter: str(trackerRaw, "filter", "status:pending", "tracker"),
    activeStates: strArray(trackerRaw, "active_states", ["todo", "active", "review"], "tracker"),
    terminalStates: strArray(trackerRaw, "terminal_states", ["done", "canceled"], "tracker"),
    todoState: str(trackerRaw, "todo_state", "todo", "tracker"),
    identifierPrefix: str(trackerRaw, "identifier_prefix", "SYM", "tracker"),
    stateAttr: str(trackerRaw, "state_attr", "state", "tracker"),
    agentAttr: str(trackerRaw, "agent_attr", "agent", "tracker"),
    branchAttr: str(trackerRaw, "branch_attr", "branch", "tracker"),
    dispatchTransition: optStr(trackerRaw, "dispatch_transition", "tracker"),
  };
  if (tracker.activeStates.length === 0) {
    throw new ConfigError("tracker.active_states must list at least one state");
  }

  const pollingRaw = asRecord(raw["polling"], "polling");
  const polling: PollingConfig = { intervalMs: num(pollingRaw, "interval_ms", 30_000, "polling") };
  if (polling.intervalMs < 100) throw new ConfigError("polling.interval_ms must be >= 100");

  const wsRaw = asRecord(raw["workspace"], "workspace");
  const workspace: WorkspaceConfig = {
    root: expandPath(str(wsRaw, "root", "~/.symphony/workspaces", "workspace"), sourceDir),
  };

  const hooksRaw = asRecord(raw["hooks"], "hooks");
  const hooks: HooksConfig = {
    afterCreate: optStr(hooksRaw, "after_create", "hooks"),
    beforeRun: optStr(hooksRaw, "before_run", "hooks"),
    afterRun: optStr(hooksRaw, "after_run", "hooks"),
    beforeRemove: optStr(hooksRaw, "before_remove", "hooks"),
    timeoutMs: num(hooksRaw, "timeout_ms", 60_000, "hooks"),
  };

  const agentRaw = asRecord(raw["agent"], "agent");
  const codexRaw = asRecord(raw["codex"], "codex");
  const agent: AgentConfig = {
    maxConcurrentAgents: num(agentRaw, "max_concurrent_agents", 10, "agent"),
    maxConcurrentAgentsByState: numMap(agentRaw, "max_concurrent_agents_by_state", "agent"),
    maxTurns: optNum(agentRaw, "max_turns", "agent"),
    baseRetryMs: num(agentRaw, "base_retry_ms", 10_000, "agent"),
    maxRetryBackoffMs: num(agentRaw, "max_retry_backoff_ms", 300_000, "agent"),
    continuationDelayMs: num(agentRaw, "continuation_delay_ms", 1_000, "agent"),
    // Accept agent.stall_timeout_ms; fall back to codex.stall_timeout_ms for SPEC compat.
    stallTimeoutMs: num(
      agentRaw,
      "stall_timeout_ms",
      num(codexRaw, "stall_timeout_ms", 300_000, "codex"),
      "agent",
    ),
    turnTimeoutMs: num(
      agentRaw,
      "turn_timeout_ms",
      num(codexRaw, "turn_timeout_ms", 3_600_000, "codex"),
      "agent",
    ),
    defaultDriver: str(agentRaw, "default_driver", "claude", "agent"),
  };
  if (agent.maxConcurrentAgents < 1) throw new ConfigError("agent.max_concurrent_agents must be >= 1");

  const claudeRaw = asRecord(raw["claude"], "claude");
  const permissionMode = str(claudeRaw, "permission_mode", "acceptEdits", "claude") as ClaudePermissionMode;
  if (!["default", "acceptEdits", "plan", "bypassPermissions"].includes(permissionMode)) {
    throw new ConfigError(`claude.permission_mode "${permissionMode}" is invalid`);
  }
  const claude: ClaudeConfig = {
    command: str(claudeRaw, "command", "claude", "claude"),
    permissionMode,
    model: optStr(claudeRaw, "model", "claude"),
    allowedTools: optStr(claudeRaw, "allowed_tools", "claude"),
    extraArgs: strArray(claudeRaw, "extra_args", [], "claude"),
  };

  const codex: CodexConfig = {
    command: str(codexRaw, "command", "codex", "codex"),
    sandbox: str(codexRaw, "sandbox", "workspace-write", "codex"),
    dangerouslyBypass: bool(codexRaw, "dangerously_bypass", false, "codex"),
    skipGitRepoCheck: bool(codexRaw, "skip_git_repo_check", true, "codex"),
    model: optStr(codexRaw, "model", "codex"),
    extraArgs: strArray(codexRaw, "extra_args", [], "codex"),
  };

  const httpRaw = asRecord(raw["http"], "http");
  const http: HttpConfig = {
    enabled: bool(httpRaw, "enabled", false, "http"),
    host: str(httpRaw, "host", "127.0.0.1", "http"),
    port: num(httpRaw, "port", 4517, "http"),
  };

  return { tracker, polling, workspace, hooks, agent, claude, codex, http };
}

/** Parse WORKFLOW.md text into a typed Workflow. */
export function parseWorkflow(text: string, sourcePath: string): Workflow {
  const sourceDir = path.dirname(path.resolve(sourcePath));
  const { frontMatter, body } = splitFrontMatter(text);

  let rawConfig: Record<string, unknown> = {};
  if (frontMatter !== null && frontMatter.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = parseYaml(frontMatter);
    } catch (err) {
      throw new ConfigError(`Invalid YAML front matter: ${(err as Error).message}`);
    }
    rawConfig = deepResolveEnv(asRecord(parsed, "front matter"));
  }

  const config = buildConfig(rawConfig, sourceDir);
  return { config, promptTemplate: body.trim(), sourcePath: path.resolve(sourcePath), sourceDir };
}

/** Load and parse WORKFLOW.md from disk. */
export async function loadWorkflow(sourcePath: string): Promise<Workflow> {
  const text = await readFile(sourcePath, "utf8");
  return parseWorkflow(text, sourcePath);
}

/**
 * Watch WORKFLOW.md and re-parse on change (SPEC §"Configuration Reload").
 * Invalid reloads are logged and ignored, preserving the last known-good config.
 * Returns a function that stops watching.
 */
export function watchWorkflow(
  sourcePath: string,
  log: Logger,
  onReload: (next: Workflow) => void,
): () => void {
  let timer: NodeJS.Timeout | null = null;
  const watcher = watch(sourcePath, () => {
    if (timer) clearTimeout(timer);
    // Debounce: editors emit multiple events per save.
    timer = setTimeout(async () => {
      try {
        const next = await loadWorkflow(sourcePath);
        log.info("workflow reloaded", { source: sourcePath });
        onReload(next);
      } catch (err) {
        log.error("workflow reload failed; keeping last known-good config", {
          error: (err as Error).message,
        });
      }
    }, 150);
  });
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
