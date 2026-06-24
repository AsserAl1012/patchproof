import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readText("package.json"));
const version = packageJson.version;
const expectedTag = `v${version}`;

const checks = [
  {
    file: "engine.js",
    pattern: new RegExp(`PATCHPROOF_VERSION\\s*=\\s*"${escapeRegex(version)}"`)
  },
  {
    file: "sandbox/python-runner.py",
    pattern: new RegExp(`PATCHPROOF_VERSION\\s*=\\s*"${escapeRegex(version)}"`)
  },
  {
    file: "server.js",
    pattern: new RegExp(`version:\\s*(?:"${escapeRegex(version)}"|PATCHPROOF_VERSION)`)
  },
  {
    file: "compose.yml",
    pattern: new RegExp(`patchproof:${escapeRegex(version)}`)
  },
  {
    file: "helm/patchproof/Chart.yaml",
    pattern: new RegExp(`\\bversion:\\s*${escapeRegex(version)}\\b[\\s\\S]*\\bappVersion:\\s*"${escapeRegex(version)}"`)
  },
  {
    file: "helm/patchproof/values.yaml",
    pattern: new RegExp(`tag:\\s*"${escapeRegex(version)}"`)
  },
  {
    file: "docs/PUBLISHING.md",
    pattern: new RegExp(`git tag ${escapeRegex(expectedTag)}`)
  }
];

const failures = [];

for (const check of checks) {
  const text = await readText(check.file);
  if (!check.pattern.test(text)) {
    failures.push(`${check.file} is not aligned with package version ${version}`);
  }
}

const refType = process.env.GITHUB_REF_TYPE || "";
const refName = process.env.GITHUB_REF_NAME || "";
if (refType === "tag" && refName !== expectedTag) {
  failures.push(`release tag ${refName} does not match package version ${version}; expected ${expectedTag}`);
}

if (failures.length) {
  console.error("Release verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Release metadata is aligned for ${expectedTag}.`);
}

async function readText(path) {
  return readFile(new URL(path, root), "utf8");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
