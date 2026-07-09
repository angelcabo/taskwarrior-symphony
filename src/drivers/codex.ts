/**
 * Codex agent driver — uses `codex exec --json` (the stable, non-interactive
 * surface), the Codex analogue of `claude -p --output-format stream-json`.
 *
 * The SPEC names the experimental `codex app-server` JSON-RPC protocol; this
 * targets `codex exec` instead, which is the supported headless entrypoint and
 * emits the same thread/turn event model as JSONL. The event format was
 * captured directly from `codex exec --json` (codex-cli 0.135.0):
 *
 *   {"type":"thread.started","thread_id":"<uuid>"}                 -> session_started
 *   {"type":"turn.started"}                                        -> turn_started
 *   {"type":"item.started","item":{"type":"command_execution",…}}  -> tool_call
 *   {"type":"item.completed","item":{"type":"agent_message",…}}    -> activity
 *   {"type":"turn.completed","usage":{input_tokens,output_tokens,…}}-> turn_completed
 *   {"type":"turn.failed","error":…} / {"type":"error",…}          -> turn_failed
 *
 * Continuation turns resume the same thread via `codex exec resume <thread_id>`,
 * which inherits the original session's cwd and sandbox. session_id = thread_id.
 *
 * Trust posture (SPEC §"Security & Safety"): `sandbox` (read-only /
 * workspace-write / danger-full-access) is operator-controlled; in exec mode
 * commands run inside the chosen sandbox without interactive approval.
 * `dangerously_bypass: true` removes the sandbox entirely for full autonomy.
 */

import { execFile } from "node:child_process";
import type { RunResult, RuntimeEvent, TokenUsage } from "../domain.js";
import {
  type AgentDriver,
  type AgentRunContext,
  type AvailabilityResult,
  type LineProcess,
  AgentAbortError,
  splitCommand,
  parseJsonLine,
  resolveOnPath,
  spawnLines,
  truncate,
  flattenToolContent,
  clampToolInput,
  TRANSCRIPT_TEXT_MAX,
  TOOL_RESULT_MAX,
  SANDBOX_ATTACH_AUTORESPOND,
} from "../agent.js";
import type { Config } from "../config.js";

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

function mapUsage(u: CodexUsage | undefined): TokenUsage {
  const input = u?.input_tokens ?? 0;
  const output = u?.output_tokens ?? 0;
  const reasoning = u?.reasoning_output_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: u?.cached_input_tokens,
    totalTokens: input + output + reasoning,
  };
}

export class CodexDriver implements AgentDriver {
  readonly name = "codex";

  buildArgs(config: Config, ctx: AgentRunContext): { bin: string; args: string[] } {
    const cfg = config.codex;
    const { bin, args: base } = splitCommand(cfg.command);
    const flags = ["--json"];
    if (cfg.skipGitRepoCheck) flags.push("--skip-git-repo-check");
    if (cfg.dangerouslyBypass) flags.push("--dangerously-bypass-approvals-and-sandbox");

    // Prompt delivery: `-` reads from stdin (default). When `command` routes
    // through a wrapper that does not forward stdin (e.g. a Docker sandbox),
    // deliver the prompt as the positional PROMPT arg instead.
    const tail = cfg.promptArg ? ctx.prompt : "-";

    if (ctx.sessionId) {
      // Continuation: resume inherits the session's cwd + sandbox.
      return { bin, args: [...base, "exec", "resume", ...flags, ...cfg.extraArgs, ctx.sessionId, tail] };
    }

    const first = [...flags];
    if (!cfg.dangerouslyBypass) first.push("--sandbox", cfg.sandbox);
    if (cfg.model) first.push("--model", cfg.model);
    first.push("-C", ctx.workspacePath);
    return { bin, args: [...base, "exec", ...first, ...cfg.extraArgs, tail] };
  }

