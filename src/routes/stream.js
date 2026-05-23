/**
 * /media stream route.
 *
 * - Resolves a logical (folder, file) tuple to an absolute on-disk path under
 *   the configured media root, with strict path-traversal protection. The
 *   check uses path.sep, never a hardcoded "/" or "\\", so it works on both
 *   Windows and POSIX.
 *
 * - HEIC / HEIF are transcoded to JPEG via sharp; the buffer is cached.
 * - Other images are served as a full body with Cache-Control + ETag.
 * - Videos use HTTP Range so the browser can scrub and seek. Range parsing
 *   is the most exercised piece in tests: malformed -> 416, start past EOF
 *   -> 416, open-ended -> serves to EOF.
 */

import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import mime from "mime-types";
import { log } from "../log.js";

const DEFAULT_CHUNK = 1024 * 1024; // 1 MB default range slice when client omits the end.

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".bmp"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"]);
const HEIC_EXTS = new Set([".heic", ".heif"]);

/**
 * Resolve a (rel, file) request into an absolute on-disk path under root.
 * Returns null on any kind of traversal attempt.
 *
 * @param {string} root - Absolute media root.
 * @param {string} rel  - Forward-slash logical folder ("2014/06").
 * @param {string} file - Filename only.
 * @returns {string|null}
 */
export function resolveSafe(root, rel, file) {
  if (typeof root !== "string" || !root) return null;
  if (typeof rel !== "string" || !rel) return null;
  if (typeof file !== "string" || !file) return null;
  if (file.includes("/") || file.includes("\\")) return null;
  if (file === "." || file === "..") return null;
  if (rel.split("/").some((seg) => seg === "" || seg === ".." || seg === ".")) return null;
  const absRoot = path.resolve(root);
  const target = path.resolve(absRoot, ...rel.split("/"), file);
  // path.sep handles both Windows '\\' and POSIX '/' in one expression.
  if (target !== absRoot && !target.startsWith(absRoot + path.sep)) return null;
  return target;
}

/**
 * Parse "Range: bytes=start-end" headers.
 *
 * Returns an object describing one of three outcomes:
 *   { ok: true, start, end, isSatisfiable: true }     - normal range
 *   { ok: false, isSatisfiable: false }               - malformed / unsupported / unsatisfiable (416)
 *
 * Multi-range ("bytes=0-99,200-299") is intentionally not supported; the spec
 * permits returning 200 OK with the full body, but for video we prefer 416 so
 * the client retries with a single range, which is what every browser does.
 *
 * @param {string|undefined} header
 * @param {number} size
 */
export function parseRange(header, size) {
  if (size <= 0) return { ok: false, isSatisfiable: false };
  if (!header || typeof header !== "string") return null; // means "no range; serve full body"
  const trimmed = header.trim();
  if (!trimmed.startsWith("bytes=")) return { ok: false, isSatisfiable: false };
  const spec = trimmed.slice("bytes=".length);
  if (spec.includes(",")) return { ok: false, isSatisfiable: false };
  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m) return { ok: false, isSatisfiable: false };
  const startStr = m[1];
  const endStr = m[2];
  if (startStr === "" && endStr === "") return { ok: false, isSatisfiable: false };

  let start, end;
  if (startStr === "") {
    // Suffix range: last N bytes.
    const suffix = parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return { ok: false, isSatisfiable: false };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    if (!Number.isFinite(start) || start < 0) return { ok: false, isSatisfiable: false };
    if (start >= size) return { ok: false, isSatisfiable: false };
    if (endStr === "") {
      // Open-ended -> serve a default chunk OR to EOF? Spec: open-ended -> serves to EOF.
      end = size - 1;
    } else {
      end = parseInt(endStr, 10);
      if (!Number.isFinite(end) || end < start) return { ok: false, isSatisfiable: false };
      if (end >= size) end = size - 1;
    }
  }
  return { ok: true, start, end, isSatisfiable: true };
}

/**
 * Build a stable ETag for an on-disk file from size + mtime.
 * @param {{size:number, mtimeMs:number}} st
 */
function etagOf(st) {
  return `"${crypto.createHash("sha1").update(`${st.size}:${st.mtimeMs}`).digest("hex")}"`;
}

/**
 * Build the /media route. The cache and config are injected so tests can pass
 * their own without instantiating the rest of the server.
 *
 * @param {object} ctx
 * @param {object} ctx.cfg
 * @param {import("../cache.js").LRUCache} ctx.cache
 * @returns {express.Router}
 */
