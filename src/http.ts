/**
 * Optional observability HTTP API (SPEC §"Optional HTTP API").
 *
 *   GET  /api/v1/state         running sessions, retry queue, token totals
 *   GET  /api/v1/<identifier>  per-issue debug info (workspace, session, retry)
 *   GET  /api/v1/<id>/stream   live SSE event stream for one task (identifier or uuid)
 *   POST /api/v1/refresh       queue an immediate poll + reconcile cycle
 *
 * Bound to 127.0.0.1 by default. No DB; everything is read from in-memory state.
 */

import http from "node:http";
import type { Orchestrator } from "./orchestrator.js";
import type { HttpConfig } from "./config.js";
import type { StreamEvent } from "./taskstream.js";
import { Logger } from "./logger.js";

// Bound to loopback, so a wildcard CORS origin is safe and lets the board's web
// app (a different localhost port) subscribe to a task's stream directly.
const CORS = { "access-control-allow-origin": "*" } as const;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json", ...CORS });
  res.end(payload);
}

/** Write one SSE frame. `end` events carry a named event so EventSource can listen for it. */
function writeSse(res: http.ServerResponse, ev: { kind: string }): void {
  const data = JSON.stringify(ev);
  if (ev.kind === "end") res.write(`event: end\ndata: ${data}\n\n`);
  else res.write(`data: ${data}\n\n`);
}

export function startHttpServer(orch: Orchestrator, cfg: HttpConfig, log: Logger): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${cfg.host}:${cfg.port}`);
    const { pathname } = url;
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, { ...CORS, "access-control-allow-methods": "GET, POST, OPTIONS" });
      res.end();
      return;
    }

    try {
      if (pathname === "/api/v1/state" && method === "GET") {
        sendJson(res, 200, orch.stateSnapshot());
        return;
      }
      if (pathname === "/api/v1/refresh" && method === "POST") {
        // Fire-and-forget; the tick guard prevents overlap.
        orch.refreshNow().catch((err) => log.error("refresh failed", { error: String(err) }));
        sendJson(res, 202, { queued: true });
        return;
      }
      const sm = /^\/api\/v1\/([^/]+)\/stream$/.exec(pathname);
      if (sm && method === "GET") {
        const key = decodeURIComponent(sm[1]!);
        // tail-style controls: ?follow=0 → one-shot (buffer then close); ?n=N → last N.
        const follow = url.searchParams.get("follow") !== "0";
        const nRaw = url.searchParams.get("n");
        const n = nRaw ? Math.max(0, Number.parseInt(nRaw, 10) || 0) : null;
        const tail = (events: StreamEvent[]): StreamEvent[] => (n != null ? events.slice(-n) : events);

        if (!follow) {
          const buffered = orch.streams.replay(key);
          if (!buffered) {
            sendJson(res, 404, { error: `no active or recent stream for "${key}"` });
            return;
          }
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", ...CORS });
          for (const ev of tail(buffered)) writeSse(res, ev);
          res.end();
          return;
        }

        const sub = orch.streams.open(key, (ev) => writeSse(res, ev));
        if (!sub) {
          sendJson(res, 404, { error: `no active or recent stream for "${key}"` });
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          ...CORS,
        });
        for (const ev of tail(sub.replay)) writeSse(res, ev); // replay recent history, then live tail
        const heartbeat = setInterval(() => res.write(":\n\n"), 20_000);
        const cleanup = (): void => {
          clearInterval(heartbeat);
          sub.close();
        };
        req.on("close", cleanup);
        req.on("error", cleanup);
        return;
      }

      const m = /^\/api\/v1\/([^/]+)$/.exec(pathname);
      if (m && method === "GET") {
        const identifier = decodeURIComponent(m[1]!);
        const snap = orch.issueSnapshot(identifier);
        if (snap) sendJson(res, 200, snap);
        else sendJson(res, 404, { error: `no running or retrying issue "${identifier}"` });
        return;
      }
      sendJson(res, 404, { error: "not found", path: pathname });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
  });

  server.listen(cfg.port, cfg.host, () => {
    log.info("http api listening", { url: `http://${cfg.host}:${cfg.port}/api/v1/state` });
  });
  server.on("error", (err) => log.error("http api error", { error: String(err) }));
  return server;
}
