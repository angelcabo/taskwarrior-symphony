/**
 * Read + edit the WORKFLOW.md configuration for the HTTP config API
 * (`GET/PUT /api/v1/config`), which backs the taskwarrior-kanban settings panel.
 *
 * Editing rules that matter:
 *  - Never round-trip the parsed `Config`: `parseWorkflow` resolves `$VAR`
 *    indirection at load time, so writing the resolved object back would bake
 *    secrets/paths into the file and destroy the indirection. We edit the RAW
 *    YAML text instead.
 *  - Preserve comments, key order, and `$VAR` on untouched keys by editing the
 *    front matter through `yaml`'s comment-preserving Document API.
 *  - Preserve the Markdown prompt body verbatim (only the front matter changes).
 *  - Always validate the result through `parseWorkflow` BEFORE writing, so a bad
 *    edit is rejected instead of breaking the daemon on the next reload.
 */

import { readFile, writeFile } from "node:fs/promises";
import { parseDocument, parse as parseYaml } from "yaml";
import { splitFrontMatter, parseWorkflow, ConfigError, type Config, type Workflow } from "./config.js";

export interface ConfigView {
  /** Absolute WORKFLOW.md path being edited. */
  path: string;
  /** Raw front-matter YAML text (for a raw editor). */
  frontMatter: string;
  /** Unresolved parse of the front matter (`$VAR` intact) — binds the form. */
  raw: Record<string, unknown>;
  /** The in-force, env-resolved config (what the daemon is actually running). */
  effective: Config;
}

export type ConfigEdit =
  | { updates: Record<string, unknown>; frontMatter?: undefined }
  | { frontMatter: string; updates?: undefined };

function parseRawFrontMatter(frontMatter: string | null): Record<string, unknown> {
  const fm = frontMatter ?? "";
  if (fm.trim() === "") return {};
  const parsed = parseYaml(fm) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** Read the current config as both raw (editable) and effective (in-force) views. */
export async function readConfigView(sourcePath: string, effective: Config): Promise<ConfigView> {
  const text = await readFile(sourcePath, "utf8");
  const { frontMatter } = splitFrontMatter(text);
  return { path: sourcePath, frontMatter: frontMatter ?? "", raw: parseRawFrontMatter(frontMatter), effective };
}

/**
 * Produce the new WORKFLOW.md text for an edit, without touching disk. Either
 * applies surgical dotted-path `updates` (comment-preserving; `null` deletes a
 * key, resetting it to its default) or replaces the whole front matter. The
 * Markdown body is preserved verbatim.
 */
export function applyConfigEdit(originalText: string, edit: ConfigEdit): string {
  const { frontMatter, body } = splitFrontMatter(originalText);

  let newFrontMatter: string;
  if (typeof edit.frontMatter === "string") {
    newFrontMatter = edit.frontMatter;
  } else if (edit.updates && typeof edit.updates === "object" && !Array.isArray(edit.updates)) {
    const doc = parseDocument(frontMatter ?? "");
    for (const [dotted, value] of Object.entries(edit.updates)) {
      const segments = dotted.split(".").filter((s) => s.length > 0);
      if (segments.length === 0) throw new ConfigError(`invalid config key "${dotted}"`);
      if (value === null) doc.deleteIn(segments);
      else doc.setIn(segments, value);
    }
    newFrontMatter = doc.toString();
  } else {
    throw new ConfigError("config edit requires an 'updates' object or a 'frontMatter' string");
  }

  // Reassemble as `---\n<front matter>\n---\n<body>` to match the parser's
  // FRONT_MATTER shape; keep the body (m[2]) exactly as it was.
  return `---\n${newFrontMatter.replace(/\n+$/, "")}\n---\n${body}`;
}

/**
 * Apply an edit and persist it: validate the new text (throws ConfigError on an
 * invalid config), write it, and return the parsed Workflow for the caller to
 * hand to `orchestrator.reload`. Never writes an invalid file.
 */
export async function writeConfigEdit(sourcePath: string, edit: ConfigEdit): Promise<Workflow> {
  const original = await readFile(sourcePath, "utf8");
  const newText = applyConfigEdit(original, edit);
  const workflow = parseWorkflow(newText, sourcePath); // validates; throws before any write
  await writeFile(sourcePath, newText, "utf8");
  return workflow;
}
