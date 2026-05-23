/**
 * Selection logic for the slideshow.
 *
 * Two independent modes:
 *
 * - sequential: walk folders in index order, files in natural sort order,
 *   wrapping at the end. cursor = { folderIdx, fileIdx }.
 *
 * - random: pick a folder weighted by file count (via the prefix-sum array),
 *   then pick a uniform file within that folder. The visit history is a
 *   bounded deque of the last 50 items so "prev" can backtrack.
 *
 * Both modes share the history deque; "prev" in random mode replays history
 * rather than re-sampling.
 */

import { findFolderIndex } from "./prefixSum.js";

const HISTORY_MAX = 50;

/**
 * Cryptographic-free random integer in [0, n). Math.random is fine for
 * weighting a slideshow.
 *
 * @param {number} n
 * @returns {number}
 */
function randInt(n) {
  return Math.floor(Math.random() * n);
}

/**
 * Construct the `current` object the rest of the system consumes.
 *
 * @param {object} index
 * @param {number} folderIdx
 * @param {number} fileIdx
 * @returns {{ rel:string, file:string, kind:"image"|"video", url:string }}
 */
function makeCurrent(index, folderIdx, fileIdx) {
  const folder = index.folders[folderIdx];
  const file = folder.files[fileIdx];
  const kind = isVideo(file) ? "video" : "image";
  // URL uses logical forward-slash rel + encoded filename so the WebOS browser
  // can request it regardless of host OS.
  const url = `/media?folder=${encodeURIComponent(folder.rel)}&file=${encodeURIComponent(file)}`;
  return { rel: folder.rel, file, kind, url };
}

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"]);
function isVideo(name) {
  const i = name.lastIndexOf(".");
  if (i < 0) return false;
  return VIDEO_EXTS.has(name.slice(i).toLowerCase());
}

/**
 * Push a visited item onto the bounded history deque.
 * @param {object} state
 * @param {{folderIdx:number,fileIdx:number}} pos
 */
function pushHistory(state, pos) {
  state.history.push({ folderIdx: pos.folderIdx, fileIdx: pos.fileIdx });
  while (state.history.length > HISTORY_MAX) state.history.shift();
}

/**
 * Advance the sequential cursor and return the new `current`.
 *
 * @param {object} state - Mutated in place: cursor + history.
 * @param {object} index - Index produced by buildIndex.
 * @returns {object|null} `current` or null if the index is empty.
 */
export function nextSequential(state, index) {
  if (!index || index.total === 0) return null;
  const folders = index.folders;
  let { folderIdx, fileIdx } = state.cursor || { folderIdx: 0, fileIdx: -1 };
  fileIdx += 1;
  if (folderIdx >= folders.length) { folderIdx = 0; fileIdx = 0; }
  while (fileIdx >= folders[folderIdx].count) {
    folderIdx = (folderIdx + 1) % folders.length;
    fileIdx = 0;
  }
  state.cursor = { folderIdx, fileIdx };
  pushHistory(state, state.cursor);
  return makeCurrent(index, folderIdx, fileIdx);
}

/**
 * Step the sequential cursor backwards.
 *
 * @param {object} state
 * @param {object} index
 * @returns {object|null}
 */
export function prevSequential(state, index) {
  if (!index || index.total === 0) return null;
  const folders = index.folders;
  let { folderIdx, fileIdx } = state.cursor || { folderIdx: 0, fileIdx: 0 };
  fileIdx -= 1;
  if (fileIdx < 0) {
    folderIdx = (folderIdx - 1 + folders.length) % folders.length;
    fileIdx = folders[folderIdx].count - 1;
  }
  state.cursor = { folderIdx, fileIdx };
  pushHistory(state, state.cursor);
  return makeCurrent(index, folderIdx, fileIdx);
}

/**
 * Weighted-by-count random pick. The folder is selected via the prefix sum so
 * that probability of any folder is proportional to its file count; within
 * the folder the file is uniform.
 *
 * @param {object} state
 * @param {object} index
 * @returns {object|null}
 */
export function pickRandom(state, index) {
  if (!index || index.total === 0) return null;
  const r = randInt(index.total);
  const folderIdx = findFolderIndex(index.prefix, r);
  const folder = index.folders[folderIdx];
  const fileIdx = randInt(folder.count);
  state.cursor = { folderIdx, fileIdx };
  pushHistory(state, state.cursor);
  return makeCurrent(index, folderIdx, fileIdx);
}

/**
 * Replay the last item from history (random mode "prev"). Falls back to a
 * fresh random pick if history is empty or only has the current item.
 *
 * @param {object} state
 * @param {object} index
 * @returns {object|null}
 */
export function prevRandom(state, index) {
  if (!index || index.total === 0) return null;
  // Pop the current item if it's the tail, then pop again to reach "previous".
  if (state.history.length >= 2) {
    state.history.pop();
    const prev = state.history[state.history.length - 1];
    state.cursor = { folderIdx: prev.folderIdx, fileIdx: prev.fileIdx };
    return makeCurrent(index, prev.folderIdx, prev.fileIdx);
  }
  return pickRandom(state, index);
}
