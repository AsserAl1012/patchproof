#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PATCHPROOF_VERSION } from "../engine.js";
import {
  createInputFromExample,
  examples,
} from "../runtime.js";
import { runPatchProofIsolated, verifyPatchProofIsolated } from "../sandbox/hosted-runner.js";

const args = process.argv.slice(2);
const command = args[0] || "help";

try {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else if (command === "version" || command === "--version" || command === "-v") {
    console.log(PATCHPROOF_VERSION);
  } else if (command === "serve") {
    const port = Number(readOption(args, "--port") || process.env.PORT || 4173);
    const host = readOption(args, "--host") || process.env.HOST || "127.0.0.1";
    const { listen } = await import("../server.js");
    listen(port, { host });
  } else if (command === "runner") {
    await runnerCommand(args.slice(1));
  } else if (command === "retention") {
    await retentionCommand(args.slice(1));
  } else if (command === "reconcile") {
    await reconcileCommand(args.slice(1));
  } else if (command === "keygen") {
    await keygenCommand(args.slice(1));
  } else if (command === "migrate") {
    await migrateCommand();
  } else if (command === "scenarios") {
    for (const example of examples) {
      console.log(`${example.id}\t${example.title}\t${example.subtitle}`);
    }
  } else if (command === "init") {
    await initCommand(args.slice(1));
  } else if (command === "doctor") {
    await doctorCommand(args.slice(1));
  } else if (command === "inspect") {
    await inspectCommand(args.slice(1));
  } else if (command === "detect") {
    await detectCommand(args.slice(1));
  } else if (command === "targets") {
    await targetsCommand(args.slice(1));
  } else if (command === "test") {
    await testCommand(args.slice(1));
  } else if (command === "run") {
    await runCommand(args.slice(1));
  } else if (command === "apply") {
    await applyCommand(args.slice(1));
  } else if (command === "verify") {
    await verifyCommand(args.slice(1));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(`patchproof: ${error.message}`);
  process.exitCode = 1;
}

async function runCommand(runArgs) {
  const jsonMode = runArgs.includes("--json");
  const scenarioId = readOption(runArgs, "--scenario");
  const inputPath = readOption(runArgs, "--input");
  const targetId = readOption(runArgs, "--target");
  const repoRoot = readOption(runArgs, "--repo");
  const configPath = readOption(runArgs, "--config");
  const outPath = readOption(runArgs, "--out");
  const applyPatch = runArgs.includes("--apply");
  const dryRun = runArgs.includes("--dry-run");
  const verifyCommand = runArgs.includes("--verify-command");
  const testCommandOverride = readOption(runArgs, "--test-command");
  const modes = [scenarioId, inputPath, targetId].filter(Boolean);

  if (modes.length !== 1) {
    throw new Error("run requires exactly one of --scenario <id>, --input <file.json>, or --target <id>.");
  }
  if (applyPatch && !targetId) {
    throw new Error("--apply requires --target so PatchProof knows which source file to update.");
  }
  if (verifyCommand && (!applyPatch || !targetId || dryRun)) {
    throw new Error("--verify-command requires --target with --apply and cannot be used with --dry-run.");
  }

  let input = scenarioId
    ? inputForScenario(scenarioId)
    : inputPath
      ? await inputFromFile(inputPath)
      : await inputFromRepositoryTarget({ repoRoot, configPath, targetId });
  input.executionMode = targetId ? "repository-adapter-cli" : "node-cli";
  input = await maybeAttachModelCandidates(input, { args: runArgs, repoRoot, configPath, targetId });
  const runnerResult = await runPatchProofIsolated(input);
  if (!runnerResult.ok) throw new Error(runnerResult.error?.message || "Isolated runner failed.");
  const result = runnerResult.result;
  const certificateJson = JSON.stringify(result.certificate, null, 2);
  let applyResult = null;

  if (applyPatch && result.certificate.status === "certified") {
    applyResult = await applyCertificatePatch({ repoRoot, configPath, targetId, certificate: result.certificate, dryRun });
    if (verifyCommand) {
      applyResult.testCommand = await runRepositoryTests({
        repoRoot,
        configPath,
        targetId,
        command: testCommandOverride || undefined
      });
    }
  }

  if (outPath) {
    await mkdir(dirname(resolve(outPath)), { recursive: true });
    await writeFile(outPath, `${certificateJson}\n`, "utf8");
  }

  if (jsonMode || !outPath) {
    console.log(certificateJson);
  } else {
    console.log(
      `${result.certificate.status}: ${result.certificate.selectedPatch?.id || "none"} score=${result.certificate.selectedPatch?.evidenceScore ?? 0}`
    );
    console.log(`certificate: ${outPath}`);
    if (applyResult) {
      console.log(`${applyResult.dryRun ? "patch preview" : "applied patch"}: ${applyResult.source}`);
      if (applyResult.testCommand) {
        console.log(`test command: ${applyResult.testCommand.command}`);
        console.log(`test status: ${applyResult.testCommand.ok ? "passed" : "failed"} (${applyResult.testCommand.durationMs}ms)`);
      }
    }
  }

  if (applyResult?.testCommand && !applyResult.testCommand.ok) {
    process.exitCode = 5;
  }

  if (result.certificate.status !== "certified") {
    process.exitCode = 2;
  }
}

async function inputFromRepositoryTarget(options) {
  const { createInputFromRepositoryTarget } = await import("../repository-adapter.js");
  return createInputFromRepositoryTarget(options);
}

async function initCommand(initArgs) {
  const repoRoot = readOption(initArgs, "--repo");
  const configPath = readOption(initArgs, "--config");
  const jsonMode = initArgs.includes("--json");
  const force = initArgs.includes("--force");
  const { initializeRepositoryConfig } = await import("../repository-adapter.js");
  const result = await initializeRepositoryConfig({ repoRoot, configPath, force });
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.overwritten ? "updated" : "created"}: ${result.config}`);
  const targets = result.report.patchproof.targets.length;
  if (targets) console.log(`existing targets before init: ${targets}`);
  console.log("next: edit target bugReport/mayChange/postcondition, then run patchproof doctor");
}

async function doctorCommand(doctorArgs) {
  if (doctorArgs.includes("--production")) {
    await productionDoctorCommand(doctorArgs);
    return;
  }
  const repoRoot = readOption(doctorArgs, "--repo");
  const configPath = readOption(doctorArgs, "--config");
  const jsonMode = doctorArgs.includes("--json");
  const { doctorRepository } = await import("../repository-adapter.js");
  const report = await doctorRepository({ repoRoot, configPath });
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`PatchProof doctor: ${report.overall}`);
    for (const check of report.checks) {
      console.log(`${check.status.toUpperCase()}\t${check.name}\t${check.message}`);
    }
  }
  if (report.overall === "error") process.exitCode = 4;
}

async function productionDoctorCommand(doctorArgs) {
  const jsonMode = doctorArgs.includes("--json");
  const skipServiceHealth = doctorArgs.includes("--skip-service-health");
  const checks = [];
  addProductionCheck(checks, "Node.js", "ok", process.version);

  const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const releaseCheck = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/verify-release.js", import.meta.url))], {
    cwd: packageRoot,
    encoding: "utf8",
    windowsHide: true
  });
  addProductionCheck(
    checks,
    "Release metadata",
    releaseCheck.status === 0 ? "ok" : "error",
    (releaseCheck.stdout || releaseCheck.stderr || "release verification failed").trim()
  );

  const dockerVersion = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    windowsHide: true
  });
  addProductionCheck(
    checks,
    "Docker daemon",
    dockerVersion.status === 0 ? "ok" : "error",
    dockerVersion.status === 0 ? `server ${dockerVersion.stdout.trim()}` : dockerStartError(dockerVersion)
  );

  const runnerImage = process.env.PATCHPROOF_RUNNER_IMAGE || `patchproof:${PATCHPROOF_VERSION}`;
  const imageInspect = spawnSync("docker", ["image", "inspect", runnerImage], {
    encoding: "utf8",
    windowsHide: true
  });
  addProductionCheck(
    checks,
    "Runner image",
    imageInspect.status === 0 ? "ok" : "warn",
    imageInspect.status === 0 ? runnerImage : `${runnerImage} was not found locally; build or pull it before starting runners.`
  );

  const runtime = process.env.PATCHPROOF_DOCKER_RUNTIME || "";
  if (runtime) {
    const runtimes = spawnSync("docker", ["info", "--format", "{{json .Runtimes}}"], {
      encoding: "utf8",
      windowsHide: true
    });
    addProductionCheck(
      checks,
      "Docker runtime",
      runtimes.status === 0 && runtimes.stdout.includes(`"${runtime}"`) ? "ok" : "error",
      runtimes.status === 0
        ? `${runtime}${runtimes.stdout.includes(`"${runtime}"`) ? " is available" : " is not registered in Docker"}`
        : dockerStartError(runtimes)
    );
  } else {
    addProductionCheck(checks, "Docker runtime", "warn", "PATCHPROOF_DOCKER_RUNTIME is unset; Docker default runtime will be used.");
  }

  const nodeEnv = process.env.NODE_ENV || "";
  addProductionCheck(
    checks,
    "NODE_ENV",
    nodeEnv === "production" ? "ok" : "warn",
    nodeEnv === "production" ? "production" : "Set NODE_ENV=production for deployed API/runner processes."
  );

  const secret = String(process.env.PATCHPROOF_SECRET_KEY || "");
  addProductionCheck(
    checks,
    "PATCHPROOF_SECRET_KEY",
    secret && secret.length >= 32 && !/replace-with|changeme|example/i.test(secret) && secret !== "patchproof-development-secret-key" ? "ok" : "error",
    secret ? "configured" : "missing; run `patchproof keygen` and set the generated value"
  );

  const storeDriver = process.env.PATCHPROOF_STORE_DRIVER || (process.env.DATABASE_URL ? "postgres" : "");
  addProductionCheck(
    checks,
    "Store driver",
    storeDriver === "postgres" && process.env.DATABASE_URL ? "ok" : "error",
    storeDriver === "postgres" && process.env.DATABASE_URL
      ? "postgres configured"
      : "Set PATCHPROOF_STORE_DRIVER=postgres and DATABASE_URL."
  );

  const redisUrl = process.env.REDIS_URL || process.env.PATCHPROOF_REDIS_URL || "";
  const queueDriver = process.env.PATCHPROOF_QUEUE_DRIVER || (redisUrl ? "redis" : "");
  addProductionCheck(
    checks,
    "Queue driver",
    queueDriver === "redis" && redisUrl ? "ok" : "error",
    queueDriver === "redis" && redisUrl
      ? "redis configured"
      : "Set PATCHPROOF_QUEUE_DRIVER=redis and REDIS_URL or PATCHPROOF_REDIS_URL."
  );

  const artifactDriver = process.env.PATCHPROOF_ARTIFACT_DRIVER || (process.env.PATCHPROOF_S3_BUCKET ? "s3" : "");
  const s3Configured = Boolean(
    process.env.PATCHPROOF_S3_BUCKET &&
      process.env.PATCHPROOF_S3_ACCESS_KEY_ID &&
      process.env.PATCHPROOF_S3_SECRET_ACCESS_KEY
  );
  addProductionCheck(
    checks,
    "Artifact driver",
    artifactDriver === "s3" && s3Configured ? "ok" : "error",
    artifactDriver === "s3" && s3Configured
      ? `s3 bucket ${process.env.PATCHPROOF_S3_BUCKET}`
      : "Set PATCHPROOF_ARTIFACT_DRIVER=s3 and S3 bucket/credentials."
  );

  addProductionCheck(checks, "Certificate signing", ...certificateSigningCheck());

  if (!skipServiceHealth) {
    await appendServiceHealthChecks(checks);
  }

  const overall = checks.some((check) => check.status === "error")
    ? "error"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "ok";
  const report = {
    overall,
    version: PATCHPROOF_VERSION,
    generatedAt: new Date().toISOString(),
    checks
  };
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`PatchProof production doctor: ${overall}`);
    for (const check of checks) {
      console.log(`${check.status.toUpperCase()}\t${check.name}\t${check.message}`);
    }
  }
  if (overall === "error") process.exitCode = 4;
}

async function targetsCommand(targetArgs) {
  const repoRoot = readOption(targetArgs, "--repo");
  const configPath = readOption(targetArgs, "--config");
  const jsonMode = targetArgs.includes("--json");
  const { listRepositoryTargets } = await import("../repository-adapter.js");
  const targets = await listRepositoryTargets({ repoRoot, configPath });
  if (jsonMode) {
    console.log(JSON.stringify({ targets }, null, 2));
    return;
  }
  for (const target of targets) {
    console.log(`${target.id}\t${target.language}\t${target.source}\t${target.tests}`);
  }
}

async function testCommand(testArgs) {
  const repoRoot = readOption(testArgs, "--repo");
  const configPath = readOption(testArgs, "--config");
  const targetId = readOption(testArgs, "--target");
  const command = readOption(testArgs, "--command");
  const timeoutSeconds = readOption(testArgs, "--timeout-seconds");
  const jsonMode = testArgs.includes("--json");
  const result = await runRepositoryTests({
    repoRoot,
    configPath,
    targetId,
    command,
    timeoutSeconds: timeoutSeconds ? Number(timeoutSeconds) : undefined
  });
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`repository test command: ${result.command}`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    console.log(`test ${result.ok ? "passed" : "failed"} in ${result.durationMs}ms`);
    if (result.error) console.log(`error: ${result.error}`);
  }
  if (!result.ok) process.exitCode = 5;
}

async function runRepositoryTests(options) {
  const { runRepositoryTestCommand } = await import("../repository-adapter.js");
  return runRepositoryTestCommand(options);
}

async function inspectCommand(inspectArgs) {
  const repoRoot = readOption(inspectArgs, "--repo");
  const configPath = readOption(inspectArgs, "--config");
  const jsonMode = inspectArgs.includes("--json");
  const { inspectRepository } = await import("../repository-adapter.js");
  const report = await inspectRepository({ repoRoot, configPath });
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printInspectReport(report);
}

async function detectCommand(detectArgs) {
  const repoRoot = readOption(detectArgs, "--repo");
  const configPath = readOption(detectArgs, "--config");
  const command = readOption(detectArgs, "--command");
  const timeoutSeconds = readOption(detectArgs, "--timeout-seconds");
  const maxFiles = readOption(detectArgs, "--max-files");
  const maxScanFiles = readOption(detectArgs, "--max-scan-files");
  const jsonMode = detectArgs.includes("--json");
  const runTests = detectArgs.includes("--run-tests");
  const { detectRepositoryBugs } = await import("../repository-adapter.js");
  const report = await detectRepositoryBugs({
    repoRoot,
    configPath,
    command,
    runTests,
    timeoutSeconds: timeoutSeconds ? Number(timeoutSeconds) : undefined,
    maxFiles: maxFiles ? Number(maxFiles) : undefined,
    maxScanFiles: maxScanFiles ? Number(maxScanFiles) : undefined
  });
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    if (["critical", "high"].includes(report.summary.highestSeverity)) process.exitCode = 6;
    return;
  }
  printDetectReport(report);
  if (["critical", "high"].includes(report.summary.highestSeverity)) process.exitCode = 6;
}

async function applyCommand(applyArgs) {
  const repoRoot = readOption(applyArgs, "--repo");
  const configPath = readOption(applyArgs, "--config");
  const targetId = readOption(applyArgs, "--target");
  const certificatePath = readOption(applyArgs, "--certificate") || applyArgs.find((arg) => !arg.startsWith("--"));
  const dryRun = applyArgs.includes("--dry-run");
  const jsonMode = applyArgs.includes("--json");
  if (!certificatePath) throw new Error("apply requires --certificate certificate.json.");
  const certificate = JSON.parse(await readFile(certificatePath, "utf8"));
  const result = await applyCertificatePatch({ repoRoot, configPath, targetId, certificate, dryRun });
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.dryRun ? "patch preview" : "applied patch"}: ${result.source}`);
    if (dryRun) console.log(result.diff);
  }
}

