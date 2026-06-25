import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

test("html references production assets", async () => {
  const html = await readFile("index.html", "utf8");
  assert.match(html, /styles\.css/);
  assert.match(html, /app\.js/);
  assert.match(html, /applyPatchButton/);
  assert.match(html, /downloadCertButton/);
  assert.match(html, /exportRunsButton/);
  assert.match(html, /importCertInput/);
  assert.match(html, /design-examples\.html/);
  assert.match(html, /Private Workspace/);
  assert.match(html, /Admin actions/);
});

test("browser worker execution is disabled", async () => {
  const worker = await readFile("worker.js", "utf8");
  assert.doesNotMatch(worker, /runPatchProof/);
  assert.match(worker, /disabled/);
  assert.match(worker, /postMessage/);
});

test("app binds saved-run controls", async () => {
  const app = await readFile("app.js", "utf8");
  assert.match(app, /historyList: document\.querySelector\("#historyList"\)/);
  assert.match(app, /exportRunsButton/);
  assert.match(app, /importCertificate/);
  assert.match(app, /loadInvitations/);
  assert.match(app, /createPasswordReset/);
  assert.match(app, /repoInspectButton/);
  assert.match(app, /initializeLocalRepository/);
  assert.match(app, /detectLocalRepository/);
  assert.match(app, /repoInstallInput/);
  assert.match(app, /repoBuildInput/);
  assert.match(app, /repoExportJsonButton/);
  assert.match(app, /exportRepositorySarif/);
  assert.match(app, /copyRepositorySuppression/);
  assert.match(app, /writeClipboardText/);
});

test("browser app module graph does not import Node-only modules", async () => {
  const graph = await collectBrowserImports("app.js");
  assert.ok(graph.has("examples.js"));
  assert.ok(graph.has("python-examples.js"));
  assert.ok(!graph.has("engine.js"));
  for (const file of graph) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /from\s+["']node:/, `${file} imports a Node built-in`);
    assert.doesNotMatch(source, /import\s+["']node:/, `${file} imports a Node built-in`);
  }
});

test("design examples page offers product layout directions", async () => {
  const examples = await readFile("design-examples.html", "utf8");
  assert.match(examples, /Operator Console/);
  assert.match(examples, /Solo Developer Flow/);
  assert.match(examples, /Certificate Review/);
  assert.match(examples, /Back to app/);
});

test("public package assets exist", async () => {
  const action = await readFile("action.yml", "utf8");
  const inputExample = await readFile("examples/clamp-range.input.json", "utf8");
  const pythonExample = await readFile("examples/python-clamp-range.input.json", "utf8");
  const migration = await readFile("migrations/001_init.sql", "utf8");
  const productionMigration = await readFile("migrations/002_production_hardening.sql", "utf8");
  const chart = await readFile("helm/patchproof/Chart.yaml", "utf8");
  const runnerChart = await readFile("helm/patchproof/templates/runner-deployment.yaml", "utf8");
  const config = await readFile("patchproof.yml", "utf8");
  const packageJson = await readFile("package.json", "utf8");
  assert.match(action, /PatchProof Verify/);
  assert.match(inputExample, /clamp/);
  assert.match(pythonExample, /"language": "python"/);
  assert.match(migration, /CREATE TABLE organizations/);
  assert.match(productionMigration, /runner_heartbeats/);
  assert.match(chart, /name: patchproof/);
  assert.match(runnerChart, /patchproof-runner/);
  assert.match(config, /minEvidenceScore/);
  assert.match(packageJson, /design-examples\.html/);
  assert.match(packageJson, /examples\.js/);
});

async function collectBrowserImports(entry, graph = new Set()) {
  const file = normalize(entry).split("\\").join("/");
  if (graph.has(file)) return graph;
  graph.add(file);
  const source = await readFile(file, "utf8");
  const imports = [...source.matchAll(/import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith("."));
  for (const specifier of imports) {
    const child = normalize(join(dirname(file), specifier)).split("\\").join("/");
    await collectBrowserImports(child, graph);
  }
  return graph;
}
