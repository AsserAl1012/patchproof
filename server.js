import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { PATCHPROOF_VERSION } from "./engine.js";
import { runPatchProofIsolated } from "./sandbox/hosted-runner.js";
import { createSaasStore } from "./saas/factory.js";
import { createJobQueue } from "./saas/queue.js";
import { createArtifactStore } from "./saas/artifacts.js";
import { processQueuedJob } from "./saas/runner-service.js";
import { requirePermission } from "./saas/rbac.js";
import { buildRunnerPolicy } from "./saas/runner-policy.js";
import { parsePatchproofConfig } from "./saas/config.js";
import { parsePatchProofCommand, verifyGitHubSignature } from "./saas/github.js";
import {
  buildQueuedComment,
  createPatchPullRequest,
  githubRepoFromWebhook,
  isRepositoryAllowed,
  postGitHubComment
} from "./saas/github-app.js";
import { assertProductionSecretConfiguration, maskSettingsSecrets } from "./saas/secrets.js";
import { runRetention } from "./saas/retention.js";
import { resolveQueuedRunInput } from "./saas/run-input.js";

const root = resolve(process.cwd());
const requestedPort = Number.parseInt(process.env.PORT || "4173", 10);
const requestedHost = process.env.HOST || "127.0.0.1";
const MAX_API_BODY_BYTES = 64 * 1024;
const SESSION_COOKIE_NAME = "patchproof_session";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": contentSecurityPolicy(),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

const apiHeaders = {
  ...securityHeaders,
  "Content-Type": "application/json; charset=utf-8"
};

function createRateLimiter(options = {}) {
  const capacity = options.capacity || 12;
  const refillPerMinute = options.refillPerMinute || 12;
  const buckets = new Map();

  return function rateLimit(key) {
    const now = Date.now();
    const existing = buckets.get(key) || { tokens: capacity, updatedAt: now };
    const elapsedMinutes = (now - existing.updatedAt) / 60000;
    existing.tokens = Math.min(capacity, existing.tokens + elapsedMinutes * refillPerMinute);
    existing.updatedAt = now;
    if (existing.tokens < 1) {
      buckets.set(key, existing);
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(((1 - existing.tokens) / refillPerMinute) * 60)
      };
    }
    existing.tokens -= 1;
    buckets.set(key, existing);
    return { allowed: true, retryAfterSeconds: 0 };
  };
}

