import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
