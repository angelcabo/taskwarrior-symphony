/**
 * GitHub Copilot CLI agent driver.
 *
 * Launches the `copilot` CLI in non-interactive print mode with the JSONL event
 * protocol — the Copilot analogue of the Claude/Codex driver contract:
 *
 *   copilot -p <prompt> --output-format json --allow-all
 *           [--model M] [--reasoning-effort E]
 *           [--session-id <new-uuid> | --resume=<session_id>]
 *
 * Copilot takes the prompt as the `-p` argument (never stdin), so continuation
 * turns pass guidance-only text the same way (SPEC: "Continuation turns: send
 * guidance only; preserve prior thread history").
 *
 * Each stdout line is one JSON event; the ones we surface:
 *   {type:"assistant.message",data:{content,toolRequests[]}}  -> assistant_message / tool_call
 *   {type:"tool.execution_complete",data:{toolCallId,success,result}} -> tool_result
 *   {type:"result",sessionId,exitCode,usage}                  -> turn_completed / turn_failed
 * Most other events (model.*, session.*, *.delta) are ephemeral and ignored.
 *
 * Session id: Copilot only reports it in the final `result` event, which is too
 * late to resume a turn that fails mid-stream. So on the first turn we PIN a
 * fresh uuid via `--session-id` (verified: Copilot creates the session under that
 * exact id); continuation turns resume it with `--resume=<id>`. Either way the id
 * is known before streaming starts, so `session_started` fires immediately.
 *
 * Trust posture (SPEC §"Security & Safety"): non-interactive Copilot cannot prompt
 * for approval (no TTY), so this passes `--allow-all` (all permissions: tools +
 * paths + urls) — it will not auto-run tools otherwise, and path/url gating would
 * wedge the same way. Autonomy is bounded by workspace isolation, not tool prompts;
 * `allow_all_tools: false` is available for operators who front Copilot with their
 * own approval flow via extra_args.
 *
 * Token usage: Copilot's `result.usage` reports premium-request counts and
 * durations, not input/output tokens, so per-turn token/cost accounting is left
 * empty (unlike Claude/Codex).
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { RunResult, RuntimeEvent } from "../domain.js";
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

export class CopilotDriver implements AgentDriver {
  readonly name = "copilot";

  buildArgs(config: Config, ctx: AgentRunContext, effectiveSessionId: string): { bin: string; args: string[] } {
    const cfg = config.copilot;
    const { bin, args: baseArgs } = splitCommand(cfg.command);
    // Prompt is always a positional `-p` arg (Copilot has no stdin prompt mode).
    const args = [...baseArgs, "-p", ctx.prompt, "--output-format", "json"];
    if (cfg.allowAllTools) args.push("--allow-all");
    if (cfg.model) args.push("--model", cfg.model);
    if (cfg.effort) args.push("--reasoning-effort", cfg.effort);
    if (ctx.sessionId) args.push(`--resume=${ctx.sessionId}`);
    else args.push("--session-id", effectiveSessionId);
    args.push(...cfg.extraArgs);
    return { bin, args };
  }

  run(ctx: AgentRunContext): Promise<RunResult> {
    const started = Date.now();
    // Known before streaming: resume the prior session, or pin a fresh id for a new one.
    let sessionId = ctx.sessionId ?? randomUUID();
    const { bin, args } = this.buildArgs(ctx.config, ctx, sessionId);
    ctx.log.debug("launching copilot", { bin, args: args.join(" "), workspace: ctx.workspacePath });
    const wrapped = splitCommand(ctx.config.copilot.command).args.length > 0;

    return new Promise<RunResult>((resolve, reject) => {
      let proc: LineProcess;
      // toolCallId -> tool name, so tool_result events can name their tool.
      const toolNames = new Map<string, string>();
      let finalResult: RunResult | null = null;
      let announcedSession = false;
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
          if (t !== "") ctx.log.debug("copilot: non-JSON line", { line: t.slice(0, 200) });
          return;
        }
        // First real event confirms the process is streaming: announce the (known) session id.
        if (!announcedSession) {
          announcedSession = true;
          emit({ type: "session_started", ts: Date.now(), sessionId, pid: proc.pid });
        }
        const type = obj["type"];
        const data = (obj["data"] ?? {}) as Record<string, unknown>;
        if (type === "assistant.message") {
          const content = typeof data["content"] === "string" ? (data["content"] as string) : "";
          if (content.trim() !== "") {
            emit({ type: "assistant_message", ts: Date.now(), text: truncate(content, TRANSCRIPT_TEXT_MAX) });
          }
          const toolRequests = Array.isArray(data["toolRequests"]) ? (data["toolRequests"] as unknown[]) : [];
          for (const tr of toolRequests) {
            const t = tr as { toolCallId?: string; name?: string; arguments?: unknown };
            if (t.toolCallId && t.name) toolNames.set(t.toolCallId, t.name);
            emit({ type: "tool_call", ts: Date.now(), name: t.name ?? "tool", input: clampToolInput(t.arguments), id: t.toolCallId });
          }
        } else if (type === "tool.execution_complete") {
          const id = typeof data["toolCallId"] === "string" ? (data["toolCallId"] as string) : undefined;
          const result = (data["result"] ?? {}) as { content?: unknown };
          emit({
            type: "tool_result",
            ts: Date.now(),
            name: id ? toolNames.get(id) : undefined,
            toolUseId: id,
            content: truncate(flattenToolContent(result.content), TOOL_RESULT_MAX),
            isError: data["success"] !== true,
          });
        } else if (type === "model.turn_started") {
          // Activity ping / turn boundary (keeps last-activity fresh for stall detection).
          emit({ type: "turn_started", ts: Date.now() });
        } else if (type === "result") {
          // Top-level (not under .data): the authoritative end of the run.
          sessionId = (obj["sessionId"] as string) ?? sessionId;
          const exitCode = obj["exitCode"];
          const runtimeSeconds = (Date.now() - started) / 1000;
          if (exitCode !== 0) {
            const err = `copilot reported exit code ${String(exitCode)}`;
            emit({ type: "turn_failed", ts: Date.now(), error: err });
            finalResult = { outcome: "Failed", sessionId, error: err, runtimeSeconds };
          } else {
            emit({ type: "turn_completed", ts: Date.now() });
            finalResult = { outcome: "Succeeded", sessionId, runtimeSeconds };
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
        stdin: null,
        onLine: handleLine,
        onError: (err) =>
          settle(() =>
            reject(
              new Error(
                `failed to launch copilot ("${bin}"): ${(err as NodeJS.ErrnoException).code === "ENOENT" ? "command not found" : err.message}`,
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
                error: `copilot exited with code ${code}${tail ? `: ${tail.trim()}` : ""}`,
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
    const { bin, args } = splitCommand(config.copilot.command);
    if (args.length > 0) {
      // Wrapped command (e.g. `sandbox copilot`): just verify the wrapper is on
      // PATH; a bare `<bin> --version` would not validate Copilot and may spin a
      // sandbox. Real launch failures surface on the first attempt.
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
