/**
 * Admin HTTP routes: setup landing page, folder picker, drive enumeration,
 * media-root selection, reindex trigger, status, and the TV-facing slideshow
 * page.
 *
 * The folder picker only allows browsing under safe roots:
 *   - the user's home directory
 *   - any Windows drive root (C:\, D:\, ... that pass fs.access)
 *   - /mnt, /media, /home on Linux
 * Parent-traversal attempts (".." segments) are rejected.
 */

import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { log } from "../log.js";
import { paths } from "../paths.js";
import { state } from "../state.js";
import { saveConfig } from "../config.js";
import { buildIndex, persistAtomic } from "../indexer.js";
import { indexFile } from "../paths.js";

const isWindows = process.platform === "win32";

const SAFE_LINUX_ROOTS = ["/mnt", "/media", "/home"];

/**
 * True if `p` is reachable from any allowed browsing root.
 * @param {string} p Absolute, normalized.
 */
function isSafeBrowsePath(p) {
  if (!path.isAbsolute(p)) return false;
  const home = os.homedir();
  if (p === home || p.startsWith(home + path.sep)) return true;
  if (isWindows) {
    // Any drive root: C:\, D:\, ... and their descendants are fine.
    if (/^[A-Za-z]:\\/.test(p) || /^[A-Za-z]:$/.test(p) || /^[A-Za-z]:\\.*/.test(p)) return true;
    // UNC like \\server\share\... is allowed by spec; the indexer can refuse
    // via DISABLE_UNC if the operator wants.
    if (p.startsWith("\\\\")) return true;
  } else {
    for (const root of SAFE_LINUX_ROOTS) {
      if (p === root || p.startsWith(root + path.sep)) return true;
    }
  }
  return false;
}

/**
 * Build the admin router.
 *
 * @param {object} ctx
 * @param {object} ctx.cfg - Mutable in-process config.
 * @param {{value:object|null}} ctx.indexRef - Live index reference (admin can rebuild it).
 * @param {string} ctx.publicDir - Absolute path to the /public directory.
 * @param {() => Promise<void>} ctx.onIndexReady - Hook called when an index becomes available.
 * @returns {express.Router}
 */
