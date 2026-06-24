import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { normalizeRole } from "./rbac.js";
import { decryptSettingsSecrets, encryptSettingsSecrets } from "./secrets.js";

const DEFAULT_STORE_PATH = resolve(process.cwd(), "data", "patchproof-store.json");
const DEFAULT_SETTINGS = Object.freeze({
  modelProvider: {
    provider: "disabled",
    baseUrl: "",
    model: "local-repair-templates",
    maxTokens: 4096,
    maxCandidates: 8,
    promptLogging: false,
    privacyMode: true
  },
  runner: {
    timeoutSeconds: 600,
    memoryMb: 2048,
    cpus: 2,
    network: "disabled",
    image: "patchproof:1.0.0"
  },
  retention: {
    artifactDays: 30,
    auditDays: 365
  },
  github: {
    appId: "",
    privateKey: "",
    webhookSecret: "",
    allowedRepositories: [],
    allowedFilePaths: [],
    applyPatchEnabled: false
  }
});

export class JsonSaasStore {
  constructor(options = {}) {
    this.path = resolve(options.path || process.env.PATCHPROOF_STORE_PATH || DEFAULT_STORE_PATH);
    this.state = createEmptyState();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    let shouldSaveMigratedState = false;
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8"));
      shouldSaveMigratedState = Array.isArray(raw.sessions)
        && raw.sessions.some((session) => session?.token && !session?.tokenHash);
      this.state = mergeState(raw);
    } catch {
      this.state = createEmptyState();
    }
    this.loaded = true;
    if (shouldSaveMigratedState) await this.save();
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  async close() {}

  async health() {
    await this.load();
    return { ok: true, driver: "json", path: this.path };
  }

  async hasUsers() {
    await this.load();
    return this.state.users.length > 0;
  }

  async bootstrap({ email, password, name = "Owner", orgName = "PatchProof" }) {
    await this.load();
    if (this.state.users.length > 0) {
      const error = new Error("Bootstrap is already complete.");
      error.statusCode = 409;
      throw error;
    }
    const now = nowIso();
    const org = {
      id: id("org"),
      name: String(orgName || "PatchProof"),
      createdAt: now
    };
    const user = {
      id: id("usr"),
      email: normalizeEmail(email),
      name: String(name || "Owner"),
      passwordHash: hashPassword(password),
      createdAt: now
    };
    this.state.orgs.push(org);
    this.state.users.push(user);
    this.state.memberships.push({ userId: user.id, orgId: org.id, role: "owner", createdAt: now });
    this.state.settings[org.id] = structuredClone(DEFAULT_SETTINGS);
    const { token } = this.createSessionRecord(user.id);
    this.addAuditEvent({
      orgId: org.id,
      actorUserId: user.id,
      action: "bootstrap.completed",
      targetType: "org",
      targetId: org.id,
      metadata: { email: user.email }
    });
    await this.save();
    return { token, user: publicUser(user), org, role: "owner", orgs: this.orgsForUser(user.id) };
  }

  async login({ email, password }) {
    await this.load();
    const user = this.state.users.find((item) => item.email === normalizeEmail(email));
    if (!user || !verifyPassword(password, user.passwordHash)) {
      const error = new Error("Invalid email or password.");
      error.statusCode = 401;
      throw error;
    }
    const { token } = this.createSessionRecord(user.id);
    const primaryMembership = this.membershipsForUser(user.id)[0];
    this.addAuditEvent({
      orgId: primaryMembership?.orgId || null,
      actorUserId: user.id,
      action: "auth.login",
      targetType: "user",
      targetId: user.id
    });
    await this.save();
    return { token, user: publicUser(user), orgs: this.orgsForUser(user.id) };
  }

  async logout(token) {
    await this.load();
    const session = this.state.sessions.find((item) => sessionMatchesToken(item, token));
    this.state.sessions = this.state.sessions.filter((item) => !sessionMatchesToken(item, token));
    if (session) {
      this.addAuditEvent({
        orgId: this.membershipsForUser(session.userId)[0]?.orgId || null,
        actorUserId: session.userId,
        action: "auth.logout",
        targetType: "user",
        targetId: session.userId
      });
    }
    await this.save();
  }

  createSessionRecord(userId) {
    const token = randomBytes(32).toString("hex");
    const session = {
      id: id("ses"),
      tokenHash: sha256(token),
      userId,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString()
    };
    this.state.sessions.push(session);
    return { token, session };
  }