async function applyCertificatePatch(options) {
  const { applyCertificatePatchToRepositoryTarget } = await import("../repository-adapter.js");
  return applyCertificatePatchToRepositoryTarget(options);
}

async function verifyCommand(verifyArgs) {
  const jsonMode = verifyArgs.includes("--json");
  const certPath = verifyArgs.find((arg) => !arg.startsWith("--"));
  if (!certPath) throw new Error("verify requires a certificate path.");

  const certificate = JSON.parse(await readFile(certPath, "utf8"));
  const runnerResult = await verifyPatchProofIsolated(certificate);
  if (!runnerResult.ok) throw new Error(runnerResult.error?.message || "Isolated verification failed.");
  const report = runnerResult.result;

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.valid) {
    console.log(`verified: ${certificate.runId} ${certificate.status}`);
  } else {
    console.log(`not verified: ${certificate.runId || certPath}`);
    for (const mismatch of report.mismatches) console.log(`- ${mismatch}`);
  }

  if (!report.valid) {
    process.exitCode = 3;
  }
}

async function runnerCommand(runnerArgs) {
  const [{ createSaasStore }, { createJobQueue }, { createArtifactStore }, { runRunnerLoop }] =
    await Promise.all([
      import("../saas/factory.js"),
      import("../saas/queue.js"),
      import("../saas/artifacts.js"),
      import("../saas/runner-service.js")
    ]);
  const once = runnerArgs.includes("--once");
  const runnerId = readOption(runnerArgs, "--id") || process.env.PATCHPROOF_RUNNER_ID;
  const isolation = readOption(runnerArgs, "--isolation") || process.env.PATCHPROOF_RUNNER_ISOLATION;
  const store = createSaasStore();
  const queue = createJobQueue();
  const artifactStore = createArtifactStore();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const result = await runRunnerLoop({ store, queue, artifactStore, runnerId, isolation, once, signal: controller.signal });
  if (once) console.log(`runner processed ${result.processed} job(s)`);
  await store.close?.();
}

