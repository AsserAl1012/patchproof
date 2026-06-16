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
  } else if (command === "targets") {
    await targetsCommand(args.slice(1));
  } else if (command === "run") {
    await runCommand(args.slice(1));
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
  const modes = [scenarioId, inputPath, targetId].filter(Boolean);

  if (modes.length !== 1) {
    throw new Error("run requires exactly one of --scenario <id>, --input <file.json>, or --target <id>.");
  }

  const input = scenarioId
    ? inputForScenario(scenarioId)
    : inputPath
      ? await inputFromFile(inputPath)
      : await inputFromRepositoryTarget({ repoRoot, configPath, targetId });
  input.executionMode = targetId ? "repository-adapter-cli" : "node-cli";
  const result = runPatchProof(input);
  const certificateJson = JSON.stringify(result.certificate, null, 2);

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
  }

  if (result.certificate.status !== "certified") {
    process.exitCode = 2;
  }
}

async function inputFromRepositoryTarget(options) {
  const { createInputFromRepositoryTarget } = await import("../repository-adapter.js");
  return createInputFromRepositoryTarget(options);
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
  patchproof targets [--repo .] [--config patchproof.yml] [--json]
  patchproof run --scenario <id> [--out certificate.json] [--json]
  patchproof run --input input.json [--out certificate.json] [--json]
  patchproof run --target <id> [--repo .] [--config patchproof.yml] [--out certificate.json] [--json]
  patchproof verify <certificate.json> [--json]
  patchproof version

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
