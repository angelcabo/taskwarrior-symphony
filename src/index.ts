#!/usr/bin/env node
/**
 * Symphony CLI — Taskwarrior adaptation.
 *
 *   symphony start     [-w WORKFLOW.md]   run the orchestrator daemon
 *   symphony validate  [-w WORKFLOW.md]   parse & validate the workflow, print a summary
 *   symphony state     [-f] [--url URL]   print /api/v1/state; -f = live top-style overview
 *   symphony refresh   [--url URL]        trigger an immediate poll + reconcile
 *   symphony watch <id> [-f] [-n N]       inspect one task (state + recent log); -f to follow, -n last N
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
  /** First positional after the command (e.g. the task id for `watch`). */
  target: string | null;
  /** `watch -f/--follow`: keep streaming instead of one-shot (tail -f). */
  follow: boolean;
  /** `watch -n/--lines N`: show only the last N events. */
  lines: number | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "", workflow: path.resolve("WORKFLOW.md"), url: null, help: false, target: null, follow: false, lines: null };
  const rest = [...argv];
  while (rest.length) {
    const tok = rest.shift()!;
    if (tok === "-w" || tok === "--workflow") args.workflow = path.resolve(rest.shift() ?? "");
    else if (tok === "--url") args.url = rest.shift() ?? null;
    else if (tok === "-f" || tok === "--follow") args.follow = true;
    else if (tok === "-n" || tok === "--lines") args.lines = Number.parseInt(rest.shift() ?? "", 10);
    else if (tok === "-h" || tok === "--help") args.help = true;
    else if (!args.command) args.command = tok;
    else if (!args.target) args.target = tok;
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
  symphony state     [-f] [--url URL]    Print /api/v1/state; -f for a live top-style overview (refresh 2s)
  symphony refresh   [--url URL]         Trigger an immediate poll + reconcile cycle
  symphony watch <id> [-f] [-n N]        Inspect one task: state + recent log, then exit. -f follows (tail -f); -n last N
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Format the daemon's /api/v1/state snapshot as a compact top-style overview. */
function renderState(s: any): string {
  const t = s.totals ?? {};
  const L: string[] = [
    `symphony · up ${s.uptime_seconds ?? 0}s · running ${(s.running ?? []).length} · retrying ${(s.retry_queue ?? []).length} · claimed ${s.claimed ?? 0}`,
    `tokens ${t.totalTokens ?? 0} · $${Number(t.costUsd ?? 0).toFixed(2)} · agent-time ${Math.round(t.runtimeSeconds ?? 0)}s`,
    "",
  ];
  const running = s.running ?? [];
  if (running.length) {
    L.push("RUNNING");
    for (const r of running) {
      L.push(`  ${String(r.identifier).padEnd(16)} ${`${r.state}/${r.phase}`.padEnd(24)} ${String(r.driver).padEnd(7)} attempt ${r.attempt} · idle ${Math.round((r.idle_ms ?? 0) / 1000)}s`);
    }
  } else {
    L.push("(nothing running)");
  }
  const retry = s.retry_queue ?? [];
  if (retry.length) {
    L.push("", "RETRY QUEUE");
    for (const q of retry) {
      L.push(`  ${String(q.identifier).padEnd(16)} ${String(q.kind).padEnd(12)} attempt ${q.attempt} · due ${Math.round((q.due_in_ms ?? 0) / 1000)}s`);
    }
  }
  L.push("", `updated ${new Date().toTimeString().slice(0, 8)} · refresh 2s · Ctrl-C to stop`);
  return L.join("\n");
}

/** `state -f`: repaint the top-style overview every 2s until Ctrl-C. */
async function cmdStateFollow(base: string): Promise<number> {
  process.on("SIGINT", () => {
    process.stdout.write("\x1b[?25h\n■ stopped\n"); // restore cursor, then exit
    process.exit(0);
  });
  process.stdout.write("\x1b[?25l"); // hide cursor while repainting
  for (;;) {
    try {
      const res = await fetch(`${base}/api/v1/state`);
      process.stdout.write("\x1b[2J\x1b[H" + renderState(await res.json()) + "\n");
    } catch {
      process.stdout.write(`\x1b[2J\x1b[H  could not reach daemon at ${base} — retrying…\n`);
    }
    await sleep(2000);
  }
}

async function cmdHttp(args: Args, route: "state" | "refresh"): Promise<number> {
  const base = args.url ?? "http://127.0.0.1:4517";
  if (route === "state" && args.follow) return cmdStateFollow(base);
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

/**
 * Inspect one task: print a state header + its recent event log, then exit
 * (tail semantics). `-f`/`--follow` keeps streaming live; `-n N` limits history.
 * Replaces the old `curl /api/v1/<id> | jq` for both the snapshot and the log.
 */
async function cmdWatch(args: Args): Promise<number> {
  const base = args.url ?? "http://127.0.0.1:4517";
  const target = args.target;
  if (!target) {
    rootLog.error("usage: symphony watch <id|uuid|prefix> [-f] [-n N] [--url URL]");
    return 1;
  }
  const id = encodeURIComponent(target);

  // State header — absorbs the old `curl /api/v1/<id> | jq`. Best-effort: a
  // finished task has no live state (404), so we just show its log below.
  try {
    const sres = await fetch(`${base}/api/v1/${id}`);
    if (sres.ok) {
      const s = (await sres.json()) as {
        identifier?: string;
        workspace_path?: string | null;
        running?: { state: string; phase: string; driver: string; session_id?: string; idle_ms?: number } | null;
        retry?: { attempt: number; due_in_ms?: number } | null;
      };
      const label = s.running
        ? `${s.running.state}/${s.running.phase} · ${s.running.driver} · session ${s.running.session_id ?? "—"} · idle ${Math.round((s.running.idle_ms ?? 0) / 1000)}s`
        : s.retry
          ? `retrying (attempt ${s.retry.attempt}, due in ${Math.round((s.retry.due_in_ms ?? 0) / 1000)}s)`
          : "not currently in flight";
      process.stdout.write(`# ${s.identifier ?? target} · ${label}\n`);
      if (s.workspace_path) process.stdout.write(`# workspace ${s.workspace_path}\n`);
    }
  } catch {
    /* daemon/snapshot unavailable; the stream request below reports clearly */
  }

  // Event log. Default is one-shot (?follow=0); -f keeps it open. -n caps history.
  const params = new URLSearchParams();
  if (!args.follow) params.set("follow", "0");
  if (args.lines && args.lines > 0) params.set("n", String(args.lines));
  const qs = params.toString();

  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/${id}/stream${qs ? `?${qs}` : ""}`, {
      headers: { accept: "text/event-stream" },
    });
  } catch (err) {
    rootLog.error(`could not reach daemon at ${base}`, { error: String(err) });
    return 1;
  }
  if (res.status === 404) {
    process.stdout.write(`no recent stream for "${target}" — is it running? (try: symphony state)\n`);
    return 1;
  }
  if (!res.ok || !res.body) {
    rootLog.error("stream request failed", { status: res.status });
    return 1;
  }

  if (args.follow) {
    process.stdout.write(`▶ following ${target}  (Ctrl-C to detach)\n`);
    process.on("SIGINT", () => {
      process.stdout.write("\n■ detached\n");
      process.exit(0);
    });
  }

  const fmt = (ev: { ts?: number; kind: string; message?: string }): string => {
    const t = new Date(ev.ts ?? Date.now()).toTimeString().slice(0, 8);
    return `  ${t}  ${String(ev.kind).padEnd(16)} ${ev.message ?? ""}`.replace(/\s+$/, "");
  };

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break; // one-shot: server closed after the buffer
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue; // heartbeat / comment line
      let ev: { ts?: number; kind: string; message?: string };
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      process.stdout.write(fmt(ev) + "\n");
      if (ev.kind === "end" && args.follow) {
        await reader.cancel().catch(() => undefined);
        return 0;
      }
    }
  }
  return 0;
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
    case "watch":
      code = await cmdWatch(args);
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
