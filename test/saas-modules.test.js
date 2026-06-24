import test from "node:test";
import assert from "node:assert/strict";
import { hasPermission, normalizeRole, requirePermission } from "../saas/rbac.js";
import { parsePatchproofConfig } from "../saas/config.js";
import {
  buildRepairPrompt,
  estimateModelUsage,
  generateModelCandidates,
  normalizeModelProvider,
  modelProvenance
} from "../saas/model-providers.js";
import { buildRunnerPolicy } from "../saas/runner-policy.js";
import { parsePatchProofCommand, verifyGitHubSignature } from "../saas/github.js";
import { LocalArtifactStore } from "../saas/artifacts.js";
import { MemoryJobQueue } from "../saas/queue.js";
import { JsonSaasStore } from "../saas/store.js";
import { runRetention } from "../saas/retention.js";
import { buildCompletionComment, buildQueuedComment } from "../saas/github-app.js";
import {
  assertProductionSecretConfiguration,
  decryptSettingsSecrets,
  encryptSettingsSecrets,
  maskSettingsSecrets
} from "../saas/secrets.js";
import { dockerArgsForPolicy, resolveRunnerIsolation } from "../sandbox/docker-runner.js";
import { processQueuedJob } from "../saas/runner-service.js";
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

test("model provider generates structured repair candidates", async () => {
  let request;
  const generated = await generateModelCandidates({
    settings: {
      provider: "openai-compatible",
      baseUrl: "https://models.example/v1",
      apiKey: "secret",
      model: "repair-model",
      maxCandidates: 2
    },
    input: {
      source: "function increment(value) { return value; }",
      tests: [{ args: [1], expect: 2 }],
      bugReport: "increment should add one"
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  candidates: [
                    {
                      title: "Add one",
                      rationale: "The function currently returns its input unchanged.",
                      source: "function increment(value) { return value + 1; }"
                    }
                  ]
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  });

  assert.equal(request.url, "https://models.example/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer secret");
  assert.equal(generated.candidates.length, 1);
  assert.equal(generated.candidates[0].provenance.provider, "openai-compatible");
  assert.equal(generated.candidates[0].provenance.candidateHash.length, 64);
  assert.equal(generated.usage.returnedCandidates, 1);
  assert.ok(generated.usage.estimatedPromptTokens > 0);
  assert.match(buildRepairPrompt({ source: "function x() {}" }), /complete replacement/);
});

test("model provider reports usage estimates and enforces prompt budget", async () => {
  const usage = estimateModelUsage({
    settings: {
      provider: "openai-compatible",
      baseUrl: "https://models.example/v1",
      model: "repair-model",
      maxPromptChars: 2000
    },
    input: { language: "python", source: "def x():\n    return 1" }
  });
  assert.equal(usage.provider, "openai-compatible");
  assert.equal(usage.maxPromptChars, 2000);
  assert.ok(usage.promptChars > 0);

  await assert.rejects(
    () => generateModelCandidates({
      settings: {
        provider: "openai-compatible",
        baseUrl: "https://models.example/v1",
        apiKey: "secret",
        model: "repair-model",
        maxPromptChars: 10
      },
      input: { source: "function x() { return 1; }" },
      fetchImpl: async () => {
        throw new Error("should not be called");
      }
    }),
    /exceeding maxPromptChars/
  );
});

test("azure model provider uses deployment endpoint and api-key header", async () => {
  let request;
  await generateModelCandidates({
    settings: {
      provider: "azure-openai",
      baseUrl: "https://example.openai.azure.com",
      apiKey: "azure-secret",
      model: "repair-deployment",
      maxCandidates: 1
    },
    input: { source: "function x() { return 0; }", bugReport: "return one" },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"candidates":[{"source":"function x() { return 1; }"}]}' } }
          ]
        }),
        { status: 200 }
      );
    }
  });
  assert.match(request.url, /openai\/deployments\/repair-deployment\/chat\/completions/);
  assert.equal(request.options.headers["api-key"], "azure-secret");
  assert.equal(request.options.headers.Authorization, undefined);
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
  assert.equal(await store.delete(artifact), true);
});

