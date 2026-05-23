import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrefix, findFolderIndex } from "../src/prefixSum.js";

test("empty array throws", () => {
  assert.throws(() => buildPrefix([]), /non-empty/);
});

test("rejects non-integer / negative counts", () => {
  assert.throws(() => buildPrefix([1.5]), /non-negative integer/);
  assert.throws(() => buildPrefix([-1]), /non-negative integer/);
  assert.throws(() => buildPrefix([1, "2"]), /non-negative integer/);
});

test("single-folder prefix", () => {
  const p = buildPrefix([7]);
  assert.deepEqual(p, [7]);
  assert.equal(findFolderIndex(p, 0), 0);
  assert.equal(findFolderIndex(p, 6), 0);
  assert.throws(() => findFolderIndex(p, 7), /out of range/);
});

test("equal-count folders distribute evenly", () => {
  const counts = [10, 10, 10, 10];
  const p = buildPrefix(counts);
  assert.deepEqual(p, [10, 20, 30, 40]);
  assert.equal(findFolderIndex(p, 0), 0);
  assert.equal(findFolderIndex(p, 9), 0);
  assert.equal(findFolderIndex(p, 10), 1);
  assert.equal(findFolderIndex(p, 19), 1);
  assert.equal(findFolderIndex(p, 20), 2);
  assert.equal(findFolderIndex(p, 39), 3);
});

test("heavily skewed counts", () => {
  const counts = [1, 100, 1, 1];
  const p = buildPrefix(counts);
  assert.deepEqual(p, [1, 101, 102, 103]);
  assert.equal(findFolderIndex(p, 0), 0);
  assert.equal(findFolderIndex(p, 1), 1);
  assert.equal(findFolderIndex(p, 100), 1);
  assert.equal(findFolderIndex(p, 101), 2);
  assert.equal(findFolderIndex(p, 102), 3);
});

test("zero-count folders are skipped by the search (never selected)", () => {
  const counts = [0, 5, 0, 5, 0];
  const p = buildPrefix(counts);
  // total = 10. r in [0,5) -> 1; r in [5,10) -> 3.
  for (let r = 0; r < 5; r++) assert.equal(findFolderIndex(p, r), 1);
  for (let r = 5; r < 10; r++) assert.equal(findFolderIndex(p, r), 3);
});

test("findFolderIndex rejects out-of-range r", () => {
  const p = buildPrefix([1, 2, 3]);
  assert.throws(() => findFolderIndex(p, -1), /out of range/);
  assert.throws(() => findFolderIndex(p, 6), /out of range/);
  assert.throws(() => findFolderIndex(p, 1.5), /out of range/);
});