async function retentionCommand(retentionArgs) {
  const [{ createSaasStore }, { createArtifactStore }, { runRetention }] = await Promise.all([
    import("../saas/factory.js"),
    import("../saas/artifacts.js"),
    import("../saas/retention.js")
  ]);
  const dryRun = retentionArgs.includes("--dry-run");
  const jsonMode = retentionArgs.includes("--json");
  const store = createSaasStore();
  const artifactStore = createArtifactStore();
  const result = await runRetention({ store, artifactStore, dryRun });
  await store.close?.();
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `retention ${dryRun ? "planned" : "applied"}: sessions=${result.planned.sessions}, artifacts=${result.planned.artifacts}, auditEvents=${result.planned.auditEvents}, githubDeliveries=${result.planned.githubDeliveries}`
  );
}

async function reconcileCommand(reconcileArgs) {
  const { createSaasStore } = await import("../saas/factory.js");
  const dryRun = !reconcileArgs.includes("--apply");
  const jsonMode = reconcileArgs.includes("--json");
  const staleMinutes = Number(readOption(reconcileArgs, "--stale-minutes") || 30);
  const store = createSaasStore();
  const result = await store.reconcileStaleRuns({
    dryRun,
    staleAfterMs: Math.max(1, staleMinutes) * 60 * 1000
  });
  await store.close?.();
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `reconcile ${dryRun ? "planned" : "applied"}: stale=${result.staleRuns.length}, reconciled=${result.reconciled}`
  );
  if (dryRun && result.staleRuns.length) {
    console.log("next: rerun with --apply to mark stale runs failed");
  }
}

