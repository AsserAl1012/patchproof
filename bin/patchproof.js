#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PATCHPROOF_VERSION } from "../engine.js";
import {
  createInputFromExample,
  examples,
  runPatchProof,
  verifyCertificate
} from "../runtime.js";

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
  } else if (command === "targets") {
    await targetsCommand(args.slice(1));
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
  const modes = [scenarioId, inputPath, targetId].filter(Boolean);

  if (modes.length !== 1) {
    throw new Error("run requires exactly one of --scenario <id>, --input <file.json>, or --target <id>.");
  }
  if (applyPatch && !targetId) {
    throw new Error("--apply requires --target so PatchProof knows which source file to update.");
  }

  let input = scenarioId
    ? inputForScenario(scenarioId)
    : inputPath
      ? await inputFromFile(inputPath)
      : await inputFromRepositoryTarget({ repoRoot, configPath, targetId });
  input.executionMode = targetId ? "repository-adapter-cli" : "node-cli";
  input = await maybeAttachModelCandidates(input, { args: runArgs, repoRoot, configPath, targetId });
  const result = runPatchProof(input);
  const certificateJson = JSON.stringify(result.certificate, null, 2);
  let applyResult = null;

  if (applyPatch && result.certificate.status === "certified") {
    applyResult = await applyCertificatePatch({ repoRoot, configPath, targetId, certificate: result.certificate, dryRun });
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
    }
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
  const report = verifyCertificate(certificate);

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
  const result = await runRunnerLoop({ store, queue, artifactStore, runnerId, isolation, once });
  if (once) console.log(`runner processed ${result.processed} job(s)`);
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
    source: raw.source,
    testsText: raw.testsText || JSON.stringify(raw.tests || [], null, 2),
    bugReport: raw.bugReport || "",
    preconditionText: raw.preconditionText || raw.precondition || "",
    mayChangeText: raw.mayChangeText || raw.mayChange || "",
    postconditionText: raw.postconditionText || raw.postcondition || "",
    limits: raw.limits
  };
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
    maxCandidates: Number(readOption(args, "--model-candidates") || configModel.maxCandidates || 8)
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
  patchproof migrate
  patchproof scenarios
  patchproof init [--repo .] [--config patchproof.yml] [--force] [--json]
  patchproof doctor [--repo .] [--config patchproof.yml] [--json]
  patchproof inspect [--repo .] [--config patchproof.yml] [--json]
  patchproof targets [--repo .] [--config patchproof.yml] [--json]
  patchproof run --scenario <id> [--out certificate.json] [--json]
  patchproof run --input input.json [--out certificate.json] [--json]
  patchproof run --target <id> [--repo .] [--config patchproof.yml] [--out certificate.json] [--apply] [--json]
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
