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
  assert.equal(result.version, `${source.version}.1.2`);
  assert.equal(result.manifest, "https://raw.githubusercontent.com/gorohovDM/PointZero/test-channel/system.json");
  assert.equal(result.download, "https://github.com/gorohovDM/PointZero/releases/download/test-42-2/point-zero.zip");
  assert.equal(result.id, source.id);
});

const options = { repository: "gorohovDM/PointZero", runNumber: 43, runAttempt: 1 };
const published = (version, runNumber = 42, runAttempt = 1) => ({ version, runNumber, runAttempt });

test("new stable versions reset the sequence while new runs increment it", () => {
  const previous = published("0.2.8.1.1");
  assert.equal(buildTestManifest({ version: "0.2.8" }, { ...options, previous }).version, "0.2.8.2.1");
  assert.equal(buildTestManifest({ version: "0.2.9" }, { ...options, previous }).version, "0.2.9.1.1");
  assert.equal(buildTestManifest({ version: "1.0.0" }, { ...options, previous }).version, "1.0.0.1.1");
});

test("legacy channel metadata continues from the published fourth component", () => {
  const previous = published("0.2.8.42.1");
  assert.equal(buildTestManifest({ version: "0.2.8" }, { ...options, previous }).version, "0.2.8.43.1");
  assert.equal(buildTestManifest({ version: "0.2.8" }, { ...options, runNumber: 42, runAttempt: 2, previous }).version, "0.2.8.42.2");
});

test("release metadata recovers retries and counts releases whose channel push failed", () => {
  const previous = published("0.2.8.1.1", 40);
  const recovered = published("0.2.8.2.1", 42);
  assert.equal(buildTestManifest({ version: "0.2.8" }, { ...options, runNumber: 42, runAttempt: 3, previous, recovered }).version, "0.2.8.2.3");
  assert.equal(buildTestManifest({ version: "0.2.8" }, { ...options, previous, recovered }).version, "0.2.8.3.1");
  assert.equal(buildTestManifest({ version: "0.2.8" }, { ...options, runNumber: 90, previous }).version, "0.2.8.2.1");
});

test("stale runs, identical attempts and baseline rollbacks are rejected", () => {
  const previous = published("0.2.8.2.1", 43);
  for (const overrides of [
    { runNumber: 42, runAttempt: 4 },
    { runNumber: 43, runAttempt: 1 },
    { runNumber: 44, source: { version: "0.2.7" } },
    { runNumber: 42, source: { version: "0.2.9" } },
  ]) {
    assert.throws(() => buildTestManifest(overrides.source ?? { version: "0.2.8" }, { ...options, previous, ...overrides }), /newer or identical/);
  }
  assert.throws(() => buildTestManifest({ version: "0.2.8" }, { ...options, recovered: published("0.2.8.3.1", 44) }), /newer or identical/);
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
