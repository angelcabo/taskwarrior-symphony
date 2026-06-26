/**
 * Per-task event streams (observability).
 *
 * A tiny in-memory pub/sub with a bounded replay buffer per task, so a late
 * subscriber — a terminal `symphony watch`, or the board's detail pane — gets
 * recent history and then a live tail of just that one task's activity.
 *
 * Streams are keyed by issue identifier; `open()` also accepts the raw tracker
 * id (uuid) or a unique identifier prefix, so a client that only knows the uuid
 * (e.g. the board, which doesn't know the identifier prefix) can subscribe.
 * Finished streams are retained briefly for post-hoc replay, then evicted.
 */

export interface StreamEvent {
  /** Monotonic per-task sequence number. */
  seq: number;
  ts: number;
  /** RuntimeEvent.type, a lifecycle marker (dispatched/finalized/…), or "end". */
  kind: string;
  /**
   * Structured payload (the event's own fields: usage, tool name, error, pid…).
   * `kind` + `data` is the stable contract consumers should key off.
   */
  data?: Record<string, unknown>;
  /** Cosmetic one-liner for terminal display ONLY — never parse this. */
  message?: string;
}

type Subscriber = (e: StreamEvent) => void;

interface TaskStream {
  identifier: string;
  id: string;
  title: string;
  buffer: StreamEvent[];
  subscribers: Set<Subscriber>;
  seq: number;
  ended: boolean;
  endedAt: number | null;
}

const MAX_BUFFER = 500; // events retained per task for replay
const RETAIN_AFTER_END_MS = 5 * 60_000; // keep a finished task's buffer this long
const MAX_STREAMS = 200; // hard cap on tracked tasks

export interface TaskRef {
  identifier: string;
  id: string;
  title?: string;
}

export class TaskStreamHub {
  private readonly streams = new Map<string, TaskStream>(); // keyed by identifier

  /** Append an event to a task's stream (creating it on first use) and fan out. */
  publish(task: TaskRef, ev: { kind: string; ts?: number; message?: string; data?: Record<string, unknown> }): void {
    const s = this.ensure(task);
    const event: StreamEvent = {
      seq: ++s.seq,
      ts: ev.ts || Date.now(),
      kind: ev.kind,
      data: ev.data,
      message: ev.message,
    };
    s.buffer.push(event);
    if (s.buffer.length > MAX_BUFFER) s.buffer.shift();
    for (const cb of s.subscribers) {
      try {
        cb(event);
      } catch {
        /* a misbehaving subscriber must not break the bus */
      }
    }
  }

  /** Mark a task's stream finished: emit a terminal `end` event, schedule eviction. */
  end(task: TaskRef, message?: string): void {
    const s = this.ensure(task);
    if (s.ended) return;
    this.publish(task, { kind: "end", message: message ?? "stream ended" });
    s.ended = true;
    s.endedAt = Date.now();
  }

  /**
   * Subscribe to a task by identifier, uuid, or unique identifier-prefix.
   * Returns the replay buffer plus an unsubscribe fn, or null if no such
   * (running or recently-finished) task exists.
   */
  open(key: string, cb: Subscriber): { replay: StreamEvent[]; close: () => void } | null {
    this.evictExpired();
    const s = this.resolve(key);
    if (!s) return null;
    const replay = [...s.buffer];
    s.subscribers.add(cb);
    return { replay, close: () => void s.subscribers.delete(cb) };
  }

  /** Buffered events for a task (no subscription), or null if unknown — the one-shot read. */
  replay(key: string): StreamEvent[] | null {
    this.evictExpired();
    const s = this.resolve(key);
    return s ? [...s.buffer] : null;
  }

  private ensure(task: TaskRef): TaskStream {
    let s = this.streams.get(task.identifier);
    if (!s) {
      this.evictExpired();
      if (this.streams.size >= MAX_STREAMS) this.evictOldest();
      s = {
        identifier: task.identifier,
        id: task.id,
        title: task.title ?? "",
        buffer: [],
        subscribers: new Set(),
        seq: 0,
        ended: false,
        endedAt: null,
      };
      this.streams.set(task.identifier, s);
    }
    if (task.title) s.title = task.title;
    return s;
  }

  private resolve(key: string): TaskStream | undefined {
    const exact = this.streams.get(key);
    if (exact) return exact;
    let prefixMatch: TaskStream | undefined;
    let prefixCount = 0;
    for (const s of this.streams.values()) {
      if (s.id === key) return s; // exact uuid
      if (s.identifier.startsWith(key)) {
        prefixMatch = s;
        prefixCount++;
      }
    }
    return prefixCount === 1 ? prefixMatch : undefined; // unique prefix only
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, s] of this.streams) {
      if (s.ended && s.endedAt !== null && now - s.endedAt > RETAIN_AFTER_END_MS && s.subscribers.size === 0) {
        this.streams.delete(k);
      }
    }
  }

  private evictOldest(): void {
    for (const [k, s] of this.streams) {
      if (s.subscribers.size === 0) {
        this.streams.delete(k);
        return;
      }
    }
  }
}
