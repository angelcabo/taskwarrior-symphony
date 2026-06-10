/**
 * Taskwarrior adapter (Integration Layer).
 *
 * This is the only file that knows Taskwarrior exists. It shells out to the
 * `task` binary, exporting JSON and normalizing records into the SPEC's `Issue`
 * shape. Mapping:
 *
 *   Taskwarrior            ->  Symphony
 *   ----------------------     -------------------------------------------
 *   uuid                   ->  Issue.id            (stable)
 *   <prefix>-<uuid8>       ->  Issue.identifier    (synthesized, sanitizable)
 *   description            ->  Issue.title
 *   annotations            ->  Issue.description   (joined)
 *   UDA `state`            ->  Issue.state         (workflow state axis)
 *   UDA `agent`            ->  Issue.agent         (driver selector)
 *   tags                   ->  Issue.labels        (lowercased)
 *   depends                ->  Issue.blockedBy     (resolved terminal/non-terminal)
 *   priority H|M|L         ->  Issue.priority      (1|2|3; lower = more urgent)
 *   entry / modified       ->  createdAt / updatedAt (ISO-8601)
 *
 * State axes: Taskwarrior `status` (pending/completed/deleted) is the storage
 * lifecycle; the `state` UDA is the Symphony workflow state. A task is a
 * candidate only when it is `status:pending` AND its `state` ∈ active_states.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Issue, Blocker } from "./domain.js";
import type { TrackerConfig } from "./config.js";
import type { Tracker, IssueStateSnapshot } from "./tracker.js";
import { Logger } from "./logger.js";

const execFileAsync = promisify(execFile);

/** Raw shape of a `task export` record (only the fields we read). */
interface TaskJson {
  uuid: string;
  description: string;
  status: string; // pending | completed | deleted | waiting | recurring
  priority?: string; // H | M | L
  tags?: string[];
  depends?: string[];
  entry?: string;
  modified?: string;
  annotations?: { entry?: string; description: string }[];
  [uda: string]: unknown; // state, agent, branch, ...
}

const TW_DATE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/** Convert Taskwarrior's basic-ISO timestamp (20240115T101530Z) to ISO-8601. */
function twDateToIso(value: string | undefined): string {
  if (!value) return new Date(0).toISOString();
  const m = TW_DATE.exec(value);
  if (!m) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
  }
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!)).toISOString();
}

const PRIORITY_MAP: Record<string, number> = { H: 1, M: 2, L: 3 };

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "task"
  );
}

