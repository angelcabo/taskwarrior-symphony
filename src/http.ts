/**
 * Optional observability HTTP API (SPEC §"Optional HTTP API").
 *
 *   GET  /api/v1/state         running sessions, retry queue, token totals
 *   GET  /api/v1/<identifier>  per-issue debug info (workspace, session, retry)
 *   POST /api/v1/refresh       queue an immediate poll + reconcile cycle
 *
 * Bound to 127.0.0.1 by default. No DB; everything is read from in-memory state.
 */

import http from "node:http";
import type { Orchestrator } from "./orchestrator.js";
import type { HttpConfig } from "./config.js";
import { Logger } from "./logger.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

export function startHttpServer(orch: Orchestrator, cfg: HttpConfig, log: Logger): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${cfg.host}:${cfg.port}`);
    const { pathname } = url;
    const method = req.method ?? "GET";

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
