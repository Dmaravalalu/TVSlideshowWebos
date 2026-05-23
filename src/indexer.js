/**
 * Builds the media index for the slideshow.
 *
 * Layout expected on disk:
 *   <root>/YYYY/MM/<files>
 * where YYYY is a 4-digit year and MM is a zero-padded month 01-12. Any other
 * directory or file at those levels is logged and skipped.
 *
 * The produced index object has stable shape (see buildIndex below). It is
 * persisted atomically via a temp-file + rename (same volume) or copy-unlink
 * (cross-volume, e.g. Windows where %APPDATA% may sit on C: while media lives
 * on E:).
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { log } from "./log.js";
import { buildPrefix } from "./prefixSum.js";

const YEAR_RE = /^\d{4}$/;
const MONTH_RE = /^(0[1-9]|1[0-2])$/;

const IMAGE_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".bmp",
]);
const VIDEO_EXTS = new Set([
  ".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi",
]);

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const READDIR_CONCURRENCY = 8;

/**
 * Classify a filename as "image", "video", or null (ignored).
 * @param {string} name
 * @returns {"image"|"video"|null}
 */
export function classify(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return null;
}

/**
 * Validate that the given path exists and is a readable directory.
 * Honors DISABLE_UNC=1 to reject \\server\share style paths.
 *
 * @param {string} root - Absolute path to the media root.
 */
export async function validateRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("validateRoot: root must be a non-empty string");
  }
  if (!path.isAbsolute(root)) {
    throw new Error(`validateRoot: '${root}' is not absolute`);
  }
  if (process.env.DISABLE_UNC === "1" && root.startsWith("\\\\")) {
    throw new Error(`validateRoot: UNC path rejected by DISABLE_UNC=1: '${root}'`);
  }
  await fsp.access(root, fs.constants.R_OK);
  const stat = await fsp.stat(root);
  if (!stat.isDirectory()) {
    throw new Error(`validateRoot: '${root}' is not a directory`);
  }
}

/**
 * List the files in a single YYYY/MM folder, filtered to known extensions and
 * sorted by natural filename order. Skips dotfiles, zero-byte files, symlinks.
 *
 * @param {string} dir - Absolute path to the YYYY/MM folder.
 * @returns {Promise<string[]>} - Sorted filenames (no path prefix).
 */
async function listMediaFiles(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    log.warn({ dir, err: err.message }, "readdir failed");
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    if (ent.isSymbolicLink()) continue;
    if (!ent.isFile()) continue;
    if (classify(ent.name) === null) continue;
    let size;
    try {
      const st = await fsp.stat(path.join(dir, ent.name));
      size = st.size;
    } catch (err) {
      log.warn({ file: ent.name, err: err.message }, "stat failed; skipping");
      continue;
    }
    if (size === 0) continue;
    out.push(ent.name);
  }
  out.sort(collator.compare);
  return out;
}

/**
 * Run an async worker over items with a fixed-size concurrency window.
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function pMap(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  async function pump() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await worker(items[idx], idx);
    }
  }
  const runners = [];
  const n = Math.min(limit, items.length);
  for (let k = 0; k < n; k++) runners.push(pump());
  await Promise.all(runners);
  return out;
}

/**
 * Build the full media index for a root directory.
 *
 * @param {string} root - Absolute path to the media root.
 * @param {(p: {processed:number,total:number}) => void} [onProgress] - Optional progress hook fired every 100 folders.
 * @returns {Promise<object>} The index object, ready to persist.
 */
