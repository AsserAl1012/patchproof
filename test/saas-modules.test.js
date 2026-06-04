import test from "node:test";
import assert from "node:assert/strict";
import { hasPermission, normalizeRole, requirePermission } from "../saas/rbac.js";
import { parsePatchproofConfig } from "../saas/config.js";
import { normalizeModelProvider, modelProvenance } from "../saas/model-providers.js";
import { buildRunnerPolicy } from "../saas/runner-policy.js";
import { parsePatchProofCommand, verifyGitHubSignature } from "../saas/github.js";
import { LocalArtifactStore } from "../saas/artifacts.js";
import { MemoryJobQueue } from "../saas/queue.js";
import { buildCompletionComment, buildQueuedComment } from "../saas/github-app.js";
import { decryptSettingsSecrets, encryptSettingsSecrets, maskSettingsSecrets } from "../saas/secrets.js";
import { dockerArgsForPolicy } from "../sandbox/docker-runner.js";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("RBAC permissions enforce role boundaries", () => {
  assert.equal(hasPermission("owner", "admin:write"), true);
  assert.equal(hasPermission("auditor", "admin:write"), false);
  assert.equal(normalizeRole("developer"), "developer");
  assert.throws(() => normalizeRole("ghost"), /Unknown role/);
  assert.throws(() => requirePermission("auditor", "run:apply"), /lacks/);
});

test("patchproof.yml parser validates production config", () => {
  const config = parsePatchproofConfig(`
version: 1
project:
  language: python
  testCommand: py -m pytest
runner:
  timeoutSeconds: 300
  network: disabled
repair:
  minEvidenceScore: 0.8
`);
  assert.equal(config.project.language, "python");
  assert.equal(config.runner.timeoutSeconds, 300);
  assert.equal(config.repair.minEvidenceScore, 0.8);
});

test("model provider normalization records hashed provenance", () => {
  const provider = normalizeModelProvider({
    provider: "openai-compatible",
    baseUrl: "https://models.local/v1",
    model: "repair-model",
    privacyMode: true
  });
  const provenance = modelProvenance(provider, "prompt", "candidate");
  assert.equal(provider.provider, "openai-compatible");
  assert.equal(provenance.promptStored, false);
  assert.equal(provenance.promptHash.length, 64);
});

test("runner policy combines settings and project config", () => {
  const policy = buildRunnerPolicy({
    orgId: "org_1",
    projectId: "prj_1",
    runId: "run_1",
    settings: { runner: { memoryMb: 1024, network: "disabled" } },
    config: { runner: { cpus: 1 } }
  });
  assert.equal(policy.memoryMb, 1024);
  assert.equal(policy.cpus, 1);
  assert.equal(policy.readOnlyRootFilesystem, true);
});

test("GitHub command parsing and signature verification work", () => {
  const body = JSON.stringify({ comment: { body: "/patchproof verify" } });
  const secret = "secret";
  const signature256 = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(parsePatchProofCommand("/patchproof verify"), "verify");
  assert.equal(verifyGitHubSignature({ secret, body, signature256 }), true);
  assert.equal(verifyGitHubSignature({ secret, body, signature256: "sha256=bad" }), false);
});

test("local artifact store validates hashes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "patchproof-artifacts-"));
  const store = new LocalArtifactStore({ root: dir });
  const artifact = await store.putJson({ orgId: "org_1", runId: "run_1", kind: "certificate", value: { ok: true } });
  assert.equal((await store.getJson(artifact)).ok, true);
  await assert.rejects(() => store.getJson({ ...artifact, sha256: "0".repeat(64) }), /hash verification/);
});

test("memory queue enqueues and claims jobs", async () => {
  const queue = new MemoryJobQueue();
  await queue.enqueue({ jobId: "job_1", runId: "run_1" });
  assert.equal(await queue.depth(), 1);
  assert.deepEqual(await queue.claim({ timeoutSeconds: 0 }), { jobId: "job_1", runId: "run_1" });
  assert.equal(await queue.depth(), 0);
});

test("Docker runner arguments enforce production isolation", () => {
  const args = dockerArgsForPolicy({ image: "patchproof:test", network: "disabled", memoryMb: 512, cpus: 1, pidsLimit: 64 });
  assert.ok(args.includes("--network"));
  assert.ok(args.includes("none"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--pids-limit"));
  assert.ok(args.includes("patchproof:test"));
});

test("GitHub comment builders include run evidence", () => {
  const queued = buildQueuedComment({ run: { id: "run_1" }, command: "verify", baseUrl: "https://patchproof.local" });
  assert.match(queued, /queued/);
  assert.match(queued, /run_1/);
  const completed = buildCompletionComment({
    run: { id: "run_1", status: "certified" },
    certificate: { selectedPatch: { id: "p1", evidenceScore: 0.91 } }
  });
  assert.match(completed, /certified/);
  assert.match(completed, /91%/);
});

test("settings secrets encrypt and mask", () => {
  const settings = { github: { privateKey: "secret-key" }, modelProvider: { apiKey: "model-key" } };
  const encrypted = encryptSettingsSecrets(settings);
  assert.notEqual(encrypted.github.privateKey, "secret-key");
  assert.equal(decryptSettingsSecrets(encrypted).github.privateKey, "secret-key");
  assert.equal(maskSettingsSecrets(encrypted).github.privateKey, "********");
});
