/**
 * Claude Code agent driver.
 *
 * Launches the `claude` CLI in headless print mode with a streaming-JSON
 * protocol — the Claude Code analogue of the SPEC's Codex app-server contract:
 *
 *   claude -p --output-format stream-json --verbose --permission-mode <mode>
 *           [--resume <session_id>] [--max-turns N] [--model M] [--allowedTools …]
 *
 * The prompt is written to stdin. Each stdout line is one JSON event:
 *   {type:"system",subtype:"init",session_id,…}  -> session_started
 *   {type:"assistant",message:{content:[…]}}     -> tool_call / activity
 *   {type:"result",subtype,is_error,usage,…}     -> turn_completed / turn_failed
 *
 * Continuation turns resume the same session via --resume, sending guidance only
 * (SPEC: "Continuation turns: send guidance only; preserve prior thread history").
 *
 * Trust posture (SPEC §"Security & Safety" — implementations MUST document this):
 * permission_mode is operator-controlled. `bypassPermissions` maps to
 * `--dangerously-skip-permissions` for unattended autonomy; prefer `acceptEdits`
 * and rely on workspace isolation otherwise.
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
  SANDBOX_ATTACH_AUTORESPOND,
} from "../agent.js";
import type { Config } from "../config.js";

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function mapUsage(u: ClaudeUsage | undefined, costUsd: number | undefined): TokenUsage {
  const input = u?.input_tokens ?? 0;
  const output = u?.output_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: u?.cache_read_input_tokens,
    cacheCreationTokens: u?.cache_creation_input_tokens,
    totalTokens: input + output,
    costUsd,
  };
}

export class ClaudeDriver implements AgentDriver {
  readonly name = "claude";

  buildArgs(config: Config, ctx: AgentRunContext): { bin: string; args: string[] } {
    const cfg = config.claude;
    const { bin, args: baseArgs } = splitCommand(cfg.command);
    const args = [...baseArgs, "-p"];
    // When `command` routes through a wrapper that does not forward stdin
    // (e.g. a Docker sandbox), deliver the prompt as a positional arg instead.
    if (cfg.promptArg) args.push(ctx.prompt);
    args.push("--output-format", "stream-json", "--verbose");
    if (cfg.permissionMode === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--permission-mode", cfg.permissionMode);
    }
    if (config.agent.maxTurns) args.push("--max-turns", String(config.agent.maxTurns));
    if (cfg.model) args.push("--model", cfg.model);
    if (cfg.allowedTools) args.push("--allowedTools", cfg.allowedTools);
    if (ctx.sessionId) args.push("--resume", ctx.sessionId);
    args.push(...cfg.extraArgs);
    return { bin, args };
  }

  run(ctx: AgentRunContext): Promise<RunResult> {
    const started = Date.now();
    const { bin, args } = this.buildArgs(ctx.config, ctx);
    ctx.log.debug("launching claude", { bin, args: args.join(" "), workspace: ctx.workspacePath });
    const wrapped = splitCommand(ctx.config.claude.command).args.length > 0;

    return new Promise<RunResult>((resolve, reject) => {
      let proc: LineProcess;
      let sessionId = ctx.sessionId;
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

      const handleLine = (line: string) => {
        const obj = parseJsonLine(line);
        if (!obj) {
          const t = line.trim();
          if (t !== "") ctx.log.debug("claude: non-JSON line", { line: t.slice(0, 200) });
          return;
        }
        const type = obj["type"];
        if (type === "system" && obj["subtype"] === "init") {
          sessionId = (obj["session_id"] as string) ?? sessionId;
          emit({ type: "session_started", ts: Date.now(), sessionId: sessionId ?? "unknown", pid: proc.pid });
        } else if (type === "assistant") {
          const message = obj["message"] as { content?: unknown[] } | undefined;
          const content = Array.isArray(message?.content) ? message!.content : [];
          let hadTool = false;
          for (const block of content) {
            const b = block as { type?: string; name?: string };
            if (b.type === "tool_use") {
              hadTool = true;
              emit({ type: "tool_call", ts: Date.now(), name: b.name ?? "tool" });
            }
          }
          if (!hadTool) emit({ type: "turn_started", ts: Date.now() });
        } else if (type === "user") {
          // Tool results streaming back — counts as activity.
          emit({ type: "log", ts: Date.now(), level: "debug", message: "tool_result" });
        } else if (type === "result") {
          const isError = obj["is_error"] === true || obj["subtype"] !== "success";
          sessionId = (obj["session_id"] as string) ?? sessionId;
          const usage = mapUsage(obj["usage"] as ClaudeUsage | undefined, obj["total_cost_usd"] as number | undefined);
          const runtimeSeconds = (Date.now() - started) / 1000;
          if (isError) {
            const err = String(obj["result"] ?? obj["subtype"] ?? "agent reported error");
            emit({ type: "turn_failed", ts: Date.now(), error: err });
            finalResult = { outcome: "Failed", sessionId, error: err, usage, runtimeSeconds };
          } else {
            emit({ type: "turn_completed", ts: Date.now(), usage });
            finalResult = { outcome: "Succeeded", sessionId, usage, runtimeSeconds };
          }
        }
      };

      proc = spawnLines({
        bin,
        args,
        cwd: ctx.workspacePath,
        env: ctx.env,
        usePty: wrapped,
        autoRespond: wrapped ? SANDBOX_ATTACH_AUTORESPOND : undefined,
        stdin: ctx.config.claude.promptArg ? null : ctx.prompt,
        onLine: handleLine,
        onError: (err) =>
          settle(() =>
            reject(
              new Error(
                `failed to launch claude ("${bin}"): ${(err as NodeJS.ErrnoException).code === "ENOENT" ? "command not found" : err.message}`,
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
            if (finalResult) {
              resolve(finalResult);
            } else if (code === 0) {
              resolve({ outcome: "Succeeded", sessionId, runtimeSeconds });
            } else {
              resolve({
                outcome: "Failed",
                sessionId,
                error: `claude exited with code ${code}${tail ? `: ${tail.trim()}` : ""}`,
                runtimeSeconds,
              });
            }
          });
        },
      });
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async checkAvailable(config: Config): Promise<AvailabilityResult> {
    const { bin, args } = splitCommand(config.claude.command);
    if (args.length > 0) {
      // Wrapped command (e.g. `sandbox claude`): a bare `<bin> --version` does
      // not validate the agent and may spin a sandbox, so just verify the
      // wrapper is on PATH. Real launch failures surface on the first attempt.
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
