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
  repairRepository,
  repositoryDetectionToSarif,
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

test("repository adapter extracts boolean JavaScript framework matchers", async () => {
  const repo = await fixtureRepo("repo-vitest-bool-");
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "tests", "flags.test.js"), `
import { expect, test } from "vitest";
test("flags", () => {
  expect(isReady("ok")).toBeTruthy();
  expect(isReady("")).toBeFalsy();
  expect(isReady("blocked")).not.toBe(true);
});
`, "utf8");

  const extracted = await extractFrameworkTests({
    repoRoot: repo,
    testPath: "tests/flags.test.js",
    functionName: "isReady",
    framework: "vitest"
  });
  assert.deepEqual(extracted.map((item) => item.expect), [true, false, false]);
  assert.deepEqual(extracted.map((item) => item.args), [["ok"], [""], ["blocked"]]);
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

@pytest.fixture
def yielded_expected():
    yield "hello-world"

def test_valid_slug():
    assert validators.is_valid_slug("api-client") is True
    assert not validators.is_valid_slug("API Client")
    assert validators.is_valid_slug("") is False

def test_positive_contract():
    with pytest.raises(ValueError):
        validators.require_positive(-1)

@pytest.mark.parametrize("raw, expected", [
    ("Hello World", "hello-world"),
    pytest.param("Docs Page", "docs-page", id="pytest-param-row"),
    ("API Client", "api-client"),
])
def test_slugify(raw, expected):
    assert validators.slugify(raw) == expected

def test_slugify_fixture(slug_expected):
    assert validators.slugify("API Client") == slug_expected

def test_slugify_local_bindings(yielded_expected):
    raw = "Hello World"
    case = {"expected": yielded_expected}
    assert validators.slugify(raw) == case["expected"]
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
    [["Docs Page"], "docs-page"],
    [["API Client"], "api-client"],
    [["API Client"], "api-client"],
    [["Hello World"], "hello-world"]
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
  assert.match(config, /buildCommand: ""/);
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

void copy_name(const char *src) {
  char dest[64];
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
  assert.ok(inspection.buildCommands.some((item) => item.command === "cmake -S . -B build"));
  assert.ok(inspection.buildCommands.some((item) => item.command === "cmake --build build"));

  const report = await detectRepositoryBugs({ repoRoot: repo });
  assert.equal(report.summary.highestSeverity, "high");
  assert.ok(report.findings.some((finding) => finding.file === "src/buffer.cpp" && finding.title === "Unbounded C string API"));
});

test("repository detector ignores bug words inside strings but honors comment markers", async () => {
  const repo = await fixtureRepo("detect-marker-noise-");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "messages.js"), `export const clean = "No bug signals were detected.";
// BUG: real marker to review
export function ok(value) { return value; }
`, "utf8");

  const report = await detectRepositoryBugs({ repoRoot: repo });
  const markers = report.findings.filter((finding) => finding.category === "comment-marker");
  assert.equal(markers.length, 1);
  assert.equal(markers[0].line, 2);
  assert.equal(report.summary.byCategory["comment-marker"], 1);
});