export function buildStreamRouter(ctx) {
  const router = express.Router();
  const { cfg, cache } = ctx;

  router.get("/media", async (req, res) => {
    if (!cfg.mediaRoot) {
      return res.status(409).json({ error: "mediaRoot not configured" });
    }
    const folder = String(req.query.folder || "");
    const file = String(req.query.file || "");
    const target = resolveSafe(cfg.mediaRoot, folder, file);
    if (!target) return res.status(400).json({ error: "invalid path" });

    let st;
    try {
      st = await fsp.stat(target);
    } catch (err) {
      if (err.code === "ENOENT") return res.status(404).json({ error: "not found" });
      log.warn({ target, err: err.message }, "stat failed");
      return res.status(500).json({ error: "stat failed" });
    }
    if (!st.isFile()) return res.status(404).json({ error: "not a file" });

    const ext = path.extname(target).toLowerCase();
    const isHeic = HEIC_EXTS.has(ext);
    const isImage = IMAGE_EXTS.has(ext);
    const isVideo = VIDEO_EXTS.has(ext);

    if (!isImage && !isVideo) {
      return res.status(415).json({ error: "unsupported media type" });
    }

    if (isImage) {
      // HEIC: transcode to JPEG; reuse cached buffer if any.
      if (isHeic) {
        const hit = cache.get(target);
        if (hit) {
          res.setHeader("Cache-Control", "public, max-age=86400");
          res.setHeader("Content-Type", "image/jpeg");
          res.setHeader("ETag", etagOf(st));
          return res.end(hit.buf);
        }
        let sharp;
        try { ({ default: sharp } = await import("sharp")); }
        catch (err) {
          log.error({ err: err.message }, "sharp unavailable");
          return res.status(500).json({ error: "sharp unavailable" });
        }
        try {
          const buf = await sharp(target).rotate().jpeg({ quality: 85 }).toBuffer();
          cache.set(target, buf, { ext, source: "heic" });
          res.setHeader("Cache-Control", "public, max-age=86400");
          res.setHeader("Content-Type", "image/jpeg");
          res.setHeader("ETag", etagOf(st));
          return res.end(buf);
        } catch (err) {
          log.warn({ target, err: err.message }, "heic transcode failed");
          return res.status(500).json({ error: "transcode failed" });
        }
      }
      // Other images: serve from cache if present, otherwise read once.
      const hit = cache.get(target);
      const tag = etagOf(st);
      if (req.headers["if-none-match"] === tag) {
        res.status(304).end();
        return;
      }
      const ctype = mime.lookup(target) || "application/octet-stream";
      if (hit) {
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.setHeader("Content-Type", ctype);
        res.setHeader("ETag", tag);
        return res.end(hit.buf);
      }
      try {
        const buf = await fsp.readFile(target);
        cache.set(target, buf, { ext });
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.setHeader("Content-Type", ctype);
        res.setHeader("ETag", tag);
        return res.end(buf);
      } catch (err) {
        log.warn({ target, err: err.message }, "image read failed");
        return res.status(500).json({ error: "read failed" });
      }
    }

    // Video: HTTP Range. Do NOT buffer the whole file into memory.
    const ctype = mime.lookup(target) || "video/mp4";
    const rangeHeader = req.headers.range;
    res.setHeader("Accept-Ranges", "bytes");

    if (!rangeHeader) {
      res.setHeader("Content-Type", ctype);
      res.setHeader("Content-Length", String(st.size));
      const stream = fs.createReadStream(target);
      stream.on("error", (err) => {
        log.warn({ target, err: err.message }, "video stream error");
        if (!res.headersSent) res.status(500).end();
        else res.end();
      });
      return stream.pipe(res);
    }

    const parsed = parseRange(rangeHeader, st.size);
    if (parsed && parsed.ok === false) {
      res.setHeader("Content-Range", `bytes */${st.size}`);
      return res.status(416).end();
    }
    if (parsed === null) {
      // No header; treated above. (Shouldn't be reachable.)
      return res.status(416).end();
    }
    let { start, end } = parsed;
    // If the client gave a bare "bytes=N-" and the file is big, we still
    // serve to EOF per spec; but cap a single response to a sensible chunk so
    // we don't pin a stream open serving 4 GB to a buggy client.
    const isOpenEnded = rangeHeader.endsWith("-") && !/^bytes=-/.test(rangeHeader.trim());
    if (isOpenEnded && end - start + 1 > DEFAULT_CHUNK * 16) {
      end = Math.min(st.size - 1, start + DEFAULT_CHUNK * 16 - 1);
    }
    const chunk = end - start + 1;
    res.status(206);
    res.setHeader("Content-Type", ctype);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
    res.setHeader("Content-Length", String(chunk));
    const stream = fs.createReadStream(target, { start, end });
    stream.on("error", (err) => {
      log.warn({ target, err: err.message }, "video range stream error");
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.pipe(res);
  });

  return router;
}