test("retention removes expired sessions, artifacts, audit events, and GitHub deliveries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "patchproof-retention-"));
  const store = new JsonSaasStore({ path: join(dir, "store.json") });
  const artifactStore = new LocalArtifactStore({ root: join(dir, "artifacts") });
  await store.load();
  const oldDate = "2020-01-01T00:00:00.000Z";
  store.state.settings.org_1 = { retention: { artifactDays: 1, auditDays: 1 } };
  store.state.sessions.push({ id: "ses_old", tokenHash: "x", userId: "usr_1", createdAt: oldDate, expiresAt: oldDate });
  const artifact = await artifactStore.putJson({ orgId: "org_1", runId: "run_1", kind: "logs", value: { ok: true } });
  store.state.artifacts.push({ id: "art_old", orgId: "org_1", projectId: "prj_1", runId: "run_1", kind: "logs", createdAt: oldDate, ...artifact });
  store.state.certificates.push({ id: "cert_1", runId: "run_1", orgId: "org_1", projectId: "prj_1", certificate: {}, hash: "h", artifactId: "art_old", createdAt: oldDate });
  store.state.auditEvents.push({ id: "aud_old", orgId: "org_1", actorUserId: null, action: "old", targetType: "org", targetId: "org_1", metadata: {}, createdAt: oldDate });
  store.state.githubDeliveries.push({ id: "ghd_old", deliveryId: "delivery-1", event: "issue_comment", repository: "a/b", receivedAt: oldDate });
  await store.save();

  const result = await runRetention({ store, artifactStore, now: new Date("2026-01-01T00:00:00.000Z") });
  assert.deepEqual(result.applied, { sessions: 1, artifacts: 1, auditEvents: 1, githubDeliveries: 1 });
  assert.equal(store.state.sessions.length, 0);
  assert.equal(store.state.artifacts.length, 0);
  assert.equal(store.state.certificates[0].artifactId, null);
  await assert.rejects(() => artifactStore.getJson(artifact), /ENOENT/);
});

test("JSON store deduplicates GitHub delivery ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "patchproof-deliveries-"));
  const store = new JsonSaasStore({ path: join(dir, "store.json") });
  const first = await store.recordGitHubDelivery({ deliveryId: "delivery-1", event: "issue_comment", repository: "owner/repo" });
  const second = await store.recordGitHubDelivery({ deliveryId: "delivery-1", event: "issue_comment", repository: "owner/repo" });
  assert.equal(first.recorded, true);
  assert.equal(second.duplicate, true);
});

test("JSON store cancels runs and reconciles stale running jobs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "patchproof-run-lifecycle-"));
  const store = new JsonSaasStore({ path: join(dir, "store.json") });
  const first = await store.createRun({
    orgId: "org_1",
    projectId: "prj_1",
    actorUserId: "usr_1",
    input: { source: "function x() { return 1; }" }
  });
  const cancelled = await store.cancelRun({
    runId: first.run.id,
    actorUserId: "usr_1",
    message: "No longer needed."
  });
  assert.equal(cancelled.run.status, "cancelled");
  assert.equal(cancelled.job.status, "cancelled");

  const second = await store.createRun({
    orgId: "org_1",
    projectId: "prj_1",
    actorUserId: "usr_1",
    input: { source: "function y() { return 1; }" }
  });
  await store.markJobRunning({ jobId: second.job.id, runnerId: "runner_stale" });
  const staleJob = store.state.jobs.find((job) => job.id === second.job.id);
  staleJob.startedAt = "2026-01-01T00:00:00.000Z";
  await store.save();

  const planned = await store.reconcileStaleRuns({
    dryRun: true,
    now: new Date("2026-01-01T01:00:00.000Z"),
    staleAfterMs: 30 * 60 * 1000
  });
  assert.equal(planned.staleRuns.length, 1);
  assert.equal(planned.reconciled, 0);

  const applied = await store.reconcileStaleRuns({
    dryRun: false,
    now: new Date("2026-01-01T01:00:00.000Z"),
    staleAfterMs: 30 * 60 * 1000
  });
  const detail = await store.getRunDetail(second.run.id);
  assert.equal(applied.reconciled, 1);
  assert.equal(detail.run.status, "failed");
  assert.match(detail.run.error, /reconciled as stale/);
});

test("memory queue enqueues and claims jobs", async () => {
  const queue = new MemoryJobQueue();
  await queue.enqueue({ jobId: "job_1", runId: "run_1" });
  assert.equal(await queue.depth(), 1);
  const claimed = await queue.claim({ timeoutSeconds: 0 });
  assert.equal(claimed.jobId, "job_1");
  assert.equal(claimed.runId, "run_1");
  assert.ok(claimed.leaseId);
  assert.equal(await queue.depth(), 0);
  assert.equal(await queue.inFlightDepth(), 1);
  assert.deepEqual(await queue.ack(claimed), { acked: true });
  assert.equal(await queue.inFlightDepth(), 0);
});