function safePath(urlPath, webRoot = root) {
  const clean = urlPath === "/" ? "/index.html" : urlPath;
  let decoded;
  try {
    decoded = decodeURIComponent(clean.split("?")[0]);
  } catch {
    return null;
  }
  const resolved = resolve(webRoot, `.${decoded}`);
  const rel = relative(webRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  if (rel.split(sep).some((part) => part.startsWith(".") && part !== ".")) return null;
  return resolved;
}

export function createPatchProofServer(options = {}) {
  assertProductionSecretConfiguration();
  const webRoot = resolve(options.root || root);
  const enableApi = options.enableApi !== false;
  const enableQuickRun = options.enableQuickRun ?? (
    process.env.PATCHPROOF_ENABLE_QUICK_RUN === "true" ||
    process.env.NODE_ENV !== "production"
  );
  const rateLimit = createRateLimiter(options.rateLimit);
  const authRateLimit = createRateLimiter({ capacity: 10, refillPerMinute: 5 });
  const store = createSaasStore(options);
  const queue = options.queue || createJobQueue(options.queueOptions);
  const artifactStore = options.artifactStore || createArtifactStore(options.artifactOptions);
  const inlineRuns =
    options.inlineRuns ??
    (queue.driver === "memory" && process.env.PATCHPROOF_RUN_MODE !== "queue");
  const server = createServer(async (req, res) => {
    const requestId = req.headers["x-request-id"] || randomUUID();
    req.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);
    const startedAt = Date.now();
    res.on("finish", () => logAccess({ req, res, startedAt }));
    const requestPath = (req.url || "").split("?")[0];
    const apiPath = normalizeApiPath(requestPath);

    if (["/api/openapi.json", "/api/v1/openapi.json"].includes(requestPath)) {
      writeJson(res, 200, buildOpenApiDocument(req));
      return;
    }

    if (isQuickApiPath(apiPath)) {
      try {
        await handleQuickApi({ req, res, apiPath, enableApi, enableQuickRun, rateLimit });
      } catch (error) {
        writeJson(res, error.statusCode || 400, {
          ok: false,
          error: { message: error.message }
        });
      }
      return;
    }

    if (apiPath.startsWith("/api/")) {
      if ([
        "/api/bootstrap",
        "/api/auth/login",
        "/api/invitations/accept",
        "/api/auth/password-reset/complete"
      ].includes(apiPath) && req.method === "POST") {
        const rate = authRateLimit(`${req.socket.remoteAddress || "unknown"}:${apiPath}`);
        if (!rate.allowed) {
          res.writeHead(429, { ...apiHeaders, "Retry-After": String(rate.retryAfterSeconds) });
          res.end(JSON.stringify({ ok: false, error: { message: "Rate limit exceeded." } }));
          return;
        }
      }
      try {
        await handleSaasApi({ req, res, requestPath: apiPath, store, queue, artifactStore, inlineRuns, enableApi });
      } catch (error) {
        writeJson(res, error.statusCode || 500, {
          ok: false,
          error: { message: error.message || "Unexpected API error." }
        });
      }
      return;
    }

    if (!["GET", "HEAD"].includes(req.method || "")) {
      res.writeHead(405, { ...securityHeaders, Allow: "GET, HEAD" });
      res.end();
      return;
    }

    if (requestPath === "/healthz") {
      const body = JSON.stringify({ ok: true, service: "patchproof", version: PATCHPROOF_VERSION });
      res.writeHead(200, {
        ...securityHeaders,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body)
      });
      if (req.method !== "HEAD") res.end(body);
      else res.end();
      return;
    }

    if (requestPath === "/readyz") {
      const readiness = await checkReadiness({ store, queue, artifactStore });
      const body = JSON.stringify(readiness);
      res.writeHead(readiness.ok ? 200 : 503, {
        ...securityHeaders,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body)
      });
      if (req.method !== "HEAD") res.end(body);
      else res.end();
      return;
    }

    if (requestPath === "/metrics") {
      await store.load();
      const metrics = await store.metrics();
      const queueHealth = await queue.health().catch((error) => ({ ok: false, error: error.message }));
      const body = renderPrometheusMetrics(metrics, queueHealth);
      res.writeHead(200, {
        ...securityHeaders,
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(body)
      });
      if (req.method !== "HEAD") res.end(body);
      else res.end();
      return;
    }

    const file = safePath(req.url || "/", webRoot);
    if (!file) {
      res.writeHead(403, securityHeaders);
      res.end("Forbidden");
      return;
    }

    try {
      const body = await readFile(file);
      res.writeHead(200, {
        ...securityHeaders,
        "Content-Type": mime[extname(file)] || "application/octet-stream",
        "Content-Length": body.length
      });
      if (req.method !== "HEAD") res.end(body);
      else res.end();
    } catch {
      res.writeHead(404, { ...securityHeaders, "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  });
  return server;
}

function isQuickApiPath(apiPath) {
  return [
    "/api/run",
    "/api/model/check",
    "/api/model/generate",
    "/api/repository/inspect",
    "/api/repository/init",
    "/api/repository/detect",
    "/api/repository/repair",
    "/api/repository/target"
  ].includes(apiPath);
}

async function handleQuickApi({ req, res, apiPath, enableApi, enableQuickRun, rateLimit }) {
  if (!enableApi || !enableQuickRun) {
    writeJson(res, 404, { ok: false, error: { message: "API is disabled." } });
    return;
  }
  if (apiPath.startsWith("/api/repository/") && !isLoopbackRequest(req) && process.env.PATCHPROOF_ENABLE_LOCAL_REPO_API !== "true") {
    writeJson(res, 403, {
      ok: false,
      error: {
        message: "Local repository APIs are restricted to loopback clients unless PATCHPROOF_ENABLE_LOCAL_REPO_API=true."
      }
    });
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { ...apiHeaders, Allow: "POST" });
    res.end(JSON.stringify({ ok: false, error: { message: "Method not allowed." } }));
    return;
  }
  const key = `${req.socket.remoteAddress || "unknown"}:${apiPath}`;
  const rate = rateLimit(key);
  if (!rate.allowed) {
    res.writeHead(429, {
      ...apiHeaders,
      "Retry-After": String(rate.retryAfterSeconds)
    });
    res.end(JSON.stringify({ ok: false, error: { message: "Rate limit exceeded." } }));
    return;
  }
  const contentType = req.headers["content-type"] || "";
  if (!String(contentType).includes("application/json")) {
    writeJson(res, 415, { ok: false, error: { message: "Content-Type must be application/json." } });
    return;
  }

  const payload = await readJsonBody(req, MAX_API_BODY_BYTES);
  if (apiPath === "/api/run") {
    const result = await runPatchProofIsolated(payload);
    writeJson(res, result.statusCode || (result.ok ? 200 : 400), result);
    return;
  }
  if (apiPath === "/api/model/check") {
    const { estimateModelUsage, normalizeModelProvider } = await import("./saas/model-providers.js");
    const settings = payload.settings || payload.model || payload;
    const normalized = normalizeModelProvider(settings);
    const usage = estimateModelUsage({
      settings: normalized,
      input: payload.input || {}
    });
    const apiKeyEnv = String(settings.apiKeyEnv || "PATCHPROOF_MODEL_API_KEY");
    const apiKeyConfigured = Boolean(settings.apiKey || process.env[apiKeyEnv] || process.env.PATCHPROOF_MODEL_API_KEY);
    const checks = [
      { name: "provider", status: normalized.provider === "disabled" ? "warning" : "ok", message: normalized.provider },
      { name: "model", status: normalized.provider === "disabled" || normalized.model ? "ok" : "error", message: normalized.model || "missing" },
      { name: "baseUrl", status: normalized.provider === "disabled" || normalized.baseUrl ? "ok" : "error", message: normalized.baseUrl || "missing" },
      {
        name: "apiKey",
        status: ["disabled", "local"].includes(normalized.provider) || apiKeyConfigured ? "ok" : "error",
        message: ["disabled", "local"].includes(normalized.provider) ? "not required" : apiKeyConfigured ? `configured through ${apiKeyEnv}` : `${apiKeyEnv} not set`
      },
      {
        name: "promptBudget",
        status: usage.promptChars <= usage.maxPromptChars ? "ok" : "error",
        message: `${usage.promptChars}/${usage.maxPromptChars} chars, approx ${usage.estimatedPromptTokens} tokens`
      }
    ];
    writeJson(res, 200, {
      ok: !checks.some((check) => check.status === "error"),
      provider: normalized.provider,
      model: normalized.model,
      baseUrl: normalized.baseUrl,
      usage,
      checks
    });
    return;
  }
  if (apiPath === "/api/model/generate") {
    const { generateModelCandidates } = await import("./saas/model-providers.js");
    const settings = payload.settings || payload.model || {};
    const apiKeyEnv = String(settings.apiKeyEnv || "PATCHPROOF_MODEL_API_KEY");
    const result = await generateModelCandidates({
      settings: {
        ...settings,
        apiKey: settings.apiKey || process.env[apiKeyEnv] || process.env.PATCHPROOF_MODEL_API_KEY || ""
      },
      input: payload.input || {}
    });
    writeJson(res, 200, {
      ok: true,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      provenance: result.provenance,
      candidates: result.candidates
    });
    return;
  }

  const repoOptions = repositoryRequestOptions(payload);
  if (apiPath === "/api/repository/inspect") {
    const { inspectRepository } = await import("./repository-adapter.js");
    writeJson(res, 200, { ok: true, report: await inspectRepository(repoOptions) });
    return;
  }
  if (apiPath === "/api/repository/init") {
    const { initializeRepositoryConfig } = await import("./repository-adapter.js");
    const result = await initializeRepositoryConfig({
      ...repoOptions,
      force: Boolean(payload.force)
    });
    writeJson(res, result.created ? 201 : 200, { ok: true, result });
    return;
  }
  if (apiPath === "/api/repository/detect") {
    const { detectRepositoryBugs, repositoryDetectionToSarif } = await import("./repository-adapter.js");
    const report = await detectRepositoryBugs({
      ...repoOptions,
      runTests: Boolean(payload.runTests),
      install: Boolean(payload.install),
      installCommand: payload.installCommand || undefined,
      build: Boolean(payload.build),
      buildCommand: payload.buildCommand || undefined,
      command: payload.command || undefined,
      timeoutSeconds: payload.timeoutSeconds ? Number(payload.timeoutSeconds) : undefined,
      maxFiles: payload.maxFiles ? Number(payload.maxFiles) : undefined,
      maxScanFiles: payload.maxScanFiles ? Number(payload.maxScanFiles) : undefined,
      suppressions: Array.isArray(payload.suppressions) ? payload.suppressions : undefined,
      suppressionsPath: payload.suppressionsPath || undefined
    });
    writeJson(res, 200, {
      ok: true,
      report,
      ...(payload.format === "sarif" ? { sarif: repositoryDetectionToSarif(report) } : {})
    });
    return;
  }
  if (apiPath === "/api/repository/repair") {
    const { repairRepository } = await import("./repository-adapter.js");
    const report = await repairRepository({
      ...repoOptions,
      apply: Boolean(payload.apply),
      dryRun: !payload.apply || Boolean(payload.dryRun),
      runTests: Boolean(payload.runTests),
      install: Boolean(payload.install),
      installCommand: payload.installCommand || undefined,
      build: Boolean(payload.build),
      buildCommand: payload.buildCommand || undefined,
      command: payload.command || undefined,
      timeoutSeconds: payload.timeoutSeconds ? Number(payload.timeoutSeconds) : undefined,
      maxFiles: payload.maxFiles ? Number(payload.maxFiles) : undefined,
      maxScanFiles: payload.maxScanFiles ? Number(payload.maxScanFiles) : undefined,
      maxRepairs: payload.maxRepairs ? Number(payload.maxRepairs) : undefined,
      fingerprints: Array.isArray(payload.fingerprints) ? payload.fingerprints : undefined,
      categories: Array.isArray(payload.categories) ? payload.categories : undefined,
      files: Array.isArray(payload.files) ? payload.files : undefined,
      suppressions: Array.isArray(payload.suppressions) ? payload.suppressions : undefined,
      suppressionsPath: payload.suppressionsPath || undefined,
      revertOnFailure: payload.revertOnFailure !== false
    });
    writeJson(res, 200, { ok: true, report });
    return;
  }
  if (apiPath === "/api/repository/target") {
    const targetId = String(payload.targetId || "").trim();
    if (!targetId) throw badRequest("targetId is required.");
    const { createInputFromRepositoryTarget } = await import("./repository-adapter.js");
    writeJson(res, 200, { ok: true, input: await createInputFromRepositoryTarget({ ...repoOptions, targetId }) });
    return;
  }

  throw notFound("API route");
}

function isLoopbackRequest(req) {
  const remote = String(req.socket?.remoteAddress || "")
    .replace(/^::ffff:/, "")
    .replace(/^\[|\]$/g, "");
  return remote === "127.0.0.1" || remote === "::1" || remote === "localhost";
}

function repositoryRequestOptions(payload = {}) {
  return {
    repoRoot: payload.repoRoot || payload.root || process.cwd(),
    configPath: payload.configPath || "patchproof.yml"
  };
}

async function handleSaasApi({ req, res, requestPath, store, queue, artifactStore, inlineRuns, enableApi }) {
  if (!enableApi) {
    writeJson(res, 404, { ok: false, error: { message: "API is disabled." } });
    return;
  }
  const method = req.method || "GET";
  const token = getRequestToken(req);
  const needsBody = ["POST", "PATCH", "PUT"].includes(method);
  const readBody = needsBody ? await readJsonBody(req, MAX_API_BODY_BYTES, { includeRaw: true }) : { json: {}, raw: "" };
  const body = readBody.json;

  if (requestPath === "/api/bootstrap" && method === "POST") {
    const alreadyBootstrapped = await store.hasUsers();
    if (alreadyBootstrapped) {
      writeJson(res, 409, { ok: false, error: { message: "Bootstrap is already complete." } });
      return;
    }
    const boot = await store.bootstrap(body);
    writeJson(res, 201, { ok: true, ...authResponse(boot, body) }, {
      "Set-Cookie": sessionCookie(boot.token, req)
    });
    return;
  }

  if (requestPath === "/api/auth/login" && method === "POST") {
    const login = await store.login(body);
    writeJson(res, 200, { ok: true, ...authResponse(login, body) }, {
      "Set-Cookie": sessionCookie(login.token, req)
    });
    return;
  }

  if (requestPath === "/api/auth/logout" && method === "POST") {
    await store.logout(token);
    writeJson(res, 200, { ok: true }, {
      "Set-Cookie": clearSessionCookie(req)
    });
    return;
  }

  if (requestPath === "/api/invitations/accept" && method === "POST") {
    const accepted = await store.acceptInvitation(body);
    writeJson(res, 200, { ok: true, ...authResponse(accepted, body) }, {
      "Set-Cookie": sessionCookie(accepted.token, req)
    });
    return;
  }

  if (requestPath === "/api/auth/password-reset/complete" && method === "POST") {
    writeJson(res, 200, { ok: true, ...(await store.resetPassword(body)) }, {
      "Set-Cookie": clearSessionCookie(req)
    });
    return;
  }

  if (requestPath === "/api/integrations/github/webhook" && method === "POST") {
    const secret = process.env.PATCHPROOF_GITHUB_WEBHOOK_SECRET || "";
    if (!secret) {
      writeJson(res, 503, {
        ok: false,
        error: { message: "GitHub webhook handling is disabled until PATCHPROOF_GITHUB_WEBHOOK_SECRET is set." }
      });
      return;
    }
    const rawBody = readBody.raw;
    const verified = verifyGitHubSignature({ secret, body: rawBody, signature256: req.headers["x-hub-signature-256"] });
    const command = parsePatchProofCommand(body.comment?.body || body.issue?.body || "");
    if (!verified) {
      writeJson(res, 401, { ok: false, error: { message: "GitHub webhook signature verification failed." } });
      return;
    }
    const repoContext = githubRepoFromWebhook(body);
    const repoFullName = repoContext.fullName;
    const installationId = repoContext.installationId;
    const delivery = await store.recordGitHubDelivery?.({
      deliveryId: req.headers["x-github-delivery"] || "",
      event: req.headers["x-github-event"] || "",
      repository: repoFullName
    });
    if (delivery?.duplicate) {
      writeJson(res, 202, { ok: true, duplicate: true, accepted: false });
      return;
    }
    const project = command && repoFullName && installationId
      ? await store.findProjectByGitHubRepository?.({ installationId, fullName: repoFullName })
      : null;
    if (!project || !command) {
      writeJson(res, 202, { ok: true, command, accepted: Boolean(command), mapped: false });
      return;
    }
    const settings = await store.getSettings(project.orgId);
    if (!isRepositoryAllowed(settings.github?.allowedRepositories, repoFullName)) {
      writeJson(res, 202, {
        ok: true,
        command,
        accepted: false,
        mapped: true,
        error: { message: `Repository ${repoFullName} is not allowed by GitHub settings.` }
      });
      return;
    }
    let queuedInput;
    try {
      queuedInput = resolveQueuedRunInput({
        project,
        input: body.input
      });
    } catch (error) {
      writeJson(res, 202, {
        ok: true,
        command,
        accepted: false,
        mapped: true,
        error: { message: error.message }
      });
      return;
    }
    const { run, job } = await store.createRun({
      orgId: project.orgId,
      projectId: project.id,
      actorUserId: null,
      trigger: `github:${command}`,
      input: queuedInput,
      metadata: {
        github: {
          command,
          delivery: req.headers["x-github-delivery"] || "",
          event: req.headers["x-github-event"] || "",
          repository: repoFullName,
          installationId,
          issueNumber: body.issue?.number || body.pull_request?.number || null
        }
      }
    });
    const runnerPolicy = buildRunnerPolicy({ orgId: project.orgId, projectId: project.id, runId: run.id, settings, config: project.config || {} });
    const payload = { jobId: job.id, runId: run.id, orgId: project.orgId, projectId: project.id, runnerPolicy };
    await queue.enqueue(payload);
    await postGitHubComment({
      settings,
      installationId,
      owner: repoContext.owner,
      repo: repoContext.repo,
      issueNumber: repoContext.issueNumber,
      body: buildQueuedComment({ run, command, baseUrl: process.env.PATCHPROOF_PUBLIC_BASE_URL || "" })
    }).catch((error) => {
      store.addAuditEvent?.({
        orgId: project.orgId,
        actorUserId: null,
        action: "github.comment_failed",
        targetType: "run",
        targetId: run.id,
        metadata: { message: error.message }
      });
    });
    if (inlineRuns) scheduleInlineRun({ store, queue, artifactStore, payload });
    writeJson(res, 202, { ok: true, command, accepted: true, mapped: true, run, job });
    return;
  }

  const auth = await store.authenticate(token);
  const primaryOrgId = selectOrgId(req, auth);
  const role = auth.apiKey ? auth.apiKey.role : await store.roleFor(auth.user.id, primaryOrgId);

  if (requestPath === "/api/me" && method === "GET") {
    writeJson(res, 200, { ok: true, user: auth.user, orgs: await store.orgsForUser(auth.user.id) });
    return;
  }

  if (requestPath === "/api/orgs" && method === "GET") {
    writeJson(res, 200, { ok: true, orgs: await store.orgsForUser(auth.user.id) });
    return;
  }

  if (requestPath === "/api/orgs" && method === "POST") {
    if (auth.apiKey) throw forbidden("API keys cannot create organizations.");
    writeJson(res, 201, { ok: true, org: await store.createOrg({ actorUserId: auth.user.id, name: body.name }) });
    return;
  }

  if (requestPath === "/api/sessions" && method === "GET") {
    if (auth.apiKey) throw forbidden("API keys do not have browser sessions.");
    writeJson(res, 200, { ok: true, sessions: await store.listSessions({ orgId: primaryOrgId, userId: auth.user.id }) });
    return;
  }

  const ownSessionMatch = requestPath.match(/^\/api\/sessions\/([^/]+)$/);
  if (ownSessionMatch && method === "DELETE") {
    if (auth.apiKey) throw forbidden("API keys do not have browser sessions.");
    const sessions = await store.listSessions({ orgId: primaryOrgId, userId: auth.user.id });
    if (!sessions.some((session) => session.id === ownSessionMatch[1])) throw notFound("Session");
    const revoked = await store.revokeSession({ orgId: primaryOrgId, actorUserId: auth.user.id, sessionId: ownSessionMatch[1] });
    const headers = auth.session?.id === ownSessionMatch[1] ? { "Set-Cookie": clearSessionCookie(req) } : {};
    writeJson(res, 200, { ok: true, session: revoked }, headers);
    return;
  }

  if (requestPath === "/api/projects" && method === "GET") {
    requirePermission(role, "project:read");
    writeJson(res, 200, { ok: true, projects: await store.listProjects(primaryOrgId) });
    return;
  }

  if (requestPath === "/api/projects" && method === "POST") {
    requirePermission(role, "project:write");
    const config = body.configText ? parsePatchproofConfig(body.configText) : body.config || null;
    const project = await store.createProject({
      orgId: primaryOrgId,
      actorUserId: actorUserId(auth),
      name: body.name,
      repoUrl: body.repoUrl,
      defaultBranch: body.defaultBranch,
      config
    });
    writeJson(res, 201, { ok: true, project });
    return;
  }

  const projectMatch = requestPath.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && method === "GET") {
    requirePermission(role, "project:read");
    const project = await store.getProject(projectMatch[1]);
    if (!project || project.orgId !== primaryOrgId) throw notFound("Project");
    writeJson(res, 200, { ok: true, project });
    return;
  }

  const projectRunMatch = requestPath.match(/^\/api\/projects\/([^/]+)\/runs$/);
  if (projectRunMatch && method === "GET") {
    requirePermission(role, "run:read");
    const project = await store.getProject(projectRunMatch[1]);
    if (!project || project.orgId !== primaryOrgId) throw notFound("Project");
    writeJson(res, 200, { ok: true, runs: await store.listRuns(primaryOrgId, project.id) });
    return;
  }

  if (projectRunMatch && method === "POST") {
    requirePermission(role, "run:create");
    const project = await store.getProject(projectRunMatch[1]);
    if (!project || project.orgId !== primaryOrgId) throw notFound("Project");
    const queuedInput = resolveQueuedRunInput({
      project,
      input: body.input
    });
    const { run, job } = await store.createRun({
      orgId: primaryOrgId,
      projectId: project.id,
      actorUserId: actorUserId(auth),
      trigger: body.trigger || "manual",
      input: queuedInput,
      metadata: body.metadata || {}
    });
    const settings = await store.getSettings(primaryOrgId);
    const runnerPolicy = buildRunnerPolicy({ orgId: primaryOrgId, projectId: project.id, runId: run.id, settings, config: project.config || {} });
    const payload = { jobId: job.id, runId: run.id, orgId: primaryOrgId, projectId: project.id, runnerPolicy };
    await queue.enqueue(payload);
    if (inlineRuns) scheduleInlineRun({ store, queue, artifactStore, payload });
    writeJson(res, 202, { ok: true, queued: true, run, job, runnerPolicy });
    return;
  }

  const runMatch = requestPath.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch && method === "GET") {
    requirePermission(role, "run:read");
    const detail = await store.getRunDetail(runMatch[1]);
    if (!detail || detail.run.orgId !== primaryOrgId) throw notFound("Run");
    writeJson(res, 200, { ok: true, ...detail });
    return;
  }

  const cancelMatch = requestPath.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (cancelMatch && method === "POST") {
    requirePermission(role, "run:create");
    const detail = await store.getRunDetail(cancelMatch[1]);
    if (!detail || detail.run.orgId !== primaryOrgId) throw notFound("Run");
    const result = await store.cancelRun({
      runId: detail.run.id,
      actorUserId: actorUserId(auth),
      message: body.message || "Run cancelled from API."
    });
    writeJson(res, 200, { ok: true, ...result });
    return;
  }

  const runLogsMatch = requestPath.match(/^\/api\/runs\/([^/]+)\/logs$/);
  if (runLogsMatch && method === "GET") {
    requirePermission(role, "run:read");
    const detail = await store.getRunDetail(runLogsMatch[1]);
    if (!detail || detail.run.orgId !== primaryOrgId) throw notFound("Run");
    const logsArtifact = await store.getArtifactForRun?.(detail.run.id, "logs");
    if (logsArtifact) {
      const text = (await artifactStore.getBytes(logsArtifact)).toString("utf8");
      writeJson(res, 200, { ok: true, logs: text ? text.split(/\r?\n/).filter(Boolean) : [] });
      return;
    }
    writeJson(res, 200, { ok: true, logs: detail.job?.logs || [] });
    return;
  }

  const certMatch = requestPath.match(/^\/api\/runs\/([^/]+)\/certificate$/);
  if (certMatch && method === "GET") {
    requirePermission(role, "certificate:download");
    const detail = await store.getRunDetail(certMatch[1]);
    if (!detail || detail.run.orgId !== primaryOrgId) throw notFound("Run");
    writeJson(res, 200, { ok: true, certificate: await loadCertificateArtifact({ store, artifactStore, detail }) });
    return;
  }

  const replayMatch = requestPath.match(/^\/api\/runs\/([^/]+)\/replay$/);
  if (replayMatch && method === "POST") {
    requirePermission(role, "run:create");
    const detail = await store.getRunDetail(replayMatch[1]);
    if (!detail || detail.run.orgId !== primaryOrgId) throw notFound("Run");
    const certificate = await loadCertificateArtifact({ store, artifactStore, detail });
    const input = certificate?.replay?.input;
    if (!input) throw badRequest("Run has no replay input.");
    const { run, job } = await store.createRun({
      orgId: primaryOrgId,
      projectId: detail.run.projectId,
      actorUserId: actorUserId(auth),
      trigger: "certificate-replay",
      input,
      metadata: { replayOf: detail.run.id }
    });
    const settings = await store.getSettings(primaryOrgId);
    const runnerPolicy = buildRunnerPolicy({ orgId: primaryOrgId, projectId: detail.run.projectId, runId: run.id, settings, config: detail.project?.config || {} });
    const payload = { jobId: job.id, runId: run.id, orgId: primaryOrgId, projectId: detail.run.projectId, runnerPolicy };
    await queue.enqueue(payload);
    if (inlineRuns) scheduleInlineRun({ store, queue, artifactStore, payload });
    writeJson(res, 202, { ok: true, queued: true, run, job, runnerPolicy });
    return;
  }

  const applyMatch = requestPath.match(/^\/api\/runs\/([^/]+)\/apply-patch$/);
  if (applyMatch && method === "POST") {
    requirePermission(role, "run:apply");
    const detail = await store.getRunDetail(applyMatch[1]);
    if (!detail || detail.run.orgId !== primaryOrgId) throw notFound("Run");
    const certificate = await loadCertificateArtifact({ store, artifactStore, detail });
    const settings = await store.getSettings(primaryOrgId);
    let prResult = null;
    if (body.mode === "github-pr") {
      const github = detail.run.metadata?.github || {};
      const [owner, repo] = String(github.repository || detail.project?.repoUrl || "").replace(/^https:\/\/[^/]+\//, "").replace(/\.git$/, "").split("/");
      prResult = await createPatchPullRequest({
        settings,
        installationId: github.installationId,
        owner,
        repo,
        base: detail.project?.defaultBranch || "main",
        run: detail.run,
        certificate,
        files: body.files || [],
        allowedFilePaths:
          detail.project?.config?.github?.allowedFilePaths ||
          detail.project?.config?.project?.allowedPaths ||
          []
      });
    }
    await store.addAuditEvent({
      orgId: primaryOrgId,
      actorUserId: actorUserId(auth),
      action: "run.patch_apply_requested",
      targetType: "run",
      targetId: detail.run.id,
      metadata: { mode: body.mode || "manual-download", github: prResult }
    });
    await store.save?.();
    writeJson(res, 200, { ok: true, message: "Patch apply recorded.", github: prResult });
    return;
  }

  const githubProjectMatch = requestPath.match(/^\/api\/projects\/([^/]+)\/integrations\/github$/);
  if (githubProjectMatch && method === "POST") {
    requirePermission(role, "admin:write");
    const project = await store.getProject(githubProjectMatch[1]);
    if (!project || project.orgId !== primaryOrgId) throw notFound("Project");
    const owner = body.owner || String(body.fullName || "").split("/")[0];
    const repo = body.repo || String(body.fullName || "").split("/")[1];
    if (!owner || !repo || !body.installationId) throw badRequest("installationId, owner, and repo are required.");
    const integration = await store.upsertGitHubRepository({
      orgId: primaryOrgId,
      projectId: project.id,
      installationId: body.installationId,
      owner,
      repo,
      fullName: body.fullName || `${owner}/${repo}`
    });
    await store.addAuditEvent({
      orgId: primaryOrgId,
      actorUserId: actorUserId(auth),
      action: "github.repository_linked",
      targetType: "project",
      targetId: project.id,
      metadata: { installationId: body.installationId, fullName: integration.fullName }
    });
    await store.save?.();
    writeJson(res, 200, { ok: true, integration });
    return;
  }

  if (requestPath === "/api/audit-events" && method === "GET") {
    requirePermission(role, "audit:read");
    writeJson(res, 200, { ok: true, auditEvents: await store.listAuditEvents(primaryOrgId) });
    return;
  }

  if (requestPath === "/api/admin/runners" && method === "GET") {
    requirePermission(role, "admin:read");
    const settings = await store.getSettings(primaryOrgId);
    const liveRunners = await store.listRunners?.();
    writeJson(res, 200, {
      ok: true,
      runners: liveRunners?.length ? liveRunners : [
        {
          id: "runner_local_1",
          status: inlineRuns ? "online" : "waiting-for-runner",
          isolation: inlineRuns ? "isolated-node-permission-runner" : "docker-runner",
          policy: buildRunnerPolicy({ orgId: primaryOrgId, projectId: "all", runId: "preview", settings })
        }
      ]
    });
    return;
  }

  if (requestPath === "/api/admin/settings" && method === "GET") {
    requirePermission(role, "admin:read");
    writeJson(res, 200, { ok: true, settings: maskSettingsSecrets(await store.getSettings(primaryOrgId)) });
    return;
  }

  if (requestPath === "/api/admin/settings" && method === "PATCH") {
    requirePermission(role, "admin:write");
    writeJson(res, 200, {
      ok: true,
      settings: maskSettingsSecrets(await store.updateSettings({ orgId: primaryOrgId, actorUserId: actorUserId(auth), patch: body }))
    });
    return;
  }

  if (requestPath === "/api/admin/invitations" && method === "GET") {
    requirePermission(role, "admin:read");
    writeJson(res, 200, { ok: true, invitations: await store.listInvitations(primaryOrgId) });
    return;
  }

  if (requestPath === "/api/admin/invitations" && method === "POST") {
    requirePermission(role, "admin:write");
    writeJson(res, 201, {
      ok: true,
      ...(await store.createInvitation({
        orgId: primaryOrgId,
        actorUserId: actorUserId(auth),
        email: body.email,
        name: body.name || "",
        role: body.role || "developer",
        expiresInDays: body.expiresInDays || 7
      }))
    });
    return;
  }

  const invitationMatch = requestPath.match(/^\/api\/admin\/invitations\/([^/]+)$/);
  if (invitationMatch && method === "DELETE") {
    requirePermission(role, "admin:write");
    writeJson(res, 200, {
      ok: true,
      invitation: await store.revokeInvitation({ orgId: primaryOrgId, actorUserId: actorUserId(auth), invitationId: invitationMatch[1] })
    });
    return;
  }

  if (requestPath === "/api/admin/password-resets" && method === "POST") {
    requirePermission(role, "admin:write");
    writeJson(res, 201, {
      ok: true,
      ...(await store.createPasswordReset({
        orgId: primaryOrgId,
        actorUserId: actorUserId(auth),
        email: body.email,
        userId: body.userId,
        expiresInMinutes: body.expiresInMinutes || 60
      }))
    });
    return;
  }

  if (requestPath === "/api/admin/sessions" && method === "GET") {
    requirePermission(role, "admin:read");
    writeJson(res, 200, { ok: true, sessions: await store.listSessions({ orgId: primaryOrgId }) });
    return;
  }

  const adminSessionMatch = requestPath.match(/^\/api\/admin\/sessions\/([^/]+)$/);
  if (adminSessionMatch && method === "DELETE") {
    requirePermission(role, "admin:write");
    writeJson(res, 200, {
      ok: true,
      session: await store.revokeSession({ orgId: primaryOrgId, actorUserId: actorUserId(auth), sessionId: adminSessionMatch[1] })
    });
    return;
  }

  if (requestPath === "/api/admin/retention" && method === "POST") {
    requirePermission(role, "admin:write");
    const result = await runRetention({ store, artifactStore, dryRun: body.dryRun === true });
    await store.addAuditEvent?.({
      orgId: primaryOrgId,
      actorUserId: actorUserId(auth),
      action: body.dryRun === true ? "retention.planned" : "retention.applied",
      targetType: "org",
      targetId: primaryOrgId,
      metadata: result
    });
    await store.save?.();
    writeJson(res, 200, { ok: true, retention: result });
    return;
  }

  if (requestPath === "/api/admin/reconcile" && method === "POST") {
    requirePermission(role, "admin:write");
    const result = await store.reconcileStaleRuns({
      dryRun: body.dryRun !== false,
      staleAfterMs: body.staleAfterMs || undefined
    });
    await store.addAuditEvent?.({
      orgId: primaryOrgId,
      actorUserId: actorUserId(auth),
      action: body.dryRun === false ? "runs.reconciled" : "runs.reconcile_planned",
      targetType: "org",
      targetId: primaryOrgId,
      metadata: { reconciled: result.reconciled, staleRuns: result.staleRuns.length }
    });
    await store.save?.();
    writeJson(res, 200, { ok: true, reconciliation: result });
    return;
  }

  if (requestPath === "/api/admin/api-keys" && method === "GET") {
    requirePermission(role, "admin:read");
    writeJson(res, 200, { ok: true, apiKeys: await store.listApiKeys(primaryOrgId) });
    return;
  }

  if (requestPath === "/api/admin/api-keys" && method === "POST") {
    requirePermission(role, "admin:write");
    writeJson(res, 201, {
      ok: true,
      ...(await store.createApiKey({
        orgId: primaryOrgId,
        actorUserId: actorUserId(auth),
        name: body.name,
        role: body.role || "developer"
      }))
    });
    return;
  }

  const apiKeyMatch = requestPath.match(/^\/api\/admin\/api-keys\/([^/]+)$/);
  if (apiKeyMatch && method === "DELETE") {
    requirePermission(role, "admin:write");
    writeJson(res, 200, {
      ok: true,
      apiKey: await store.revokeApiKey({ orgId: primaryOrgId, actorUserId: actorUserId(auth), apiKeyId: apiKeyMatch[1] })
    });
    return;
  }

  throw notFound("API route");
}

function buildOpenApiDocument(req) {
  const origin = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host || "127.0.0.1:4173"}`;
  return {
    openapi: "3.1.0",
    info: {
      title: "PatchProof API",
      version: PATCHPROOF_VERSION,
      description: "Self-hosted PatchProof v1 API for projects, queued runs, certificates, operations, and replay."
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    paths: {
      "/bootstrap": {
        post: {
          summary: "Bootstrap the first owner account",
          security: [],
          requestBody: jsonRequest("BootstrapRequest"),
          responses: { "201": jsonResponse("Bootstrap complete", "AuthResponse"), "409": errorResponse("Already bootstrapped") }
        }
      },
      "/auth/login": {
        post: {
          summary: "Create an HttpOnly browser session or return a bearer token",
          security: [],
          requestBody: jsonRequest("LoginRequest"),
          responses: { "200": jsonResponse("Authenticated", "AuthResponse"), "401": errorResponse("Invalid credentials") }
        }
      },
      "/auth/password-reset/complete": {
        post: {
          summary: "Complete a one-time password reset",
          security: [],
          requestBody: jsonRequest("PasswordResetCompleteRequest"),
          responses: { "200": jsonResponse("Password reset complete", "UserResponse"), "400": errorResponse("Invalid or expired token") }
        }
      },
      "/invitations/accept": {
        post: {
          summary: "Accept an organization invitation and create a browser session",
          security: [],
          requestBody: jsonRequest("AcceptInvitationRequest"),
          responses: { "200": jsonResponse("Invitation accepted", "AuthResponse"), "400": errorResponse("Invalid or expired token") }
        }
      },
      "/me": { get: { summary: "Current authenticated user", responses: { "200": { description: "User and orgs" } } } },
      "/sessions": {
        get: { summary: "List current user's browser sessions", responses: { "200": jsonResponse("Sessions", "SessionsResponse") } }
      },
      "/sessions/{sessionId}": {
        delete: {
          summary: "Revoke one of the current user's browser sessions",
          parameters: [pathParameter("sessionId")],
          responses: { "200": jsonResponse("Session revoked", "SessionResponse"), "404": errorResponse("Session not found") }
        }
      },
      "/projects": {
        get: { summary: "List projects", responses: { "200": jsonResponse("Projects", "ProjectsResponse") } },
        post: { summary: "Create project", requestBody: jsonRequest("CreateProjectRequest"), responses: { "201": jsonResponse("Project created", "ProjectResponse") } }
      },
      "/projects/{projectId}": {
        get: {
          summary: "Read project",
          parameters: [pathParameter("projectId")],
          responses: { "200": { description: "Project" } }
        }
      },
      "/projects/{projectId}/runs": {
        get: {
          summary: "List project runs",
          parameters: [pathParameter("projectId")],
          responses: { "200": { description: "Runs" } }
        },
        post: {
          summary: "Queue a PatchProof run",
          parameters: [pathParameter("projectId")],
          requestBody: jsonRequest("CreateRunRequest"),
          responses: { "202": jsonResponse("Run queued", "QueuedRunResponse") }
        }
      },
      "/runs/{runId}": {
        get: {
          summary: "Read run detail",
          parameters: [pathParameter("runId")],
          responses: { "200": { description: "Run, job, certificate, artifacts" } }
        }
      },
      "/runs/{runId}/cancel": {
        post: {
          summary: "Cancel a queued or running run",
          parameters: [pathParameter("runId")],
          responses: { "200": { description: "Run cancelled" }, "409": { description: "Run already terminal" } }
        }
      },
      "/runs/{runId}/logs": {
        get: {
          summary: "Read run logs",
          parameters: [pathParameter("runId")],
          responses: { "200": { description: "Logs" } }
        }
      },
      "/runs/{runId}/certificate": {
        get: {
          summary: "Download certificate",
          parameters: [pathParameter("runId")],
          responses: { "200": { description: "Certificate" } }
        }
      },
      "/runs/{runId}/replay": {
        post: {
          summary: "Queue a replay run from a certificate",
          parameters: [pathParameter("runId")],
          responses: { "202": { description: "Replay queued" } }
        }
      },
      "/runs/{runId}/apply-patch": {
        post: {
          summary: "Record patch application or request a GitHub PR",
          parameters: [pathParameter("runId")],
          requestBody: jsonRequest("ApplyPatchRequest"),
          responses: { "200": { description: "Apply request recorded" } }
        }
      },
      "/admin/settings": {
        get: { summary: "Read masked admin settings", responses: { "200": { description: "Settings" } } },
        patch: { summary: "Update admin settings", requestBody: jsonRequest("SettingsPatch"), responses: { "200": { description: "Settings updated" } } }
      },
      "/admin/runners": { get: { summary: "List runner heartbeats", responses: { "200": { description: "Runners" } } } },
      "/admin/retention": { post: { summary: "Plan or apply retention cleanup", responses: { "200": { description: "Retention result" } } } },
      "/admin/reconcile": { post: { summary: "Plan or apply stale-run reconciliation", responses: { "200": { description: "Reconciliation result" } } } },
      "/admin/invitations": {
        get: { summary: "List organization invitations", responses: { "200": jsonResponse("Invitations", "InvitationsResponse") } },
        post: {
          summary: "Create an organization invitation",
          requestBody: jsonRequest("CreateInvitationRequest"),
          responses: { "201": jsonResponse("Invitation and one-time token", "CreateInvitationResponse") }
        }
      },
      "/admin/invitations/{invitationId}": {
        delete: {
          summary: "Revoke an organization invitation",
          parameters: [pathParameter("invitationId")],
          responses: { "200": jsonResponse("Invitation revoked", "InvitationResponse") }
        }
      },
      "/admin/password-resets": {
        post: {
          summary: "Create a one-time password reset token for an organization member",
          requestBody: jsonRequest("CreatePasswordResetRequest"),
          responses: { "201": jsonResponse("Password reset token created", "CreatePasswordResetResponse") }
        }
      },
      "/admin/sessions": {
        get: { summary: "List organization browser sessions", responses: { "200": jsonResponse("Sessions", "SessionsResponse") } }
      },
      "/admin/sessions/{sessionId}": {
        delete: {
          summary: "Revoke an organization browser session",
          parameters: [pathParameter("sessionId")],
          responses: { "200": jsonResponse("Session revoked", "SessionResponse") }
        }
      },
      "/admin/api-keys": {
        get: { summary: "List API keys", responses: { "200": { description: "API keys" } } },
        post: { summary: "Create API key", requestBody: jsonRequest("CreateApiKeyRequest"), responses: { "201": { description: "API key and one-time token" } } }
      },
      "/audit-events": { get: { summary: "List audit events", responses: { "200": { description: "Audit events" } } } },
      "/run": {
        post: {
          summary: "Local/demo quick run through isolated hosted runner. Disabled by default when NODE_ENV=production unless PATCHPROOF_ENABLE_QUICK_RUN=true.",
          security: [],
          requestBody: jsonRequest("PatchProofInput"),
          responses: { "200": { description: "PatchProof result" } }
        }
      },
      "/model/check": {
        post: {
          summary: "Validate model-provider settings and estimate prompt usage without calling the provider. Local/demo endpoint.",
          security: [],
          requestBody: jsonRequest("ModelCheckRequest"),
          responses: { "200": { description: "Model setup report" } }
        }
      },
      "/model/generate": {
        post: {
          summary: "Generate repair candidates with the configured model provider and return them for bounded validation. Local/demo endpoint.",
          security: [],
          requestBody: jsonRequest("ModelGenerateRequest"),
          responses: { "200": { description: "Generated model candidates" } }
        }
      },
      "/repository/inspect": {
        post: {
          summary: "Inspect a local repository checkout. Local/demo endpoint.",
          security: [],
          requestBody: jsonRequest("RepositoryRequest"),
          responses: { "200": { description: "Repository inspection report" } }
        }
      },
      "/repository/init": {
        post: {
          summary: "Create a starter patchproof.yml for a local repository checkout. Local/demo endpoint.",
          security: [],
          requestBody: jsonRequest("RepositoryInitRequest"),
          responses: { "201": { description: "Repository config created" } }
        }
      },
      "/repository/detect": {
        post: {
          summary: "Detect likely bug signals in a local repository checkout and optionally export SARIF. Local/demo endpoint.",
          security: [],
          requestBody: jsonRequest("RepositoryDetectRequest"),
          responses: { "200": { description: "Repository detection report" } }
        }
      },
      "/repository/repair": {
        post: {
          summary: "Preview or apply conservative repository-level static repairs. Local/demo endpoint.",
          security: [],
          requestBody: jsonRequest("RepositoryRepairRequest"),
          responses: { "200": { description: "Repository repair report" } }
        }
      },
      "/repository/target": {
        post: {
          summary: "Load one configured local repository target as PatchProof input. Local/demo endpoint.",
          security: [],
          requestBody: jsonRequest("RepositoryTargetRequest"),
          responses: { "200": { description: "PatchProof input for target" } }
        }
      }
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        cookieAuth: { type: "apiKey", in: "cookie", name: SESSION_COOKIE_NAME }
      },
      schemas: openApiSchemas()
    }
  };
}

function pathParameter(name) {
  return { name, in: "path", required: true, schema: { type: "string" } };
}

function jsonRequest(schemaName) {
  return {
    required: true,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schemaName}` }
      }
    }
  };
}

