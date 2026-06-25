import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCertificatePatchToRepositoryTarget,
  createInputFromRepositoryTarget,
  detectRepositoryBugs,
  doctorRepository,
  extractFrameworkTests,
  initializeRepositoryConfig,
  inspectRepository,
  listRepositoryTargets,
  runRepositoryTestCommand
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

test("repository adapter extracts simple JavaScript framework assertions", async () => {
  const repo = await fixtureRepo("repo-vitest-");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "src", "clamp.js"), `export function clamp(value, min, max) {
  if (value < min) return min;
  if (value > min) return max;
  return value;
}
`, "utf8");
  await writeFile(join(repo, "tests", "clamp.test.js"), `
import { expect, test } from "vitest";
import { clamp } from "../src/clamp.js";
test("clamps", () => {
  expect(clamp(-5, 0, 10)).toBe(0);
  expect(clamp(12, 0, 10)).toBe(10);
  expect(clamp(6, 0, 10)).toBe(6);
});
`, "utf8");
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
    framework: vitest
    frameworkTests: tests/clamp.test.js
    bugReport: Upper guard compares value to min instead of max.
    precondition: args[1] <= args[2]
    mayChange: args[0] > args[1] && args[0] < args[2]
    postcondition: result === Math.min(Math.max(args[0], args[1]), args[2])
`, "utf8");

  const extracted = await extractFrameworkTests({
    repoRoot: repo,
    testPath: "tests/clamp.test.js",
    functionName: "clamp",
    framework: "vitest"
  });
  assert.equal(extracted.length, 3);
  const input = await createInputFromRepositoryTarget({ repoRoot: repo, targetId: "clamp-range" });
  assert.equal(input.repository.testSource, "framework-adapter");
  const result = runPatchProof(input);
  assert.equal(result.certificate.status, "certified");
});

test("repository adapter extracts arrow function and TypeScript targets", async () => {
  const repo = await fixtureRepo("repo-ts-");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "src", "math.ts"), `export const increment = (value: number): number => value;
`, "utf8");
  await writeFile(join(repo, "tests", "increment.patchproof.json"), JSON.stringify([
    { name: "increments", args: [1], expect: 2 },
    { name: "keeps negative", args: [-2], expect: -1 }
  ], null, 2), "utf8");
  await writeFile(join(repo, "patchproof.yml"), `
