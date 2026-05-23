/**
 * Persistent server configuration.
 *
 * - File on disk: configFile (paths.config + "/config.json").
 * - Defaults supplied for fields the user hasn't set yet.
 * - Env vars (PORT, MEDIA_ROOT, IMG_SEC, MODE, CACHE_BYTES) override the file
 *   at load time but are not written back.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { configFile, paths } from "./paths.js";
import { log } from "./log.js";

const DEFAULTS = Object.freeze({
  mediaRoot: null,
  imgSec: 5,
  mode: "sequential",
  cacheBytes: 536870912,
  port: 8080,
});

/**
 * Load config.json, layering defaults and env overrides on top.
 *
 * @returns {object} The merged config.
 */
export function loadConfig() {
  let onDisk = {};
  try {
    const body = fs.readFileSync(configFile, "utf8");
    onDisk = JSON.parse(body);
  } catch (err) {
    if (err.code !== "ENOENT") {
      log.warn({ configFile, err: err.message }, "config read failed; using defaults");
    }
  }
  const merged = { ...DEFAULTS, ...onDisk };
  if (process.env.PORT) merged.port = parseInt(process.env.PORT, 10);
  if (process.env.MEDIA_ROOT) merged.mediaRoot = process.env.MEDIA_ROOT;
  if (process.env.IMG_SEC) merged.imgSec = parseFloat(process.env.IMG_SEC);
  if (process.env.MODE) merged.mode = process.env.MODE;
  if (process.env.CACHE_BYTES) merged.cacheBytes = parseInt(process.env.CACHE_BYTES, 10);
  return merged;
}

/**
 * Persist config to disk. Only writes the fields that belong in config.json;
 * env overrides are not persisted.
 *
 * @param {object} cfg
 */
export async function saveConfig(cfg) {
  await fsp.mkdir(paths.config, { recursive: true });
  const out = {
    mediaRoot: cfg.mediaRoot,
    imgSec: cfg.imgSec,
    mode: cfg.mode,
    cacheBytes: cfg.cacheBytes,
    port: cfg.port,
  };
  const tmp = path.join(paths.config, `.config.json.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(out, null, 2), "utf8");
  try {
    await fsp.rename(tmp, configFile);
  } catch (err) {
    if (err && err.code === "EXDEV") {
      await fsp.copyFile(tmp, configFile);
      await fsp.unlink(tmp).catch(() => {});
    } else {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
  }
}
