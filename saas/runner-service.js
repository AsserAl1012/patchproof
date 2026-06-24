import { createInputFromExample, examples } from "../engine.js";
import { resolveRunnerIsolation, runPatchProofInRunner } from "../sandbox/docker-runner.js";
import { buildRunnerPolicy } from "./runner-policy.js";
import { generateModelCandidates } from "./model-providers.js";
import { buildCompletionComment, postGitHubComment } from "./github-app.js";

const DEFAULT_RUNNER_ID = `runner_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;

export async function processQueuedJob({ store, queue, artifactStore, payload, runnerId = DEFAULT_RUNNER_ID, isolation } = {}) {
  if (!payload?.jobId || !payload?.runId) throw new Error("Queue payload is missing jobId/runId.");
  const effectiveIsolation = resolveRunnerIsolation({ isolation });
  let detail = null;
  await store.recordRunnerHeartbeat({
    runnerId,
    status: "online",
    isolation: effectiveIsolation,
    metadata: { pid: process.pid }
  });
  const logs = [`claimed ${payload.jobId}`, `phase baseline`, `phase repairing`, `phase verifying`];

  try {
    detail = await store.getRunDetail(payload.runId);
    if (!detail) throw new Error(`Run ${payload.runId} was not found.`);
    if (detail.run.status === "cancelled") {
      await queue.ack?.(payload);
      return { ok: false, cancelled: true, run: detail.run };
    }
    await store.markJobRunning({ jobId: payload.jobId, runnerId, phase: "claimed" });
    const settings = await store.getSettings(detail.run.orgId);
    const runnerPolicy = payload.runnerPolicy || buildRunnerPolicy({
      orgId: detail.run.orgId,
      projectId: detail.run.projectId,
      runId: detail.run.id,
      settings,
      config: detail.project?.config || {}
    });
    const input = resolveRunInput(detail);
    await store.updateJobPhase({ jobId: payload.jobId, phase: "baseline", logs: ["baseline evidence started"] });
    await store.updateJobPhase({ jobId: payload.jobId, phase: "repairing", logs: ["candidate generation started"] });
    const repair = detail.project?.config?.repair || {};
    const configuredCandidateLimit = positiveInteger(
      repair.maxCandidates,
      settings.modelProvider?.maxCandidates || 8
    );
    const generation = await generateModelCandidates({
      settings: {
        ...(settings.modelProvider || {}),
        maxCandidates: configuredCandidateLimit
      },
      input
    });
    logs.push(
      `model ${generation.provider}/${generation.model}: ${generation.candidates.length} candidate(s)`
    );
    const result = await runPatchProofInRunner(
      {
        ...input,
        candidatePatches: generation.candidates,
        modelProvenance: generation.provenance,
        limits: {
          ...(input.limits || {}),
          maxCandidates: configuredCandidateLimit,
          minEvidenceScore: boundedScore(repair.minEvidenceScore, input.limits?.minEvidenceScore || 0)
        },
        runnerPolicy
      },
      runnerPolicy,
      { isolation: effectiveIsolation }
    );
    if (!result.ok) throw new Error(result.error?.message || "Runner failed.");
    const latest = await store.getRunDetail(detail.run.id);
    if (latest?.run?.status === "cancelled") {
      await queue.ack?.(payload);
      return { ok: false, cancelled: true, run: latest.run };
    }
    await store.updateJobPhase({ jobId: payload.jobId, phase: "uploading", logs: ["uploading artifacts"] });
    const certificate = result.result.certificate;
    const resultLogs = result.result.logs || [];
    const artifacts = [
      {
        kind: "certificate",
        artifact: await artifactStore.putJson({
          orgId: detail.run.orgId,
          runId: detail.run.id,
          kind: "certificate",
          value: certificate
        })
      },
      {
        kind: "logs",
        artifact: await artifactStore.putText({
          orgId: detail.run.orgId,
          runId: detail.run.id,
          kind: "logs",
          text: resultLogs.join("\n")
        })
      },
      {
        kind: "diff",
        artifact: await artifactStore.putText({
          orgId: detail.run.orgId,
          runId: detail.run.id,
          kind: "diff",
          text: certificate.selectedPatch?.diff || ""
        })
      },
      {
        kind: "runner-metadata",
        artifact: await artifactStore.putJson({
          orgId: detail.run.orgId,
          runId: detail.run.id,
          kind: "runner-metadata",
          value: {
            runnerId,
            runnerPolicy,
            resourceUsage: result.resourceUsage || {},
            completedAt: new Date().toISOString()
          }
        })
      }
    ];
    const completed = await store.completeRun({
      runId: detail.run.id,
      certificate,
      status: certificate.status,
      logs: [...logs, ...resultLogs],
      artifacts,
      resourceUsage: result.resourceUsage || {}
    });
    await queue.ack?.(payload);
    await maybePostGitHubCompletion({ store, settings, detail, completed, certificate });
    return { ok: true, ...completed };
  } catch (error) {
    const runId = detail?.run?.id || payload.runId;
    let latest = null;
    try {
      latest = await store.getRunDetail?.(runId);
    } catch {
      latest = null;
    }
    if (latest?.run?.status === "cancelled") {
      await queue.ack?.(payload);
      return { ok: false, cancelled: true, error };
    }
    const retryable = isRetryableJobError(error, detail);
    const queueResult = await queue.fail?.(payload, error, { retry: retryable }) || { retry: false, deadLettered: true };
    if (queueResult.retry) {
      await store.markJobRetrying?.({
        jobId: payload.jobId,
        message: error.message,
        logs: [...logs, error.message],
        nextAttempt: Number(queueResult.attempts || payload.queueAttempt || 1) + 1
      }).catch?.(() => {});
      return { ok: false, error, retry: true, queue: queueResult };
    }
    await store.failRun?.({
      runId,
      message: error.message,
      logs: [...logs, error.message]
    }).catch?.(() => {});
    return { ok: false, error, retry: false, queue: queueResult };
  }
}

async function maybePostGitHubCompletion({ store, settings, detail, completed, certificate }) {
  const github = detail.run.metadata?.github;
  if (!github?.repository || !github?.issueNumber) return;
  const [owner, repo] = github.repository.split("/");
  await postGitHubComment({
    settings,
    installationId: github.installationId,
    owner,
    repo,
    issueNumber: github.issueNumber,
    body: buildCompletionComment({
      run: completed.run,
      certificate,
      baseUrl: process.env.PATCHPROOF_PUBLIC_BASE_URL || ""
    })
  }).catch((error) =>
    store.addAuditEvent?.({
      orgId: detail.run.orgId,
      actorUserId: detail.run.actorUserId,
      action: "github.comment_failed",
      targetType: "run",
      targetId: detail.run.id,
      metadata: { message: error.message }
    })
  );
}

export async function runRunnerLoop({ store, queue, artifactStore, runnerId = DEFAULT_RUNNER_ID, isolation, once = false, pollSeconds = 5, signal } = {}) {
  await queue.connect?.();
  let processed = 0;
  while (!signal?.aborted) {
    await store.recordRunnerHeartbeat({
      runnerId,
      status: "online",
      isolation: resolveRunnerIsolation({ isolation }),
      metadata: { pid: process.pid, processed }
    });
    const payload = await queue.claim({ timeoutSeconds: pollSeconds });
    if (!payload) {
      if (once || signal?.aborted) break;
      continue;
    }
    await processQueuedJob({ store, queue, artifactStore, payload, runnerId, isolation });
    processed += 1;
    if (once || signal?.aborted) break;
  }
  await store.recordRunnerHeartbeat({
    runnerId,
    status: "stopping",
    isolation: resolveRunnerIsolation({ isolation }),
    metadata: { pid: process.pid, processed }
  }).catch?.(() => {});
  return { processed, stopped: true };
}

function resolveRunInput(detail) {
  const language = detail.run.input?.language || detail.project?.config?.project?.language || "javascript";
  if (detail.run.input?.source) return { ...detail.run.input, language };
  const configInput = detail.project?.config?.repairInput || detail.project?.config?.github?.repairInput;
  if (configInput?.source) return { ...configInput, language: configInput.language || language };
  return createInputFromExample(examples[0]);
}

function positiveInteger(value, fallback) {
  const result = Number(value || fallback);
  return Number.isInteger(result) && result > 0 ? result : Number(fallback);
}

function boundedScore(value, fallback) {
  const result = Number(value ?? fallback);
  return Number.isFinite(result) && result >= 0 && result <= 1 ? result : Number(fallback);
}

function isRetryableJobError(error, detail) {
  const message = String(error?.message || "");
  if (!detail) return false;
  if (/was not found|authentication required|lacks permission/i.test(message)) return false;
  if (/unsafe source|unsafe precondition|unsafe may-change|unsafe postcondition/i.test(message)) return false;
  if (/tests must be valid json|source must declare|unsupported language/i.test(message)) return false;
  return true;
}