version: 1
project:
  language: typescript
  allowedPaths:
    - src/**
    - tests/**
targets:
  increment:
    source: src/math.ts
    function: increment
    tests: tests/increment.patchproof.json
    bugReport: increment should add one.
    mayChange: true
    postcondition: result === args[0] + 1
`, "utf8");

  const input = await createInputFromRepositoryTarget({ repoRoot: repo, targetId: "increment" });
  assert.equal(input.language, "javascript");
  assert.match(input.source, /^function increment\(value\)/);
  assert.doesNotMatch(input.source, /number/);
  const result = runPatchProof({
    ...input,
    candidatePatches: ["function increment(value) { return value + 1; }"]
  });
  assert.equal(result.certificate.status, "certified");
});

test("repository adapter extracts object methods and AST framework literals", async () => {
  const repo = await fixtureRepo("repo-method-");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "src", "numbers.js"), `export const numbers = {
  clamp(value, min, max) {
    if (value < min) return min;
    if (value > min) return max;
    return value;
  }
};
`, "utf8");
  await writeFile(join(repo, "tests", "numbers.test.js"), `
import { expect, test } from "vitest";
test("clamp", () => {
  expect(numbers.clamp(-5, 0, 10)).toEqual(0);
  expect(numbers.clamp(12, 0, 10)).toEqual(10);
  expect(numbers.clamp(6, 0, 10)).toEqual(6);
  expect(numbers.clamp(1, 0, 10)).toEqual({ value: 1 }.value);
});
`, "utf8");

  const extracted = await extractFrameworkTests({
    repoRoot: repo,
    testPath: "tests/numbers.test.js",
    functionName: "clamp",
    framework: "vitest"
  });
  assert.equal(extracted.length, 3);

  await writeFile(join(repo, "tests", "clamp.patchproof.json"), JSON.stringify(extracted, null, 2), "utf8");
  await writeFile(join(repo, "patchproof.yml"), `
version: 1
project:
  language: javascript
  allowedPaths:
    - src/**
    - tests/**
targets:
  clamp:
    source: src/numbers.js
    function: clamp
    tests: tests/clamp.patchproof.json
    bugReport: Upper guard compares value to min instead of max.
    precondition: args[1] <= args[2]
    mayChange: args[0] > args[1] && args[0] < args[2]
    postcondition: result === Math.min(Math.max(args[0], args[1]), args[2])
`, "utf8");
  const input = await createInputFromRepositoryTarget({ repoRoot: repo, targetId: "clamp" });
  assert.match(input.source, /^function clamp/);
  const result = runPatchProof(input);
  assert.equal(result.certificate.status, "certified");
});

test("repository adapter extracts simple pytest assertions", async () => {
  const repo = await fixtureRepo("repo-pytest-");
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "tests", "test_ranges.py"), `
from ranges import clamp

def test_clamp():
    assert clamp(-5, 0, 10) == 0
    assert clamp(12, 0, 10) == 10
    assert clamp(6, 0, 10) == 6
`, "utf8");

  const extracted = await extractFrameworkTests({
    repoRoot: repo,
    testPath: "tests/test_ranges.py",
    functionName: "clamp",
    framework: "pytest"
  });
  assert.deepEqual(extracted.map((item) => item.expect), [0, 10, 6]);
});

test("repository adapter extracts pytest boolean and raises assertions", async () => {
  const repo = await fixtureRepo("repo-pytest-rich-");
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "tests", "test_validation.py"), `
import pytest
import validators

@pytest.fixture
def slug_expected():
    return "api-client"

def test_valid_slug():
    assert validators.is_valid_slug("api-client") is True
    assert not validators.is_valid_slug("API Client")
    assert validators.is_valid_slug("") is False

def test_positive_contract():
    with pytest.raises(ValueError):
        validators.require_positive(-1)

@pytest.mark.parametrize("raw, expected", [
    ("Hello World", "hello-world"),
    ("API Client", "api-client"),
])
def test_slugify(raw, expected):
    assert validators.slugify(raw) == expected

def test_slugify_fixture(slug_expected):
    assert validators.slugify("API Client") == slug_expected
`, "utf8");

  const booleanTests = await extractFrameworkTests({
    repoRoot: repo,
    testPath: "tests/test_validation.py",
    functionName: "is_valid_slug",
    framework: "pytest"
  });
  assert.deepEqual(booleanTests.map((item) => item.expect), [true, false, false]);

  const raisesTests = await extractFrameworkTests({
    repoRoot: repo,
    testPath: "tests/test_validation.py",
    functionName: "require_positive",
    framework: "pytest"
  });
  assert.deepEqual(raisesTests, [
    {
      name: "pytest require_positive case 1",
      args: [-1],
      expectError: "ValueError"
    }
  ]);

  const parametrizedTests = await extractFrameworkTests({
    repoRoot: repo,
    testPath: "tests/test_validation.py",
    functionName: "slugify",
    framework: "pytest"
  });
  assert.deepEqual(parametrizedTests.map((item) => [item.args, item.expect]), [
    [["Hello World"], "hello-world"],
    [["API Client"], "api-client"],
    [["API Client"], "api-client"]
  ]);
});

test("repository init creates a starter config from checkout metadata", async () => {
  const repo = await fixtureRepo("repo-init-");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "package.json"), JSON.stringify({
    scripts: { test: "vitest run" },
    devDependencies: { vitest: "^1.0.0" }
  }, null, 2), "utf8");
  await writeFile(join(repo, "src", "clamp.js"), "function clamp(value, min, max) { return value; }\n", "utf8");
  await writeFile(join(repo, "tests", "clamp.test.js"), "expect(clamp(1, 0, 2)).toBe(1);\n", "utf8");

  const result = await initializeRepositoryConfig({ repoRoot: repo });
  assert.equal(result.created, true);
  const config = await readFile(join(repo, "patchproof.yml"), "utf8");
  assert.match(config, /frameworkTests: tests\/clamp\.test\.js/);
  assert.match(config, /testCommand: "npm test"/);
  const doctor = await doctorRepository({ repoRoot: repo });
  assert.notEqual(doctor.overall, "error");
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

test("repository adapter applies a certified patch back to the source file", async () => {
  const repo = await fixtureRepo("repo-apply-");
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
  const input = await createInputFromRepositoryTarget({ repoRoot: repo, targetId: "clamp-range" });
  const result = runPatchProof(input);
  assert.equal(result.certificate.status, "certified");

  const applied = await applyCertificatePatchToRepositoryTarget({
    repoRoot: repo,
    targetId: "clamp-range",
    certificate: result.certificate
  });
  assert.equal(applied.applied, true);
  const source = await readFile(join(repo, "src", "clamp.js"), "utf8");
  assert.match(source, /export function clamp/);
  assert.match(source, /value > max/);
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

test("repository detector imports C/C++ repos and reports risky bug signals", async () => {
  const repo = await fixtureRepo("detect-cpp-");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "CMakeLists.txt"), `
cmake_minimum_required(VERSION 3.20)
project(sample)
enable_testing()
find_package(GTest)
add_test(NAME sample_tests COMMAND sample_tests)
`, "utf8");
  await writeFile(join(repo, "src", "buffer.cpp"), `
#include <cstdio>
#include <cstring>

void copy_name(char *dest, const char *src) {
  strcpy(dest, src);
}
`, "utf8");
  await writeFile(join(repo, "tests", "buffer_test.cpp"), `
#include <gtest/gtest.h>
TEST(Buffer, Copy) {
  EXPECT_TRUE(true);
}
`, "utf8");

  const inspection = await inspectRepository({ repoRoot: repo });
  assert.ok(inspection.languages.includes("cpp"));
  assert.ok(inspection.frameworks.includes("cmake"));
  assert.ok(inspection.frameworks.includes("ctest"));
  assert.ok(inspection.frameworks.includes("gtest"));
  assert.ok(inspection.testCommands.some((item) => item.command.includes("ctest")));

  const report = await detectRepositoryBugs({ repoRoot: repo });
  assert.equal(report.summary.highestSeverity, "high");
  assert.ok(report.findings.some((finding) => finding.file === "src/buffer.cpp" && finding.title === "Unbounded C string API"));
});

test("repository adapter runs configured project test commands", async () => {
  const repo = await fixtureRepo("repo-test-command-");
  await writeFile(join(repo, "package.json"), JSON.stringify({
    scripts: { test: "node test-command.js" }
  }, null, 2), "utf8");
  await writeFile(join(repo, "test-command.js"), "console.log('project tests passed');\n", "utf8");
  await writeFile(join(repo, "patchproof.yml"), `
version: 1
project:
  language: javascript
  testCommand: npm test
  allowedPaths:
    - src/**
`, "utf8");

  const result = await runRepositoryTestCommand({ repoRoot: repo });
  assert.equal(result.ok, true);
  assert.equal(result.command, "npm test");
  assert.match(result.stdout, /project tests passed/);
});

test("repository adapter rejects shell-chained project test commands", async () => {
  const repo = await fixtureRepo("repo-test-command-unsafe-");
  await writeFile(join(repo, "patchproof.yml"), `
version: 1
project:
  language: javascript
  testCommand: npm test && node steal.js
  allowedPaths:
    - src/**
`, "utf8");

  await assert.rejects(
    () => runRepositoryTestCommand({ repoRoot: repo }),
    /must not contain shell chaining/
  );
});

async function fixtureRepo(prefix) {
  return mkdtemp(join(tmpdir(), `patchproof-${prefix}`));
}
