/**
 * WebSocket controller at /ctrl.
 *
 * Direction summary:
 *
 *   server -> client:
 *     show     { item, nextHint, mode, imgSec }
 *     volume   { value }
 *     paused   { value }
 *     mode     { value }
 *     status   { connectedClients, indexed, root, ... }
 *     error    { message }
 *
 *   client -> server:
 *     ready
 *     ended
 *     remote   { key }      // "next" | "prev" | "volUp" | "volDown" | "pause" | "shuffleToggle"
 *     config   { imgSec?, mode? }
 *
 * Liveness: ping every 15 s, drop the client after 2 missed pongs.
 */

import { WebSocketServer } from "ws";
import { log } from "./log.js";
import { state } from "./state.js";
import { nextSequential, prevSequential, pickRandom, prevRandom } from "./selector.js";
import { saveConfig } from "./config.js";

const PING_INTERVAL_MS = 15000;
const MAX_MISSED_PONGS = 2;
const VOLUME_STEP = 0.05;

/**
 * Attach the WebSocket server to the given HTTP server.
 *
 * @param {import("http").Server} httpServer
 * @param {object} ctx
 * @param {object} ctx.cfg - Mutable in-process config.
 * @param {{value:object|null}} ctx.indexRef - Live media index reference.
 * @param {import("./cache.js").LRUCache} ctx.cache - Used to prefetch next item.
 * @returns {{wss: WebSocketServer, broadcastShow: ()=>void, broadcastStatus: ()=>void}}
 */
export function attachWs(httpServer, ctx) {
  const { cfg, indexRef, cache } = ctx;
  const wss = new WebSocketServer({ server: httpServer, path: "/ctrl" });

  function safeSend(ws, msg) {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify(msg)); }
    catch (err) { log.warn({ err: err.message }, "ws send failed"); }
  }

  function broadcast(msg) {
    const str = JSON.stringify(msg);
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(str); }
        catch (err) { log.warn({ err: err.message }, "ws broadcast failed"); }
      }
    }
  }

  function peekNext() {
    // Compute the hint without mutating state, by snapshotting cursor/history.
    const idx = indexRef.value;
    if (!idx || idx.total === 0) return null;
    const snap = {
      cursor: { ...state.cursor },
      history: state.history.slice(),
    };
    let next;
    if (state.mode === "sequential") next = nextSequential(snap, idx);
    else next = pickRandom(snap, idx);
    return next;
  }

  function broadcastShow() {
    const next = peekNext();
    if (next && cache && cfg.mediaRoot) {
      // Prime the page cache for videos; ignore failures.
      // (Build the absolute path the way the stream route will.)
      const absRoot = cfg.mediaRoot;
      try {
        // Lazy import path to avoid a top-level dep when constructing the hint.
        const filePath = absRoot
          + (absRoot.endsWith("\\") || absRoot.endsWith("/") ? "" : "/")
          + next.rel + "/" + next.file;
        cache.prefetch(filePath).catch(() => {});
      } catch { /* prefetch is best-effort */ }
    }
    broadcast({
      type: "show",
      item: state.current,
      nextHint: next ? { url: next.url, kind: next.kind } : null,
      mode: state.mode,
      imgSec: state.imgSec,
    });
  }

  function broadcastStatus() {
    broadcast({
      type: "status",
      connectedClients: state.connectedClients,
      indexed: Boolean(indexRef.value),
      total: indexRef.value ? indexRef.value.total : 0,
      mode: state.mode,
      imgSec: state.imgSec,
      paused: state.paused,
      volume: state.volume,
      root: cfg.mediaRoot || null,
    });
  }

  function advance(direction) {
    const idx = indexRef.value;
    if (!idx) return;
    let chosen;
    if (state.mode === "sequential") {
      chosen = direction === "next" ? nextSequential(state, idx) : prevSequential(state, idx);
    } else {
      chosen = direction === "next" ? pickRandom(state, idx) : prevRandom(state, idx);
    }
    state.current = chosen;
    broadcastShow();
  }

  function handleRemote(key) {
    switch (key) {
      case "next": advance("next"); break;
      case "prev": advance("prev"); break;
      case "volUp":
        state.volume = Math.min(1, +(state.volume + VOLUME_STEP).toFixed(2));
        broadcast({ type: "volume", value: state.volume });
        break;
      case "volDown":
        state.volume = Math.max(0, +(state.volume - VOLUME_STEP).toFixed(2));
        broadcast({ type: "volume", value: state.volume });
        break;
      case "pause":
        state.paused = !state.paused;
        broadcast({ type: "paused", value: state.paused });
        break;
      case "shuffleToggle":
        state.mode = state.mode === "sequential" ? "random" : "sequential";
        cfg.mode = state.mode;
        saveConfig(cfg).catch((err) => log.warn({ err: err.message }, "saveConfig after shuffleToggle"));
        broadcast({ type: "mode", value: state.mode });
        // Bring the next item forward so the change is visible immediately.
        advance("next");
        break;
      default:
        log.debug({ key }, "unknown remote key");
    }
  }

  wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.missedPongs = 0;
    state.connectedClients++;
    log.info({ peer: req.socket.remoteAddress, clients: state.connectedClients }, "ws connect");

    ws.on("pong", () => {
      ws.isAlive = true;
      ws.missedPongs = 0;
    });

    ws.on("close", () => {
      state.connectedClients = Math.max(0, state.connectedClients - 1);
      broadcastStatus();
    });

    ws.on("error", (err) => {
      log.warn({ err: err.message }, "ws error");
    });

    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch { safeSend(ws, { type: "error", message: "invalid JSON" }); return; }
      switch (msg.type) {
        case "ready":
          // First client load or page reload: serve the current item or pick one.
          if (!state.current) advance("next");
          else broadcastShow();
          broadcastStatus();
          break;
        case "ended":
          if (!state.paused) advance("next");
          break;
        case "remote":
          handleRemote(msg.key);
          break;
        case "config": {
          if (msg.imgSec !== undefined) {
            const n = Number(msg.imgSec);
            if (Number.isFinite(n) && n >= 1 && n <= 600) {
              state.imgSec = n; cfg.imgSec = n;
            }
          }
          if (msg.mode === "sequential" || msg.mode === "random") {
            state.mode = msg.mode; cfg.mode = msg.mode;
            broadcast({ type: "mode", value: state.mode });
          }
          saveConfig(cfg).catch((err) => log.warn({ err: err.message }, "saveConfig after config msg"));
          broadcastStatus();
          break;
        }
        default:
          safeSend(ws, { type: "error", message: "unknown message type" });
      }
    });

    // Initial status push as soon as the client lands.
    safeSend(ws, { type: "status", connectedClients: state.connectedClients, mode: state.mode, imgSec: state.imgSec });
  });

  // Heartbeat sweep.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.missedPongs >= MAX_MISSED_PONGS) {
        log.info({}, "dropping unresponsive ws client");
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.missedPongs++;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, PING_INTERVAL_MS);
  wss.on("close", () => clearInterval(heartbeat));

  return { wss, broadcastShow, broadcastStatus };
}
