import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildTestManifest } from "../scripts/build-test-manifest.mjs";

test("test manifest keeps the stable source intact and points package updates to test-channel", () => {
  const source = JSON.parse(readFileSync(new URL("../system.json", import.meta.url), "utf8"));
  const snapshot = structuredClone(source);
  const result = buildTestManifest(source, {
    repository: "gorohovDM/PointZero",
    runNumber: "42",
    runAttempt: "2",
  });

  assert.deepEqual(source, snapshot);
  assert.equal(result.version, `${source.version}.42.2`);
  assert.equal(result.manifest, "https://raw.githubusercontent.com/gorohovDM/PointZero/test-channel/system.json");
  assert.equal(result.download, "https://github.com/gorohovDM/PointZero/releases/download/test-42-2/point-zero.zip");
  assert.equal(result.id, source.id);
});

test("run attempts create distinct, ordered versions and tags", () => {
  const source = { version: "0.2.7" };
  const options = { repository: "gorohovDM/PointZero", runNumber: "42" };
  const first = buildTestManifest(source, { ...options, runAttempt: "1" });
  const retry = buildTestManifest(source, { ...options, runAttempt: "2" });
  assert.notEqual(first.version, retry.version);
  assert.notEqual(first.download, retry.download);
  assert.throws(() => buildTestManifest(source, { ...options, runAttempt: "0" }));
});
