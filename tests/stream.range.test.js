import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { buildStreamRouter, parseRange, resolveSafe } from "../src/routes/stream.js";
import { LRUCache } from "../src/cache.js";

// ----- parseRange unit tests -----

test("parseRange: malformed inputs are unsatisfiable (416)", () => {
  for (const h of ["bytes=abc-def", "items=0-99", "bytes=", "bytes=,", "bytes=0-99,200-299"]) {
    const r = parseRange(h, 1000);
    assert.equal(r.isSatisfiable, false, `expected 416 for ${h}`);
  }
});

test("parseRange: start past EOF -> 416", () => {
  const r = parseRange("bytes=2000-", 1000);
  assert.equal(r.isSatisfiable, false);
});

test("parseRange: open-ended serves to EOF", () => {
  const r = parseRange("bytes=100-", 1000);
  assert.equal(r.ok, true);
  assert.equal(r.start, 100);
  assert.equal(r.end, 999);
});

test("parseRange: explicit end clamps to size-1", () => {
  const r = parseRange("bytes=100-5000", 1000);
  assert.equal(r.ok, true);
  assert.equal(r.start, 100);
  assert.equal(r.end, 999);
});

test("parseRange: suffix range (-N) gives last N bytes", () => {
  const r = parseRange("bytes=-100", 1000);
  assert.equal(r.ok, true);
  assert.equal(r.start, 900);
  assert.equal(r.end, 999);
});

test("parseRange: end < start -> 416", () => {
  const r = parseRange("bytes=500-100", 1000);
  assert.equal(r.isSatisfiable, false);
});

// ----- resolveSafe traversal tests -----

test("resolveSafe blocks parent traversal in rel", () => {
  assert.equal(resolveSafe("/srv/media", "../etc", "passwd"), null);
  assert.equal(resolveSafe("/srv/media", "2014/../..", "x.jpg"), null);
});

test("resolveSafe blocks separators in filename", () => {
  assert.equal(resolveSafe("/srv/media", "2014/06", "../x.jpg"), null);
  assert.equal(resolveSafe("/srv/media", "2014/06", "sub/x.jpg"), null);
});

test("resolveSafe accepts a valid path", () => {
  const r = resolveSafe("/srv/media", "2014/06", "IMG.jpg");
  assert.ok(r);
  assert.ok(r.startsWith(path.resolve("/srv/media")));
});

// ----- integration: real video file + HTTP Range -----

async function withFixtureServer(t, fn) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "slideshow-stream-"));
  const folder = path.join(tmp, "2014", "06");
  await fsp.mkdir(folder, { recursive: true });
  // 100 KB of repeating bytes makes range arithmetic easy to verify.
  const size = 100 * 1024;
  const body = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) body[i] = i & 0xff;
  const videoPath = path.join(folder, "movie.mp4");
  await fsp.writeFile(videoPath, body);
  const imgPath = path.join(folder, "photo.jpg");
  await fsp.writeFile(imgPath, Buffer.from("\xff\xd8\xff\xe0fake jpeg bytes"));

  const app = express();
  const cache = new LRUCache({ maxBytes: 1024 * 1024 });
  const cfg = { mediaRoot: tmp };
  app.use(buildStreamRouter({ cfg, cache }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await fsp.rm(tmp, { recursive: true, force: true });
  });
  return { port, tmp, size, body };
}

function fetchUrl(port, path_, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: path_, method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

test("video range: open-ended returns 206 with content to EOF", async (t) => {
  const { port, size, body } = await withFixtureServer(t);
  const r = await fetchUrl(port, "/media?folder=2014%2F06&file=movie.mp4", { Range: "bytes=0-" });
  assert.equal(r.status, 206);
  assert.equal(r.headers["accept-ranges"], "bytes");
  // Open-ended serves to EOF for files <= chunk cap; this fixture is 100KB so the whole file should arrive.
  assert.match(r.headers["content-range"], new RegExp(`^bytes 0-${size - 1}/${size}$`));
  assert.equal(r.body.length, size);
  assert.deepEqual(r.body, body);
});

test("video range: specific window returns correct bytes", async (t) => {
  const { port, body } = await withFixtureServer(t);
  const r = await fetchUrl(port, "/media?folder=2014%2F06&file=movie.mp4", { Range: "bytes=100-199" });
  assert.equal(r.status, 206);
  assert.equal(r.headers["content-range"], "bytes 100-199/102400");
  assert.equal(r.headers["content-length"], "100");
  assert.equal(r.body.length, 100);
  assert.deepEqual(r.body, body.slice(100, 200));
});

test("video range: start past EOF -> 416", async (t) => {
  const { port } = await withFixtureServer(t);
  const r = await fetchUrl(port, "/media?folder=2014%2F06&file=movie.mp4", { Range: "bytes=999999-" });
  assert.equal(r.status, 416);
  assert.match(r.headers["content-range"], /^bytes \*\/102400$/);
});

test("video range: malformed header -> 416", async (t) => {
  const { port } = await withFixtureServer(t);
  const r = await fetchUrl(port, "/media?folder=2014%2F06&file=movie.mp4", { Range: "items=0-99" });
  assert.equal(r.status, 416);
});

test("video without Range header returns full body 200", async (t) => {
  const { port, size, body } = await withFixtureServer(t);
  const r = await fetchUrl(port, "/media?folder=2014%2F06&file=movie.mp4");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-length"], String(size));
  assert.equal(r.body.length, size);
  assert.deepEqual(r.body, body);
});

test("traversal attempt -> 400", async (t) => {
  const { port } = await withFixtureServer(t);
  const r = await fetchUrl(port, "/media?folder=..%2F..&file=passwd");
  assert.equal(r.status, 400);
});

test("missing file -> 404", async (t) => {
  const { port } = await withFixtureServer(t);
  const r = await fetchUrl(port, "/media?folder=2014%2F06&file=does-not-exist.jpg");
  assert.equal(r.status, 404);
});

test("non-HEIC image served with ETag + Cache-Control", async (t) => {
  const { port } = await withFixtureServer(t);
  const r = await fetchUrl(port, "/media?folder=2014%2F06&file=photo.jpg");
  assert.equal(r.status, 200);
  assert.match(r.headers["cache-control"], /max-age=86400/);
  assert.ok(r.headers.etag);
  // Conditional get with the same etag -> 304.
  const r2 = await fetchUrl(port, "/media?folder=2014%2F06&file=photo.jpg", { "If-None-Match": r.headers.etag });
  assert.equal(r2.status, 304);
});
