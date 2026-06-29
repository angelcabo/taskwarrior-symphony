/**
 * postinstall: make node-pty's prebuilt `spawn-helper` executable.
 *
 * node-pty ships a prebuilt `spawn-helper` binary that, on some platforms
 * (observed: macOS arm64 via the 1.1.0 prebuild), lands with mode `rw-r--r--`.
 * The native addon loads fine, but `pty.spawn()` then fails at runtime with
 * `Error: posix_spawnp failed.` because the helper it forks is not executable.
 * `npm rebuild` does not fix it (it reuses the same prebuild). The minimal fix
 * is to restore the executable bit — no compiler / source rebuild required.
 *
 * This script is intentionally defensive: it never throws and always exits 0,
 * so a fresh `npm install` cannot be broken by it. It is a no-op anywhere the
 * helper is absent or already executable (Linux prebuilds, Windows, CI caches).
 */
import { createRequire } from "node:module";
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function ptyRoot() {
  // Prefer the resolved module (robust to workspace hoisting); fall back to the
  // conventional local path.
  try {
    const main = createRequire(import.meta.url).resolve("node-pty"); // .../node-pty/lib/index.js
    return path.resolve(path.dirname(main), "..");
  } catch {
    const local = path.resolve(process.cwd(), "node_modules", "node-pty");
    return existsSync(local) ? local : null;
  }
}

try {
  const root = ptyRoot();
  if (!root) process.exit(0); // node-pty not installed; nothing to do

  const helpers = [];
  const prebuilds = path.join(root, "prebuilds");
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds)) {
      const h = path.join(prebuilds, entry, "spawn-helper");
      if (existsSync(h)) helpers.push(h);
    }
  }
  const built = path.join(root, "build", "Release", "spawn-helper");
  if (existsSync(built)) helpers.push(built);

  for (const h of helpers) {
    try {
      if ((statSync(h).mode & 0o111) === 0) {
        chmodSync(h, 0o755);
        console.log(`[fix-node-pty-perms] chmod +x ${path.relative(process.cwd(), h)}`);
      }
    } catch {
      /* a single un-chmod-able helper must not fail the install */
    }
  }
} catch {
  /* never break `npm install` over this */
}
process.exit(0);