async function keygenCommand(keygenArgs) {
  const jsonMode = keygenArgs.includes("--json");
  const issuer = readOption(keygenArgs, "--issuer") || "patchproof";
  const keyId = readOption(keygenArgs, "--key-id") || new Date().toISOString().slice(0, 10);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const values = {
    PATCHPROOF_SECRET_KEY: randomBytes(48).toString("base64url"),
    PATCHPROOF_CERTIFICATE_PRIVATE_KEY_PEM: privateKeyPem,
    PATCHPROOF_CERTIFICATE_PUBLIC_KEY_PEM: publicKeyPem,
    PATCHPROOF_CERTIFICATE_ISSUER: issuer,
    PATCHPROOF_CERTIFICATE_KEY_ID: keyId
  };
  if (jsonMode) {
    console.log(JSON.stringify(values, null, 2));
    return;
  }
  console.log("# Add these to the API and runner environment. Rotate per your deployment policy.");
  for (const [key, value] of Object.entries(values)) {
    console.log(`${key}=${escapeEnvValue(value)}`);
  }
}

async function migrateCommand() {
  const { createSaasStore } = await import("../saas/factory.js");
  const store = createSaasStore({ driver: "postgres" });
  await store.load();
  const health = await store.health();
  console.log(JSON.stringify(health.migrations || health, null, 2));
  await store.close?.();
}

