import { createInputFromExample, examples } from "../engine.js";
import { runPatchProofInRunner } from "../sandbox/docker-runner.js";
import { buildRunnerPolicy } from "./runner-policy.js";
import { modelProvenance, normalizeModelProvider } from "./model-providers.js";
import { buildCompletionComment, postGitHubComment } from "./github-app.js";

const DEFAULT_RUNNER_ID = `runner_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;

export async function processQueuedJob({ store, queue, artifactStore, payload, runnerId = DEFAULT_RUNNER_ID, isolation } = {}) {
  if (!payload?.jobId || !payload?.runId) throw new Error("Queue payload is missing jobId/runId.");
  await store.recordRunnerHeartbeat({
    runnerId,
    status: "online",
    isolation: isolation || process.env.PATCHPROOF_RUNNER_ISOLATION || "process",
    metadata: { pid: process.pid }
  });
  await store.markJobRunning({ jobId: payload.jobId, runnerId, phase: "claimed" });

  const detail = await store.getRunDetail(payload.runId);
  if (!detail) throw new Error(`Run ${payload.runId} was not found.`);
  const settings = await store.getSettings(detail.run.orgId);
  const runnerPolicy = payload.runnerPolicy || buildRunnerPolicy({
    orgId: detail.run.orgId,
    projectId: detail.run.projectId,
    runId: detail.run.id,
    settings,
    config: detail.project?.config || {}
  });
  const model = normalizeModelProvider(settings.modelProvider);
  const input = resolveRunInput(detail);
  const logs = [`claimed ${payload.jobId}`, `phase baseline`, `phase repairing`, `phase verifying`];

  try {
    await store.updateJobPhase({ jobId: payload.jobId, phase: "baseline", logs: ["baseline evidence started"] });
    await store.updateJobPhase({ jobId: payload.jobId, phase: "repairing", logs: ["candidate generation started"] });
    const result = await runPatchProofInRunner(
      {
        ...input,
        modelProvenance: modelProvenance(model, input.bugReport || "", input.source || ""),
        runnerPolicy
      },
      runnerPolicy,
      { isolation }
    );
    if (!result.ok) throw new Error(result.error?.message || "Runner failed.");
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
    await maybePostGitHubCompletion({ store, settings, detail, completed, certificate });
    return { ok: true, ...completed };
  } catch (error) {
    await store.failRun({
      runId: detail.run.id,
      message: error.message,
      logs: [...logs, error.message]
    });
    return { ok: false, error };
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

export async function runRunnerLoop({ store, queue, artifactStore, runnerId = DEFAULT_RUNNER_ID, isolation, once = false, pollSeconds = 5 } = {}) {
  await queue.connect?.();
  let processed = 0;
  while (true) {
    await store.recordRunnerHeartbeat({
      runnerId,
      status: "online",
      isolation: isolation || process.env.PATCHPROOF_RUNNER_ISOLATION || "process",
      metadata: { pid: process.pid, processed }
    });
    const payload = await queue.claim({ timeoutSeconds: pollSeconds });
    if (!payload) {
      if (once) return { processed };
      continue;
    }
    await processQueuedJob({ store, queue, artifactStore, payload, runnerId, isolation });
    processed += 1;
    if (once) return { processed };
  }
}

function resolveRunInput(detail) {
  if (detail.run.input?.source) return detail.run.input;
  const configInput = detail.project?.config?.repairInput || detail.project?.config?.github?.repairInput;
  if (configInput?.source) return configInput;
  return createInputFromExample(examples[0]);
}
