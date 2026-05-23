/**
 * Pure prefix-sum helpers used by the weighted random selector.
 *
 * Given a counts array [c0, c1, c2, ...] where ci is the number of media files
 * in folder i, we precompute a prefix-sum array [c0, c0+c1, c0+c1+c2, ...].
 * A random integer r in [0, total) is then mapped to a folder index by binary
 * search: the folder with the smallest prefix value strictly greater than r.
 * This makes a random pick weighted by file count without scanning all files.
 */

/**
 * Build a prefix-sum array from a non-empty array of non-negative integers.
 *
 * @param {number[]} counts - Per-folder file counts.
 * @returns {number[]} prefix - Same length as counts. prefix[i] = sum(counts[0..i]).
 * @throws {Error} If counts is empty or contains a non-integer / negative value.
 */
export function buildPrefix(counts) {
  if (!Array.isArray(counts) || counts.length === 0) {
    throw new Error("buildPrefix: counts must be a non-empty array");
  }
  const prefix = new Array(counts.length);
  let running = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i];
    if (!Number.isInteger(c) || c < 0) {
      throw new Error(`buildPrefix: counts[${i}] must be a non-negative integer`);
    }
    running += c;
    prefix[i] = running;
  }
  return prefix;
}

/**
 * Find the folder index for a given random draw r using binary search.
 *
 * Returns the smallest i such that prefix[i] > r.
 *
 * @param {number[]} prefix - Prefix sum array.
 * @param {number} r - Random integer in [0, prefix[prefix.length - 1]).
 * @returns {number} The folder index.
 * @throws {Error} If r is out of range or prefix is empty.
 */
export function findFolderIndex(prefix, r) {
  if (!Array.isArray(prefix) || prefix.length === 0) {
    throw new Error("findFolderIndex: prefix must be a non-empty array");
  }
  const total = prefix[prefix.length - 1];
  if (!Number.isInteger(r) || r < 0 || r >= total) {
    throw new Error(`findFolderIndex: r=${r} out of range [0, ${total})`);
  }
  let lo = 0;
  let hi = prefix.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (prefix[mid] > r) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}
