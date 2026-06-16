import test from "node:test";
import assert from "node:assert/strict";
import { createPatchProofServer } from "../server.js";
import { JsonSaasStore } from "../saas/store.js";
import { MemoryJobQueue } from "../saas/queue.js";
import { LocalArtifactStore } from "../saas/artifacts.js";
import { createInputFromExample, examples } from "../engine.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

async function startSaasServer() {
  const dir = await mkdtemp(join(tmpdir(), "patchproof-saas-"));
  const store = new JsonSaasStore({ path: join(dir, "store.json") });
  const queue = new MemoryJobQueue();
  const artifactStore = new LocalArtifactStore({ root: join(dir, "artifacts") });
  const server = createPatchProofServer({ store, queue, artifactStore, inlineRuns: true });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, store, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function waitForRun(baseUrl, runId, { token, orgId }) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const detail = await request(baseUrl, `/api/runs/${runId}`, { token, orgId });
    assert.equal(detail.response.status, 200);
    if (!["queued", "running"].includes(detail.json.run.status)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run ${runId} did not finish.`);
}

async function request(baseUrl, path, { method = "GET", token = "", cookie = "", orgId = "", body = null } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(orgId ? { "X-PatchProof-Org": orgId } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const json = text && response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text;
  return { response, json };
}

async function bootstrap(baseUrl) {
  const boot = await request(baseUrl, "/api/bootstrap", {
    method: "POST",
    body: {
      email: "owner@example.com",
      password: "correct horse battery staple",
      name: "Owner",
      orgName: "Acme"
    }
  });
  assert.equal(boot.response.status, 201);
  const login = await request(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { email: "owner@example.com", password: "correct horse battery staple", returnToken: true }
  });
  assert.equal(login.response.status, 200);
  return { token: login.json.token, orgId: login.json.orgs[0].id };
}

test("JSON sessions store token hashes instead of bearer tokens", async () => {
  const { server, store, baseUrl } = await startSaasServer();
  try {
    const { token } = await bootstrap(baseUrl);
    await store.load();
    assert.equal(store.state.sessions.length, 1);
    assert.equal(store.state.sessions[0].token, undefined);
    assert.equal(store.state.sessions[0].tokenHash.length, 64);
    assert.notEqual(store.state.sessions[0].tokenHash, token);
  } finally {
    server.close();
  }
});

test("browser sessions can authenticate with HttpOnly cookies", async () => {
  const { server, baseUrl } = await startSaasServer();
  try {
    await request(baseUrl, "/api/bootstrap", {
      method: "POST",
      body: {
        email: "owner@example.com",
        password: "correct horse battery staple",
        name: "Owner",
        orgName: "Acme"
      }
    });
    const login = await request(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "owner@example.com", password: "correct horse battery staple" }
    });
    const cookie = login.response.headers.get("set-cookie");
    assert.equal(login.response.status, 200);
    assert.match(cookie, /patchproof_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal(login.json.token, undefined);
    const sessionCookie = cookie.split(";")[0];
    const me = await request(baseUrl, "/api/me", { cookie: sessionCookie });
    assert.equal(me.response.status, 200);
    assert.equal(me.json.user.email, "owner@example.com");
    const logout = await request(baseUrl, "/api/auth/logout", { method: "POST", cookie: sessionCookie });
    assert.match(logout.response.headers.get("set-cookie"), /Max-Age=0/);
  } finally {
    server.close();
  }
});

test("JSON store migrates legacy raw session tokens on load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "patchproof-saas-legacy-"));
  const storePath = join(dir, "store.json");
  await writeFile(
    storePath,
    JSON.stringify({
      sessions: [
        {
          id: "ses_legacy",
          token: "legacy-token",
          userId: "usr_legacy",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      ],
      settings: {}
    }),
    "utf8"
  );
  const store = new JsonSaasStore({ path: storePath });
  await store.load();
  assert.equal(store.state.sessions[0].token, undefined);
  assert.equal(store.state.sessions[0].tokenHash.length, 64);
  const persisted = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(persisted.sessions[0].token, undefined);
  assert.equal(persisted.sessions[0].tokenHash.length, 64);
});

test("SaaS flow bootstraps, creates project, creates run, and reads artifacts", async () => {
  const { server, baseUrl } = await startSaasServer();
  try {
    const { token, orgId } = await bootstrap(baseUrl);
    const projectRes = await request(baseUrl, "/api/projects", {
      method: "POST",
      token,
      orgId,
      body: { name: "Demo Repo", repoUrl: "https://github.example/acme/demo" }
    });
    assert.equal(projectRes.response.status, 201);
    const project = projectRes.json.project;

    const runRes = await request(baseUrl, `/api/projects/${project.id}/runs`, {
      method: "POST",
      token,
      orgId,
      body: { input: createInputFromExample(examples[0]), trigger: "manual" }
    });
    assert.equal(runRes.response.status, 202, JSON.stringify(runRes.json));
    assert.equal(runRes.json.run.status, "queued");

    const finished = await waitForRun(baseUrl, runRes.json.run.id, { token, orgId });
    assert.equal(finished.json.run.status, "certified");
    assert.equal(finished.json.certificate.certificate.status, "certified");

    const runList = await request(baseUrl, `/api/projects/${project.id}/runs`, { token, orgId });
    assert.equal(runList.response.status, 200);
    assert.equal(runList.json.runs.length, 1);

    const detail = await request(baseUrl, `/api/runs/${runRes.json.run.id}`, { token, orgId });
    assert.equal(detail.response.status, 200);
    assert.equal(detail.json.run.id, runRes.json.run.id);
    assert.equal(detail.json.certificate.certificate.status, "certified");

    const cert = await request(baseUrl, `/api/runs/${runRes.json.run.id}/certificate`, { token, orgId });
    assert.equal(cert.response.status, 200);
    assert.equal(cert.json.certificate.status, "certified");

    const logs = await request(baseUrl, `/api/runs/${runRes.json.run.id}/logs`, { token, orgId });
    assert.equal(logs.response.status, 200);
    assert.ok(Array.isArray(logs.json.logs));

    const audit = await request(baseUrl, "/api/audit-events", { token, orgId });
    assert.equal(audit.response.status, 200);
    assert.ok(audit.json.auditEvents.some((event) => event.action === "run.completed"));
  } finally {
    server.close();
  }
});

test("SaaS runner uses configured model provider candidates", async () => {
  const modelServer = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                candidates: [
                  {
                    title: "Add the missing increment",
                    rationale: "The function should return one more than its input.",
                    source: "function increment(value) { return value + 1; }"
                  }
                ]
              })
            }
          }
        ]
      })
    );
  });
  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelPort = modelServer.address().port;
  const { server, baseUrl } = await startSaasServer();
  try {
    const { token, orgId } = await bootstrap(baseUrl);
    const settings = await request(baseUrl, "/api/admin/settings", {
      method: "PATCH",
      token,
      orgId,
      body: {
        modelProvider: {
          provider: "local",
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          model: "local-repair-model",
          maxCandidates: 2
        }
      }
    });
    assert.equal(settings.response.status, 200);

    const projectRes = await request(baseUrl, "/api/projects", {
      method: "POST",
      token,
      orgId,
      body: { name: "Model Project", config: { repair: { minEvidenceScore: 0.75 } } }
    });
    const runRes = await request(baseUrl, `/api/projects/${projectRes.json.project.id}/runs`, {
      method: "POST",
      token,
      orgId,
      body: {
        input: {
          source: "function increment(value) { return value; }",
          tests: [
            { name: "zero", args: [0], expect: 1 },
            { name: "four", args: [4], expect: 5 }
          ],
          bugReport: "increment should add one",
          precondition: "Number.isFinite(args[0])",
          mayChange: "true",
          postcondition: "result === args[0] + 1"
        }
      }
    });
    const finished = await waitForRun(baseUrl, runRes.json.run.id, { token, orgId });
    assert.equal(finished.json.run.status, "certified");
    assert.equal(finished.json.certificate.certificate.selectedPatch.generator, "local");
    assert.equal(finished.json.certificate.certificate.repair.suppliedCandidates, 1);
  } finally {
    server.close();
    modelServer.close();
  }
});

test("SaaS admin endpoints expose settings, runners, readiness, and metrics", async () => {
  const { server, baseUrl } = await startSaasServer();
  try {
    const { token, orgId } = await bootstrap(baseUrl);
    const settings = await request(baseUrl, "/api/admin/settings", { token, orgId });
    assert.equal(settings.response.status, 200);
    assert.equal(settings.json.settings.runner.network, "disabled");

    const patched = await request(baseUrl, "/api/admin/settings", {
      method: "PATCH",
      token,
      orgId,
      body: { runner: { memoryMb: 1024 }, modelProvider: { provider: "disabled" } }
    });
    assert.equal(patched.response.status, 200);
    assert.equal(patched.json.settings.runner.memoryMb, 1024);

    const runners = await request(baseUrl, "/api/admin/runners", { token, orgId });
    assert.equal(runners.response.status, 200);
    assert.equal(runners.json.runners[0].status, "online");

    const ready = await fetch(`${baseUrl}/readyz`);
    assert.equal(ready.status, 200);

    const metrics = await fetch(`${baseUrl}/metrics`);
    const text = await metrics.text();
    assert.equal(metrics.status, 200);
    assert.match(text, /patchproof_runs_total/);
  } finally {
    server.close();
  }
});

test("SaaS APIs require auth and reject cross-org access", async () => {
  const { server, baseUrl } = await startSaasServer();
  try {
    const unauth = await request(baseUrl, "/api/projects");
    assert.equal(unauth.response.status, 401);

    const { token, orgId } = await bootstrap(baseUrl);
    const secondOrg = await request(baseUrl, "/api/orgs", {
      method: "POST",
      token,
      body: { name: "Second" }
    });
    assert.equal(secondOrg.response.status, 201);

    const project = await request(baseUrl, "/api/projects", {
      method: "POST",
      token,
      orgId,
      body: { name: "Private" }
    });
    const wrongOrgRead = await request(baseUrl, `/api/projects/${project.json.project.id}`, {
      token,
      orgId: secondOrg.json.org.id
    });
    assert.equal(wrongOrgRead.response.status, 404);
  } finally {
    server.close();
  }
});

test("API keys can create runs but cannot change admin settings", async () => {
  const { server, baseUrl } = await startSaasServer();
  try {
    const { token, orgId } = await bootstrap(baseUrl);
    const projectRes = await request(baseUrl, "/api/projects", {
      method: "POST",
      token,
      orgId,
      body: { name: "API Project" }
    });
    assert.equal(projectRes.response.status, 201);
    const keyRes = await request(baseUrl, "/api/admin/api-keys", {
      method: "POST",
      token,
      orgId,
      body: { name: "CI", role: "developer" }
    });
    assert.equal(keyRes.response.status, 201);
    assert.match(keyRes.json.token, /^ppk_/);

    const forbiddenSettings = await request(baseUrl, "/api/admin/settings", {
      token: keyRes.json.token,
      orgId
    });
    assert.equal(forbiddenSettings.response.status, 403);

    const runRes = await request(baseUrl, `/api/projects/${projectRes.json.project.id}/runs`, {
      method: "POST",
      token: keyRes.json.token,
      orgId,
      body: { input: createInputFromExample(examples[0]), trigger: "api-key" }
    });
    assert.equal(runRes.response.status, 202);
    const finished = await waitForRun(baseUrl, runRes.json.run.id, { token, orgId });
    assert.equal(finished.json.run.status, "certified");
  } finally {
    server.close();
  }
});