export async function buildIndex(root, onProgress) {
  await validateRoot(root);

  const topEntries = await fsp.readdir(root, { withFileTypes: true });
  const years = [];
  for (const ent of topEntries) {
    if (!ent.isDirectory() || ent.isSymbolicLink()) {
      if (!ent.name.startsWith(".")) {
        log.info({ root, name: ent.name }, "ignored top-level entry");
      }
      continue;
    }
    if (!YEAR_RE.test(ent.name)) {
      log.info({ root, name: ent.name }, "ignored non-year top-level dir");
      continue;
    }
    years.push(ent.name);
  }
  years.sort(collator.compare);

  // Gather candidate YYYY/MM pairs first so we can drive a fixed-concurrency walk.
  const yearMonthPairs = [];
  for (const year of years) {
    const yearDir = path.join(root, year);
    let monthEntries;
    try {
      monthEntries = await fsp.readdir(yearDir, { withFileTypes: true });
    } catch (err) {
      log.warn({ yearDir, err: err.message }, "skipping unreadable year");
      continue;
    }
    const months = [];
    for (const ent of monthEntries) {
      if (!ent.isDirectory() || ent.isSymbolicLink()) {
        if (!ent.name.startsWith(".")) {
          log.info({ year, name: ent.name }, "ignored non-month entry");
        }
        continue;
      }
      if (!MONTH_RE.test(ent.name)) {
        log.info({ year, name: ent.name }, "ignored non-month folder");
        continue;
      }
      months.push(ent.name);
    }
    months.sort(collator.compare);
    for (const m of months) yearMonthPairs.push({ year, month: m });
  }

  let processed = 0;
  const total = yearMonthPairs.length;
  const folders = await pMap(yearMonthPairs, READDIR_CONCURRENCY, async ({ year, month }) => {
    const dir = path.join(root, year, month);
    const files = await listMediaFiles(dir);
    processed++;
    if (onProgress && (processed % 100 === 0 || processed === total)) {
      try { onProgress({ processed, total }); } catch { /* hook errors must not abort the walk */ }
    }
    // rel is forward-slash by spec (URL-friendly logical id); on-disk paths get
    // reconstructed with path.join(root, ...rel.split("/")).
    return { rel: `${year}/${month}`, files, count: files.length };
  });

  // Drop folders with zero media files: they would only contribute noise to the
  // selector and bloat the index.
  const populated = folders.filter((f) => f.count > 0);

  const counts = populated.map((f) => f.count);
  const prefix = counts.length ? buildPrefix(counts) : [];
  const grandTotal = counts.reduce((a, b) => a + b, 0);

  return {
    root,
    builtAt: Math.floor(Date.now() / 1000),
    folders: populated,
    counts,
    prefix,
    total: grandTotal,
  };
}

/**
 * Persist an object to disk atomically.
 *
 * Strategy: write to a temp file next to the destination, then rename. Rename
 * across volumes throws EXDEV; in that case fall back to copy + unlink. We
 * place the tmp file in the same directory as the destination by default to
 * keep the rename intra-volume on POSIX and Windows.
 *
 * @param {string} destFile - Absolute path to write to.
 * @param {object} obj - JSON-serializable value.
 */
export async function persistAtomic(destFile, obj) {
  const dir = path.dirname(destFile);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(destFile)}.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify(obj);
  await fsp.writeFile(tmp, body, "utf8");
  try {
    await fsp.rename(tmp, destFile);
  } catch (err) {
    if (err && err.code === "EXDEV") {
      await fsp.copyFile(tmp, destFile);
      await fsp.unlink(tmp).catch(() => {});
    } else {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
  }
}

/**
 * Load a previously persisted index from disk. Returns null if it does not
 * exist or fails to parse.
 *
 * @param {string} file - Absolute path to the index JSON.
 * @returns {Promise<object|null>}
 */
export async function loadIndex(file) {
  try {
    const body = await fsp.readFile(file, "utf8");
    return JSON.parse(body);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    log.warn({ file, err: err.message }, "loadIndex failed");
    return null;
  }
}

/**
 * Resolve a logical rel path ("2014/06") + filename into an absolute on-disk
 * path under root. The split-on-"/" is intentional: rel is always
 * forward-slash, regardless of the host OS.
 *
 * @param {string} root
 * @param {string} rel - e.g. "2014/06"
 * @param {string} file - e.g. "IMG_001.jpg"
 * @returns {string} Absolute path using OS-native separators.
 */
export function resolveMediaPath(root, rel, file) {
  return path.resolve(root, ...rel.split("/"), file);
}

// Exported for tests only.
export const __internal = { listMediaFiles, pMap };
// Reference os to keep linters happy in environments that flag unused imports;
// it's part of our portability surface even if unused here directly.
void os;
