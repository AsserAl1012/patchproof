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
import { buildCompletionComment, buildQueuedComment } from "../saas/github-app.js";
import {
  assertProductionSecretConfiguration,
  decryptSettingsSecrets,
  encryptSettingsSecrets,
  maskSettingsSecrets
} from "../saas/secrets.js";
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
  const pythonArgs = dockerArgsForPolicy({ image: "patchproof:test" }, "python");
  assert.ok(pythonArgs.includes("python3"));
  assert.ok(pythonArgs.includes("sandbox/python-runner.py"));
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
