/**
 * Unit tests for the deterministic, pure pieces of the orchestrator.
 * Run with: npm test   (node --test via the tsx loader)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderPrompt, buildPromptContext, PromptError } from "./prompt.js";
import { sanitizeKey, WorkspaceManager, WorkspaceError } from "./workspace.js";
import { comparePriorityThenAge } from "./orchestrator.js";
import { parseWorkflow, splitFrontMatter, expandPath, ConfigError } from "./config.js";
import { applyConfigEdit, writeConfigEdit } from "./configedit.js";
import { RetryQueue } from "./retry.js";
import type { AgentConfig } from "./config.js";
import type { Issue } from "./domain.js";
import { Logger } from "./logger.js";

function issue(partial: Partial<Issue>): Issue {
  return {
    id: "id",
    identifier: "SYM-00000001",
    title: "t",
    description: "",
    priority: null,
    state: "todo",
    branchName: "symphony/sym-00000001-t",
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

// --- prompt rendering -------------------------------------------------------

test("renderPrompt resolves variables and filters", () => {
  const ctx = buildPromptContext(
    issue({ title: "Fix bug", labels: ["backend", "urgent"], priority: 1 }),
    null,
  );
  const out = renderPrompt(
    "T={{ issue.title }} L={{ issue.labels | join(\", \") }} P={{ issue.priority }}",
    ctx,
  );
  assert.equal(out, "T=Fix bug L=backend, urgent P=1");
});

test("renderPrompt default filter handles empty/null", () => {
  const ctx = buildPromptContext(issue({ description: "" }), null);
  assert.equal(renderPrompt('{{ issue.description | default("none") }}', ctx), "none");
  assert.equal(renderPrompt('{{ attempt | default("first") }}', ctx), "first");
});

test("renderPrompt is strict about unknown variables", () => {
  const ctx = buildPromptContext(issue({}), 2);
  assert.throws(() => renderPrompt("{{ issue.nope }}", ctx), PromptError);
  assert.throws(() => renderPrompt("{{ totally.unknown }}", ctx), PromptError);
});

test("renderPrompt is strict about unknown filters", () => {
  const ctx = buildPromptContext(issue({}), null);
  assert.throws(() => renderPrompt("{{ issue.title | bogus }}", ctx), PromptError);
});

test("renderPrompt renders integer attempt on retries", () => {
  const ctx = buildPromptContext(issue({}), 3);
  assert.equal(renderPrompt("attempt={{ attempt }}", ctx), "attempt=3");
});

// --- workspace safety -------------------------------------------------------

test("sanitizeKey replaces unsafe characters", () => {
  assert.equal(sanitizeKey("ABC-123"), "ABC-123");
  assert.equal(sanitizeKey("a/b\\c d:e"), "a_b_c_d_e");
  assert.equal(sanitizeKey(".."), "_");
  assert.equal(sanitizeKey(""), "_");
});

test("WorkspaceManager confines paths under the root", () => {
  const ws = new WorkspaceManager("/tmp/symphony-root", new Logger());
  const p = ws.pathFor("SYM-abc");
  assert.ok(p.startsWith("/tmp/symphony-root/"));
  // Traversal attempts are sanitized, never escape.
  assert.ok(ws.pathFor("../escape").startsWith("/tmp/symphony-root/"));
});

// --- candidate sorting ------------------------------------------------------

test("comparePriorityThenAge: priority asc (urgent first), null last, oldest tiebreak", () => {
  const a = issue({ identifier: "A", priority: 2, createdAt: "2026-01-02T00:00:00Z" });
  const b = issue({ identifier: "B", priority: 1, createdAt: "2026-01-03T00:00:00Z" });
  const c = issue({ identifier: "C", priority: null, createdAt: "2026-01-01T00:00:00Z" });
  const d = issue({ identifier: "D", priority: 1, createdAt: "2026-01-01T00:00:00Z" });
  const sorted = [a, b, c, d].sort(comparePriorityThenAge).map((i) => i.identifier);
  assert.deepEqual(sorted, ["D", "B", "A", "C"]);
});

// --- config layer -----------------------------------------------------------

test("splitFrontMatter separates YAML and body", () => {
  const { frontMatter, body } = splitFrontMatter("---\nkey: val\n---\nhello body\n");
  assert.equal(frontMatter, "key: val");
  assert.equal(body.trim(), "hello body");
});

test("parseWorkflow applies typed defaults and resolves $VAR", () => {
  process.env.SYMPHONY_TEST_TOKEN = "secret-value";
  const text = [
    "---",
    "tracker:",
    "  kind: taskwarrior",
    "  active_states: [todo, active]",
    "  taskrc: $SYMPHONY_TEST_TOKEN",
    "agent:",
    "  default_driver: mock",
    "---",
    "Prompt for {{ issue.identifier }}",
  ].join("\n");
  const wf = parseWorkflow(text, "/tmp/WORKFLOW.md");
  assert.equal(wf.config.tracker.kind, "taskwarrior");
  assert.deepEqual(wf.config.tracker.activeStates, ["todo", "active"]);
  assert.equal(wf.config.tracker.taskrc, "secret-value"); // $VAR resolved
  assert.equal(wf.config.polling.intervalMs, 30_000); // default
  assert.equal(wf.config.agent.maxConcurrentAgents, 10); // default
  assert.equal(wf.config.agent.defaultDriver, "mock");
  assert.match(wf.promptTemplate, /Prompt for/);
});

test("parseWorkflow rejects unsupported tracker kinds", () => {
  const text = "---\ntracker:\n  kind: linear\n---\nbody";
  assert.throws(() => parseWorkflow(text, "/tmp/WORKFLOW.md"), ConfigError);
});

test("parseWorkflow rejects malformed types", () => {
  const text = "---\npolling:\n  interval_ms: not-a-number\n---\nbody";
  assert.throws(() => parseWorkflow(text, "/tmp/WORKFLOW.md"), ConfigError);
});

test("expandPath expands ~ and resolves relative to base dir", () => {
  assert.ok(expandPath("~/x", "/base").endsWith("/x"));
  assert.equal(expandPath("rel/dir", "/base"), "/base/rel/dir");
  assert.equal(expandPath("/abs/dir", "/base"), "/abs/dir");
});

// --- retry backoff ----------------------------------------------------------

test("RetryQueue failure backoff follows min(base*2^(n-1), cap)", () => {
  const cfg = {
    baseRetryMs: 10_000,
    maxRetryBackoffMs: 300_000,
    continuationDelayMs: 1_000,
  } as AgentConfig;
  const q = new RetryQueue(cfg, new Logger());
  assert.equal(q.failureDelay(1), 10_000);
  assert.equal(q.failureDelay(2), 20_000);
  assert.equal(q.failureDelay(3), 40_000);
  assert.equal(q.failureDelay(6), 300_000); // 320000 capped
  assert.equal(q.failureDelay(10), 300_000); // capped
});

// --- config edit (config API backing the board settings panel) --------------

const EDITABLE_WORKFLOW = [
  "---",
  "# top comment — must survive edits",
  "tracker:",
  "  kind: taskwarrior",
  "  data_dir: $HOME/keepme   # inline comment on an untouched key",
  "  active_states: [todo, active]",
  "agent:",
  "  default_driver: claude",
  "claude:",
  "  command: claude",
  "codex:",
  "  command: codex",
  "---",
  "",
  "# Task {{ issue.identifier }}",
  "",
  "Prompt body.",
].join("\n");

test("applyConfigEdit updates keys, preserving comments, $VAR, and body", () => {
  const out = applyConfigEdit(EDITABLE_WORKFLOW, {
    updates: { "agent.default_driver": "codex", "claude.command": "sandbox claude --bedrock" },
  });
  // Untouched comments and $VAR indirection survive (never resolved on write).
  assert.match(out, /# top comment — must survive edits/);
  assert.match(out, /# inline comment on an untouched key/);
  assert.match(out, /\$HOME\/keepme/);
  // Changes landed, and unrelated keys are intact.
  assert.match(out, /default_driver: codex/);
  assert.match(out, /command: sandbox claude --bedrock/);
  assert.match(out, /codex:\n {2}command: codex/);
  // The result still parses, reflects the change, and keeps the body verbatim.
  const wf = parseWorkflow(out, "/tmp/WORKFLOW.md");
  assert.equal(wf.config.agent.defaultDriver, "codex");
  assert.equal(wf.config.claude.command, "sandbox claude --bedrock");
  assert.match(wf.promptTemplate, /# Task \{\{ issue.identifier \}\}/);
});

test("applyConfigEdit creates nested keys and null resets a key", () => {
  const created = applyConfigEdit(EDITABLE_WORKFLOW, { updates: { "codex.prompt_arg": true } });
  assert.equal(parseWorkflow(created, "/tmp/WORKFLOW.md").config.codex.promptArg, true);

  const reset = applyConfigEdit(created, { updates: { "codex.prompt_arg": null } });
  assert.doesNotMatch(reset, /prompt_arg/); // key removed -> back to default (false)
  assert.equal(parseWorkflow(reset, "/tmp/WORKFLOW.md").config.codex.promptArg, false);
});

test("applyConfigEdit can replace the whole front matter, keeping the body", () => {
  const out = applyConfigEdit(EDITABLE_WORKFLOW, {
    frontMatter: "tracker:\n  kind: taskwarrior\nagent:\n  default_driver: mock",
  });
  const wf = parseWorkflow(out, "/tmp/WORKFLOW.md");
  assert.equal(wf.config.agent.defaultDriver, "mock");
  assert.match(wf.promptTemplate, /Prompt body\./);
});

test("writeConfigEdit persists a valid edit and rejects an invalid one without writing", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sym-cfg-"));
  const file = path.join(dir, "WORKFLOW.md");
  writeFileSync(file, EDITABLE_WORKFLOW, "utf8");

  const wf = await writeConfigEdit(file, { updates: { "agent.default_driver": "codex" } });
  assert.equal(wf.config.agent.defaultDriver, "codex");
  assert.match(readFileSync(file, "utf8"), /default_driver: codex/);

  // An invalid edit (wrong type) must throw and leave the file untouched.
  const before = readFileSync(file, "utf8");
  await assert.rejects(
    () => writeConfigEdit(file, { updates: { "polling.interval_ms": "not-a-number" } }),
    ConfigError,
  );
  assert.equal(readFileSync(file, "utf8"), before);
});
