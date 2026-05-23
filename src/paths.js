/**
 * The only file in src/ that is allowed to know about OS conventions.
 *
 * Wraps env-paths so every other module can ask for paths.config / paths.data /
 * paths.cache / paths.log without caring whether we are on Windows, Linux, or
 * macOS. Tests assert that every exported path is absolute and that
 * ensureDirs() is idempotent.
 */

import envPaths from "env-paths";
import path from "node:path";
import fs from "node:fs";

const ep = envPaths("slideshow", { suffix: "" });

/**
 * Per-OS absolute directories used by the slideshow server.
 *
 * Windows:
 *   config -> %APPDATA%\slideshow
 *   data   -> %LOCALAPPDATA%\slideshow-nodata\Data
 *   cache  -> %LOCALAPPDATA%\slideshow-nodata\Cache
 *   log    -> %LOCALAPPDATA%\slideshow-nodata\Log
 *
 * Linux:
 *   config -> ~/.config/slideshow
 *   data   -> ~/.local/share/slideshow
 *   cache  -> ~/.cache/slideshow
 *   log    -> ~/.local/state/slideshow
 *
 * macOS:
 *   config -> ~/Library/Preferences/slideshow
 *   data   -> ~/Library/Application Support/slideshow
 *   cache  -> ~/Library/Caches/slideshow
 *   log    -> ~/Library/Logs/slideshow
 */
export const paths = Object.freeze({
  config: ep.config,
  data: ep.data,
  cache: ep.cache,
  log: ep.log,
});

/**
 * Ensure every directory in `paths` exists. Safe to call repeatedly; mkdir is
 * called with { recursive: true } so it is a no-op when the directory is
 * already present.
 */
export function ensureDirs() {
  for (const dir of Object.values(paths)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Absolute path to the JSON config file (mediaRoot, mode, imgSec, port, cacheBytes). */
export const configFile = path.join(paths.config, "config.json");

/** Absolute path to the persisted media index. */
export const indexFile = path.join(paths.data, "index.json");

/** Absolute path to the persisted runtime state snapshot. */
export const stateFile = path.join(paths.data, "state.json");