async function inputFromFile(filePath) {
  if (!filePath) throw new Error("--input requires a file path.");
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  return {
    language: raw.language || "javascript",
    functionName: raw.functionName || raw.target?.function || raw.repository?.function || "",
    source: raw.source,
    testsText: raw.testsText || JSON.stringify(raw.tests || [], null, 2),
    bugReport: raw.bugReport || "",
    preconditionText: raw.preconditionText || raw.precondition || "",
    mayChangeText: raw.mayChangeText || raw.mayChange || "",
    postconditionText: raw.postconditionText || raw.postcondition || "",
    limits: raw.limits
  };
}

async function appendServiceHealthChecks(checks) {
  if (process.env.DATABASE_URL || process.env.PATCHPROOF_STORE_DRIVER === "postgres") {
    let store;
    try {
      const { createSaasStore } = await import("../saas/factory.js");
      store = createSaasStore({ driver: "postgres" });
      const health = await store.health();
      addProductionCheck(checks, "Postgres health", health.ok ? "ok" : "error", health.ok ? "reachable" : "migrations pending");
    } catch (error) {
      addProductionCheck(checks, "Postgres health", "error", error.message);
    } finally {
      await closeQuietly(store);
    }
  }

  if (process.env.REDIS_URL || process.env.PATCHPROOF_REDIS_URL || process.env.PATCHPROOF_QUEUE_DRIVER === "redis") {
    let queue;
    try {
      const { createJobQueue } = await import("../saas/queue.js");
      queue = createJobQueue({ driver: "redis", url: process.env.REDIS_URL || process.env.PATCHPROOF_REDIS_URL });
      const health = await queue.health();
      addProductionCheck(checks, "Redis health", health.ok ? "ok" : "error", `depth=${health.depth}, inFlight=${health.inFlight}, dead=${health.dead}`);
    } catch (error) {
      addProductionCheck(checks, "Redis health", "error", error.message);
    } finally {
      await closeQuietly(queue);
    }
  }

  if (process.env.PATCHPROOF_S3_BUCKET || process.env.PATCHPROOF_ARTIFACT_DRIVER === "s3") {
    try {
      const { createArtifactStore } = await import("../saas/artifacts.js");
      const artifacts = createArtifactStore({ driver: "s3" });
      const health = await artifacts.health();
      addProductionCheck(checks, "S3/MinIO health", health.ok ? "ok" : "error", health.ok ? `bucket=${health.bucket}` : "not reachable");
    } catch (error) {
      addProductionCheck(checks, "S3/MinIO health", "error", error.message);
    }
  }
}

