/**
 * Strict prompt rendering (Execution Layer, SPEC §"Prompt Template Rendering").
 *
 * A small mustache-style renderer. Variables come from a fixed context:
 * `issue` (normalized fields + labels/blockers) and `attempt` (null on the
 * first run, an integer on retries). Strict mode (SPEC): an unknown variable or
 * an unknown filter fails the run rather than silently rendering empty.
 */

import type { Issue } from "./domain.js";

export class PromptError extends Error {}

type Ctx = Record<string, unknown>;

const TOKEN = /\{\{([\s\S]*?)\}\}/g;

/** Build the rendering context for an issue + attempt number. */
export function buildPromptContext(issue: Issue, attempt: number | null): Ctx {
  return {
    attempt,
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      state: issue.state,
      branch_name: issue.branchName,
      url: issue.url,
      labels: issue.labels,
      blockers: issue.blockedBy.map((b) => b.identifier ?? b.id),
      blocked_by: issue.blockedBy,
      agent: issue.agent ?? "",
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
    },
  };
}

/** Split a `{{ ... }}` body on `|`, ignoring pipes inside quotes/parens. */
function splitPipes(expr: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (const ch of expr) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === "(") {
      depth++;
      buf += ch;
    } else if (ch === ")") {
      depth--;
      buf += ch;
    } else if (ch === "|" && depth === 0) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  parts.push(buf);
  return parts;
}

function resolvePath(pathExpr: string, context: Ctx): unknown {
  const segments = pathExpr.split(".");
  let cur: unknown = context;
  const trail: string[] = [];
  for (const seg of segments) {
    trail.push(seg);
    if (cur !== null && typeof cur === "object" && seg in (cur as object)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else if (Array.isArray(cur) && /^\d+$/.test(seg) && Number(seg) < cur.length) {
      cur = cur[Number(seg)];
    } else {
      throw new PromptError(`unknown variable "${trail.join(".")}"`);
    }
  }
  return cur;
}

function parseArgs(argsStr: string | undefined): unknown[] {
  if (!argsStr || argsStr.trim() === "") return [];
  // Single quoted string or number argument support is enough for our filters.
  const raw = argsStr.trim();
  try {
    return [JSON.parse(raw)];
  } catch {
    const m = /^['"]([\s\S]*)['"]$/.exec(raw);
    if (m) return [m[1]];
    return [raw];
  }
}

const FILTERS: Record<string, (value: unknown, args: unknown[]) => unknown> = {
  upper: (v) => String(v ?? "").toUpperCase(),
  lower: (v) => String(v ?? "").toLowerCase(),
  trim: (v) => String(v ?? "").trim(),
  json: (v) => JSON.stringify(v),
  length: (v) => (Array.isArray(v) ? v.length : String(v ?? "").length),
  join: (v, args) => (Array.isArray(v) ? v.map(String).join((args[0] as string) ?? ", ") : String(v ?? "")),
  default: (v, args) => (v === null || v === undefined || v === "" ? args[0] : v),
};

function applyFilter(filterExpr: string, value: unknown): unknown {
  const m = /^([A-Za-z_]\w*)\s*(?:\(([\s\S]*)\))?$/.exec(filterExpr.trim());
  if (!m) throw new PromptError(`invalid filter "${filterExpr}"`);
  const name = m[1]!;
  const fn = FILTERS[name];
  if (!fn) throw new PromptError(`unknown filter "${name}"`);
  return fn(value, parseArgs(m[2]));
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Render a template against a context, failing on unknown variables/filters. */
export function renderPrompt(template: string, context: Ctx): string {
  return template.replace(TOKEN, (_full, body: string) => {
    const parts = splitPipes(body);
    const pathExpr = (parts[0] ?? "").trim();
    if (pathExpr === "") throw new PromptError("empty template expression");
    let value = resolvePath(pathExpr, context);
    for (let i = 1; i < parts.length; i++) {
      value = applyFilter(parts[i]!, value);
    }
    return stringify(value);
  });
}
