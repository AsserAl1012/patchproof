#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  PATCHPROOF_VERSION,
  createInputFromExample,
  examples,
  runPatchProof,
  verifyCertificate
} from "../engine.js";

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
  const outPath = readOption(runArgs, "--out");

  if (!scenarioId && !inputPath) {
    throw new Error("run requires --scenario <id> or --input <file.json>.");
  }

  const input = scenarioId ? inputForScenario(scenarioId) : await inputFromFile(inputPath);
  input.executionMode = "node-cli";
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
  patchproof run --scenario <id> [--out certificate.json] [--json]
  patchproof run --input input.json [--out certificate.json] [--json]
  patchproof verify <certificate.json> [--json]
  patchproof version

Input file shape:
  {
    "source": "function ...",
    "tests": [{ "name": "...", "args": [], "expect": null }],
    "bugReport": "...",
    "precondition": "true",
    "mayChange": "false",
    "postcondition": "true"
  }
`);
}