  run(ctx: AgentRunContext): Promise<RunResult> {
    const started = Date.now();
    const { bin, args } = this.buildArgs(ctx.config, ctx);
    ctx.log.debug("launching codex exec", { bin, args: args.join(" "), workspace: ctx.workspacePath });
    const wrapped = splitCommand(ctx.config.codex.command).args.length > 0;

    return new Promise<RunResult>((resolve, reject) => {
      let proc: LineProcess;
      let sessionId = ctx.sessionId;
      let usage: TokenUsage | undefined;
      let finalResult: RunResult | null = null;
      let killed = false;
      let settled = false;

      const emit = (e: RuntimeEvent) => ctx.onEvent(e);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        ctx.signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        killed = true;
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 2000);
      };

      // Map a codex `item` (started or completed phase) to rich transcript events,
      // mirroring the claude driver: agent_message -> assistant_message, reasoning
      // -> thinking, command_execution -> tool_call (command) + tool_result (output),
      // file_change / mcp_tool_call / unknown -> tool_call (+ tool_result) with input.
      const emitItem = (phase: "started" | "completed", item: Record<string, unknown> | undefined) => {
        if (!item) return;
        const type = typeof item["type"] === "string" ? (item["type"] as string) : "item";
        const id = typeof item["id"] === "string" ? (item["id"] as string) : undefined;
        const text = typeof item["text"] === "string" ? (item["text"] as string) : "";
        switch (type) {
          case "agent_message":
            if (phase === "completed" && text.trim() !== "")
              emit({ type: "assistant_message", ts: Date.now(), text: truncate(text, TRANSCRIPT_TEXT_MAX) });
            return;
          case "reasoning":
            if (phase === "completed" && text.trim() !== "")
              emit({ type: "thinking", ts: Date.now(), text: truncate(text, TRANSCRIPT_TEXT_MAX) });
            return;
          case "command_execution": {
            const command = typeof item["command"] === "string" ? (item["command"] as string) : "";
            if (phase === "started") {
              emit({ type: "tool_call", ts: Date.now(), name: "shell", input: command || clampToolInput(item), id });
            } else {
              const out = flattenToolContent(item["aggregated_output"] ?? item["output"] ?? "");
              const exit = typeof item["exit_code"] === "number" ? (item["exit_code"] as number) : undefined;
              emit({
                type: "tool_result",
                ts: Date.now(),
                name: "shell",
                toolUseId: id,
                content: truncate(out, TOOL_RESULT_MAX),
                isError: exit !== undefined && exit !== 0,
              });
            }
            return;
          }
          case "file_change":
            if (phase === "completed")
              emit({ type: "tool_call", ts: Date.now(), name: "file_change", input: clampToolInput(item["changes"] ?? item), id });
            return;
          case "mcp_tool_call": {
            const label = [item["server"], item["tool"]].filter(Boolean).join("/") || "mcp_tool";
            if (phase === "started") {
              emit({ type: "tool_call", ts: Date.now(), name: label, input: clampToolInput(item["arguments"] ?? item), id });
            } else if (item["result"] !== undefined) {
              emit({
                type: "tool_result",
                ts: Date.now(),
                name: label,
                toolUseId: id,
                content: truncate(flattenToolContent(item["result"]), TOOL_RESULT_MAX),
                isError: item["status"] === "failed",
              });
            }
            return;
          }
          default:
            // Unknown item type: surface once (on completed) as a tool_call whose
            // input is the item's salient fields, so nothing is silently dropped.
            if (phase === "completed") {
              const { type: _t, id: _i, status: _s, ...rest } = item;
              void _t;
              void _i;
              void _s;
              const input = Object.keys(rest).length > 0 ? rest : item;
              emit({ type: "tool_call", ts: Date.now(), name: type, input: clampToolInput(input), id });
            }
        }
      };

      const handleLine = (line: string) => {
        const obj = parseJsonLine(line);
        if (!obj) {
          const t = line.trim();
          if (t !== "") ctx.log.debug("codex: non-JSON line", { line: t.slice(0, 200) });
          return;
        }
        const item = obj["item"] as Record<string, unknown> | undefined;
        switch (obj["type"]) {
          case "thread.started":
            sessionId = (obj["thread_id"] as string) ?? sessionId;
            emit({ type: "session_started", ts: Date.now(), sessionId: sessionId ?? "unknown", threadId: sessionId, pid: proc.pid });
            break;
          case "turn.started":
            emit({ type: "turn_started", ts: Date.now() });
            break;
          case "item.started":
            emitItem("started", item);
            break;
          case "item.completed":
            emitItem("completed", item);
            break;
          case "turn.completed":
            usage = mapUsage(obj["usage"] as CodexUsage | undefined);
            emit({ type: "turn_completed", ts: Date.now(), usage });
            finalResult = { outcome: "Succeeded", sessionId, usage, runtimeSeconds: (Date.now() - started) / 1000 };
            break;
          case "turn.failed":
          case "error": {
            const err = String(
              (obj["error"] as { message?: string } | string | undefined) ?? obj["message"] ?? "codex turn failed",
            );
            emit({ type: "turn_failed", ts: Date.now(), error: err });
            finalResult = { outcome: "Failed", sessionId, error: err, usage, runtimeSeconds: (Date.now() - started) / 1000 };
            break;
          }
          default:
            if (obj["type"]) emit({ type: "log", ts: Date.now(), level: "debug", message: String(obj["type"]) });
        }
      };

      proc = spawnLines({
        bin,
        args,
        cwd: ctx.workspacePath,
        env: ctx.env,
        usePty: wrapped,
        autoRespond: wrapped ? SANDBOX_ATTACH_AUTORESPOND : undefined,
        stdin: ctx.config.codex.promptArg ? null : ctx.prompt,
        onLine: handleLine,
        onError: (err) =>
          settle(() =>
            reject(
              new Error(
                `failed to launch codex ("${bin}"): ${(err as NodeJS.ErrnoException).code === "ENOENT" ? "command not found" : err.message}`,
              ),
            ),
          ),
        onExit: (code, tail) => {
          const runtimeSeconds = (Date.now() - started) / 1000;
          settle(() => {
            if (killed) {
              reject(new AgentAbortError());
              return;
            }
            if (finalResult) resolve(finalResult);
            else if (code === 0) resolve({ outcome: "Succeeded", sessionId, usage, runtimeSeconds });
            else
              resolve({
                outcome: "Failed",
                sessionId,
                error: `codex exited with code ${code}${tail ? `: ${tail.trim()}` : ""}`,
                runtimeSeconds,
              });
          });
        },
      });
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async checkAvailable(config: Config): Promise<AvailabilityResult> {
    const { bin, args } = splitCommand(config.codex.command);
    if (args.length > 0) {
      // Wrapped command (e.g. `sandbox codex --`): verify the wrapper is on PATH
      // rather than running `<bin> --version`, which the wrapper may not support.
      const resolved = resolveOnPath(bin);
      return resolved
        ? { ok: true, detail: `wrapper "${bin}" → ${resolved}` }
        : { ok: false, detail: `wrapper "${bin}" not found on PATH` };
    }
    return new Promise((resolve) => {
      execFile(bin, ["--version"], { timeout: 10_000 }, (err, stdout) => {
        if (err) resolve({ ok: false, detail: `"${bin} --version" failed: ${err.message}` });
        else resolve({ ok: true, detail: stdout.trim() });
      });
    });
  }
}