test("memory queue recovers expired leases and dead-letters exhausted jobs", async () => {
  const queue = new MemoryJobQueue({ leaseMs: 1, maxAttempts: 2 });
  await queue.enqueue({ jobId: "job_lease", runId: "run_lease" });
  const first = await queue.claim({ timeoutSeconds: 0, leaseMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await queue.depth(), 1);
  const second = await queue.claim({ timeoutSeconds: 0, leaseMs: 1 });
  assert.equal(second.queueAttempt, 2);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await queue.depth(), 0);
  assert.equal(await queue.deadDepth(), 1);
});

test("Docker runner arguments enforce production isolation", () => {
  const args = dockerArgsForPolicy({ image: "patchproof:test", runtime: "runsc", network: "disabled", memoryMb: 512, cpus: 1, pidsLimit: 64 });
  assert.ok(args.includes("--runtime"));
  assert.ok(args.includes("runsc"));
  assert.ok(args.includes("--network"));
  assert.ok(args.includes("none"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("no-new-privileges:true"));
  assert.ok(args.includes("--cap-drop"));
  assert.ok(args.includes("--ipc"));
  assert.ok(args.includes("--pids-limit"));
  assert.ok(args.includes("patchproof:test"));
  const pythonArgs = dockerArgsForPolicy({ image: "patchproof:test" }, "python");
  assert.ok(pythonArgs.includes("python3"));
  assert.ok(pythonArgs.includes("sandbox/python-runner.py"));
});

test("runner defaults to Docker isolation and current image tag", () => {
  const previousIsolation = process.env.PATCHPROOF_RUNNER_ISOLATION;
  const previousImage = process.env.PATCHPROOF_RUNNER_IMAGE;
  try {
    delete process.env.PATCHPROOF_RUNNER_ISOLATION;
    delete process.env.PATCHPROOF_RUNNER_IMAGE;
    assert.equal(resolveRunnerIsolation(), "docker");
    assert.ok(dockerArgsForPolicy().includes("patchproof:1.0.0"));
  } finally {
    if (previousIsolation === undefined) delete process.env.PATCHPROOF_RUNNER_ISOLATION;
    else process.env.PATCHPROOF_RUNNER_ISOLATION = previousIsolation;
    if (previousImage === undefined) delete process.env.PATCHPROOF_RUNNER_IMAGE;
    else process.env.PATCHPROOF_RUNNER_IMAGE = previousImage;
  }
});

test("queued runner failure handling preserves missing-run failures", async () => {
  const failedRuns = [];
  const heartbeats = [];
  const runningJobs = [];
  const result = await processQueuedJob({
    store: {
      recordRunnerHeartbeat: async (value) => heartbeats.push(value),
      markJobRunning: async (value) => runningJobs.push(value),
      getRunDetail: async () => null,
      failRun: async (value) => failedRuns.push(value)
    },
    queue: {},
    artifactStore: {},
    payload: { jobId: "job_1", runId: "run_missing" },
    runnerId: "runner_test",
    isolation: "process"
  });

  assert.equal(result.ok, false);
  assert.equal(heartbeats[0].isolation, "process");
  assert.equal(runningJobs.length, 0);
  assert.equal(failedRuns[0].runId, "run_missing");
  assert.match(failedRuns[0].message, /was not found/);
});

test("queued runner acknowledges already-cancelled runs", async () => {
  const runningJobs = [];
  const acked = [];
  const result = await processQueuedJob({
    store: {
      recordRunnerHeartbeat: async () => {},
      getRunDetail: async () => ({ run: { id: "run_cancelled", status: "cancelled" } }),
      markJobRunning: async (value) => runningJobs.push(value)
    },
    queue: { ack: async (payload) => acked.push(payload) },
    artifactStore: {},
    payload: { jobId: "job_1", runId: "run_cancelled" },
    runnerId: "runner_test",
    isolation: "process"
  });

  assert.equal(result.cancelled, true);
  assert.equal(acked[0].runId, "run_cancelled");
  assert.equal(runningJobs.length, 0);
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

test("production rejects missing or placeholder encryption keys", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousKey = process.env.PATCHPROOF_SECRET_KEY;
  try {
    process.env.NODE_ENV = "production";
    process.env.PATCHPROOF_SECRET_KEY = "replace-with-random-32-byte-secret";
    assert.throws(() => assertProductionSecretConfiguration(), /at least 32 non-placeholder/);
    process.env.PATCHPROOF_SECRET_KEY = "a-secure-production-key-with-32-chars";
    assert.doesNotThrow(() => assertProductionSecretConfiguration());
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousKey === undefined) delete process.env.PATCHPROOF_SECRET_KEY;
    else process.env.PATCHPROOF_SECRET_KEY = previousKey;
  }
});
