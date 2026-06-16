import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInputFromRepositoryTarget,
  inspectRepository,
  listRepositoryTargets
} from "../repository-adapter.js";
import { runPatchProof } from "../runtime.js";

test("repository adapter builds a JavaScript PatchProof input from source and tests", async () => {
  const repo = await fixtureRepo("repo-js-");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "src", "clamp.js"), `export function clamp(value, min, max) {
  if (value < min) return min;
  if (value > min) return max;
  return value;
}
`, "utf8");
  await writeFile(join(repo, "tests", "clamp.patchproof.json"), JSON.stringify([
    { name: "below min", args: [-5, 0, 10], expect: 0 },
    { name: "above max", args: [12, 0, 10], expect: 10 },
    { name: "in range", args: [6, 0, 10], expect: 6 }
  ], null, 2), "utf8");
  await writeFile(join(repo, "patchproof.yml"), `
version: 1
project:
  language: javascript
  allowedPaths:
    - src/**
    - tests/**
targets:
  clamp-range:
    source: src/clamp.js
    function: clamp
    tests: tests/clamp.patchproof.json
    bugReport: Upper guard compares value to min instead of max.
    precondition: args[1] <= args[2]
    mayChange: args[0] > args[1] && args[0] < args[2]
    postcondition: result === Math.min(Math.max(args[0], args[1]), args[2])
`, "utf8");

  const targets = await listRepositoryTargets({ repoRoot: repo });
  assert.equal(targets[0].id, "clamp-range");
  const input = await createInputFromRepositoryTarget({ repoRoot: repo, targetId: "clamp-range" });
  assert.equal(input.language, "javascript");
  assert.match(input.source, /^function clamp/);
  assert.doesNotMatch(input.source, /export/);
  const result = runPatchProof(input);
  assert.equal(result.certificate.status, "certified");
});

test("repository adapter builds a Python PatchProof input from source and tests", async () => {
  const repo = await fixtureRepo("repo-python-");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "src", "ranges.py"), `def helper(value):
    return value

def clamp(value, min, max):
    if value < min:
        return min
    if value > min:
        return max
    return value
`, "utf8");
  await writeFile(join(repo, "tests", "clamp.patchproof.json"), JSON.stringify({
    tests: [
      { name: "below min", args: [-5, 0, 10], expect: 0 },
      { name: "above max", args: [12, 0, 10], expect: 10 },
      { name: "in range", args: [6, 0, 10], expect: 6 }
    ]
  }, null, 2), "utf8");
  await writeFile(join(repo, "patchproof.yml"), `
version: 1
project:
  language: python
  allowedPaths:
    - src/**
    - tests/**
targets:
  clamp-range:
    source: src/ranges.py
    function: clamp
    tests: tests/clamp.patchproof.json
    bugReport: Upper guard compares value to lower instead of upper.
    precondition: args[1] <= args[2]
    mayChange: args[0] > args[1] and args[0] < args[2]
    postcondition: result == min(max(args[0], args[1]), args[2])
`, "utf8");

  const input = await createInputFromRepositoryTarget({ repoRoot: repo, targetId: "clamp-range" });
  assert.equal(input.language, "python");
  assert.match(input.source, /^def clamp/);
  assert.doesNotMatch(input.source, /def helper/);
  const result = runPatchProof(input);
  assert.equal(result.certificate.status, "certified");
  assert.equal(result.certificate.target.language, "python");
});

test("repository adapter enforces allowed paths", async () => {
  const repo = await fixtureRepo("repo-paths-");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "secrets"), { recursive: true });
  await writeFile(join(repo, "src", "x.js"), "function x(value) { return value; }\n", "utf8");
  await writeFile(join(repo, "secrets", "x.patchproof.json"), "[]\n", "utf8");
  await writeFile(join(repo, "patchproof.yml"), `
version: 1
project:
  language: javascript
  allowedPaths:
    - src/**
  forbiddenPaths:
    - secrets/**
targets:
  x:
    source: src/x.js
    function: x
    tests: secrets/x.patchproof.json
`, "utf8");

  await assert.rejects(
    () => createInputFromRepositoryTarget({ repoRoot: repo, targetId: "x" }),
    /not allowed|forbidden/
  );
});

test("repository inspector detects JavaScript project metadata", async () => {
  const repo = await fixtureRepo("inspect-js-");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "package.json"), JSON.stringify({
    scripts: { test: "vitest run" },
    devDependencies: { vitest: "^1.0.0" }
  }, null, 2), "utf8");
  await writeFile(join(repo, "package-lock.json"), "{}\n", "utf8");
  await writeFile(join(repo, "src", "clamp.js"), "export function clamp(value) { return value; }\n", "utf8");
  await writeFile(join(repo, "tests", "clamp.test.js"), "import { test } from 'vitest';\n", "utf8");
  await writeFile(join(repo, "tests", "clamp.patchproof.json"), "[]\n", "utf8");

  const report = await inspectRepository({ repoRoot: repo });
  assert.equal(report.packageManager, "npm");
  assert.ok(report.languages.includes("javascript"));
  assert.ok(report.frameworks.includes("vitest"));
  assert.ok(report.testCommands.some((item) => item.command === "npm test"));
  assert.ok(report.testCommands.some((item) => item.command === "npx vitest run"));
  assert.ok(report.sourceFiles.includes("src/clamp.js"));
  assert.ok(report.patchproofTestFiles.includes("tests/clamp.patchproof.json"));
});

test("repository inspector detects Python pytest metadata", async () => {
  const repo = await fixtureRepo("inspect-python-");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "pyproject.toml"), "[tool.pytest.ini_options]\npythonpath = ['src']\n", "utf8");
  await writeFile(join(repo, "src", "ranges.py"), "def clamp(value):\n    return value\n", "utf8");
  await writeFile(join(repo, "tests", "test_ranges.py"), "def test_clamp():\n    assert True\n", "utf8");

  const report = await inspectRepository({ repoRoot: repo });
  assert.equal(report.packageManager, "python");
  assert.ok(report.languages.includes("python"));
  assert.ok(report.frameworks.includes("pytest"));
  assert.deepEqual(report.testCommands.map((item) => item.command), ["python -m pytest"]);
  assert.ok(report.suggestions.next.some((item) => item.includes("patchproof.yml")));
});

async function fixtureRepo(prefix) {
  return mkdtemp(join(tmpdir(), `patchproof-${prefix}`));
}
