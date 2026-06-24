import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { createInputFromExample, examples, verifyCertificate } from "../runtime.js";
import { createArtifactStore } from "../saas/artifacts.js";
import { createJobQueue } from "../saas/queue.js";
import { PostgresSaasStore } from "../saas/postgres-store.js";
import { buildRunnerPolicy } from "../saas/runner-policy.js";
import { runRunnerLoop } from "../saas/runner-service.js";

const image = process.env.PATCHPROOF_RUNNER_IMAGE || "patchproof:ci";
const databaseUrl = process.env.DATABASE_URL || "postgres://patchproof:patchproof@127.0.0.1:5432/patchproof";
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const s3Endpoint = process.env.PATCHPROOF_S3_ENDPOINT || "http://127.0.0.1:9000";
const bucket = process.env.PATCHPROOF_S3_BUCKET || "patchproof";
const accessKeyId = process.env.PATCHPROOF_S3_ACCESS_KEY_ID || "patchproof";
const secretAccessKey = process.env.PATCHPROOF_S3_SECRET_ACCESS_KEY || "patchproof-password";

process.env.PATCHPROOF_STORE_DRIVER = "postgres";
process.env.DATABASE_URL = databaseUrl;
process.env.PATCHPROOF_QUEUE_DRIVER = "redis";
process.env.REDIS_URL = redisUrl;
process.env.PATCHPROOF_REDIS_URL = redisUrl;
process.env.PATCHPROOF_ARTIFACT_DRIVER = "s3";
process.env.PATCHPROOF_S3_ENDPOINT = s3Endpoint;
process.env.PATCHPROOF_S3_BUCKET = bucket;
process.env.PATCHPROOF_S3_ACCESS_KEY_ID = accessKeyId;
process.env.PATCHPROOF_S3_SECRET_ACCESS_KEY = secretAccessKey;
process.env.PATCHPROOF_S3_FORCE_PATH_STYLE = "true";
process.env.PATCHPROOF_RUNNER_IMAGE = image;

const store = new PostgresSaasStore({ connectionString: databaseUrl });
const queue = createJobQueue({ driver: "redis", redis: { url: redisUrl, queueName: `patchproof:ci:${Date.now()}` } });
const artifactStore = createArtifactStore({ driver: "s3", s3: { endpoint: s3Endpoint, bucket, accessKeyId, secretAccessKey, forcePathStyle: true } });

try {
  await ensureBucket();
  await store.load();
  await queue.connect();
  await artifactStore.health();

  const boot = await store.bootstrap({
    email: `ci-${Date.now()}@example.com`,
    password: "correct horse battery staple",
    name: "CI Owner",
    orgName: "PatchProof CI"
  });
  const project = await store.createProject({
    orgId: boot.org.id,
    actorUserId: boot.user.id,
    name: "Integration Project",
    config: {
      runner: {
        image,
        network: "disabled",
        timeoutSeconds: 120,
        memoryMb: 768,
        cpus: 1
      }
    }
  });
  const { run, job } = await store.createRun({
    orgId: boot.org.id,
    projectId: project.id,
    actorUserId: boot.user.id,
    trigger: "integration-services",
    input: createInputFromExample(examples[0])
  });
  const settings = await store.getSettings(boot.org.id);
  const runnerPolicy = buildRunnerPolicy({ orgId: boot.org.id, projectId: project.id, runId: run.id, settings, config: project.config });
  await queue.enqueue({ jobId: job.id, runId: run.id, orgId: boot.org.id, projectId: project.id, runnerPolicy });

  const processed = await runRunnerLoop({
    store,
    queue,
    artifactStore,
    runnerId: "runner_ci_services",
    isolation: "docker",
    once: true,
    pollSeconds: 1
  });
  if (processed.processed !== 1) throw new Error(`Expected one processed job, got ${processed.processed}.`);

  const detail = await store.getRunDetail(run.id);
  if (detail.run.status !== "certified") {
    throw new Error(`Expected certified run, got ${detail.run.status}: ${detail.run.error || ""}`);
  }
  const certificateArtifact = await store.getArtifactForRun(run.id, "certificate");
  if (!certificateArtifact || certificateArtifact.storageDriver !== "s3") {
    throw new Error("Certificate artifact was not stored in S3.");
  }
  const certificate = await artifactStore.getJson(certificateArtifact);
  const replay = verifyCertificate(certificate);
  if (!replay.valid) {
    throw new Error(`Certificate replay failed: ${replay.mismatches.join("; ")}`);
  }

  console.log(JSON.stringify({
    ok: true,
    runId: run.id,
    status: detail.run.status,
    artifactDriver: certificateArtifact.storageDriver,
    queueDepth: await queue.depth(),
    replayValid: replay.valid
  }, null, 2));
} finally {
  await queue.close?.().catch?.(() => {});
  await store.close?.().catch?.(() => {});
}

async function ensureBucket() {
  const client = new S3Client({
    region: process.env.PATCHPROOF_S3_REGION || "us-east-1",
    endpoint: s3Endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey }
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}
