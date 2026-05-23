/**
 * Slideshow server entry point.
 *
 * Wiring order (top-down):
 *
 *   1. ensureDirs()       — create config/data/cache/log dirs from env-paths.
 *   2. load config + state from disk.
 *   3. try to load the previously persisted media index.
 *   4. build Express app, mount admin + stream routers.
 *   5. construct the HTTP server, attach the WS at /ctrl.
 *   6. install SIGTERM/SIGINT/SIGBREAK shutdown handlers.
 *
 * The 3-signal shutdown is non-negotiable: SIGTERM for systemd, SIGINT for
 * Ctrl+C, SIGBREAK for NSSM on Windows.
 */

import http from "node:http";
import path from "node:path";
import express from "express";
import { fileURLToPath } from "node:url";
import { ensureDirs, indexFile } from "./paths.js";
import { loadConfig, saveConfig } from "./config.js";
import { state } from "./state.js";
import { LRUCache } from "./cache.js";
import { loadIndex } from "./indexer.js";
import { buildAdminRouter } from "./routes/admin.js";
import { buildStreamRouter } from "./routes/stream.js";
import { attachWs } from "./ws.js";
import { log } from "./log.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "..", "public");

ensureDirs();

const cfg = loadConfig();
await state.load();
// Sync the live state with config-driven defaults if the persisted state
// pre-dates them.
if (cfg.mode && state.mode === undefined) state.mode = cfg.mode;
if (cfg.imgSec && state.imgSec === undefined) state.imgSec = cfg.imgSec;

const indexRef = { value: await loadIndex(indexFile) };
if (indexRef.value && indexRef.value.root && cfg.mediaRoot && indexRef.value.root !== cfg.mediaRoot) {
  log.warn({ indexRoot: indexRef.value.root, configRoot: cfg.mediaRoot }, "index/config root mismatch; ignoring stale index");
  indexRef.value = null;
}

const cache = new LRUCache({ maxBytes: cfg.cacheBytes });

const app = express();
app.disable("x-powered-by");

// Optional basic-auth gate via env var.
if (process.env.BASIC_AUTH) {
  const [u, p] = process.env.BASIC_AUTH.split(":");
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || "";
    if (!hdr.startsWith("Basic ")) {
      res.set("WWW-Authenticate", 'Basic realm="slideshow"').status(401).end();
      return;
    }
    const decoded = Buffer.from(hdr.slice(6), "base64").toString("utf8");
    const [user, pass] = decoded.split(":");
    if (user !== u || pass !== p) {
      res.set("WWW-Authenticate", 'Basic realm="slideshow"').status(401).end();
      return;
    }
    next();
  });
}

// JSON access log line per request.
app.use((req, _res, next) => {
  const t0 = Date.now();
  _res.on("finish", () => {
    log.info({ method: req.method, url: req.url, status: _res.statusCode, ms: Date.now() - t0 }, "req");
  });
  next();
});

// Static public assets.
app.use(express.static(publicDir, { extensions: ["html"], index: false }));

const adminRouter = buildAdminRouter({
  cfg,
  indexRef,
  publicDir,
  onIndexReady: async () => {
    // Reset the cursor when a new index is built; next "ended" will start at
    // the first item in the first folder.
    state.cursor = { folderIdx: 0, fileIdx: -1 };
    state.current = null;
    broadcastStatusRef.fn && broadcastStatusRef.fn();
  },
});
app.use(adminRouter);

app.use(buildStreamRouter({ cfg, cache }));

const httpServer = http.createServer(app);
const broadcastStatusRef = { fn: null };
const wsCtx = attachWs(httpServer, { cfg, indexRef, cache });
broadcastStatusRef.fn = wsCtx.broadcastStatus;

httpServer.listen(cfg.port, "0.0.0.0", () => {
  log.info({ port: cfg.port, mediaRoot: cfg.mediaRoot, indexed: Boolean(indexRef.value) }, "slideshow listening");
});

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  // Stop accepting new connections.
  httpServer.close();
  // Close WS clients politely.
  for (const ws of wsCtx.wss.clients) {
    try { ws.close(1001, "shutting down"); } catch { /* ignore */ }
  }
  try {
    await state.persist();
    await saveConfig(cfg);
  } catch (err) {
    log.warn({ err: err.message }, "shutdown persist failed");
  }
  // Give in-flight responses ~2 s before forcing exit.
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGBREAK", () => shutdown("SIGBREAK"));

process.on("uncaughtException", (err) => {
  log.error({ err: err.message, stack: err.stack }, "uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  log.error({ reason: String(reason) }, "unhandledRejection");
});
