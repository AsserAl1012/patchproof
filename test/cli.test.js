import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const node = process.execPath;

test("CLI lists scenarios", () => {
  const result = spawnSync(node, ["bin/patchproof.js", "scenarios"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /clamp-range/);
  assert.match(result.stdout, /slugify-whitespace/);
});

test("CLI runs and verifies a replayable certificate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "patchproof-"));
  const certPath = join(dir, "certificate.json");

  const run = spawnSync(
    node,
    ["bin/patchproof.js", "run", "--scenario", "clamp-range", "--out", certPath],
    { encoding: "utf8" }
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /certified/);

  const certificate = JSON.parse(await readFile(certPath, "utf8"));
  assert.equal(certificate.status, "certified");
  assert.equal(certificate.schema, "patchproof.certificate.v2");

  const verify = spawnSync(node, ["bin/patchproof.js", "verify", certPath], {
    encoding: "utf8"
  });
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  assert.match(verify.stdout, /verified/);
});

test("CLI runs from an input file", async () => {
  const result = spawnSync(
    node,
    ["bin/patchproof.js", "run", "--input", "examples/clamp-range.input.json", "--json"],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const certificate = JSON.parse(result.stdout);
  assert.equal(certificate.status, "certified");
  assert.equal(certificate.replay.input.preconditionText, "args[1] <= args[2]");
});

test("certificate CLI works from an action checkout without installed dependencies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "patchproof-action-"));
  await mkdir(join(dir, "bin"), { recursive: true });
  await mkdir(join(dir, "sandbox"), { recursive: true });
  await Promise.all([
    copyFile("engine.js", join(dir, "engine.js")),
    copyFile("runtime.js", join(dir, "runtime.js")),
    copyFile("python-examples.js", join(dir, "python-examples.js")),
    copyFile("sandbox/hosted-runner.js", join(dir, "sandbox", "hosted-runner.js")),
    copyFile("sandbox/runner-child.js", join(dir, "sandbox", "runner-child.js")),
    copyFile("sandbox/python-runner.py", join(dir, "sandbox", "python-runner.py")),
    copyFile("package.json", join(dir, "package.json")),
    copyFile("bin/patchproof.js", join(dir, "bin", "patchproof.js"))
  ]);
  const certPath = join(dir, "certificate.json");
  const run = spawnSync(
    node,
    [join(dir, "bin", "patchproof.js"), "run", "--scenario", "take-limit", "--out", certPath],
    { cwd: dir, encoding: "utf8" }
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const verify = spawnSync(node, [join(dir, "bin", "patchproof.js"), "verify", certPath], {
    cwd: dir,
    encoding: "utf8"
  });
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  assert.match(verify.stdout, /verified/);
});

test("CLI runs Python from an input file", () => {
  const result = spawnSync(
    node,
    ["bin/patchproof.js", "run", "--input", "examples/python-clamp-range.input.json", "--json"],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const certificate = JSON.parse(result.stdout);
  assert.equal(certificate.status, "certified");
  assert.equal(certificate.target.language, "python");
});

test("CLI lists and runs repository targets", async () => {
  const repo = await mkdtemp(join(tmpdir(), "patchproof-repo-cli-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "src", "clamp.js"), `function clamp(value, min, max) {
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

  const list = spawnSync(node, ["bin/patchproof.js", "targets", "--repo", repo], {
    encoding: "utf8"
  });
  assert.equal(list.status, 0, list.stderr || list.stdout);
  assert.match(list.stdout, /clamp-range/);

  const run = spawnSync(node, ["bin/patchproof.js", "run", "--repo", repo, "--target", "clamp-range", "--json"], {
    encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const certificate = JSON.parse(run.stdout);
  assert.equal(certificate.status, "certified");
});

test("CLI inspects repository metadata", async () => {
  const repo = await mkdtemp(join(tmpdir(), "patchproof-repo-inspect-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "package.json"), JSON.stringify({
    scripts: { test: "node --test" }
  }, null, 2), "utf8");
  await writeFile(join(repo, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");
  await writeFile(join(repo, "tests", "math.test.js"), "import test from 'node:test';\n", "utf8");

  const result = spawnSync(node, ["bin/patchproof.js", "inspect", "--repo", repo, "--json"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.packageManager, "npm");
  assert.ok(report.frameworks.includes("node:test"));
  assert.ok(report.sourceFiles.includes("src/math.js"));
});

test("CLI initializes and doctors a repository", async () => {
  const repo = await mkdtemp(join(tmpdir(), "patchproof-repo-init-cli-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "package.json"), JSON.stringify({
    scripts: { test: "vitest run" },
    devDependencies: { vitest: "^1.0.0" }
  }, null, 2), "utf8");
  await writeFile(join(repo, "src", "clamp.js"), "function clamp(value, min, max) { return value; }\n", "utf8");
  await writeFile(join(repo, "tests", "clamp.test.js"), "expect(clamp(1, 0, 2)).toBe(1);\n", "utf8");

  const init = spawnSync(node, ["bin/patchproof.js", "init", "--repo", repo], {
    encoding: "utf8"
  });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.match(await readFile(join(repo, "patchproof.yml"), "utf8"), /frameworkTests/);

  const doctor = spawnSync(node, ["bin/patchproof.js", "doctor", "--repo", repo], {
    encoding: "utf8"
  });
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  assert.match(doctor.stdout, /PatchProof doctor/);
});

test("CLI applies a certified repository patch", async () => {
  const repo = await mkdtemp(join(tmpdir(), "patchproof-repo-apply-cli-"));
  const certPath = join(repo, "certificate.json");
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

  const run = spawnSync(
    node,
    ["bin/patchproof.js", "run", "--repo", repo, "--target", "clamp-range", "--out", certPath, "--apply"],
    { encoding: "utf8" }
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /applied patch/);
  assert.match(await readFile(join(repo, "src", "clamp.js"), "utf8"), /value > max/);
});