export class TaskwarriorTracker implements Tracker {
  readonly kind = "taskwarrior";
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly cfg: TrackerConfig,
    private readonly log: Logger,
  ) {
    this.env = { ...process.env };
    if (cfg.dataDir) this.env["TASKDATA"] = cfg.dataDir;
    if (cfg.taskrc) this.env["TASKRC"] = cfg.taskrc;
  }

  /** rc overrides applied to every invocation for non-interactive, quiet runs. */
  private rcArgs(): string[] {
    return [
      "rc.verbose=nothing",
      "rc.confirmation=off",
      "rc.json.array=on",
      "rc.hooks=off",
      "rc.recurrence=no",
    ];
  }

  private async runTask(filter: string[], command: string, extra: string[] = []): Promise<string> {
    const args = [...this.rcArgs(), ...filter, command, ...extra];
    try {
      const { stdout } = await execFileAsync(this.cfg.taskBin, args, {
        env: this.env,
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      // `task export` with no matches can exit non-zero on some builds; treat
      // an empty/array stdout as success rather than an error.
      if (command === "export" && (e.stdout === undefined || e.stdout.trim() === "")) {
        return "[]";
      }
      throw new Error(`task ${command} failed: ${(e.stderr || e.message || "unknown error").trim()}`);
    }
  }

  private async exportTasks(filter: string[]): Promise<TaskJson[]> {
    const stdout = await this.runTask(filter, "export");
    const trimmed = stdout.trim();
    if (trimmed === "" || trimmed === "[]") return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? (parsed as TaskJson[]) : [];
    } catch {
      // Taskwarrior occasionally prefixes notices; salvage the JSON array.
      const start = trimmed.indexOf("[");
      const end = trimmed.lastIndexOf("]");
      if (start >= 0 && end > start) {
        return JSON.parse(trimmed.slice(start, end + 1)) as TaskJson[];
      }
      throw new Error("could not parse `task export` output as JSON");
    }
  }

  private identifierFor(uuid: string): string {
    return `${this.cfg.identifierPrefix}-${uuid.replace(/-/g, "").slice(0, 8)}`;
  }

  private udaString(task: TaskJson, attr: string): string | undefined {
    const v = task[attr];
    return typeof v === "string" && v !== "" ? v : undefined;
  }

  /** Whether a Taskwarrior record is closed regardless of its workflow state. */
  private isClosed(task: TaskJson): boolean {
    return task.status === "completed" || task.status === "deleted";
  }

  private stateOf(task: TaskJson): string | null {
    return this.udaString(task, this.cfg.stateAttr) ?? null;
  }

  /**
   * Resolve a set of dependency uuids to Blockers. A dependency is terminal
   * (no longer blocking) if its record is closed, its workflow state is
   * terminal, or it no longer exists.
   */
  private async resolveBlockers(uuids: string[]): Promise<Map<string, Blocker>> {
    const out = new Map<string, Blocker>();
    if (uuids.length === 0) return out;
    const deps = await this.exportTasks(uuids);
    const seen = new Set<string>();
    for (const dep of deps) {
      seen.add(dep.uuid);
      const state = this.stateOf(dep);
      const terminal = this.isClosed(dep) || (state !== null && this.cfg.terminalStates.includes(state));
      out.set(dep.uuid, {
        id: dep.uuid,
        identifier: this.identifierFor(dep.uuid),
        state: state ?? undefined,
        terminal,
      });
    }
    // Dependencies that didn't resolve are treated as terminal (resolved).
    for (const uuid of uuids) {
      if (!seen.has(uuid)) {
        out.set(uuid, { id: uuid, identifier: this.identifierFor(uuid), terminal: true });
      }
    }
    return out;
  }

  private async normalize(tasks: TaskJson[]): Promise<Issue[]> {
    // Batch-resolve every dependency across the set in a single export.
    const allDeps = [...new Set(tasks.flatMap((t) => t.depends ?? []))];
    const blockerIndex = await this.resolveBlockers(allDeps);

    return tasks.map((task) => {
      const state = this.stateOf(task) ?? "";
      const annotations = (task.annotations ?? []).map((a) => a.description).filter(Boolean);
      const priorityRaw = task.priority ? PRIORITY_MAP[task.priority] : undefined;
      const branchUda = this.udaString(task, this.cfg.branchAttr);
      const identifier = this.identifierFor(task.uuid);
      const blockedBy = (task.depends ?? [])
        .map((d) => blockerIndex.get(d))
        .filter((b): b is Blocker => b !== undefined);

      const issue: Issue = {
        id: task.uuid,
        identifier,
        title: task.description ?? "",
        description: annotations.join("\n"),
        priority: priorityRaw ?? null,
        state,
        branchName: branchUda ?? `symphony/${identifier.toLowerCase()}-${slugify(task.description ?? "")}`,
        url: null,
        labels: (task.tags ?? []).map((t) => t.toLowerCase()),
        blockedBy,
        createdAt: twDateToIso(task.entry),
        updatedAt: twDateToIso(task.modified ?? task.entry),
        agent: this.udaString(task, this.cfg.agentAttr),
        raw: task,
      };
      return issue;
    });
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const filter = this.cfg.filter.trim() ? this.cfg.filter.trim().split(/\s+/) : [];
    const tasks = await this.exportTasks(filter);
    // Workflow-state filtering happens here (kept out of the Taskwarrior filter
    // grammar for robustness across UDA configurations).
    const candidates = tasks.filter((t) => {
      if (this.isClosed(t)) return false;
      const state = this.stateOf(t);
      return state !== null && this.cfg.activeStates.includes(state);
    });
    return this.normalize(candidates);
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const tasks = await this.exportTasks([]); // all tasks; filter by state in JS
    const wanted = new Set(states);
    const matched = tasks.filter((t) => {
      const state = this.stateOf(t);
      return state !== null && wanted.has(state);
    });
    return this.normalize(matched);
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Map<string, IssueStateSnapshot>> {
    const out = new Map<string, IssueStateSnapshot>();
    if (ids.length === 0) return out;
    const tasks = await this.exportTasks(ids);
    const seen = new Set<string>();
    for (const task of tasks) {
      seen.add(task.uuid);
      const state = this.stateOf(task);
      const closed = this.isClosed(task);
      const terminal = closed || (state !== null && this.cfg.terminalStates.includes(state));
      const active = !closed && state !== null && this.cfg.activeStates.includes(state);
      out.set(task.uuid, {
        id: task.uuid,
        identifier: this.identifierFor(task.uuid),
        state,
        exists: true,
        terminal,
        active,
      });
    }
    for (const id of ids) {
      if (!seen.has(id)) {
        out.set(id, {
          id,
          identifier: this.identifierFor(id),
          state: null,
          exists: false,
          terminal: false,
          active: false,
        });
      }
    }
    return out;
  }

  async transitionState(id: string, state: string): Promise<void> {
    await this.runTask([id], "modify", [`${this.cfg.stateAttr}:${state}`]);
    this.log.debug("tracker state transition", { issue_id: id, state });
  }

  async preflight(): Promise<void> {
    // Verifies the binary runs and the data store is reachable.
    await this.runTask(["status:pending"], "count");
  }
}