test("repository repair previews and applies conservative C/C++ repairs with project validation", async () => {
  const repo = await fixtureRepo("repair-cpp-");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "buffer.c"), `#include <stdio.h>
#include <string.h>

void copy_name(const char *src) {
  char dest[64];
  strcpy(dest, src);
}
`, "utf8");
  await writeFile(join(repo, "test-command.js"), `import { readFileSync } from "node:fs";
const source = readFileSync("src/buffer.c", "utf8");
if (!source.includes("snprintf(dest, sizeof(dest)")) process.exit(2);
`, "utf8");
  await writeFile(join(repo, "patchproof.yml"), `
version: 1
project:
  language: c
  testCommand: node test-command.js
  allowedPaths:
    - src/**
`, "utf8");

  const preview = await repairRepository({ repoRoot: repo });
  assert.equal(preview.status, "preview");
  assert.equal(preview.changes.length, 1);
  assert.match(preview.changes[0].diff, /snprintf\(dest, sizeof\(dest\)/);
  assert.match(await readFile(join(repo, "src", "buffer.c"), "utf8"), /strcpy/);

  const applied = await repairRepository({ repoRoot: repo, apply: true, runTests: true });
  assert.equal(applied.status, "certified");
  assert.equal(applied.projectTest.ok, true);
  const updated = await readFile(join(repo, "src", "buffer.c"), "utf8");
  assert.match(updated, /snprintf\(dest, sizeof\(dest\), "%s", src\);/);
  assert.equal(applied.semanticClaim, false);
  assert.equal(applied.writePolicy.allowedPathsEnforced, true);
  assert.equal(applied.repairMode, "static-rewrite-project-test");
});

test("repository repair does not rewrite C/C++ pointer destinations", async () => {
  const repo = await fixtureRepo("repair-cpp-pointer-");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "buffer.c"), `#include <string.h>

void copy_name(char *dest, const char *src) {
  strcpy(dest, src);
}
`, "utf8");

  const preview = await repairRepository({ repoRoot: repo });
  assert.equal(preview.status, "no-candidates");
  assert.equal(preview.changes.length, 0);
  const unchanged = await readFile(join(repo, "src", "buffer.c"), "utf8");
  assert.match(unchanged, /strcpy\(dest, src\)/);
});

test("repository repair honors allowed paths and preserves CRLF line endings", async () => {
  const repo = await fixtureRepo("repair-policy-");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "vendor"), { recursive: true });
  await writeFile(join(repo, "src", "items.py"), "def add_item(items, item):\r\n    return items.append(item)\r\n", "utf8");
  await writeFile(join(repo, "vendor", "items.py"), "def add_item(items, item):\r\n    return items.append(item)\r\n", "utf8");
  await writeFile(join(repo, "patchproof.yml"), `
version: 1
project:
  language: python
  allowedPaths:
    - src/**
  forbiddenPaths:
    - vendor/**
`, "utf8");

  const preview = await repairRepository({ repoRoot: repo, files: ["src/**"] });
  assert.equal(preview.status, "preview");
  assert.equal(preview.changes.length, 1);
  assert.equal(preview.changes[0].file, "src/items.py");
  assert.equal(preview.writePolicy.lineEndingsPreserved, true);
  assert.match(preview.changes[0].diff, /return items/);

  const applied = await repairRepository({ repoRoot: repo, apply: true, files: ["src/**"] });
  const updated = await readFile(join(repo, "src", "items.py"), "utf8");
  assert.match(updated, /\r\n    return items\r\n$/);
  assert.equal(applied.changes[0].file, "src/items.py");
});

test("repository repair previews Python append-return repairs", async () => {
  const repo = await fixtureRepo("repair-python-");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "items.py"), `def add_item(items, item):
    return items.append(item)
`, "utf8");

  const preview = await repairRepository({ repoRoot: repo });
  assert.equal(preview.status, "preview");
  assert.equal(preview.changes.length, 1);
  assert.match(preview.changes[0].diff, /items\.append\(item\)/);
  assert.match(preview.changes[0].diff, /return items/);
});

test("repository init creates C/C++ build and test commands", async () => {
  const repo = await fixtureRepo("repo-init-cpp-");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "CMakeLists.txt"), `
cmake_minimum_required(VERSION 3.20)
project(sample)
enable_testing()
add_test(NAME sample_tests COMMAND sample_tests)
`, "utf8");
  await writeFile(join(repo, "src", "buffer.cpp"), "int copy_name() { return 1; }\n", "utf8");
  await writeFile(join(repo, "tests", "buffer_test.cpp"), "TEST(Buffer, Copy) {}\n", "utf8");

  const result = await initializeRepositoryConfig({ repoRoot: repo });
  assert.equal(result.created, true);
  const config = await readFile(join(repo, "patchproof.yml"), "utf8");
  assert.match(config, /language: cpp/);
  assert.match(config, /testCommand: "ctest --test-dir build --output-on-failure"/);
  assert.match(config, /buildCommand: "cmake --build build"/);
  assert.match(config, /installCommand: "cmake -S \. -B build"/);
});

