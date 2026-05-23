/**
 * LRU media cache.
 *
 * Two behaviors keyed by file type:
 *
 *   - Images and transcoded HEIC outputs: the full decoded buffer is cached
 *     (up to CACHE_BYTES bytes total). On hit we return the buffer; the stream
 *     route writes it directly.
 *
 *   - Videos: never buffered in memory. `prefetch()` opens the file and reads
 *     the first 16 MB into a small throwaway buffer purely to prime the OS
 *     page cache (works on Windows and Linux alike — both have a unified page
 *     cache). The handle is closed immediately and nothing is retained.
 *
 * Strict LRU eviction by access order. The map preserves insertion order; on
 * access we delete + reinsert to move the key to the tail. Eviction pops from
 * the head until total bytes fit within the budget.
 */

import fsp from "node:fs/promises";
import { log } from "./log.js";

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"]);
const VIDEO_PRIME_BYTES = 16 * 1024 * 1024;

function isVideo(filePath) {
  const i = filePath.lastIndexOf(".");
  if (i < 0) return false;
  return VIDEO_EXTS.has(filePath.slice(i).toLowerCase());
}

export class LRUCache {
  /**
   * @param {{maxBytes:number}} opts
   */
  constructor({ maxBytes = 512 * 1024 * 1024 } = {}) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.map = new Map(); // key -> { buf:Buffer, meta:object }
  }

  /**
   * Look up a cached image buffer.
   * @param {string} key - Absolute path.
   * @returns {{buf:Buffer, meta:object}|null}
   */
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    // Move to LRU tail.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  /**
   * Store an image buffer in the cache; evicts oldest entries to fit.
   *
   * @param {string} key
   * @param {Buffer} buf
   * @param {object} [meta]
   */
  set(key, buf, meta = {}) {
    if (this.map.has(key)) {
      const prev = this.map.get(key);
      this.bytes -= prev.buf.length;
      this.map.delete(key);
    }
    if (buf.length > this.maxBytes) {
      // Single item bigger than budget: skip caching, don't blow up.
      return;
    }
    this.map.set(key, { buf, meta });
    this.bytes += buf.length;
    while (this.bytes > this.maxBytes) {
      const firstKey = this.map.keys().next().value;
      if (firstKey === undefined) break;
      const e = this.map.get(firstKey);
      this.map.delete(firstKey);
      this.bytes -= e.buf.length;
    }
  }

  /**
   * Prime the OS page cache for a video by reading its first 16 MB. Does NOT
   * retain the buffer.
   *
   * @param {string} filePath
   */
  async prefetch(filePath) {
    if (!isVideo(filePath)) return;
    let fh;
    try {
      fh = await fsp.open(filePath, "r");
      const buf = Buffer.allocUnsafe(VIDEO_PRIME_BYTES);
      await fh.read(buf, 0, VIDEO_PRIME_BYTES, 0);
    } catch (err) {
      log.warn({ filePath, err: err.message }, "video prefetch failed");
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  /** @returns {{bytes:number,entries:number,maxBytes:number}} */
  stats() {
    return { bytes: this.bytes, entries: this.map.size, maxBytes: this.maxBytes };
  }
}