export function buildAdminRouter(ctx) {
  const router = express.Router();
  const { cfg, indexRef, publicDir, onIndexReady } = ctx;

  // Track in-process reindex progress for /api/status (also surfaced via WS).
  let indexingProgress = null; // null = idle, otherwise 0..1.

  // Landing: setup if not configured, else jump to /slideshow.
  router.get("/", (_req, res) => {
    if (!cfg.mediaRoot) {
      res.sendFile(path.join(publicDir, "index.html"));
    } else {
      res.redirect("/slideshow");
    }
  });

  // Slideshow page is always available even pre-config (so the user can keep
  // the URL bookmarked on the TV); it will show an "awaiting setup" overlay.
  router.get("/slideshow", (_req, res) => {
    res.sendFile(path.join(publicDir, "slideshow.html"));
  });

  // List immediate subdirectories of a path. Used by the folder picker.
  router.get("/api/dirs", async (req, res) => {
    const p = String(req.query.path || "");
    if (!p || !path.isAbsolute(p)) {
      return res.status(400).json({ error: "absolute path required" });
    }
    if (p.split(path.sep).some((seg) => seg === "..")) {
      return res.status(400).json({ error: "parent traversal rejected" });
    }
    if (!isSafeBrowsePath(p)) {
      return res.status(403).json({ error: "path is outside the allowed browse roots" });
    }
    try {
      const entries = await fsp.readdir(p, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({ name: e.name, path: path.join(p, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ path: p, parent: path.dirname(p) === p ? null : path.dirname(p), dirs });
    } catch (err) {
      log.warn({ p, err: err.message }, "/api/dirs failed");
      res.status(404).json({ error: "cannot read directory" });
    }
  });

  // Enumerate available drive letters (Windows only).
  router.get("/api/drives", async (_req, res) => {
    if (!isWindows) return res.json({ drives: [] });
    const drives = [];
    for (let c = 0x41; c <= 0x5a; c++) { // 'A'..'Z'
      const letter = String.fromCharCode(c);
      const root = `${letter}:\\`;
      try {
        await fsp.access(root, fs.constants.R_OK);
        drives.push({ letter, path: root });
      } catch { /* drive not present or unreadable; skip */ }
    }
    res.json({ drives });
  });

  // Set the media root, save config, kick off an index build.
  router.post("/api/root", express.json(), async (req, res) => {
    const p = req.body && req.body.path;
    if (!p || typeof p !== "string" || !path.isAbsolute(p)) {
      return res.status(400).json({ error: "absolute path required" });
    }
    try {
      const st = await fsp.stat(p);
      if (!st.isDirectory()) throw new Error("not a directory");
      await fsp.access(p, fs.constants.R_OK);
    } catch (err) {
      return res.status(400).json({ error: `path not usable: ${err.message}` });
    }
    cfg.mediaRoot = p;
    await saveConfig(cfg);
    // Kick off indexing in the background; the response returns immediately.
    res.status(202).json({ ok: true });
    indexingProgress = 0;
    buildIndex(p, ({ processed, total }) => {
      indexingProgress = total ? processed / total : 0;
    }).then(async (idx) => {
      await persistAtomic(indexFile, idx);
      indexRef.value = idx;
      indexingProgress = null;
      log.info({ folders: idx.folders.length, total: idx.total }, "index built");
      if (onIndexReady) await onIndexReady();
    }).catch((err) => {
      indexingProgress = null;
      log.error({ err: err.message }, "index build failed");
    });
  });

  // Rebuild the index on demand.
  router.post("/api/reindex", async (_req, res) => {
    if (!cfg.mediaRoot) {
      return res.status(400).json({ error: "mediaRoot not configured" });
    }
    res.status(202).json({ ok: true });
    indexingProgress = 0;
    try {
      const idx = await buildIndex(cfg.mediaRoot, ({ processed, total }) => {
        indexingProgress = total ? processed / total : 0;
      });
      await persistAtomic(indexFile, idx);
      indexRef.value = idx;
      indexingProgress = null;
      log.info({ folders: idx.folders.length, total: idx.total }, "reindex complete");
      if (onIndexReady) await onIndexReady();
    } catch (err) {
      indexingProgress = null;
      log.error({ err: err.message }, "reindex failed");
    }
  });

  // Status snapshot for the setup/admin page.
  router.get("/api/status", (_req, res) => {
    const idx = indexRef.value;
    const body = {
      indexed: Boolean(idx),
      total: idx ? idx.total : 0,
      mode: state.mode,
      imgSec: state.imgSec,
      root: cfg.mediaRoot || null,
      port: cfg.port,
      paused: state.paused,
      volume: state.volume,
      connectedClients: state.connectedClients,
    };
    if (indexingProgress !== null) body.indexingProgress = indexingProgress;
    res.json(body);
  });

  // Update simple knobs from the setup page (mode + imgSec).
  router.post("/api/config", express.json(), async (req, res) => {
    const { mode, imgSec } = req.body || {};
    if (mode && mode !== "sequential" && mode !== "random") {
      return res.status(400).json({ error: "invalid mode" });
    }
    if (mode) { cfg.mode = mode; state.mode = mode; }
    if (imgSec !== undefined) {
      const n = Number(imgSec);
      if (!Number.isFinite(n) || n < 1 || n > 600) {
        return res.status(400).json({ error: "imgSec out of range" });
      }
      cfg.imgSec = n; state.imgSec = n;
    }
    await saveConfig(cfg);
    res.json({ ok: true, mode: cfg.mode, imgSec: cfg.imgSec });
  });

  // Where on disk things live (used by the troubleshooting view).
  router.get("/api/paths", (_req, res) => {
    res.json({ ...paths });
  });

  return router;
}