function certificateSigningCheck() {
  const privateKeyPem = normalizePem(process.env.PATCHPROOF_CERTIFICATE_PRIVATE_KEY_PEM);
  const publicKeyPem = normalizePem(process.env.PATCHPROOF_CERTIFICATE_PUBLIC_KEY_PEM);
  if (!privateKeyPem && !publicKeyPem) {
    return ["warn", "certificate issuer signing is disabled"];
  }
  if (!privateKeyPem || !publicKeyPem) {
    return ["error", "set both PATCHPROOF_CERTIFICATE_PRIVATE_KEY_PEM and PATCHPROOF_CERTIFICATE_PUBLIC_KEY_PEM"];
  }
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    const publicKey = createPublicKey(publicKeyPem);
    const payload = Buffer.from("patchproof certificate signing check", "utf8");
    const signature = sign(null, payload, privateKey);
    return verify(null, payload, publicKey, signature)
      ? ["ok", `issuer=${process.env.PATCHPROOF_CERTIFICATE_ISSUER || "patchproof"}, keyId=${process.env.PATCHPROOF_CERTIFICATE_KEY_ID || "default"}`]
      : ["error", "certificate key pair did not verify"];
  } catch (error) {
    return ["error", error.message];
  }
}

function addProductionCheck(checks, name, status, message) {
  checks.push({ name, status, message });
}

function dockerStartError(result) {
  return result.error?.message || (result.stderr || result.stdout || "docker command failed").trim();
}

function escapeEnvValue(value) {
  return String(value).replace(/\r?\n/g, "\\n");
}

function normalizePem(value) {
  return String(value || "").trim().replace(/\\n/g, "\n");
}

async function closeQuietly(service) {
  try {
    await service?.close?.();
  } catch {}
}

