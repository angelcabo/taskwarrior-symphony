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

import { spawn, execFile } from "node:child_process";
import type { RunResult, RuntimeEvent, TokenUsage } from "../domain.js";
import {
  type AgentDriver,
  type AgentRunContext,
  type AvailabilityResult,
  AgentAbortError,
  splitCommand,
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

    if (ctx.sessionId) {
      // Continuation: resume inherits the session's cwd + sandbox.
      return { bin, args: [...base, "exec", "resume", ...flags, ...cfg.extraArgs, ctx.sessionId, "-"] };
    }

    const first = [...flags];
    if (!cfg.dangerouslyBypass) first.push("--sandbox", cfg.sandbox);
    if (cfg.model) first.push("--model", cfg.model);
    first.push("-C", ctx.workspacePath);
    return { bin, args: [...base, "exec", ...first, ...cfg.extraArgs, "-"] };
  }

  run(ctx: AgentRunContext): Promise<RunResult> {
    const started = Date.now();
    const { bin, args } = this.buildArgs(ctx.config, ctx);
    ctx.log.debug("launching codex exec", { bin, args: args.join(" "), workspace: ctx.workspacePath });

    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(bin, args, { cwd: ctx.workspacePath, env: ctx.env });

      let sessionId = ctx.sessionId;
      let usage: TokenUsage | undefined;
      let finalResult: RunResult | null = null;
      let killed = false;
      let settled = false;
      let stdoutBuf = "";
      let stderrTail = "";

      const emit = (e: RuntimeEvent) => ctx.onEvent(e);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        ctx.signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        killed = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 2000);
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const isToolItem = (type: string | undefined): boolean =>
        type !== undefined && type !== "agent_message" && type !== "reasoning";

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (trimmed === "") return;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          ctx.log.debug("codex: non-JSON line", { line: trimmed.slice(0, 200) });
          return;
        }
        const item = obj["item"] as { type?: string; name?: string } | undefined;
        switch (obj["type"]) {
          case "thread.started":
            sessionId = (obj["thread_id"] as string) ?? sessionId;
            emit({ type: "session_started", ts: Date.now(), sessionId: sessionId ?? "unknown", threadId: sessionId, pid: child.pid });
            break;
          case "turn.started":
            emit({ type: "turn_started", ts: Date.now() });
            break;
          case "item.started":
          case "item.completed":
            if (isToolItem(item?.type)) {
              emit({ type: "tool_call", ts: Date.now(), name: item?.type ?? "item" });
            } else {
              emit({ type: "log", ts: Date.now(), level: "debug", message: item?.type ?? "item" });
            }
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

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
          handleLine(stdoutBuf.slice(0, nl));
          stdoutBuf = stdoutBuf.slice(nl + 1);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });

      child.on("error", (err) => {
        settle(() =>
          reject(
            new Error(
              `failed to launch codex ("${bin}"): ${(err as NodeJS.ErrnoException).code === "ENOENT" ? "command not found" : err.message}`,
            ),
          ),
        );
      });

      child.on("close", (code) => {
        if (stdoutBuf.trim() !== "") handleLine(stdoutBuf);
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
              error: `codex exited with code ${code}${stderrTail ? `: ${stderrTail.trim()}` : ""}`,
              runtimeSeconds,
            });
        });
      });

      try {
        child.stdin?.write(ctx.prompt);
        child.stdin?.end();
      } catch {
        /* child may have exited; close handler settles. */
      }
    });
  }

  async checkAvailable(config: Config): Promise<AvailabilityResult> {
    const { bin } = splitCommand(config.codex.command);
    return new Promise((resolve) => {
      execFile(bin, ["--version"], { timeout: 10_000 }, (err, stdout) => {
        if (err) resolve({ ok: false, detail: `"${bin} --version" failed: ${err.message}` });
        else resolve({ ok: true, detail: stdout.trim() });
      });
    });
  }
}
