import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function buildTestManifest(source, { repository, runNumber, runAttempt }) {
  if (!/^\d+\.\d+\.\d+$/.test(source.version)) {
    throw new Error("Stable system.json version must have three numeric components");
  }
  if (!/^[1-9]\d*$/.test(String(runNumber)) || !/^[1-9]\d*$/.test(String(runAttempt))) {
    throw new Error("GitHub run number and attempt must be positive integers");
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("Invalid GitHub repository");
  }

  const version = `${source.version}.${runNumber}.${runAttempt}`;
  const tag = `test-${runNumber}-${runAttempt}`;
  return {
    ...source,
    version,
    manifest: `https://raw.githubusercontent.com/${repository}/test-channel/system.json`,
    download: `https://github.com/${repository}/releases/download/${tag}/point-zero.zip`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sourcePath, outputPath, metadataPath] = process.argv.slice(2);
  if (!sourcePath || !outputPath || !metadataPath) {
    throw new Error("Usage: node build-test-manifest.mjs SOURCE OUTPUT METADATA");
  }
  const { GITHUB_REPOSITORY, GITHUB_RUN_NUMBER, GITHUB_RUN_ATTEMPT, GITHUB_SHA } = process.env;
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const manifest = buildTestManifest(source, {
    repository: GITHUB_REPOSITORY,
    runNumber: GITHUB_RUN_NUMBER,
    runAttempt: GITHUB_RUN_ATTEMPT,
  });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(metadataPath, `${JSON.stringify({
    runNumber: Number(GITHUB_RUN_NUMBER),
    runAttempt: Number(GITHUB_RUN_ATTEMPT),
    sourceSha: GITHUB_SHA,
    version: manifest.version,
  }, null, 2)}\n`);
}