async function maybeAttachModelCandidates(input, { args, repoRoot, configPath, targetId } = {}) {
  const shouldLoadConfig = Boolean(targetId || repoRoot || configPath || args.includes("--model"));
  const configModel = shouldLoadConfig ? await loadConfigModel({ repoRoot, configPath }) : {};
  const explicit =
    args.includes("--model") ||
    Boolean(readOption(args, "--model-provider")) ||
    (configModel.provider && configModel.provider !== "disabled");
  if (!explicit) return input;
  const settings = await modelSettingsForRun({ args, repoRoot, configPath, targetId });
  if (settings.provider === "disabled") {
    throw new Error("Model candidate generation is disabled. Set --model-provider or configure model.provider in patchproof.yml.");
  }
  const { generateModelCandidates } = await import("../saas/model-providers.js");
  const generation = await generateModelCandidates({ settings, input });
  return {
    ...input,
    candidatePatches: [...(input.candidatePatches || []), ...generation.candidates],
    modelProvenance: generation.provenance,
    limits: {
      ...(input.limits || {}),
      maxCandidates: Math.min(
        Number(input.limits?.maxCandidates || 8),
        Math.max(generation.candidates.length, Number(input.limits?.maxCandidates || 8))
      )
    }
  };
}

async function modelSettingsForRun({ args, repoRoot, configPath, targetId }) {
  const configModel = (targetId || repoRoot || configPath || args.includes("--model"))
    ? await loadConfigModel({ repoRoot, configPath })
    : {};
  const provider =
    readOption(args, "--model-provider") ||
    process.env.PATCHPROOF_MODEL_PROVIDER ||
    configModel.provider ||
    "disabled";
  const baseUrl =
    readOption(args, "--model-base-url") ||
    process.env.PATCHPROOF_MODEL_BASE_URL ||
    envValue(configModel.endpointEnv) ||
    configModel.baseUrl ||
    configModel.endpoint ||
    "";
  const model =
    readOption(args, "--model-name") ||
    process.env.PATCHPROOF_MODEL_NAME ||
    configModel.model ||
    "";
  const apiKeyEnv = readOption(args, "--model-api-key-env") || configModel.apiKeyEnv || "PATCHPROOF_MODEL_API_KEY";
  return {
    ...configModel,
    provider,
    baseUrl,
    model,
    apiKey: process.env[apiKeyEnv] || process.env.PATCHPROOF_MODEL_API_KEY || "",
    maxCandidates: Number(readOption(args, "--model-candidates") || configModel.maxCandidates || 8),
    maxPromptChars: Number(readOption(args, "--model-max-prompt-chars") || configModel.maxPromptChars || 20000)
  };
}

async function loadConfigModel({ repoRoot, configPath }) {
  try {
    const { loadRepositoryConfig } = await import("../repository-adapter.js");
    const { config } = await loadRepositoryConfig({ repoRoot, configPath });
    return config.model || config.modelProvider || {};
  } catch {
    return {};
  }
}

function envValue(name) {
  return name ? process.env[name] || "" : "";
}

function inputForScenario(scenarioId) {
  const example = examples.find((item) => item.id === scenarioId);
  if (!example) {
    throw new Error(`Unknown scenario '${scenarioId}'. Run 'patchproof scenarios' to list examples.`);
  }
  return createInputFromExample(example);
}

function readOption(values, name) {
  const index = values.indexOf(name);
  if (index === -1) return null;
  return values[index + 1] || null;
}

function printHelp() {
  console.log(`PatchProof ${PATCHPROOF_VERSION}

Usage:
  patchproof serve [--port 4173] [--host 127.0.0.1]
  patchproof runner [--once] [--id runner_1] [--isolation docker|process]
  patchproof retention [--dry-run] [--json]
  patchproof reconcile [--stale-minutes 30] [--apply] [--json]
  patchproof keygen [--issuer patchproof] [--key-id 2026-rotation-1] [--json]
  patchproof migrate
  patchproof scenarios
  patchproof init [--repo .] [--config patchproof.yml] [--force] [--json]
  patchproof doctor [--repo .] [--config patchproof.yml] [--json]
  patchproof doctor --production [--skip-service-health] [--json]
  patchproof inspect [--repo .] [--config patchproof.yml] [--json]
  patchproof detect [--repo .] [--config patchproof.yml] [--run-tests] [--command "npm test"] [--json]
  patchproof targets [--repo .] [--config patchproof.yml] [--json]
  patchproof test [--repo .] [--config patchproof.yml] [--target <id>] [--command "npm test"] [--timeout-seconds 600] [--json]
  patchproof run --scenario <id> [--out certificate.json] [--json]
  patchproof run --input input.json [--out certificate.json] [--json]
  patchproof run --target <id> [--repo .] [--config patchproof.yml] [--out certificate.json] [--apply] [--verify-command] [--json]
  patchproof apply --certificate certificate.json --repo . --target <id> [--dry-run] [--json]
  patchproof verify <certificate.json> [--json]
  patchproof version

Model candidate options:
  --model
  --model-provider openai-compatible|azure-openai|local
  --model-base-url <url>
  --model-name <name>
  --model-api-key-env PATCHPROOF_MODEL_API_KEY
  --model-candidates <n>
  --model-max-prompt-chars <n>

Input file shape:
  {
    "language": "javascript | python",
    "source": "function ...",
    "tests": [{ "name": "...", "args": [], "expect": null }],
    "bugReport": "...",
    "precondition": "true",
    "mayChange": "false",
    "postcondition": "true"
  }
`);
}