test("repository detector supports suppressions and SARIF output", async () => {
  const repo = await fixtureRepo("detect-suppressions-");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "cache.py"), `def remember(value, seen=[]):
    seen.append(value)
    return seen
`, "utf8");
  await writeFile(join(repo, ".patchproofignore"), "static-python:Mutable default argument@src/cache.py\n", "utf8");

  const suppressed = await detectRepositoryBugs({ repoRoot: repo });
  assert.equal(suppressed.summary.highestSeverity, "medium");
  assert.equal(suppressed.summary.suppressedFindings, 1);
  assert.ok(suppressed.suppressedFindings.some((finding) => finding.title === "Mutable default argument"));

  const unsuppressed = await detectRepositoryBugs({ repoRoot: repo, defaultSuppressions: false });
  assert.equal(unsuppressed.summary.highestSeverity, "high");
  assert.ok(unsuppressed.findings[0].fingerprint);
  const sarif = repositoryDetectionToSarif(unsuppressed);
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0].results.some((result) => result.partialFingerprints.patchproof), true);
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

test("repository detection maps failing framework output to files", async () => {
  const repo = await fixtureRepo("repo-test-failure-map-");
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "tests", "math.test.js"), "throw new Error('bad math');\n", "utf8");
  await writeFile(join(repo, "test-command.js"), `console.error("FAILED tests/math.test.js::adds_numbers");
console.error("    at Object.<anonymous> (tests/math.test.js:1:7)");
process.exit(1);
`, "utf8");

  const report = await detectRepositoryBugs({
    repoRoot: repo,
    runTests: true,
    command: "node test-command.js"
  });
  const mapped = report.findings.filter((finding) => finding.category === "framework-test-failure");
  assert.ok(mapped.some((finding) => finding.file === "tests/math.test.js"));
  assert.ok(report.projectTest.frameworkFailures.some((failure) => failure.file === "tests/math.test.js"));
});

test("repository adapter can install dependencies before project tests", async () => {
  const repo = await fixtureRepo("repo-test-install-");
  await writeFile(join(repo, "install-command.js"), "console.log('install step passed');\n", "utf8");
  await writeFile(join(repo, "test-command.js"), "console.log('project tests passed');\n", "utf8");
  await writeFile(join(repo, "patchproof.yml"), `
version: 1
project:
  language: javascript
  installCommand: node install-command.js
  testCommand: node test-command.js
  allowedPaths:
    - src/**
`, "utf8");

  const result = await runRepositoryTestCommand({ repoRoot: repo, install: true });
  assert.equal(result.ok, true);
  assert.equal(result.install.ok, true);
  assert.match(result.install.stdout, /install step passed/);
  assert.match(result.stdout, /project tests passed/);
});

test("repository adapter can build before project tests", async () => {
  const repo = await fixtureRepo("repo-test-build-");
  await writeFile(join(repo, "build-command.js"), "console.log('build step passed');\n", "utf8");
  await writeFile(join(repo, "test-command.js"), "console.log('project tests passed');\n", "utf8");
  await writeFile(join(repo, "patchproof.yml"), `
version: 1
project:
  language: cpp
  buildCommand: node build-command.js
  testCommand: node test-command.js
  allowedPaths:
    - src/**
`, "utf8");

  const result = await runRepositoryTestCommand({ repoRoot: repo, build: true });
  assert.equal(result.ok, true);
  assert.equal(result.build.ok, true);
  assert.match(result.build.stdout, /build step passed/);
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
