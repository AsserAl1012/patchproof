import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import pg from "pg";
import { DEFAULT_SETTINGS } from "./store.js";
import { normalizeRole } from "./rbac.js";
import { runMigrations, migrationStatus } from "./migrations.js";
import { decryptSettingsSecrets, encryptSettingsSecrets } from "./secrets.js";

const { Pool } = pg;

export class PostgresSaasStore {
  constructor(options = {}) {
    this.pool =
      options.pool ||
      new Pool({
        connectionString: options.connectionString || process.env.DATABASE_URL || "postgres://patchproof:patchproof@127.0.0.1:5432/patchproof",
        max: Number(options.maxConnections || process.env.PATCHPROOF_PG_MAX_CONNECTIONS || 10)
      });
    this.migrationsDir = options.migrationsDir;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    if (process.env.PATCHPROOF_AUTO_MIGRATE !== "false") {
      await runMigrations(this.pool, { migrationsDir: this.migrationsDir });
    }
    this.loaded = true;
  }

  async close() {
    await this.pool.end();
  }

  async health() {
    await this.load();
    await this.pool.query("SELECT 1");
    const migrations = await migrationStatus(this.pool, { migrationsDir: this.migrationsDir });
    return { ok: migrations.ok, driver: "postgres", migrations };
  }

  async hasUsers() {
    await this.load();
    const result = await this.pool.query("SELECT COUNT(*)::int AS count FROM users");
    return result.rows[0].count > 0;
  }

  async bootstrap({ email, password, name = "Owner", orgName = "PatchProof" }) {
    await this.load();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query("SELECT COUNT(*)::int AS count FROM users");
      if (existing.rows[0].count > 0) throw statusError("Bootstrap is already complete.", 409);
      const now = nowIso();
      const org = { id: id("org"), name: String(orgName || "PatchProof"), createdAt: now };
      const user = {
        id: id("usr"),
        email: normalizeEmail(email),
        name: String(name || "Owner"),
        passwordHash: hashPassword(password),
        createdAt: now
      };
      await client.query("INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)", [org.id, org.name, org.createdAt]);
      await client.query("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)", [
        user.id,
        user.email,
        user.name,
        user.passwordHash,
        user.createdAt
      ]);
      await client.query("INSERT INTO memberships (user_id, org_id, role, created_at) VALUES ($1, $2, 'owner', $3)", [
        user.id,
        org.id,
        now
      ]);
      await client.query("INSERT INTO org_settings (org_id, settings) VALUES ($1, $2)", [org.id, JSON.stringify(encryptSettingsSecrets(DEFAULT_SETTINGS))]);
      await insertAuditEvent(client, {
        orgId: org.id,
        actorUserId: user.id,
        action: "bootstrap.completed",
        targetType: "org",
        targetId: org.id,
        metadata: { email: user.email }
      });
      await client.query("COMMIT");
      return { user: publicUser(user), org, role: "owner" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async login({ email, password }) {
    await this.load();
    const result = await this.pool.query("SELECT * FROM users WHERE email = $1", [normalizeEmail(email)]);
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) throw statusError("Invalid email or password.", 401);
    const session = {
      id: id("ses"),
      token: randomBytes(32).toString("hex"),
      tokenHash: "",
      userId: user.id,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString()
    };
    session.tokenHash = sha256(session.token);
    await this.pool.query("INSERT INTO sessions (id, token, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)", [
      session.id,
      session.tokenHash,
      session.userId,
      session.createdAt,
      session.expiresAt
    ]);
    const memberships = await this.membershipsForUser(user.id);
    await this.addAuditEvent({
      orgId: memberships[0]?.orgId || null,
      actorUserId: user.id,
      action: "auth.login",
      targetType: "user",
      targetId: user.id
    });
    return { token: session.token, user: publicUser(fromUserRow(user)), orgs: await this.orgsForUser(user.id) };
  }

  async logout(token) {
    await this.load();
    const tokenHash = sha256(token || "");
    const session = await this.pool.query("DELETE FROM sessions WHERE token IN ($1, $2) RETURNING user_id", [tokenHash, token || ""]);
    const userId = session.rows[0]?.user_id;
    if (userId) {
      const memberships = await this.membershipsForUser(userId);
      await this.addAuditEvent({
        orgId: memberships[0]?.orgId || null,
        actorUserId: userId,
        action: "auth.logout",
        targetType: "user",
        targetId: userId
      });
    }
  }

  async authenticate(token) {
    await this.load();
    const apiKeyAuth = await this.authenticateApiKey(token);
    if (apiKeyAuth) return apiKeyAuth;
    const tokenHash = sha256(token || "");
    const result = await this.pool.query(
      `SELECT s.id AS session_id, s.token, s.user_id, s.created_at AS session_created_at, s.expires_at,
              u.id, u.email, u.name, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token IN ($1, $2) AND s.expires_at > now()`,
      [tokenHash, token || ""]
    );
    const row = result.rows[0];
    if (!row) throw statusError("Authentication required.", 401);
    if (row.token === token) {
      await this.pool.query("UPDATE sessions SET token = $2 WHERE id = $1", [row.session_id, tokenHash]);
    }
    return {
      session: {
        id: row.session_id,
        tokenHash,
        userId: row.user_id,
        createdAt: row.session_created_at?.toISOString?.() || row.session_created_at,
        expiresAt: row.expires_at?.toISOString?.() || row.expires_at
      },
      user: publicUser({ id: row.id, email: row.email, name: row.name, createdAt: iso(row.created_at) }),
      memberships: await this.membershipsForUser(row.user_id)
    };
  }

  async authenticateApiKey(token) {
    if (!String(token || "").startsWith("ppk_")) return null;
    const tokenHash = sha256(token);
    const result = await this.pool.query("SELECT * FROM api_keys WHERE token_hash = $1 AND revoked_at IS NULL", [tokenHash]);
    const key = result.rows[0];
    if (!key) return null;
    await this.pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [key.id]);
    return {
      session: null,
      apiKey: fromApiKeyRow(key),
      user: { id: `api_${key.id}`, email: `api-key:${key.name}`, name: key.name, createdAt: iso(key.created_at) },
      memberships: [{ userId: null, orgId: key.org_id, role: key.role, createdAt: iso(key.created_at) }]
    };
  }

