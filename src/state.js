/**
 * Runtime state singleton.
 *
 * Holds the live slideshow state (mode, cursor, history, current item, etc.)
 * and persists it to disk on graceful shutdown so a restart resumes where it
 * left off. The current playback item is intentionally kept simple to fit the
 * spec's WS payload shape.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { stateFile, paths } from "./paths.js";
import { log } from "./log.js";

const DEFAULTS = () => ({
  mode: "sequential",          // "sequential" | "random"
  imgSec: 5,
  cursor: { folderIdx: 0, fileIdx: -1 },
  history: [],
  current: null,
  volume: 0.8,
  paused: false,
  connectedClients: 0,
});

class State {
  constructor() {
    Object.assign(this, DEFAULTS());
  }

  /**
   * Load persisted state from disk on top of defaults.
   */
  async load() {
    try {
      const body = await fsp.readFile(stateFile, "utf8");
      const onDisk = JSON.parse(body);
      // connectedClients should never be persisted - it depends on live WS.
      delete onDisk.connectedClients;
      Object.assign(this, onDisk);
      if (!this.cursor) this.cursor = { folderIdx: 0, fileIdx: -1 };
      if (!Array.isArray(this.history)) this.history = [];
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn({ stateFile, err: err.message }, "state load failed; using defaults");
      }
    }
  }

  /**
   * Persist runtime state to disk atomically.
   */
  async persist() {
    await fsp.mkdir(paths.data, { recursive: true });
    const snapshot = {
      mode: this.mode,
      imgSec: this.imgSec,
      cursor: this.cursor,
      history: this.history,
      current: this.current,
      volume: this.volume,
      paused: this.paused,
    };
    const tmp = path.join(paths.data, `.state.json.${process.pid}.${Date.now()}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify(snapshot), "utf8");
    try {
      await fsp.rename(tmp, stateFile);
    } catch (err) {
      if (err && err.code === "EXDEV") {
        await fsp.copyFile(tmp, stateFile);
        await fsp.unlink(tmp).catch(() => {});
      } else {
        await fsp.unlink(tmp).catch(() => {});
        throw err;
      }
    }
  }
}

export const state = new State();