  async authenticate(token) {
    await this.load();
    const apiKey = this.authenticateApiKey(token);
    if (apiKey) return apiKey;
    const session = this.state.sessions.find((item) => sessionMatchesToken(item, token));
    if (!session || new Date(session.expiresAt).getTime() < Date.now()) {
      const error = new Error("Authentication required.");
      error.statusCode = 401;
      throw error;
    }
    const user = this.state.users.find((item) => item.id === session.userId);
    if (!user) {
      const error = new Error("Session user was not found.");
      error.statusCode = 401;
      throw error;
    }
    return { session, user: publicUser(user), memberships: this.membershipsForUser(user.id) };
  }

  authenticateApiKey(token) {
    if (!String(token || "").startsWith("ppk_")) return null;
    const tokenHash = sha256(token);
    const key = this.state.apiKeys.find((item) => item.tokenHash === tokenHash && !item.revokedAt);
    if (!key) return null;
    key.lastUsedAt = nowIso();
    return {
      session: null,
      apiKey: publicApiKey(key),
      user: { id: `api_${key.id}`, email: `api-key:${key.name}`, name: key.name, createdAt: key.createdAt },
      memberships: [{ userId: null, orgId: key.orgId, role: key.role, createdAt: key.createdAt }]
    };
  }

  orgsForUser(userId) {
    return this.membershipsForUser(userId).map((membership) => ({
      ...this.state.orgs.find((org) => org.id === membership.orgId),
      role: membership.role
    }));
  }

  membershipsForUser(userId) {
    return this.state.memberships.filter((membership) => membership.userId === userId);
  }

  roleFor(userId, orgId) {
    return this.state.memberships.find((membership) => membership.userId === userId && membership.orgId === orgId)?.role;
  }

  async createOrg({ actorUserId, name }) {
    await this.load();
    const now = nowIso();
    const org = { id: id("org"), name: String(name || "New Organization"), createdAt: now };
    this.state.orgs.push(org);
    this.state.memberships.push({ userId: actorUserId, orgId: org.id, role: "owner", createdAt: now });
    this.state.settings[org.id] = structuredClone(DEFAULT_SETTINGS);
    this.addAuditEvent({ orgId: org.id, actorUserId, action: "org.created", targetType: "org", targetId: org.id });
    await this.save();
    return org;
  }

  async createApiKey({ orgId, actorUserId, name, role = "developer" }) {
    await this.load();
    const normalizedRole = normalizeRole(role);
    if (!["developer", "reviewer", "auditor"].includes(normalizedRole)) {
      const error = new Error("API keys can only use developer, reviewer, or auditor roles.");
      error.statusCode = 400;
      throw error;
    }
    const token = `ppk_${randomBytes(32).toString("hex")}`;
    const key = {
      id: id("key"),
      orgId,
      name: String(name || "API key"),
      tokenHash: sha256(token),
      role: normalizedRole,
      createdByUserId: actorUserId,
      createdAt: nowIso(),
      lastUsedAt: null,
      revokedAt: null
    };
    this.state.apiKeys.push(key);
    this.addAuditEvent({ orgId, actorUserId, action: "api_key.created", targetType: "api_key", targetId: key.id });
    await this.save();
    return { apiKey: publicApiKey(key), token };
  }

  async listApiKeys(orgId) {
    await this.load();
    return this.state.apiKeys.filter((key) => key.orgId === orgId).map(publicApiKey);
  }

  async revokeApiKey({ orgId, actorUserId, apiKeyId }) {
    await this.load();
    const key = this.state.apiKeys.find((item) => item.id === apiKeyId && item.orgId === orgId);
    if (!key) throw notFound("API key");
    key.revokedAt = nowIso();
    this.addAuditEvent({ orgId, actorUserId, action: "api_key.revoked", targetType: "api_key", targetId: key.id });
    await this.save();
    return publicApiKey(key);
  }

