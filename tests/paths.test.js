import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { paths, ensureDirs, configFile, indexFile, stateFile } from "../src/paths.js";

test("every exported path is absolute", () => {
  for (const [k, v] of Object.entries(paths)) {
    assert.equal(typeof v, "string", `paths.${k} should be a string`);
    assert.ok(path.isAbsolute(v), `paths.${k} = ${v} should be absolute`);
  }
});

test("configFile / indexFile / stateFile are absolute and live under paths", () => {
  for (const f of [configFile, indexFile, stateFile]) {
    assert.ok(path.isAbsolute(f), `${f} should be absolute`);
  }
  assert.equal(path.dirname(configFile), paths.config);
  assert.equal(path.dirname(indexFile), paths.data);
  assert.equal(path.dirname(stateFile), paths.data);
});

test("ensureDirs is idempotent and creates every directory", () => {
  ensureDirs();
  ensureDirs();
  for (const [k, v] of Object.entries(paths)) {
    assert.ok(fs.existsSync(v), `paths.${k} = ${v} should exist after ensureDirs`);
    assert.ok(fs.statSync(v).isDirectory(), `paths.${k} should be a directory`);
  }
});
