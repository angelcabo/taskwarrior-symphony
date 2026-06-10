/**
 * Workspace manager (Execution Layer, SPEC §"Workspace" + §"Workspace Safety
 * Invariants").
 *
 * One directory per issue under a configured root. Directories are reused
 * across attempts and never auto-deleted on success — only on terminal-state
 * transitions and startup cleanup. All three SPEC safety invariants are
 * enforced here:
 *   1. Execution containment — callers launch agents only at `path`.
 *   2. Path confinement      — `path` is always under the workspace root.
 *   3. Key sanitization      — non [A-Za-z0-9._-] chars become `_`.
 */

import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Logger } from "./logger.js";

export interface WorkspaceHandle {
  /** Sanitized directory name. */
  key: string;
  /** Absolute path, guaranteed under the workspace root. */
  path: string;
  /** True if this call created the directory. */
  created: boolean;
}

export class WorkspaceError extends Error {}

/** Replace any character outside [A-Za-z0-9._-] with `_` (SPEC mandatory). */
export function sanitizeKey(identifier: string): string {
  const cleaned = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  // Exact "." / ".." would escape confinement; neutralize them.
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "_";
  return cleaned;
}

export class WorkspaceManager {
  private readonly root: string;

  constructor(
    root: string,
    private readonly log: Logger,
  ) {
    this.root = path.resolve(root);
  }

  get rootPath(): string {
    return this.root;
  }

  /** Resolve the per-issue path and assert it is confined under the root. */
  pathFor(identifier: string): string {
    const key = sanitizeKey(identifier);
    const resolved = path.resolve(this.root, key);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new WorkspaceError(
        `workspace path "${resolved}" escapes root "${this.root}" (identifier=${identifier})`,
      );
    }
    if (resolved === this.root) {
      throw new WorkspaceError(`workspace for "${identifier}" resolved to the root itself`);
    }
    return resolved;
  }

  async exists(identifier: string): Promise<boolean> {
    try {
      const s = await stat(this.pathFor(identifier));
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  /** Create the workspace if absent; reuse it otherwise. */
  async ensure(identifier: string): Promise<WorkspaceHandle> {
    const key = sanitizeKey(identifier);
    const wsPath = this.pathFor(identifier);
    let created = false;
    try {
      const s = await stat(wsPath);
      if (!s.isDirectory()) {
        throw new WorkspaceError(`workspace path "${wsPath}" exists but is not a directory`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        await mkdir(wsPath, { recursive: true });
        created = true;
        this.log.debug("workspace created", { issue_identifier: identifier, path: wsPath });
      } else {
        throw err;
      }
    }
    return { key, path: wsPath, created };
  }

  /** Remove a workspace directory (confined). No-op if it does not exist. */
  async remove(identifier: string): Promise<void> {
    const wsPath = this.pathFor(identifier); // re-asserts confinement before rm
    await rm(wsPath, { recursive: true, force: true });
    this.log.debug("workspace removed", { issue_identifier: identifier, path: wsPath });
  }
}
