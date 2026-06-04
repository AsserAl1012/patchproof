import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("html references production assets", async () => {
  const html = await readFile("index.html", "utf8");
  assert.match(html, /styles\.css/);
  assert.match(html, /app\.js/);
  assert.match(html, /applyPatchButton/);
  assert.match(html, /downloadCertButton/);
  assert.match(html, /exportRunsButton/);
  assert.match(html, /importCertInput/);
});

test("worker delegates to engine", async () => {
  const worker = await readFile("worker.js", "utf8");
  assert.match(worker, /runPatchProof/);
  assert.match(worker, /postMessage/);
});

test("app binds saved-run controls", async () => {
  const app = await readFile("app.js", "utf8");
  assert.match(app, /historyList: document\.querySelector\("#historyList"\)/);
  assert.match(app, /exportRunsButton/);
  assert.match(app, /importCertificate/);
});

test("public package assets exist", async () => {
  const action = await readFile("action.yml", "utf8");
  const inputExample = await readFile("examples/clamp-range.input.json", "utf8");
  const migration = await readFile("migrations/001_init.sql", "utf8");
  const productionMigration = await readFile("migrations/002_production_hardening.sql", "utf8");
  const chart = await readFile("helm/patchproof/Chart.yaml", "utf8");
  const runnerChart = await readFile("helm/patchproof/templates/runner-deployment.yaml", "utf8");
  const config = await readFile("patchproof.yml", "utf8");
  assert.match(action, /PatchProof Verify/);
  assert.match(inputExample, /clamp/);
  assert.match(migration, /CREATE TABLE organizations/);
  assert.match(productionMigration, /runner_heartbeats/);
  assert.match(chart, /name: patchproof/);
  assert.match(runnerChart, /patchproof-runner/);
  assert.match(config, /minEvidenceScore/);
});
