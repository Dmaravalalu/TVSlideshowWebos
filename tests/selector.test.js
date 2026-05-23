import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSequential, prevSequential, pickRandom, prevRandom } from "../src/selector.js";
import { buildPrefix } from "../src/prefixSum.js";

function makeIndex(folderDefs) {
  // folderDefs = [{ rel, count }, ...]
  const folders = folderDefs.map(({ rel, count }) => ({
    rel,
    count,
    files: Array.from({ length: count }, (_, i) => `f${String(i).padStart(3, "0")}.jpg`),
  }));
  const counts = folders.map((f) => f.count);
  return {
    root: "/fake",
    builtAt: 0,
    folders,
    counts,
    prefix: counts.length ? buildPrefix(counts) : [],
    total: counts.reduce((a, b) => a + b, 0),
  };
}

function freshState() {
  return { history: [], cursor: { folderIdx: 0, fileIdx: -1 } };
}

test("sequential walks files in order then wraps folders", () => {
  const idx = makeIndex([
    { rel: "2014/01", count: 2 },
    { rel: "2014/02", count: 1 },
  ]);
  const s = freshState();
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const c = nextSequential(s, idx);
    seen.push(`${c.rel}/${c.file}`);
  }
  assert.deepEqual(seen, [
    "2014/01/f000.jpg",
    "2014/01/f001.jpg",
    "2014/02/f000.jpg",
    "2014/01/f000.jpg",
    "2014/01/f001.jpg",
    "2014/02/f000.jpg",
  ]);
});

test("prevSequential reverses, wrapping across folders", () => {
  const idx = makeIndex([
    { rel: "2014/01", count: 2 },
    { rel: "2014/02", count: 1 },
  ]);
  const s = freshState();
  // Advance twice so cursor is at folder 0, file 1.
  nextSequential(s, idx);
  nextSequential(s, idx);
  const back = prevSequential(s, idx);
  assert.equal(`${back.rel}/${back.file}`, "2014/01/f000.jpg");
  const back2 = prevSequential(s, idx);
  // Wraps to last folder, last file.
  assert.equal(`${back2.rel}/${back2.file}`, "2014/02/f000.jpg");
});

test("empty index returns null", () => {
  const idx = makeIndex([]);
  const s = freshState();
  assert.equal(nextSequential(s, idx), null);
  assert.equal(pickRandom(s, idx), null);
});

test("history capped at 50", () => {
  const idx = makeIndex([{ rel: "2014/01", count: 100 }]);
  const s = freshState();
  for (let i = 0; i < 80; i++) nextSequential(s, idx);
  assert.equal(s.history.length, 50);
});

test("prevRandom replays the previous visited item", () => {
  const idx = makeIndex([
    { rel: "2014/01", count: 5 },
    { rel: "2014/02", count: 5 },
  ]);
  const s = freshState();
  // Stub Math.random to force distinct picks: folder 0/file 0, then 1/2.
  // prefix = [5,10]; randInt(10) draws need r values 0 and 5 -> Math.random
  // returns 0/10 and 5/10. Then within-folder draws use Math.random*count.
  const seq = [0.0, 0.0, 0.5, 0.4];
  const orig = Math.random;
  let i = 0;
  Math.random = () => seq[i++ % seq.length];
  try {
    const a = pickRandom(s, idx);
    const b = pickRandom(s, idx);
    assert.notEqual(`${a.rel}/${a.file}`, `${b.rel}/${b.file}`);
    const back = prevRandom(s, idx);
    assert.equal(back.rel, a.rel);
    assert.equal(back.file, a.file);
  } finally { Math.random = orig; }
});

test("statistical: 10000 random picks within +/-2% of expected weight", () => {
  // Three folders with counts 200, 500, 300 -> expected weights 0.20, 0.50, 0.30.
  const idx = makeIndex([
    { rel: "2014/01", count: 200 },
    { rel: "2014/02", count: 500 },
    { rel: "2014/03", count: 300 },
  ]);
  const trials = 10000;
  const hits = [0, 0, 0];
  // Fresh state per call would still work, but reusing is faster.
  const s = freshState();
  for (let i = 0; i < trials; i++) {
    pickRandom(s, idx);
    hits[s.cursor.folderIdx]++;
  }
  const expected = [0.20, 0.50, 0.30];
  for (let i = 0; i < 3; i++) {
    const emp = hits[i] / trials;
    assert.ok(
      Math.abs(emp - expected[i]) < 0.02,
      `folder ${i}: empirical ${emp.toFixed(4)} not within 2% of expected ${expected[i]}`,
    );
  }
});
