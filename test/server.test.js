import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatchProofServer } from "../server.js";
import { createInputFromExample, examples } from "../engine.js";

function startTestServer(options = {}) {
  const server = createPatchProofServer(options);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`
      });
    });
  });
}

test("serves app shell and security headers", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /PatchProof/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const csp = response.headers.get("content-security-policy");
    assert.match(csp, /worker-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
  } finally {
    server.close();
  }
});

test("serves health endpoint", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/healthz`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, service: "patchproof", version: "1.0.0" });
  } finally {
    server.close();
  }
});

test("blocks path traversal", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/..%2Fpackage.json`);
    assert.equal(response.status, 403);
  } finally {
    server.close();
  }
});

test("rejects unsupported methods", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/`, { method: "POST" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  } finally {
    server.close();
  }
});

test("hosted API certifies a scenario through isolated runner", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createInputFromExample(examples[0]))
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.result.certificate.status, "certified");
    assert.equal(body.result.certificate.schema, "patchproof.certificate.v2");
    assert.equal(body.result.certificate.target.execution, "isolated-node-permission-runner");
  } finally {
    server.close();
  }
});

test("hosted API accepts public input-file shape", async () => {
  const inputFile = JSON.parse(await readFile("examples/clamp-range.input.json", "utf8"));
  const { server, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inputFile)
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.result.certificate.status, "certified");
  } finally {
    server.close();
  }
});

test("hosted API rejects non-json requests", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello"
    });
    const body = await response.json();
    assert.equal(response.status, 415);
    assert.equal(body.ok, false);
  } finally {
    server.close();
  }
});

test("hosted API can be disabled", async () => {
  const { server, baseUrl } = await startTestServer({ enableApi: false });
  try {
    const response = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 404);
  } finally {
    server.close();
  }
});

test("quick run is disabled by default in production", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousQuickRun = process.env.PATCHPROOF_ENABLE_QUICK_RUN;
  const previousSecret = process.env.PATCHPROOF_SECRET_KEY;
  process.env.NODE_ENV = "production";
  process.env.PATCHPROOF_SECRET_KEY = "test-production-secret-key-with-enough-length";
  delete process.env.PATCHPROOF_ENABLE_QUICK_RUN;
  const { server, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createInputFromExample(examples[0]))
    });
    assert.equal(response.status, 404);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousQuickRun === undefined) delete process.env.PATCHPROOF_ENABLE_QUICK_RUN;
    else process.env.PATCHPROOF_ENABLE_QUICK_RUN = previousQuickRun;
    if (previousSecret === undefined) delete process.env.PATCHPROOF_SECRET_KEY;
    else process.env.PATCHPROOF_SECRET_KEY = previousSecret;
    server.close();
  }
});

test("hosted API rejects unsafe source in isolated runner", async () => {
  const input = createInputFromExample(examples[0]);
  input.source = `function clamp(value, min, max) { fetch("/x"); return value; }`;
  const { server, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error.message, /Unsafe source/);
    assert.equal(body.error.stack, undefined);
  } finally {
    server.close();
  }
});