  async orgsForUser(userId) {
    await this.load();
    const result = await this.pool.query(
      `SELECT o.id, o.name, o.created_at, m.role
       FROM memberships m
       JOIN organizations o ON o.id = m.org_id
       WHERE m.user_id = $1
       ORDER BY o.created_at ASC`,
      [userId]
    );
    return result.rows.map((row) => ({ id: row.id, name: row.name, createdAt: iso(row.created_at), role: row.role }));
  }

  async membershipsForUser(userId) {
    await this.load();
    const result = await this.pool.query("SELECT user_id, org_id, role, created_at FROM memberships WHERE user_id = $1", [userId]);
    return result.rows.map((row) => ({ userId: row.user_id, orgId: row.org_id, role: row.role, createdAt: iso(row.created_at) }));
  }

  async roleFor(userId, orgId) {
    await this.load();
    const result = await this.pool.query("SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2", [userId, orgId]);
    return result.rows[0]?.role;
  }

  async createOrg({ actorUserId, name }) {
    await this.load();
    const org = { id: id("org"), name: String(name || "New Organization"), createdAt: nowIso() };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)", [org.id, org.name, org.createdAt]);
      await client.query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'owner')", [actorUserId, org.id]);
      await client.query("INSERT INTO org_settings (org_id, settings) VALUES ($1, $2)", [org.id, JSON.stringify(encryptSettingsSecrets(DEFAULT_SETTINGS))]);
      await insertAuditEvent(client, { orgId: org.id, actorUserId, action: "org.created", targetType: "org", targetId: org.id });
      await client.query("COMMIT");
      return org;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createApiKey({ orgId, actorUserId, name, role = "developer" }) {
    await this.load();
    const normalizedRole = normalizeRole(role);
    if (!["developer", "reviewer", "auditor"].includes(normalizedRole)) {
      throw statusError("API keys can only use developer, reviewer, or auditor roles.", 400);
    }
    const token = `ppk_${randomBytes(32).toString("hex")}`;
    const row = {
      id: id("key"),
      orgId,
      name: String(name || "API key"),
      tokenHash: sha256(token),
      role: normalizedRole,
      createdByUserId: actorUserId,
      createdAt: nowIso()
    };
    await this.pool.query(
      `INSERT INTO api_keys (id, org_id, name, token_hash, role, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.id, orgId, row.name, row.tokenHash, row.role, actorUserId, row.createdAt]
    );
    await this.addAuditEvent({ orgId, actorUserId, action: "api_key.created", targetType: "api_key", targetId: row.id });
    return { apiKey: { ...row, tokenHash: undefined, lastUsedAt: null, revokedAt: null }, token };
  }

  async listApiKeys(orgId) {
    await this.load();
    const result = await this.pool.query("SELECT * FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC", [orgId]);
    return result.rows.map(fromApiKeyRow);
  }

  async revokeApiKey({ orgId, actorUserId, apiKeyId }) {
    await this.load();
    const result = await this.pool.query(
      "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND org_id = $2 RETURNING *",
      [apiKeyId, orgId]
    );
    if (!result.rows[0]) throw statusError("API key not found.", 404);
    await this.addAuditEvent({ orgId, actorUserId, action: "api_key.revoked", targetType: "api_key", targetId: apiKeyId });
    return fromApiKeyRow(result.rows[0]);
  }

  async listProjects(orgId) {
    await this.load();
    const result = await this.pool.query("SELECT * FROM projects WHERE org_id = $1 ORDER BY created_at DESC", [orgId]);
    return result.rows.map(fromProjectRow);
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
    await this.pool.query(
      "INSERT INTO projects (id, org_id, name, repo_url, default_branch, config, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [project.id, project.orgId, project.name, project.repoUrl, project.defaultBranch, JSON.stringify(project.config), project.createdAt]
    );
    await this.addAuditEvent({ orgId, actorUserId, action: "project.created", targetType: "project", targetId: project.id });
    return project;
  }

  async getProject(projectId) {
    await this.load();
    const result = await this.pool.query("SELECT * FROM projects WHERE id = $1", [projectId]);
    return result.rows[0] ? fromProjectRow(result.rows[0]) : null;
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
      logs: []
    };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO runs (id, org_id, project_id, actor_user_id, trigger, status, evidence_score, input, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'queued', 0, $6, $7, $8, $8)`,
        [run.id, orgId, projectId, actorUserId, trigger, JSON.stringify(input || {}), JSON.stringify(metadata || {}), now]
      );
      await client.query(
        `INSERT INTO jobs (id, org_id, project_id, run_id, status, phase, logs, created_at)
         VALUES ($1, $2, $3, $4, 'queued', 'queued', '[]', $5)`,
        [job.id, orgId, projectId, run.id, now]
      );
      await insertAuditEvent(client, { orgId, actorUserId, action: "run.created", targetType: "run", targetId: run.id });
      await client.query("COMMIT");
      return { run, job };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markJobRunning({ jobId, runnerId, phase = "claimed" }) {
    await this.load();
    const now = nowIso();
    const result = await this.pool.query(
      `UPDATE jobs
       SET status = 'running', phase = $2, runner_id = $3, claimed_by = $3, started_at = COALESCE(started_at, $4), attempt = attempt + 1
       WHERE id = $1
       RETURNING *`,
      [jobId, phase, runnerId, now]
    );
    const job = result.rows[0];
    if (!job) throw statusError("Job not found.", 404);
    await this.pool.query("UPDATE runs SET status = 'running', updated_at = $2 WHERE id = $1", [job.run_id, now]);
    await this.pool.query("INSERT INTO job_attempts (id, job_id, run_id, runner_id, status) VALUES ($1, $2, $3, $4, 'running')", [
      id("att"),
      job.id,
      job.run_id,
      runnerId
    ]);
    return fromJobRow(job);
  }

  async updateJobPhase({ jobId, phase, logs = [] }) {
    await this.load();
    const result = await this.pool.query("SELECT logs FROM jobs WHERE id = $1", [jobId]);
    if (!result.rows[0]) throw statusError("Job not found.", 404);
    const mergedLogs = [...(result.rows[0].logs || []), ...logs];
    const updated = await this.pool.query("UPDATE jobs SET phase = $2, logs = $3 WHERE id = $1 RETURNING *", [
      jobId,
      phase,
      JSON.stringify(mergedLogs)
    ]);
    return fromJobRow(updated.rows[0]);
  }

  async completeRun({ runId, certificate, logs = [], status = null, artifacts = [], resourceUsage = {} }) {
    await this.load();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const runResult = await client.query("SELECT * FROM runs WHERE id = $1", [runId]);
      const runRow = runResult.rows[0];
      if (!runRow) throw statusError("Run not found.", 404);
      const now = nowIso();
      const finalStatus = status || certificate?.status || "completed";
      const evidenceScore = certificate?.selectedPatch?.evidenceScore || 0;
      await client.query("UPDATE runs SET status = $2, evidence_score = $3, updated_at = $4 WHERE id = $1", [
        runId,
        finalStatus,
        evidenceScore,
        now
      ]);
      const insertedArtifacts = [];
      for (const artifact of artifacts) {
        insertedArtifacts.push(
          await insertArtifact(client, {
            orgId: runRow.org_id,
            projectId: runRow.project_id,
            runId,
            ...artifact
          })
        );
      }
      const certificateArtifact = insertedArtifacts.find((artifact) => artifact.kind === "certificate");
      const cert = {
        id: id("cert"),
        runId,
        orgId: runRow.org_id,
        projectId: runRow.project_id,
        certificate,
        hash: sha256(JSON.stringify(certificate)),
        artifactId: certificateArtifact?.id || null,
        createdAt: now
      };
      await client.query(
        "INSERT INTO certificates (id, run_id, org_id, project_id, certificate, hash, artifact_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [cert.id, cert.runId, cert.orgId, cert.projectId, JSON.stringify(certificate), cert.hash, cert.artifactId, cert.createdAt]
      );
      await client.query(
        "UPDATE jobs SET status = 'completed', phase = 'complete', completed_at = $2, exit_reason = 'completed', logs = $3, resource_usage = $4 WHERE run_id = $1",
        [runId, now, JSON.stringify(logs), JSON.stringify(resourceUsage)]
      );
      await client.query(
        "UPDATE job_attempts SET status = 'completed', completed_at = $2, exit_reason = 'completed', resource_usage = $3 WHERE run_id = $1 AND completed_at IS NULL",
        [runId, now, JSON.stringify(resourceUsage)]
      );
      await insertAuditEvent(client, { orgId: runRow.org_id, actorUserId: runRow.actor_user_id, action: "run.completed", targetType: "run", targetId: runId });
      await client.query("COMMIT");
      return { run: { ...fromRunRow(runRow), status: finalStatus, evidenceScore, updatedAt: now }, certificate: cert, artifacts: insertedArtifacts };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failRun({ runId, message, logs = [], resourceUsage = {} }) {
    await this.load();
    const now = nowIso();
    const runResult = await this.pool.query("UPDATE runs SET status = 'failed', error = $2, updated_at = $3 WHERE id = $1 RETURNING *", [
      runId,
      message,
      now
    ]);
    if (!runResult.rows[0]) throw statusError("Run not found.", 404);
    await this.pool.query(
      "UPDATE jobs SET status = 'failed', phase = 'failed', completed_at = $2, exit_reason = $3, logs = $4, resource_usage = $5 WHERE run_id = $1",
      [runId, now, message, JSON.stringify(logs), JSON.stringify(resourceUsage)]
    );
    await this.pool.query(
      "UPDATE job_attempts SET status = 'failed', completed_at = $2, exit_reason = $3, resource_usage = $4 WHERE run_id = $1 AND completed_at IS NULL",
      [runId, now, message, JSON.stringify(resourceUsage)]
    );
    const run = fromRunRow(runResult.rows[0]);
    await this.addAuditEvent({ orgId: run.orgId, actorUserId: run.actorUserId, action: "run.failed", targetType: "run", targetId: run.id });
    return run;
  }

  async listRuns(orgId, projectId = null) {
    await this.load();
    const result = await this.pool.query(
      `SELECT * FROM runs WHERE org_id = $1 AND ($2::text IS NULL OR project_id = $2) ORDER BY created_at DESC`,
      [orgId, projectId]
    );
    return result.rows.map(fromRunRow);
  }

  async getRun(runId) {
    await this.load();
    const result = await this.pool.query("SELECT * FROM runs WHERE id = $1", [runId]);
    return result.rows[0] ? fromRunRow(result.rows[0]) : null;
  }

  async getRunDetail(runId) {
    await this.load();
    const result = await this.pool.query("SELECT * FROM runs WHERE id = $1", [runId]);
    const run = result.rows[0];
    if (!run) return null;
    const [job, certificate, project, artifacts] = await Promise.all([
      this.pool.query("SELECT * FROM jobs WHERE run_id = $1", [runId]),
      this.pool.query("SELECT * FROM certificates WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1", [runId]),
      this.pool.query("SELECT * FROM projects WHERE id = $1", [run.project_id]),
      this.pool.query("SELECT * FROM artifacts WHERE run_id = $1 ORDER BY created_at ASC", [runId])
    ]);
    return {
      run: fromRunRow(run),
      job: job.rows[0] ? fromJobRow(job.rows[0]) : null,
      certificate: certificate.rows[0] ? fromCertificateRow(certificate.rows[0]) : null,
      project: project.rows[0] ? fromProjectRow(project.rows[0]) : null,
      artifacts: artifacts.rows.map(fromArtifactRow)
    };
  }

  async getArtifactForRun(runId, kind) {
    await this.load();
    const result = await this.pool.query("SELECT * FROM artifacts WHERE run_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 1", [runId, kind]);
    return result.rows[0] ? fromArtifactRow(result.rows[0]) : null;
  }

  async getSettings(orgId) {
    await this.load();
    const result = await this.pool.query("SELECT settings FROM org_settings WHERE org_id = $1", [orgId]);
    return decryptSettingsSecrets(result.rows[0]?.settings || structuredClone(DEFAULT_SETTINGS));
  }

  async updateSettings({ orgId, actorUserId, patch }) {
    await this.load();
    const current = await this.getSettings(orgId);
    const settings = deepMerge(current, patch || {});
    await this.pool.query(
      `INSERT INTO org_settings (org_id, settings, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (org_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()`,
      [orgId, JSON.stringify(encryptSettingsSecrets(settings))]
    );
    await this.addAuditEvent({ orgId, actorUserId, action: "settings.updated", targetType: "org", targetId: orgId });
    return settings;
  }

  async listAuditEvents(orgId) {
    await this.load();
    const result = await this.pool.query("SELECT * FROM audit_events WHERE org_id = $1 ORDER BY created_at DESC LIMIT 250", [orgId]);
    return result.rows.map(fromAuditRow);
  }

  async addAuditEvent(event) {
    await this.load();
    await insertAuditEvent(this.pool, event);
  }

  async recordRunnerHeartbeat({ runnerId, status = "online", isolation = "docker", metadata = {} }) {
    await this.load();
    await this.pool.query(
      `INSERT INTO runner_heartbeats (runner_id, status, isolation, metadata, last_seen_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (runner_id) DO UPDATE
       SET status = EXCLUDED.status, isolation = EXCLUDED.isolation, metadata = EXCLUDED.metadata, last_seen_at = now()`,
      [runnerId, status, isolation, JSON.stringify(metadata)]
    );
  }

  async listRunners() {
    await this.load();
    const result = await this.pool.query("SELECT * FROM runner_heartbeats ORDER BY last_seen_at DESC LIMIT 100");
    return result.rows.map((row) => ({
      id: row.runner_id,
      status: row.status,
      isolation: row.isolation,
      metadata: row.metadata || {},
      lastSeenAt: iso(row.last_seen_at)
    }));
  }

  async upsertGitHubRepository({ orgId, projectId, installationId, owner, repo, fullName }) {
    await this.load();
    const row = {
      id: id("ghr"),
      orgId,
      projectId,
      installationId: String(installationId),
      owner,
      repo,
      fullName: fullName || `${owner}/${repo}`,
      createdAt: nowIso()
    };
    await this.pool.query(
      `INSERT INTO github_repositories (id, org_id, project_id, installation_id, owner, repo, full_name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (installation_id, full_name) DO UPDATE
       SET org_id = EXCLUDED.org_id, project_id = EXCLUDED.project_id, owner = EXCLUDED.owner, repo = EXCLUDED.repo
       RETURNING *`,
      [row.id, orgId, projectId, row.installationId, owner, repo, row.fullName, row.createdAt]
    );
    return row;
  }

  async findProjectByGitHubRepository({ installationId, fullName }) {
    await this.load();
    const result = await this.pool.query(
      `SELECT p.*
       FROM github_repositories gr
       JOIN projects p ON p.id = gr.project_id
       WHERE gr.installation_id = $1 AND gr.full_name = $2
       LIMIT 1`,
      [String(installationId), fullName]
    );
    return result.rows[0] ? fromProjectRow(result.rows[0]) : null;
  }

  async metrics() {
    await this.load();
    const result = await this.pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM runs) AS runs_total,
        (SELECT COUNT(*)::int FROM runs WHERE status = 'certified') AS runs_certified,
        (SELECT COUNT(*)::int FROM runs WHERE status = 'rejected') AS runs_rejected,
        (SELECT COUNT(*)::int FROM runs WHERE status = 'failed') AS runs_failed,
        (SELECT COUNT(*)::int FROM jobs WHERE status = 'queued') AS queue_depth,
        (SELECT COUNT(*)::int FROM runner_heartbeats WHERE last_seen_at > now() - interval '2 minutes') AS runner_count,
        (SELECT COUNT(*)::int FROM audit_events) AS audit_events
    `);
    const row = result.rows[0];
    return {
      runsTotal: row.runs_total,
      runsCertified: row.runs_certified,
      runsRejected: row.runs_rejected,
      runsFailed: row.runs_failed,
      queueDepth: row.queue_depth,
      runnerCount: row.runner_count,
      auditEvents: row.audit_events
    };
  }
}

async function insertAuditEvent(client, { orgId, actorUserId, action, targetType, targetId, metadata = {} }) {
  await client.query(
    "INSERT INTO audit_events (id, org_id, actor_user_id, action, target_type, target_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [id("aud"), orgId, actorUserId, action, targetType, targetId, JSON.stringify(metadata || {})]
  );
}

async function insertArtifact(client, { orgId, projectId, runId, kind, artifact }) {
  const row = {
    id: id("art"),
    orgId,
    projectId,
    runId,
    kind,
    storageDriver: artifact.storageDriver,
    storageKey: artifact.storageKey,
    sha256: artifact.sha256,
    bytes: artifact.bytes || 0,
    contentType: artifact.contentType || "application/octet-stream",
    createdAt: nowIso()
  };
  await client.query(
    `INSERT INTO artifacts (id, org_id, project_id, run_id, kind, storage_driver, storage_key, sha256, bytes, content_type, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [row.id, orgId, projectId, runId, kind, row.storageDriver, row.storageKey, row.sha256, row.bytes, row.contentType, row.createdAt]
  );
  return row;
}

function fromUserRow(row) {
  return { id: row.id, email: row.email, name: row.name, passwordHash: row.password_hash, createdAt: iso(row.created_at) };
}

function fromProjectRow(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch,
    config: row.config,
    createdAt: iso(row.created_at)
  };
}

