import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function assertCanAdvance(previous, next) {
  if (!previous) return;
  const oldParts = previous.version.split(".").map(Number);
  const newParts = next.version.split(".").map(Number);
  if (oldParts.length !== 5 || oldParts.some(n => !Number.isSafeInteger(n) || n < 0)
      || !Number.isSafeInteger(previous.runNumber) || previous.runNumber < 1
      || !Number.isSafeInteger(previous.runAttempt) || previous.runAttempt < 1) {
    throw new Error("Invalid previous build metadata");
  }
  const comparison = newParts.findIndex((n, i) => n !== oldParts[i]);
  if (previous.runNumber > next.runNumber
      || (previous.runNumber === next.runNumber && previous.runAttempt >= next.runAttempt)
      || comparison === -1 || newParts[comparison] < oldParts[comparison]) {
    throw new Error("A newer or identical test build is already published");
  }
}

export function buildTestManifest(source, { repository, runNumber, runAttempt, previous, recovered }) {
  if (!/^\d+\.\d+\.\d+$/.test(source.version)) {
    throw new Error("Stable system.json version must have three numeric components");
  }
  if (!/^[1-9]\d*$/.test(String(runNumber)) || !/^[1-9]\d*$/.test(String(runAttempt))) {
    throw new Error("GitHub run number and attempt must be positive integers");
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("Invalid GitHub repository");
  }

  // A release asset survives failure to update test-channel. Reuse its sequence on retry.
  const last = recovered && (!previous || recovered.runNumber > previous.runNumber
    || (recovered.runNumber === previous.runNumber && recovered.runAttempt > previous.runAttempt))
    ? recovered : previous;
  const sameBase = last?.version.split(".").slice(0, 3).join(".") === source.version;
  const sequence = sameBase
    ? Number(last.version.split(".")[3]) + (last.runNumber === Number(runNumber) ? 0 : 1)
    : 1;
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid build sequence");
  const version = `${source.version}.${sequence}.${runAttempt}`;
  const next = { version, runNumber: Number(runNumber), runAttempt: Number(runAttempt) };
  assertCanAdvance(previous, next);
  assertCanAdvance(recovered, next);
  const tag = `test-${runNumber}-${runAttempt}`;
  return {
    ...source,
    version,
    manifest: `https://raw.githubusercontent.com/${repository}/test-channel/system.json`,
    download: `https://github.com/${repository}/releases/download/${tag}/point-zero.zip`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sourcePath, outputPath, metadataPath, previousPath, recoveredPath] = process.argv.slice(2);
  if (!sourcePath || !outputPath || !metadataPath) {
    throw new Error("Usage: node build-test-manifest.mjs SOURCE OUTPUT METADATA [PREVIOUS] [RECOVERED]");
  }
  const { GITHUB_REPOSITORY, GITHUB_RUN_NUMBER, GITHUB_RUN_ATTEMPT, GITHUB_SHA } = process.env;
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const manifest = buildTestManifest(source, {
    repository: GITHUB_REPOSITORY,
    runNumber: GITHUB_RUN_NUMBER,
    runAttempt: GITHUB_RUN_ATTEMPT,
    previous: previousPath ? JSON.parse(readFileSync(previousPath, "utf8")) : undefined,
    recovered: recoveredPath ? JSON.parse(readFileSync(recoveredPath, "utf8")) : undefined,
  });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(metadataPath, `${JSON.stringify({
    runNumber: Number(GITHUB_RUN_NUMBER),
    runAttempt: Number(GITHUB_RUN_ATTEMPT),
    sourceSha: GITHUB_SHA,
    version: manifest.version,
    baseVersion: source.version,
    versionRunNumber: Number(manifest.version.split(".")[3]),
  }, null, 2)}\n`);
}
