#!/usr/bin/env node
/**
 * Symphony CLI — Taskwarrior adaptation.
 *
 *   symphony start     [-w WORKFLOW.md]   run the orchestrator daemon
 *   symphony validate  [-w WORKFLOW.md]   parse & validate the workflow, print a summary
 *   symphony state     [--url URL]        print /api/v1/state from a running daemon
 *   symphony refresh   [--url URL]        trigger an immediate poll + reconcile
 *   symphony version | help
 *
 * Wires the layers together: Config (WORKFLOW.md) → Integration (Taskwarrior) →
 * Coordination (Orchestrator) → Execution (agent drivers) → Observability (HTTP).
 */

import path from "node:path";
import { loadWorkflow, watchWorkflow, ConfigError, type Config, type Workflow } from "./config.js";
import { TaskwarriorTracker } from "./taskwarrior.js";
import type { Tracker } from "./tracker.js";
import { AgentRegistry } from "./agent.js";
import { ClaudeDriver } from "./drivers/claude.js";
import { CodexDriver } from "./drivers/codex.js";
import { MockDriver } from "./drivers/mock.js";
import { Orchestrator } from "./orchestrator.js";
import { startHttpServer } from "./http.js";
import { Logger, log as rootLog } from "./logger.js";

const VERSION = "0.1.0";

interface Args {
  command: string;
  workflow: string;
  url: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "", workflow: path.resolve("WORKFLOW.md"), url: null, help: false };
  const rest = [...argv];
  while (rest.length) {
    const tok = rest.shift()!;
    if (tok === "-w" || tok === "--workflow") args.workflow = path.resolve(rest.shift() ?? "");
    else if (tok === "--url") args.url = rest.shift() ?? null;
    else if (tok === "-h" || tok === "--help") args.help = true;
    else if (!args.command) args.command = tok;
  }
  return args;
}

function buildRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(new ClaudeDriver());
  registry.register(new CodexDriver());
  registry.register(new MockDriver());
  return registry;
}

function buildTracker(config: Config, log: Logger): Tracker {
  switch (config.tracker.kind) {
    case "taskwarrior":
      return new TaskwarriorTracker(config.tracker, log);
    default:
      throw new ConfigError(`unsupported tracker kind: ${config.tracker.kind}`);
  }
}

const HELP = `Symphony (Taskwarrior adaptation) v${VERSION}

Usage:
  symphony start     [-w WORKFLOW.md]    Run the orchestrator daemon
  symphony validate  [-w WORKFLOW.md]    Parse & validate the workflow, print a summary
  symphony state     [--url URL]         Print /api/v1/state from a running daemon
  symphony refresh   [--url URL]         Trigger an immediate poll + reconcile cycle
  symphony version
  symphony help

Defaults: WORKFLOW.md in the current directory; URL http://127.0.0.1:4517

Environment:
  SYMPHONY_LOG_LEVEL=debug|info|warn|error   log threshold (default info)
  SYMPHONY_LOG_PRETTY=1                       human-readable logs (default JSON)
  SYMPHONY_MAX_CONTINUATIONS=N                cap rapid continuations (default 25)
`;

async function cmdValidate(args: Args): Promise<number> {
  let wf: Workflow;
  try {
    wf = await loadWorkflow(args.workflow);
  } catch (err) {
    rootLog.error("workflow invalid", { source: args.workflow, error: (err as Error).message });
    return 1;
  }
  const c = wf.config;
  const summary = {
    source: wf.sourcePath,
    tracker: {
      kind: c.tracker.kind,
      filter: c.tracker.filter,
      active_states: c.tracker.activeStates,
      terminal_states: c.tracker.terminalStates,
      todo_state: c.tracker.todoState,
      state_attr: c.tracker.stateAttr,
      agent_attr: c.tracker.agentAttr,
      dispatch_transition: c.tracker.dispatchTransition,
    },
    polling_ms: c.polling.intervalMs,
    workspace_root: c.workspace.root,
    agent: {
      default_driver: c.agent.defaultDriver,
      max_concurrent: c.agent.maxConcurrentAgents,
      by_state: c.agent.maxConcurrentAgentsByState,
      stall_timeout_ms: c.agent.stallTimeoutMs,
      turn_timeout_ms: c.agent.turnTimeoutMs,
      max_retry_backoff_ms: c.agent.maxRetryBackoffMs,
    },
    hooks: {
      after_create: Boolean(c.hooks.afterCreate),
      before_run: Boolean(c.hooks.beforeRun),
      after_run: Boolean(c.hooks.afterRun),
      before_remove: Boolean(c.hooks.beforeRemove),
    },
    http: c.http,
    prompt_template_chars: wf.promptTemplate.length,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  rootLog.info("workflow valid", { source: wf.sourcePath });
  return 0;
}

async function cmdStart(args: Args): Promise<number> {
  let wf: Workflow;
  try {
    wf = await loadWorkflow(args.workflow);
  } catch (err) {
    rootLog.error("failed to load workflow", { source: args.workflow, error: (err as Error).message });
    return 1;
  }

  const log = rootLog;
  const tracker = buildTracker(wf.config, log);
  const registry = buildRegistry();
  const orch = new Orchestrator({ workflow: wf, tracker, registry, logger: log });

  const server = wf.config.http.enabled ? startHttpServer(orch, wf.config.http, log) : null;
  const stopWatch = watchWorkflow(args.workflow, log, (next) => orch.reload(next));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    stopWatch();
    server?.close();
    await orch.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await orch.start();
  return 0; // process stays alive via the poll interval / http server
}

async function cmdHttp(args: Args, route: "state" | "refresh"): Promise<number> {
  const base = args.url ?? "http://127.0.0.1:4517";
  try {
    if (route === "state") {
      const res = await fetch(`${base}/api/v1/state`);
      process.stdout.write((await res.text()) + "\n");
    } else {
      const res = await fetch(`${base}/api/v1/refresh`, { method: "POST" });
      process.stdout.write((await res.text()) + "\n");
    }
    return 0;
  } catch (err) {
    rootLog.error(`could not reach daemon at ${base}`, { error: String(err) });
    return 1;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === "help" || args.command === "") {
    process.stdout.write(HELP);
    process.exit(args.command === "" && !args.help ? 1 : 0);
  }

  let code = 0;
  switch (args.command) {
    case "version":
      process.stdout.write(`${VERSION}\n`);
      break;
    case "validate":
      code = await cmdValidate(args);
      break;
    case "start":
      code = await cmdStart(args);
      break;
    case "state":
      code = await cmdHttp(args, "state");
      break;
    case "refresh":
      code = await cmdHttp(args, "refresh");
      break;
    default:
      rootLog.error("unknown command", { command: args.command });
      process.stdout.write(HELP);
      code = 1;
  }
  if (args.command !== "start") process.exit(code);
}

main().catch((err) => {
  rootLog.error("fatal", { error: String(err?.stack ?? err) });
  process.exit(1);
});