function fromRunRow(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    actorUserId: row.actor_user_id,
    trigger: row.trigger,
    status: row.status,
    evidenceScore: Number(row.evidence_score || 0),
    input: row.input,
    metadata: row.metadata || {},
    error: row.error,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function fromJobRow(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    runId: row.run_id,
    status: row.status,
    phase: row.phase || row.status,
    claimedBy: row.claimed_by,
    runnerId: row.runner_id,
    attempt: row.attempt || 0,
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    exitReason: row.exit_reason,
    logs: row.logs || [],
    resourceUsage: row.resource_usage || {}
  };
}

function fromCertificateRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    orgId: row.org_id,
    projectId: row.project_id,
    certificate: row.certificate,
    hash: row.hash,
    artifactId: row.artifact_id,
    createdAt: iso(row.created_at)
  };
}

function fromArtifactRow(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    runId: row.run_id,
    kind: row.kind,
    storageDriver: row.storage_driver,
    storageKey: row.storage_key,
    sha256: row.sha256,
    bytes: Number(row.bytes || 0),
    contentType: row.content_type,
    createdAt: iso(row.created_at)
  };
}

function fromAuditRow(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: row.metadata || {},
    createdAt: iso(row.created_at)
  };
}

function fromApiKeyRow(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    role: row.role,
    createdByUserId: row.created_by_user_id,
    createdAt: iso(row.created_at),
    lastUsedAt: iso(row.last_used_at),
    revokedAt: iso(row.revoked_at)
  };
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt };
}

function hashPassword(password) {
  if (!password || String(password).length < 8) throw statusError("Password must be at least 8 characters.", 400);
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
  if (!value.includes("@")) throw statusError("A valid email is required.", 400);
  return value;
}

function normalizeSettings(settings) {
  return deepMerge(structuredClone(DEFAULT_SETTINGS), settings || {});
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

function id(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function iso(value) {
  return value?.toISOString?.() || value || null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