function jsonResponse(description, schemaName) {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schemaName}` }
      }
    }
  };
}

function errorResponse(description) {
  return jsonResponse(description, "ErrorResponse");
}

function openApiSchemas() {
  const id = { type: "string", examples: ["run_0123456789abcdef"] };
  const timestamp = { type: ["string", "null"], format: "date-time" };
  const role = { type: "string", enum: ["owner", "admin", "developer", "reviewer", "auditor"] };
  return {
    ErrorResponse: {
      type: "object",
      required: ["ok", "error"],
      properties: { ok: { const: false }, error: { type: "object", required: ["message"], properties: { message: { type: "string" } } } }
    },
    User: { type: "object", required: ["id", "email", "name"], properties: { id, email: { type: "string", format: "email" }, name: { type: "string" }, createdAt: timestamp } },
    Org: { type: "object", required: ["id", "name"], properties: { id, name: { type: "string" }, role, createdAt: timestamp } },
    AuthResponse: {
      type: "object",
      required: ["ok", "user", "orgs"],
      properties: { ok: { const: true }, user: { $ref: "#/components/schemas/User" }, orgs: { type: "array", items: { $ref: "#/components/schemas/Org" } }, token: { type: "string", description: "Returned only when returnToken is true." } }
    },
    UserResponse: { type: "object", properties: { ok: { const: true }, user: { $ref: "#/components/schemas/User" } } },
    BootstrapRequest: { type: "object", required: ["email", "password"], properties: { email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 }, name: { type: "string" }, orgName: { type: "string" }, returnToken: { type: "boolean" } } },
    LoginRequest: { type: "object", required: ["email", "password"], properties: { email: { type: "string", format: "email" }, password: { type: "string" }, returnToken: { type: "boolean" } } },
    AcceptInvitationRequest: { type: "object", required: ["token", "password"], properties: { token: { type: "string" }, password: { type: "string", minLength: 8 }, name: { type: "string" }, returnToken: { type: "boolean" } } },
    PasswordResetCompleteRequest: { type: "object", required: ["token", "password"], properties: { token: { type: "string" }, password: { type: "string", minLength: 8 } } },
    Project: { type: "object", properties: { id, orgId: id, name: { type: "string" }, repoUrl: { type: "string" }, defaultBranch: { type: "string" }, config: { type: ["object", "null"], additionalProperties: true }, createdAt: timestamp } },
    CreateProjectRequest: { type: "object", required: ["name"], properties: { name: { type: "string" }, repoUrl: { type: "string" }, defaultBranch: { type: "string" }, config: { type: "object", additionalProperties: true }, configText: { type: "string" } } },
    ProjectsResponse: { type: "object", properties: { ok: { const: true }, projects: { type: "array", items: { $ref: "#/components/schemas/Project" } } } },
    ProjectResponse: { type: "object", properties: { ok: { const: true }, project: { $ref: "#/components/schemas/Project" } } },
    PatchProofInput: { type: "object", required: ["source", "tests"], additionalProperties: true, properties: { language: { type: "string", enum: ["javascript", "python"] }, source: { type: "string" }, tests: { type: "array", items: { type: "object", additionalProperties: true } }, bugReport: { type: "string" }, precondition: { type: "string" }, mayChange: { type: "string" }, postcondition: { type: "string" } } },
    ModelCheckRequest: {
      type: "object",
      additionalProperties: true,
      properties: {
        settings: { type: "object", additionalProperties: true },
        input: { $ref: "#/components/schemas/PatchProofInput" }
      }
    },
    RepositoryRequest: { type: "object", properties: { repoRoot: { type: "string" }, configPath: { type: "string", default: "patchproof.yml" } } },
    RepositoryInitRequest: { type: "object", properties: { repoRoot: { type: "string" }, configPath: { type: "string", default: "patchproof.yml" }, force: { type: "boolean" } } },
    RepositoryDetectRequest: {
      type: "object",
      properties: {
        repoRoot: { type: "string" },
        configPath: { type: "string", default: "patchproof.yml" },
        runTests: { type: "boolean" },
        install: { type: "boolean" },
        installCommand: { type: "string" },
        build: { type: "boolean" },
        buildCommand: { type: "string" },
        command: { type: "string" },
        format: { type: "string", enum: ["json", "sarif"] },
        suppressions: { type: "array", items: { type: "string" } },
        suppressionsPath: { type: "string" }
      }
    },
    RepositoryRepairRequest: {
      type: "object",
      properties: {
        repoRoot: { type: "string" },
        configPath: { type: "string", default: "patchproof.yml" },
        apply: { type: "boolean" },
        dryRun: { type: "boolean" },
        runTests: { type: "boolean" },
        install: { type: "boolean" },
        build: { type: "boolean" },
        command: { type: "string" },
        maxRepairs: { type: "integer", minimum: 1 },
        suppressions: { type: "array", items: { type: "string" } },
        suppressionsPath: { type: "string" }
      }
    },
    RepositoryTargetRequest: { type: "object", required: ["targetId"], properties: { repoRoot: { type: "string" }, configPath: { type: "string", default: "patchproof.yml" }, targetId: { type: "string" } } },
    CreateRunRequest: { type: "object", properties: { input: { $ref: "#/components/schemas/PatchProofInput" }, trigger: { type: "string" }, metadata: { type: "object", additionalProperties: true } } },
    Run: { type: "object", properties: { id, orgId: id, projectId: id, trigger: { type: "string" }, status: { type: "string" }, evidenceScore: { type: "number" }, metadata: { type: "object", additionalProperties: true }, createdAt: timestamp, updatedAt: timestamp } },
    Job: { type: "object", properties: { id, runId: id, status: { type: "string" }, phase: { type: "string" }, runnerId: { type: ["string", "null"] }, attempt: { type: "integer" }, createdAt: timestamp, startedAt: timestamp, completedAt: timestamp } },
    QueuedRunResponse: { type: "object", properties: { ok: { const: true }, queued: { type: "boolean" }, run: { $ref: "#/components/schemas/Run" }, job: { $ref: "#/components/schemas/Job" } } },
    Invitation: { type: "object", properties: { id, orgId: id, email: { type: "string" }, name: { type: "string" }, role, createdByUserId: id, createdAt: timestamp, expiresAt: timestamp, acceptedAt: timestamp, revokedAt: timestamp } },
    CreateInvitationRequest: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" }, name: { type: "string" }, role: { type: "string", enum: ["admin", "developer", "reviewer", "auditor"] }, expiresInDays: { type: "integer", minimum: 1 } } },
    InvitationsResponse: { type: "object", properties: { ok: { const: true }, invitations: { type: "array", items: { $ref: "#/components/schemas/Invitation" } } } },
    InvitationResponse: { type: "object", properties: { ok: { const: true }, invitation: { $ref: "#/components/schemas/Invitation" } } },
    CreateInvitationResponse: { type: "object", properties: { ok: { const: true }, invitation: { $ref: "#/components/schemas/Invitation" }, token: { type: "string", description: "One-time invitation token. Display once and deliver out of band." } } },
    CreatePasswordResetRequest: { type: "object", properties: { email: { type: "string", format: "email" }, userId: id, expiresInMinutes: { type: "integer", minimum: 5 } } },
    CreatePasswordResetResponse: { type: "object", properties: { ok: { const: true }, passwordReset: { type: "object", additionalProperties: true }, token: { type: "string", description: "One-time reset token. Display once and deliver out of band." } } },
    Session: { type: "object", properties: { id, userId: id, user: { anyOf: [{ $ref: "#/components/schemas/User" }, { type: "null" }] }, createdAt: timestamp, expiresAt: timestamp } },
    SessionsResponse: { type: "object", properties: { ok: { const: true }, sessions: { type: "array", items: { $ref: "#/components/schemas/Session" } } } },
    SessionResponse: { type: "object", properties: { ok: { const: true }, session: { $ref: "#/components/schemas/Session" } } },
    CreateApiKeyRequest: { type: "object", required: ["name"], properties: { name: { type: "string" }, role: { type: "string", enum: ["developer", "reviewer", "auditor"] } } },
    SettingsPatch: { type: "object", additionalProperties: true },
    ApplyPatchRequest: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["manual-download", "github-pr"] },
        files: { type: "array", items: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } }
      }
    }
  };
}

function writeJson(res, statusCode, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    ...apiHeaders,
    "X-PatchProof-API-Version": "1",
    "Content-Length": Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

function normalizeApiPath(requestPath) {
  return requestPath.startsWith("/api/v1/") ? requestPath.replace(/^\/api\/v1/, "/api") : requestPath;
}

function logAccess({ req, res, startedAt }) {
  if (process.env.PATCHPROOF_ACCESS_LOGS !== "json") return;
  const record = {
    timestamp: new Date().toISOString(),
    requestId: req.requestId,
    method: req.method,
    path: (req.url || "").split("?")[0],
    status: res.statusCode,
    durationMs: Date.now() - startedAt,
    remoteAddress: req.socket.remoteAddress || ""
  };
  console.log(JSON.stringify(record));
}

function authResponse(auth, body = {}) {
  const { token, ...publicAuth } = auth;
  return body.returnToken === true ? { ...publicAuth, token } : publicAuth;
}

function getRequestToken(req) {
  const header = String(req.headers.authorization || "");
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return cookieValue(req, SESSION_COOKIE_NAME);
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const prefix = `${name}=`;
  const cookie = cookies.find((part) => part.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : "";
}

function sessionCookie(token, req) {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    "Max-Age=43200",
    secureCookieAttribute(req)
  ].filter(Boolean).join("; ");
}

function clearSessionCookie(req) {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    "Max-Age=0",
    secureCookieAttribute(req)
  ].filter(Boolean).join("; ");
}

function secureCookieAttribute(req) {
  if (process.env.PATCHPROOF_SECURE_COOKIES === "false") return "";
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (forwardedProto === "https" || req.socket.encrypted || process.env.NODE_ENV === "production") {
    return "Secure";
  }
  return "";
}

function selectOrgId(req, auth) {
  const requested = req.headers["x-patchproof-org"];
  const memberships = auth.memberships || [];
  if (requested && memberships.some((membership) => membership.orgId === requested)) return requested;
  const first = memberships[0]?.orgId;
  if (!first) {
    const error = new Error("No organization membership found.");
    error.statusCode = 403;
    throw error;
  }
  return first;
}

function actorUserId(auth) {
  return auth.apiKey ? null : auth.user.id;
}

function renderPrometheusMetrics(metrics, queueHealth = null) {
  return [
    "# HELP patchproof_runs_total Total PatchProof runs.",
    "# TYPE patchproof_runs_total counter",
    `patchproof_runs_total ${metrics.runsTotal}`,
    "# HELP patchproof_queue_depth Queued PatchProof jobs.",
    "# TYPE patchproof_queue_depth gauge",
    `patchproof_queue_depth ${metrics.queueDepth}`,
    "# HELP patchproof_queue_in_flight_depth Leased PatchProof jobs reported by the active queue backend.",
    "# TYPE patchproof_queue_in_flight_depth gauge",
    `patchproof_queue_in_flight_depth ${queueHealth?.inFlight || 0}`,
    "# HELP patchproof_queue_dead_depth Dead-letter PatchProof jobs reported by the active queue backend.",
    "# TYPE patchproof_queue_dead_depth gauge",
    `patchproof_queue_dead_depth ${queueHealth?.dead || 0}`,
    "# HELP patchproof_runner_count Available runners.",
    "# TYPE patchproof_runner_count gauge",
    `patchproof_runner_count ${metrics.runnerCount}`,
    "# HELP patchproof_audit_events_total Total audit events.",
    "# TYPE patchproof_audit_events_total counter",
    `patchproof_audit_events_total ${metrics.auditEvents}`,
    `patchproof_runs_certified_total ${metrics.runsCertified}`,
    `patchproof_runs_rejected_total ${metrics.runsRejected}`,
    `patchproof_runs_failed_total ${metrics.runsFailed}`,
    `patchproof_runs_cancelled_total ${metrics.runsCancelled || 0}`,
    "# HELP patchproof_run_duration_ms_avg Average terminal run duration in milliseconds.",
    "# TYPE patchproof_run_duration_ms_avg gauge",
    `patchproof_run_duration_ms_avg ${metrics.runDurationMsAvg || 0}`,
    "# HELP patchproof_jobs_total PatchProof jobs by status.",
    "# TYPE patchproof_jobs_total gauge",
    `patchproof_jobs_total{status="queued"} ${metrics.jobsQueued || 0}`,
    `patchproof_jobs_total{status="running"} ${metrics.jobsRunning || 0}`,
    `patchproof_jobs_total{status="completed"} ${metrics.jobsCompleted || 0}`,
    `patchproof_jobs_total{status="failed"} ${metrics.jobsFailed || 0}`,
    `patchproof_jobs_total{status="cancelled"} ${metrics.jobsCancelled || 0}`,
    "# HELP patchproof_job_duration_ms_avg Average completed job duration in milliseconds.",
    "# TYPE patchproof_job_duration_ms_avg gauge",
    `patchproof_job_duration_ms_avg ${metrics.jobDurationMsAvg || 0}`,
    "# HELP patchproof_model_calls_total Jobs that invoked an external model provider.",
    "# TYPE patchproof_model_calls_total counter",
    `patchproof_model_calls_total ${metrics.modelCallsTotal || 0}`,
    "# HELP patchproof_model_errors_total Failed jobs that invoked an external model provider.",
    "# TYPE patchproof_model_errors_total counter",
    `patchproof_model_errors_total ${metrics.modelErrorsTotal || 0}`,
    ""
  ].join("\n");
}

async function checkReadiness({ store, queue, artifactStore }) {
  const checks = {};
  checks.store = await settleHealth(store);
  checks.queue = await settleHealth(queue);
  checks.artifacts = await settleHealth(artifactStore);
  return {
    ok: Object.values(checks).every((check) => check.ok),
    ready: Object.values(checks).every((check) => check.ok),
    checks
  };
}

async function settleHealth(service) {
  try {
    if (service?.health) return await service.health();
    await service?.load?.();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function scheduleInlineRun({ store, queue, artifactStore, payload }) {
  setImmediate(async () => {
    try {
      const claimed = await queue.claim({ timeoutSeconds: 1 });
      await processQueuedJob({ store, queue, artifactStore, payload: claimed || payload, isolation: "process" });
    } catch (error) {
      await store.failRun?.({ runId: payload.runId, message: error.message, logs: [error.message] }).catch?.(() => {});
    }
  });
}

function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "worker-src 'none'",
    "style-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'"
  ].join("; ");
}

async function loadCertificateArtifact({ store, artifactStore, detail }) {
  const certificateArtifact = await store.getArtifactForRun?.(detail.run.id, "certificate");
  if (certificateArtifact) return artifactStore.getJson(certificateArtifact);
  return detail.certificate?.certificate || null;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

function notFound(name) {
  const error = new Error(`${name} not found.`);
  error.statusCode = 404;
  return error;
}

function readJsonBody(req, maxBytes, options = {}) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    let bytes = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        const error = new Error(`Request body exceeds ${maxBytes} bytes.`);
        error.statusCode = 413;
        rejectBody(error);
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        const json = JSON.parse(body || "{}");
        resolveBody(options.includeRaw ? { json, raw: body } : json);
      } catch (error) {
        const parseError = new Error(`Invalid JSON: ${error.message}`);
        parseError.statusCode = 400;
        rejectBody(parseError);
      }
    });
    req.on("error", rejectBody);
  });
}

export function listen(port = requestedPort, options = {}) {
  const server = createPatchProofServer(options);
  const host = options.host || requestedHost;

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && port < requestedPort + 20) {
      listen(port + 1);
      return;
    }
    throw error;
  });

  server.listen(port, host, () => {
    console.log(`PatchProof running at http://${host}:${port}`);
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  listen(requestedPort);
}