function printInspectReport(report) {
  console.log(`Repository: ${report.repoRoot}`);
  if (report.git.available) {
    console.log(`Git: ${report.git.branch || "detached"} ${report.git.commit}${report.git.dirty ? " dirty" : ""}`);
  }
  console.log(`Package manager: ${report.packageManager || "unknown"}`);
  console.log(`Languages: ${report.languages.length ? report.languages.join(", ") : "none detected"}`);
  console.log(`Frameworks: ${report.frameworks.length ? report.frameworks.join(", ") : "none detected"}`);
  if (report.frameworkAdapters?.length) {
    console.log("Framework adapters:");
    for (const adapter of report.frameworkAdapters) {
      console.log(`- ${adapter.framework}: ${adapter.supported ? "supported" : "not supported"} (${adapter.testFiles.length} file(s))`);
    }
  }
  if (report.testCommands.length) {
    console.log("Test commands:");
    for (const item of report.testCommands) console.log(`- ${item.command}`);
  }
  console.log(`PatchProof config: ${report.patchproof.configured ? report.patchproof.config : "missing"}`);
  if (report.patchproof.error) console.log(`PatchProof config error: ${report.patchproof.error}`);
  if (report.patchproof.targets.length) {
    console.log("PatchProof targets:");
    for (const target of report.patchproof.targets) {
      console.log(`- ${target.id}: ${target.language} ${target.source} -> ${target.tests}`);
    }
  }
  if (report.suggestions.candidateSourceFiles.length) {
    console.log("Candidate source files:");
    for (const file of report.suggestions.candidateSourceFiles) console.log(`- ${file}`);
  }
  if (report.suggestions.candidatePatchProofTests.length) {
    console.log("PatchProof test files:");
    for (const file of report.suggestions.candidatePatchProofTests) console.log(`- ${file}`);
  }
  if (report.suggestions.candidateProjectTests.length) {
    console.log("Project test files:");
    for (const file of report.suggestions.candidateProjectTests) console.log(`- ${file}`);
  }
  if (report.suggestions.next.length) {
    console.log("Next:");
    for (const item of report.suggestions.next) console.log(`- ${item}`);
  }
}

function printDetectReport(report) {
  console.log(`Repository: ${report.repoRoot}`);
  console.log(`Detection summary: ${report.summary.totalFindings} finding(s), highest=${report.summary.highestSeverity}`);
  console.log(`Languages: ${report.summary.languages.length ? report.summary.languages.join(", ") : "none detected"}`);
  console.log(`Scanned source files: ${report.summary.scannedSourceFiles}/${report.summary.sourceFiles}`);
  const counts = report.summary.bySeverity;
  console.log(`Severity counts: critical=${counts.critical}, high=${counts.high}, medium=${counts.medium}, low=${counts.low}, info=${counts.info}`);
  if (report.projectTest) {
    console.log(`Project tests: ${report.projectTest.ok ? "passed" : "failed"} (${report.projectTest.command})`);
  }
  if (!report.findings.length) {
    console.log("No bug signals were detected.");
    return;
  }
  console.log("Findings:");
  for (const finding of report.findings) {
    const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "repository";
    console.log(`- [${finding.severity}] ${location} ${finding.title}`);
    console.log(`  ${finding.message}`);
    if (finding.evidence) console.log(`  evidence: ${singleLine(finding.evidence)}`);
    if (finding.suggestion) console.log(`  next: ${finding.suggestion}`);
  }
}

function singleLine(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= 220 ? text : `${text.slice(0, 217)}...`;
}
