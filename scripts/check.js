import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const nodeFiles = [
  "engine.js",
  "runtime.js",
  "repository-adapter.js",
  "app.js",
  "worker.js",
  "server.js",
  "bin/patchproof.js",
  "saas/store.js",
  "saas/postgres-store.js",
  "saas/factory.js",
  "saas/migrations.js",
  "saas/artifacts.js",
  "saas/queue.js",
  "saas/retention.js",
  "saas/runner-service.js",
  "saas/secrets.js",
  "saas/rbac.js",
  "saas/config.js",
  "saas/model-providers.js",
  "saas/runner-policy.js",
  "saas/github.js",
  "saas/github-app.js",
  "sandbox/hosted-runner.js",
  "sandbox/runner-child.js",
  "sandbox/docker-runner.js",
  "scripts/check.js",
  "scripts/integration-services.js",
  "scripts/smoke.js",
  "scripts/verify-release.js"
];

for (const file of nodeFiles) {
  run(process.execPath, ["--check", file], `node --check ${file}`);
}

const python = process.env.PATCHPROOF_PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
const pythonCheck = `
import ast
import pathlib
for path in ("sandbox/python-runner.py", "sandbox/pytest-extractor.py"):
    ast.parse(pathlib.Path(path).read_text(encoding="utf-8"))
`;
run(python, ["-I", "-S", "-c", pythonCheck], "python AST check");

for (const workflow of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
  if (!readFileSync(workflow, "utf8").trim()) {
    throw new Error(`${workflow} is empty.`);
  }
}

function run(command, args, label) {
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true });
  if (result.error) {
    console.error(`${label} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${label} failed with exit code ${result.status}.`);
    process.exit(result.status || 1);
  }
}
