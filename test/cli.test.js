import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
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
  await Promise.all([
    copyFile("engine.js", join(dir, "engine.js")),
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