test("local repository API inspects, detects, and loads configured targets", async () => {
  const repo = await mkdtemp(join(tmpdir(), "patchproof-server-repo-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "src", "clamp.js"), `function clamp(value, min, max) {
  if (value < min) return min;
  if (value > min) return max;
  return value;
}
`, "utf8");
  await writeFile(join(repo, "src", "cache.py"), `def remember(value, seen=[]):
    seen.append(value)
    return seen
`, "utf8");
  await writeFile(join(repo, "tests", "clamp.patchproof.json"), JSON.stringify([
    { name: "below min", args: [-5, 0, 10], expect: 0 },
    { name: "above max", args: [12, 0, 10], expect: 10 },
    { name: "in range", args: [6, 0, 10], expect: 6 }
  ], null, 2), "utf8");
  await writeFile(join(repo, "patchproof.yml"), `
version: 1
project:
  language: javascript
  allowedPaths:
    - src/**
    - tests/**
targets:
  clamp-range:
    source: src/clamp.js
    function: clamp
    tests: tests/clamp.patchproof.json
    bugReport: Upper guard compares value to min instead of max.
    precondition: args[1] <= args[2]
    mayChange: args[0] > args[1] && args[0] < args[2]
    postcondition: result === Math.min(Math.max(args[0], args[1]), args[2])
`, "utf8");

  const { server, baseUrl } = await startTestServer();
  try {
    const inspect = await fetch(`${baseUrl}/api/repository/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoRoot: repo })
    });
    const inspectBody = await inspect.json();
    assert.equal(inspect.status, 200);
    assert.equal(inspectBody.ok, true);
    assert.equal(inspectBody.report.patchproof.targets[0].id, "clamp-range");

    const detect = await fetch(`${baseUrl}/api/repository/detect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoRoot: repo })
    });
    const detectBody = await detect.json();
    assert.equal(detect.status, 200);
    assert.equal(detectBody.ok, true);
    assert.ok(detectBody.report.findings.some((finding) => finding.title === "Mutable default argument"));

    const target = await fetch(`${baseUrl}/api/repository/target`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoRoot: repo, targetId: "clamp-range" })
    });
    const targetBody = await target.json();
    assert.equal(target.status, 200);
    assert.equal(targetBody.input.repository.target, "clamp-range");
    assert.match(targetBody.input.source, /^function clamp/);

    const repair = await fetch(`${baseUrl}/api/repository/repair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoRoot: repo, dryRun: true })
    });
    const repairBody = await repair.json();
    assert.equal(repair.status, 200);
    assert.equal(repairBody.ok, true);
    assert.equal(repairBody.report.status, "preview");
    assert.ok(repairBody.report.changes.some((change) => change.file === "src/cache.py"));
  } finally {
    server.close();
  }
});

test("local model API validates setup and estimates prompt budget", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/api/model/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: {
          provider: "disabled",
          maxPromptChars: 20000
        },
        input: {
          language: "javascript",
          source: "function add(a, b) { return a + b; }",
          testsText: "[]"
        }
      })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.provider, "disabled");
    assert.ok(body.usage.promptChars > 0);
  } finally {
    server.close();
  }
});

test("local model API can generate candidate payloads through disabled provider", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/api/model/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: {
          provider: "disabled",
          maxPromptChars: 20000
        },
        input: {
          language: "javascript",
          source: "function add(a, b) { return a + b; }",
          testsText: "[]"
        }
      })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.provider, "disabled");
    assert.deepEqual(body.candidates, []);
    assert.ok(body.usage.promptChars > 0);
  } finally {
    server.close();
  }
});

test("local repository API can initialize a starter config", async () => {
  const repo = await mkdtemp(join(tmpdir(), "patchproof-server-init-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "package.json"), JSON.stringify({
    scripts: { test: "node --test" }
  }, null, 2), "utf8");
  await writeFile(join(repo, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");
  await writeFile(join(repo, "tests", "math.test.js"), "import test from 'node:test';\n", "utf8");

  const { server, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/api/repository/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoRoot: repo })
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.result.created, true);
    const config = await readFile(join(repo, "patchproof.yml"), "utf8");
    assert.match(config, /targets:/);
    assert.match(config, /testCommand: "npm test"|testCommand: "node --test"/);
  } finally {
    server.close();
  }
});

test("GitHub webhook fails closed when no signing secret is configured", async () => {
  const previous = process.env.PATCHPROOF_GITHUB_WEBHOOK_SECRET;
  delete process.env.PATCHPROOF_GITHUB_WEBHOOK_SECRET;
  const { server, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/api/integrations/github/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment: { body: "/patchproof verify" } })
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.match(body.error.message, /disabled until PATCHPROOF_GITHUB_WEBHOOK_SECRET/);
  } finally {
    if (previous === undefined) delete process.env.PATCHPROOF_GITHUB_WEBHOOK_SECRET;
    else process.env.PATCHPROOF_GITHUB_WEBHOOK_SECRET = previous;
    server.close();
  }
});