  async createInvitation({ orgId, actorUserId, email, role = "developer", name = "", expiresInDays = 7 }) {
    await this.load();
    const normalizedRole = normalizeRole(role);
    if (!["admin", "developer", "reviewer", "auditor"].includes(normalizedRole)) {
      throw statusError("Invitations can only use admin, developer, reviewer, or auditor roles.", 400);
    }
    const token = `ppi_${randomBytes(32).toString("hex")}`;
    const invitation = {
      id: id("inv"),
      orgId,
      email: normalizeEmail(email),
      name: String(name || ""),
      role: normalizedRole,
      tokenHash: sha256(token),
      createdByUserId: actorUserId,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + Math.max(1, Number(expiresInDays || 7)) * 24 * 60 * 60 * 1000).toISOString(),
      acceptedAt: null,
      acceptedByUserId: null,
      revokedAt: null
    };
    this.state.invitations.push(invitation);
    this.addAuditEvent({ orgId, actorUserId, action: "invitation.created", targetType: "invitation", targetId: invitation.id, metadata: { email: invitation.email, role: invitation.role } });
    await this.save();
    return { invitation: publicInvitation(invitation), token };
  }

  async listInvitations(orgId) {
    await this.load();
    return this.state.invitations
      .filter((invitation) => invitation.orgId === orgId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicInvitation);
  }

  async revokeInvitation({ orgId, actorUserId, invitationId }) {
    await this.load();
    const invitation = this.state.invitations.find((item) => item.id === invitationId && item.orgId === orgId);
    if (!invitation) throw notFound("Invitation");
    invitation.revokedAt ||= nowIso();
    this.addAuditEvent({ orgId, actorUserId, action: "invitation.revoked", targetType: "invitation", targetId: invitation.id });
    await this.save();
    return publicInvitation(invitation);
  }

  async acceptInvitation({ token, password, name = "" }) {
    await this.load();
    const invitation = activeTokenRecord(this.state.invitations, token, "Invitation");
    const now = nowIso();
    let user = this.state.users.find((item) => item.email === invitation.email);
    if (!user) {
      user = {
        id: id("usr"),
        email: invitation.email,
        name: String(name || invitation.name || invitation.email.split("@")[0]),
        passwordHash: hashPassword(password),
        createdAt: now
      };
      this.state.users.push(user);
    } else if (name && !user.name) {
      user.name = String(name);
    }
    const existingMembership = this.state.memberships.find((item) => item.userId === user.id && item.orgId === invitation.orgId);
    if (existingMembership) {
      existingMembership.role = invitation.role;
    } else {
      this.state.memberships.push({ userId: user.id, orgId: invitation.orgId, role: invitation.role, createdAt: now });
    }
    invitation.acceptedAt = now;
    invitation.acceptedByUserId = user.id;
    const { token: sessionToken } = this.createSessionRecord(user.id);
    this.addAuditEvent({ orgId: invitation.orgId, actorUserId: user.id, action: "invitation.accepted", targetType: "invitation", targetId: invitation.id });
    await this.save();
    return { token: sessionToken, user: publicUser(user), orgs: this.orgsForUser(user.id), invitation: publicInvitation(invitation) };
  }

  async createPasswordReset({ orgId, actorUserId, email, userId, expiresInMinutes = 60 }) {
    await this.load();
    const user = userId
      ? this.state.users.find((item) => item.id === userId)
      : this.state.users.find((item) => item.email === normalizeEmail(email));
    if (!user) throw notFound("User");
    if (!this.state.memberships.some((membership) => membership.userId === user.id && membership.orgId === orgId)) {
      throw notFound("User");
    }
    const token = `ppr_${randomBytes(32).toString("hex")}`;
    const reset = {
      id: id("rst"),
      orgId,
      userId: user.id,
      tokenHash: sha256(token),
      createdByUserId: actorUserId,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + Math.max(5, Number(expiresInMinutes || 60)) * 60 * 1000).toISOString(),
      usedAt: null
    };
    this.state.passwordResets.push(reset);
    this.addAuditEvent({ orgId, actorUserId, action: "password_reset.created", targetType: "user", targetId: user.id });
    await this.save();
    return { passwordReset: publicPasswordReset(reset), token };
  }

  async resetPassword({ token, password }) {
    await this.load();
    const reset = activeTokenRecord(this.state.passwordResets, token, "Password reset");
    const user = this.state.users.find((item) => item.id === reset.userId);
    if (!user) throw notFound("User");
    user.passwordHash = hashPassword(password);
    reset.usedAt = nowIso();
    this.state.sessions = this.state.sessions.filter((session) => session.userId !== user.id);
    this.addAuditEvent({ orgId: reset.orgId, actorUserId: user.id, action: "password_reset.completed", targetType: "user", targetId: user.id });
    await this.save();
    return { user: publicUser(user) };
  }

  async listSessions({ orgId, userId = null }) {
    await this.load();
    const memberUserIds = new Set(this.state.memberships.filter((membership) => membership.orgId === orgId).map((membership) => membership.userId));
    return this.state.sessions
      .filter((session) => memberUserIds.has(session.userId) && (!userId || session.userId === userId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((session) => publicSession(session, this.state.users.find((user) => user.id === session.userId)));
  }

  async revokeSession({ orgId, actorUserId, sessionId }) {
    await this.load();
    const session = this.state.sessions.find((item) => item.id === sessionId);
    if (!session || !this.state.memberships.some((membership) => membership.userId === session.userId && membership.orgId === orgId)) {
      throw notFound("Session");
    }
    this.state.sessions = this.state.sessions.filter((item) => item.id !== session.id);
    this.addAuditEvent({ orgId, actorUserId, action: "session.revoked", targetType: "session", targetId: session.id, metadata: { userId: session.userId } });
    await this.save();
    return publicSession(session, this.state.users.find((user) => user.id === session.userId));
  }

  async listProjects(orgId) {
    await this.load();
    return this.state.projects.filter((project) => project.orgId === orgId);
  }

  async createProject({ orgId, actorUserId, name, repoUrl = "", defaultBranch = "main", config = null }) {
    await this.load();
    const project = {
      id: id("prj"),
      orgId,
      name: String(name || "Untitled Project"),
      repoUrl: String(repoUrl || ""),
      defaultBranch: String(defaultBranch || "main"),
      config,
      createdAt: nowIso()
    };
    this.state.projects.push(project);
    this.addAuditEvent({ orgId, actorUserId, action: "project.created", targetType: "project", targetId: project.id });
    await this.save();
    return project;
  }

  getProject(projectId) {
    return this.state.projects.find((project) => project.id === projectId);
  }

  async createRun({ orgId, projectId, actorUserId, trigger = "manual", input, metadata = {} }) {
    await this.load();
    const now = nowIso();
    const run = {
      id: id("run"),
      orgId,
      projectId,
      actorUserId,
      trigger,
      input,
      metadata,
      status: "queued",
      phase: "queued",
      evidenceScore: 0,
      createdAt: now,
      updatedAt: now
    };
    const job = {
      id: id("job"),
      orgId,
      projectId,
      runId: run.id,
      status: "queued",
      phase: "queued",
      claimedBy: null,
      runnerId: null,
      attempt: 0,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      exitReason: null,
      logs: [],
      resourceUsage: {}
    };
    this.state.runs.push(run);
    this.state.jobs.push(job);
    this.addAuditEvent({ orgId, actorUserId, action: "run.created", targetType: "run", targetId: run.id });
    await this.save();
    return { run, job };
  }

  async markJobRunning({ jobId, runnerId, phase = "claimed" }) {
    await this.load();
    const job = this.state.jobs.find((item) => item.id === jobId);
    if (!job) throw notFound("Job");
    const run = this.state.runs.find((item) => item.id === job.runId);
    if (run?.status === "cancelled") {
      const error = new Error("Run was cancelled.");
      error.statusCode = 409;
      throw error;
    }
    job.status = "running";
    job.phase = phase;
    job.runnerId = runnerId;
    job.claimedBy = runnerId;
    job.startedAt ||= nowIso();
    job.attempt = Number(job.attempt || 0) + 1;
    if (run) {
      run.status = "running";
      run.updatedAt = nowIso();
    }
    this.state.jobAttempts.push({
      id: id("att"),
      jobId: job.id,
      runId: job.runId,
      runnerId,
      status: "running",
      startedAt: nowIso(),
      completedAt: null,
      exitReason: null,
      resourceUsage: {}
    });
    await this.save();
    return job;
  }

  async updateJobPhase({ jobId, phase, logs = [] }) {
    await this.load();
    const job = this.state.jobs.find((item) => item.id === jobId);
    if (!job) throw notFound("Job");
    job.phase = phase;
    job.logs = [...(job.logs || []), ...logs];
    await this.save();
    return job;
  }

  async markJobRetrying({ jobId, message, logs = [], nextAttempt = null }) {
    await this.load();
    const job = this.state.jobs.find((item) => item.id === jobId);
    if (!job) throw notFound("Job");
    job.status = "queued";
    job.phase = "retrying";
    job.exitReason = message;
    job.claimedBy = null;
    job.runnerId = null;
    job.completedAt = null;
    job.logs = [...(job.logs || []), ...logs, `retry scheduled${nextAttempt ? ` for attempt ${nextAttempt}` : ""}`];
    const run = this.state.runs.find((item) => item.id === job.runId);
    if (run) {
      run.status = "queued";
      run.error = null;
      run.updatedAt = nowIso();
    }
    const attempt = this.state.jobAttempts.find((item) => item.runId === job.runId && !item.completedAt);
    if (attempt) {
      attempt.status = "retrying";
      attempt.completedAt = nowIso();
      attempt.exitReason = message;
    }
    await this.save();
    return job;
  }

  async completeRun({ runId, certificate, logs = [], status = null, artifacts = [], resourceUsage = {} }) {
    await this.load();
    const run = this.state.runs.find((item) => item.id === runId);
    if (!run) throw notFound("Run");
    if (run.status === "cancelled") {
      const error = new Error("Run was cancelled.");
      error.statusCode = 409;
      throw error;
    }
    run.status = status || certificate?.status || "completed";
    run.evidenceScore = certificate?.selectedPatch?.evidenceScore || 0;
    run.updatedAt = nowIso();
    const insertedArtifacts = artifacts.map(({ kind, artifact }) => ({
      id: id("art"),
      orgId: run.orgId,
      projectId: run.projectId,
      runId,
      kind,
      storageDriver: artifact.storageDriver,
      storageKey: artifact.storageKey,
      sha256: artifact.sha256,
      bytes: artifact.bytes || 0,
      contentType: artifact.contentType || "application/octet-stream",
      createdAt: nowIso()
    }));
    this.state.artifacts.push(...insertedArtifacts);
    const certificateArtifact = insertedArtifacts.find((artifact) => artifact.kind === "certificate");
    const cert = {
      id: id("cert"),
      runId,
      orgId: run.orgId,
      projectId: run.projectId,
      certificate,
      hash: sha256(JSON.stringify(certificate)),
      artifactId: certificateArtifact?.id || null,
      createdAt: nowIso()
    };
    this.state.certificates.push(cert);
    const job = this.state.jobs.find((item) => item.runId === runId);
    if (job) {
      job.status = "completed";
      job.phase = "complete";
      job.startedAt ||= run.createdAt;
      job.completedAt = nowIso();
      job.exitReason = "completed";
      job.logs = logs;
      job.resourceUsage = resourceUsage;
    }
    const attempt = this.state.jobAttempts.find((item) => item.runId === runId && !item.completedAt);
    if (attempt) {
      attempt.status = "completed";
      attempt.completedAt = nowIso();
      attempt.exitReason = "completed";
      attempt.resourceUsage = resourceUsage;
    }
    this.addAuditEvent({ orgId: run.orgId, actorUserId: run.actorUserId, action: "run.completed", targetType: "run", targetId: run.id });
    await this.save();
    return { run, certificate: cert, artifacts: insertedArtifacts };
  }

  async failRun({ runId, message, logs = [] }) {
    await this.load();
    const run = this.state.runs.find((item) => item.id === runId);
    if (!run) throw notFound("Run");
    run.status = "failed";
    run.error = message;
    run.updatedAt = nowIso();
    const job = this.state.jobs.find((item) => item.runId === runId);
    if (job) {
      job.status = "failed";
      job.phase = "failed";
      job.completedAt = nowIso();
      job.exitReason = message;
      job.logs = logs;
    }
    const attempt = this.state.jobAttempts.find((item) => item.runId === runId && !item.completedAt);
    if (attempt) {
      attempt.status = "failed";
      attempt.completedAt = nowIso();
      attempt.exitReason = message;
    }
    this.addAuditEvent({ orgId: run.orgId, actorUserId: run.actorUserId, action: "run.failed", targetType: "run", targetId: run.id });
    await this.save();
    return run;
  }

  async cancelRun({ runId, actorUserId = null, message = "Run cancelled by request." }) {
    await this.load();
    const run = this.state.runs.find((item) => item.id === runId);
    if (!run) throw notFound("Run");
    if (isTerminalRunStatus(run.status) && run.status !== "cancelled") {
      const error = new Error(`Run is already ${run.status} and cannot be cancelled.`);
      error.statusCode = 409;
      throw error;
    }
    const now = nowIso();
    run.status = "cancelled";
    run.phase = "cancelled";
    run.error = message;
    run.updatedAt = now;
    const job = this.state.jobs.find((item) => item.runId === runId);
    if (job) {
      job.status = "cancelled";
      job.phase = "cancelled";
      job.completedAt = job.completedAt || now;
      job.exitReason = message;
      job.logs = [...(job.logs || []), message];
    }
    const attempt = this.state.jobAttempts.find((item) => item.runId === runId && !item.completedAt);
    if (attempt) {
      attempt.status = "cancelled";
      attempt.completedAt = now;
      attempt.exitReason = message;
    }
    this.addAuditEvent({
      orgId: run.orgId,
      actorUserId: actorUserId || run.actorUserId,
      action: "run.cancelled",
      targetType: "run",
      targetId: run.id,
      metadata: { message }
    });
    await this.save();
    return { run, job };
  }

  async reconcileStaleRuns({ staleAfterMs = defaultStaleRunMs(), dryRun = false, now = new Date() } = {}) {
    await this.load();
    const cutoff = now.getTime() - Math.max(1, Number(staleAfterMs));
    const staleJobs = this.state.jobs.filter((job) => {
      if (job.status !== "running") return false;
      const run = this.state.runs.find((item) => item.id === job.runId);
      if (!run || isTerminalRunStatus(run.status)) return false;
      const reference = Date.parse(job.startedAt || run.updatedAt || job.createdAt || "");
      return Number.isFinite(reference) && reference < cutoff;
    });
    const staleRuns = staleJobs.map((job) => ({
      runId: job.runId,
      jobId: job.id,
      runnerId: job.runnerId,
      status: job.status,
      phase: job.phase,
      startedAt: job.startedAt,
      ageMs: now.getTime() - Date.parse(job.startedAt || job.createdAt)
    }));
    if (dryRun) return { dryRun: true, staleRuns, reconciled: 0 };

    const message = `Run reconciled as stale after ${Math.round(Math.max(1, Number(staleAfterMs)) / 60000)} minute(s).`;
    for (const item of staleRuns) {
      await this.failRun({ runId: item.runId, message, logs: [message] });
    }
    return { dryRun: false, staleRuns, reconciled: staleRuns.length };
  }

  async listRuns(orgId, projectId = null) {
    await this.load();
    return this.state.runs
      .filter((run) => run.orgId === orgId && (!projectId || run.projectId === projectId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getRun(runId) {
    await this.load();
    return this.state.runs.find((run) => run.id === runId) || null;
  }

  async getRunDetail(runId) {
    await this.load();
    const run = this.state.runs.find((item) => item.id === runId);
    if (!run) return null;
    return {
      run,
      job: this.state.jobs.find((job) => job.runId === runId) || null,
      certificate: this.state.certificates.find((cert) => cert.runId === runId) || null,
      project: this.state.projects.find((project) => project.id === run.projectId) || null,
      artifacts: this.state.artifacts.filter((artifact) => artifact.runId === runId)
    };
  }

  async getArtifactForRun(runId, kind) {
    await this.load();
    return [...this.state.artifacts].reverse().find((artifact) => artifact.runId === runId && artifact.kind === kind) || null;
  }

  async getSettings(orgId) {
    await this.load();
    return decryptSettingsSecrets(this.state.settings[orgId] || structuredClone(DEFAULT_SETTINGS));
  }

  async updateSettings({ orgId, actorUserId, patch }) {
    await this.load();
    const current = this.state.settings[orgId] || structuredClone(DEFAULT_SETTINGS);
    this.state.settings[orgId] = encryptSettingsSecrets(deepMerge(decryptSettingsSecrets(current), patch || {}));
    this.addAuditEvent({ orgId, actorUserId, action: "settings.updated", targetType: "org", targetId: orgId });
    await this.save();
    return this.state.settings[orgId];
  }

  listAuditEvents(orgId) {
    return this.state.auditEvents.filter((event) => event.orgId === orgId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  addAuditEvent({ orgId, actorUserId, action, targetType, targetId, metadata = {} }) {
    this.state.auditEvents.push({
      id: id("aud"),
      orgId,
      actorUserId,
      action,
      targetType,
      targetId,
      metadata,
      createdAt: nowIso()
    });
  }

  async recordRunnerHeartbeat({ runnerId, status = "online", isolation = "isolated-node-permission-runner", metadata = {} }) {
    await this.load();
    const existing = this.state.runnerHeartbeats.find((runner) => runner.id === runnerId);
    const heartbeat = {
      id: runnerId,
      status,
      isolation,
      metadata,
      lastSeenAt: nowIso()
    };
    if (existing) Object.assign(existing, heartbeat);
    else this.state.runnerHeartbeats.push(heartbeat);
    await this.save();
  }

  async listRunners() {
    await this.load();
    return [...this.state.runnerHeartbeats].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  async upsertGitHubRepository({ orgId, projectId, installationId, owner, repo, fullName }) {
    await this.load();
    const key = `${installationId}:${fullName || `${owner}/${repo}`}`;
    const existing = this.state.githubRepositories.find((item) => item.key === key);
    const row = {
      id: existing?.id || id("ghr"),
      key,
      orgId,
      projectId,
      installationId: String(installationId),
      owner,
      repo,
      fullName: fullName || `${owner}/${repo}`,
      createdAt: existing?.createdAt || nowIso()
    };
    if (existing) Object.assign(existing, row);
    else this.state.githubRepositories.push(row);
    await this.save();
    return row;
  }

  async recordGitHubDelivery({ deliveryId, event = "", repository = "", receivedAt = nowIso() }) {
    await this.load();
    const idValue = String(deliveryId || "").trim();
    if (!idValue) return { duplicate: false, recorded: false };
    const existing = this.state.githubDeliveries.find((delivery) => delivery.deliveryId === idValue);
    if (existing) return { duplicate: true, recorded: false, delivery: existing };
    const delivery = {
      id: id("ghd"),
      deliveryId: idValue,
      event: String(event || ""),
      repository: String(repository || ""),
      receivedAt
    };
    this.state.githubDeliveries.push(delivery);
    await this.save();
    return { duplicate: false, recorded: true, delivery };
  }

  async findProjectByGitHubRepository({ installationId, fullName }) {
    await this.load();
    const repo = this.state.githubRepositories.find((item) => item.installationId === String(installationId) && item.fullName === fullName);
    if (!repo) return null;
    return this.state.projects.find((project) => project.id === repo.projectId) || null;
  }

  metrics() {
    const runs = this.state.runs;
    const jobs = this.state.jobs;
    const terminalRuns = runs.filter((run) => isTerminalRunStatus(run.status));
    const completedJobs = jobs.filter((job) => job.completedAt);
    return {
      runsTotal: runs.length,
      runsCertified: runs.filter((run) => run.status === "certified").length,
      runsRejected: runs.filter((run) => run.status === "rejected").length,
      runsFailed: runs.filter((run) => run.status === "failed").length,
      runsCancelled: runs.filter((run) => run.status === "cancelled").length,
      runDurationMsAvg: averageDurationMs(terminalRuns, "createdAt", "updatedAt"),
      queueDepth: jobs.filter((job) => job.status === "queued").length,
      jobsQueued: jobs.filter((job) => job.status === "queued").length,
      jobsRunning: jobs.filter((job) => job.status === "running").length,
      jobsCompleted: jobs.filter((job) => job.status === "completed").length,
      jobsFailed: jobs.filter((job) => job.status === "failed").length,
      jobsCancelled: jobs.filter((job) => job.status === "cancelled").length,
      jobDurationMsAvg: averageDurationMs(completedJobs, "startedAt", "completedAt"),
      modelCallsTotal: jobs.filter((job) => job.resourceUsage?.modelProvider && job.resourceUsage?.modelProvider !== "disabled").length,
      modelErrorsTotal: jobs.filter((job) => job.status === "failed" && job.resourceUsage?.modelProvider && job.resourceUsage?.modelProvider !== "disabled").length,
      runnerCount: this.state.runnerHeartbeats.filter((runner) => Date.now() - new Date(runner.lastSeenAt).getTime() < 120000).length || 1,
      auditEvents: this.state.auditEvents.length
    };
  }

  async retentionPlan({ now = new Date() } = {}) {
    await this.load();
    const artifactCutoffs = retentionCutoffs(this.state.settings, "artifactDays", now);
    const auditCutoffs = retentionCutoffs(this.state.settings, "auditDays", now);
    return {
      expiredSessions: this.state.sessions.filter((session) => new Date(session.expiresAt).getTime() <= now.getTime()),
      expiredArtifacts: this.state.artifacts.filter((artifact) => isOlderThanOrgCutoff(artifact, artifactCutoffs, DEFAULT_SETTINGS.retention.artifactDays)),
      expiredAuditEvents: this.state.auditEvents.filter((event) => isOlderThanOrgCutoff(event, auditCutoffs, DEFAULT_SETTINGS.retention.auditDays)),
      expiredGitHubDeliveries: this.state.githubDeliveries.filter(
        (delivery) => now.getTime() - new Date(delivery.receivedAt).getTime() > 1000 * 60 * 60 * 24 * 30
      )
    };
  }

  async applyRetentionPlan(plan) {
    await this.load();
    const sessionIds = new Set((plan.expiredSessions || []).map((item) => item.id));
    const artifactIds = new Set((plan.expiredArtifacts || []).map((item) => item.id));
    const auditIds = new Set((plan.expiredAuditEvents || []).map((item) => item.id));
    const deliveryIds = new Set((plan.expiredGitHubDeliveries || []).map((item) => item.id));
    this.state.sessions = this.state.sessions.filter((item) => !sessionIds.has(item.id));
    this.state.artifacts = this.state.artifacts.filter((item) => !artifactIds.has(item.id));
    this.state.certificates = this.state.certificates.map((cert) =>
      artifactIds.has(cert.artifactId) ? { ...cert, artifactId: null } : cert
    );
    this.state.auditEvents = this.state.auditEvents.filter((item) => !auditIds.has(item.id));
    this.state.githubDeliveries = this.state.githubDeliveries.filter((item) => !deliveryIds.has(item.id));
    await this.save();
    return {
      sessions: sessionIds.size,
      artifacts: artifactIds.size,
      auditEvents: auditIds.size,
      githubDeliveries: deliveryIds.size
    };
  }
}

function createEmptyState() {
  return {
    users: [],
    apiKeys: [],
    orgs: [],
    memberships: [],
    sessions: [],
    invitations: [],
    passwordResets: [],
    projects: [],
    runs: [],
    jobs: [],
    jobAttempts: [],
    certificates: [],
    artifacts: [],
    runnerHeartbeats: [],
    githubRepositories: [],
    githubDeliveries: [],
    auditEvents: [],
    settings: {}
  };
}

function mergeState(raw) {
  const state = { ...createEmptyState(), ...(raw || {}), settings: raw?.settings || {} };
  state.sessions = (state.sessions || []).map(normalizeSession);
  return state;
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt };
}

function publicApiKey(key) {
  return {
    id: key.id,
    orgId: key.orgId,
    name: key.name,
    role: key.role,
    createdByUserId: key.createdByUserId,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt
  };
}

function publicInvitation(invitation) {
  return {
    id: invitation.id,
    orgId: invitation.orgId,
    email: invitation.email,
    name: invitation.name || "",
    role: invitation.role,
    createdByUserId: invitation.createdByUserId,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    acceptedAt: invitation.acceptedAt,
    acceptedByUserId: invitation.acceptedByUserId,
    revokedAt: invitation.revokedAt
  };
}

function publicPasswordReset(reset) {
  return {
    id: reset.id,
    orgId: reset.orgId,
    userId: reset.userId,
    createdByUserId: reset.createdByUserId,
    createdAt: reset.createdAt,
    expiresAt: reset.expiresAt,
    usedAt: reset.usedAt
  };
}

function publicSession(session, user = null) {
  return {
    id: session.id,
    userId: session.userId,
    user: user ? publicUser(user) : null,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt
  };
}

function hashPassword(password) {
  if (!password || String(password).length < 8) {
    const error = new Error("Password must be at least 8 characters.");
    error.statusCode = 400;
    throw error;
  }
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(password), salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || "").split(":");
  if (!salt || !expectedHex) return false;
  const actual = Buffer.from(scryptSync(String(password || ""), salt, 32).toString("hex"), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  if (!value.includes("@")) {
    const error = new Error("A valid email is required.");
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function activeTokenRecord(records, token, label) {
  const tokenHash = sha256(String(token || ""));
  const record = records.find((item) => item.tokenHash === tokenHash);
  if (!record || record.revokedAt || record.acceptedAt || record.usedAt || new Date(record.expiresAt).getTime() <= Date.now()) {
    throw statusError(`${label} token is invalid or expired.`, 400);
  }
  return record;
}

function id(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function defaultStaleRunMs() {
  return Number(process.env.PATCHPROOF_STALE_RUN_MS || 30 * 60 * 1000);
}

function isTerminalRunStatus(status) {
  return ["certified", "rejected", "failed", "completed", "cancelled"].includes(String(status || ""));
}

function averageDurationMs(items, startKey, endKey) {
  const durations = items
    .map((item) => Date.parse(item[endKey] || "") - Date.parse(item[startKey] || ""))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (!durations.length) return 0;
  return Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function retentionCutoffs(settingsByOrg, field, now) {
  const entries = Object.entries(settingsByOrg || {});
  return new Map(entries.map(([orgId, settings]) => {
    const days = Number(settings?.retention?.[field] ?? DEFAULT_SETTINGS.retention[field]);
    return [orgId, now.getTime() - Math.max(1, days) * 24 * 60 * 60 * 1000];
  }));
}

function isOlderThanOrgCutoff(item, cutoffs, defaultDays) {
  const cutoff = cutoffs.get(item.orgId) ?? Date.now() - Math.max(1, defaultDays) * 24 * 60 * 60 * 1000;
  return new Date(item.createdAt).getTime() < cutoff;
}

function normalizeSession(session) {
  if (!session || typeof session !== "object") return session;
  if (session.tokenHash) return session;
  if (session.token) {
    const { token, ...rest } = session;
    return { ...rest, tokenHash: sha256(token) };
  }
  return session;
}

function sessionMatchesToken(session, token) {
  const value = String(token || "");
  if (!value) return false;
  const tokenHash = sha256(value);
  return session?.tokenHash === tokenHash || session?.token === value;
}

function notFound(name) {
  const error = new Error(`${name} not found.`);
  error.statusCode = 404;
  return error;
}

function deepMerge(base, patch) {
  const result = structuredClone(base || {});
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(result[key] || {}, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export { DEFAULT_SETTINGS };
