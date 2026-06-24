import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

export function githubRepoFromWebhook(payload = {}) {
  const fullName = payload.repository?.full_name || "";
  const [owner, repo] = fullName.split("/");
  return {
    owner,
    repo,
    fullName,
    installationId: payload.installation?.id ? String(payload.installation.id) : "",
    issueNumber: payload.issue?.number || payload.pull_request?.number || null
  };
}

export function buildQueuedComment({ run, command, baseUrl = "" }) {
  const runUrl = baseUrl ? `${baseUrl.replace(/\/$/, "")}/?run=${encodeURIComponent(run.id)}` : run.id;
  return [
    `PatchProof accepted \`/patchproof ${command}\`.`,
    "",
    `Run: ${runUrl}`,
    "Status: queued",
    "",
    "I will post the certificate summary when verification completes."
  ].join("\n");
}

export function buildCompletionComment({ run, certificate, baseUrl = "" }) {
  const certUrl = baseUrl ? `${baseUrl.replace(/\/$/, "")}/api/runs/${encodeURIComponent(run.id)}/certificate` : `run ${run.id}`;
  const score = Math.round((certificate?.selectedPatch?.evidenceScore || run.evidenceScore || 0) * 100);
  const risk = certificate?.risk?.residualRisk || certificate?.residualRisk || "bounded evidence only";
  return [
    `PatchProof completed: **${run.status}**`,
    "",
    `Evidence score: ${score}%`,
    `Selected patch: ${certificate?.selectedPatch?.id || "none"}`,
    `Residual risk: ${risk}`,
    "",
    `Certificate: ${certUrl}`,
    "",
    "Replay locally:",
    "```bash",
    `patchproof verify ${run.id}-certificate.json`,
    "```"
  ].join("\n");
}

export async function postGitHubComment({ settings = {}, installationId, owner, repo, issueNumber, body, octokit = null }) {
  if (!owner || !repo || !issueNumber || !body) return { posted: false, reason: "missing-repository-context" };
  const client = octokit || createOctokit({ settings, installationId });
  if (!client) return { posted: false, reason: "github-client-not-configured" };
  const response = await client.issues.createComment({ owner, repo, issue_number: Number(issueNumber), body });
  return { posted: true, id: response.data.id, url: response.data.html_url };
}

export async function createPatchPullRequest({
  settings = {},
  installationId,
  owner,
  repo,
  base = "main",
  run,
  certificate,
  files = [],
  allowedFilePaths = [],
  octokit = null
}) {
  if (!settings.github?.applyPatchEnabled) return { created: false, reason: "apply-patch-disabled" };
  assertSafeGitHubTarget({ owner, repo, base });
  const repository = `${owner}/${repo}`;
  if (!isRepositoryAllowed(settings.github?.allowedRepositories, repository, { allowEmpty: false })) {
    return { created: false, reason: "repository-not-allowed", repository };
  }
  const client = octokit || createOctokit({ settings, installationId });
  if (!client) return { created: false, reason: "github-client-not-configured" };
  const branch = `patchproof/${run.id}`;
  const patchPath = `patchproof-patches/${run.id}.patch`;
  const patch = certificate?.selectedPatch?.diff || "";
  const fileUpdates = normalizeFileUpdates(files, allowedFilePaths.length ? allowedFilePaths : settings.github?.allowedFilePaths || settings.github?.applyPatchAllowedPaths || []);
  if (!patch && !fileUpdates.length) return { created: false, reason: "certificate-has-no-diff" };

  const ref = await client.git.getRef({ owner, repo, ref: `heads/${base}` });
  const baseSha = ref.data.object.sha;
  try {
    await client.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
  } catch (error) {
    if (error.status !== 422) throw error;
  }
  const updatedFiles = [];
  if (fileUpdates.length) {
    for (const file of fileUpdates) {
      const existingSha = await existingContentSha(client, { owner, repo, path: file.path, ref: branch });
      await client.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: file.path,
        branch,
        message: `Apply PatchProof change for ${run.id}: ${file.path}`,
        content: Buffer.from(file.content, "utf8").toString("base64"),
        sha: existingSha || undefined
      });
      updatedFiles.push(file.path);
    }
  } else {
    const existingSha = await existingContentSha(client, { owner, repo, path: patchPath, ref: branch });
    await client.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: patchPath,
      branch,
      message: `Add PatchProof patch for ${run.id}`,
      content: Buffer.from(patch, "utf8").toString("base64"),
      sha: existingSha || undefined
    });
    updatedFiles.push(patchPath);
  }
  const title = `PatchProof patch for ${run.id}`;
  const body = buildCompletionComment({ run, certificate });
  try {
    const pr = await client.pulls.create({ owner, repo, base, head: branch, title, body });
    return { created: true, number: pr.data.number, url: pr.data.html_url, branch, files: updatedFiles };
  } catch (error) {
    if (error.status !== 422) throw error;
    return { created: false, reason: "pull-request-already-exists", branch, files: updatedFiles };
  }
}

async function existingContentSha(client, { owner, repo, path, ref }) {
  try {
    const existing = await client.repos.getContent({ owner, repo, path, ref });
    return Array.isArray(existing.data) ? null : existing.data.sha;
  } catch (error) {
    if (error.status !== 404) throw error;
    return null;
  }
}

function normalizeFileUpdates(files, allowedFilePaths = []) {
  if (!Array.isArray(files)) return [];
  return files.map((file) => {
    const path = String(file?.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path || path.includes("..") || path.split("/").some((part) => !part || part === ".")) {
      throw policyError("GitHub file updates require safe repository-relative paths.");
    }
    const allowed = Array.isArray(allowedFilePaths) ? allowedFilePaths.filter(Boolean) : [];
    if (allowed.length && !allowed.some((pattern) => matchPath(pattern, path))) {
      throw policyError(`GitHub file update '${path}' is not allowed by the configured path policy.`);
    }
    if (typeof file.content !== "string") throw policyError(`GitHub file update '${path}' is missing string content.`);
    return { path, content: file.content };
  });
}

export function isRepositoryAllowed(allowedRepositories = [], repository = "", { allowEmpty = true } = {}) {
  const allowed = Array.isArray(allowedRepositories) ? allowedRepositories.filter(Boolean) : [];
  if (!allowed.length) return allowEmpty;
  const repo = normalizeRepository(repository);
  return allowed.some((pattern) => matchRepository(pattern, repo));
}

function assertSafeGitHubTarget({ owner, repo, base }) {
  if (!/^[A-Za-z0-9_.-]+$/.test(String(owner || ""))) {
    throw policyError("GitHub owner must be a safe repository owner name.");
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(String(repo || ""))) {
    throw policyError("GitHub repo must be a safe repository name.");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(String(base || "")) || String(base || "").includes("..")) {
    throw policyError("GitHub base branch must be a safe ref name.");
  }
}

function normalizeRepository(value) {
  return String(value || "")
    .trim()
    .replace(/^https:\/\/[^/]+\//, "")
    .replace(/^git@[^:]+:/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

function matchRepository(pattern, repository) {
  const normalized = normalizeRepository(pattern);
  if (normalized === "*" || normalized === repository) return true;
  if (normalized.endsWith("/*")) {
    return repository.startsWith(`${normalized.slice(0, -1)}`);
  }
  return matchPath(normalized, repository);
}

function matchPath(pattern, path) {
  const normalized = String(pattern || "").replace(/\\/g, "/");
  const value = String(path || "").replace(/\\/g, "/");
  if (normalized === "*" || normalized === "**") return true;
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3);
    return value === prefix || value.startsWith(`${prefix}/`);
  }
  if (!normalized.includes("*")) return value === normalized;
  const regex = new RegExp(`^${normalized.split("*").map(escapeRegex).join(".*")}$`);
  return regex.test(value);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function policyError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function createOctokit({ settings = {}, installationId } = {}) {
  const github = settings.github || {};
  const token = github.token || process.env.PATCHPROOF_GITHUB_TOKEN;
  if (token) return new Octokit({ auth: token, baseUrl: github.apiBaseUrl || process.env.PATCHPROOF_GITHUB_API_BASE_URL || undefined });
  const appId = github.appId || process.env.PATCHPROOF_GITHUB_APP_ID;
  const privateKey = normalizePrivateKey(github.privateKey || process.env.PATCHPROOF_GITHUB_PRIVATE_KEY);
  if (!appId || !privateKey || !installationId) return null;
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId,
      privateKey,
      installationId
    },
    baseUrl: github.apiBaseUrl || process.env.PATCHPROOF_GITHUB_API_BASE_URL || undefined
  });
}

function normalizePrivateKey(value = "") {
  return String(value || "").replace(/\\n/g, "\n").trim();
}
