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
  octokit = null
}) {
  if (!settings.github?.applyPatchEnabled) return { created: false, reason: "apply-patch-disabled" };
  const client = octokit || createOctokit({ settings, installationId });
  if (!client) return { created: false, reason: "github-client-not-configured" };
  const branch = `patchproof/${run.id}`;
  const patchPath = `patchproof-patches/${run.id}.patch`;
  const patch = certificate?.selectedPatch?.diff || "";
  if (!patch) return { created: false, reason: "certificate-has-no-diff" };

  const ref = await client.git.getRef({ owner, repo, ref: `heads/${base}` });
  const baseSha = ref.data.object.sha;
  try {
    await client.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
  } catch (error) {
    if (error.status !== 422) throw error;
  }
  let existingSha = null;
  try {
    const existing = await client.repos.getContent({ owner, repo, path: patchPath, ref: branch });
    existingSha = Array.isArray(existing.data) ? null : existing.data.sha;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  await client.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: patchPath,
    branch,
    message: `Add PatchProof patch for ${run.id}`,
    content: Buffer.from(patch, "utf8").toString("base64"),
    sha: existingSha || undefined
  });
  const title = `PatchProof patch for ${run.id}`;
  const body = buildCompletionComment({ run, certificate });
  try {
    const pr = await client.pulls.create({ owner, repo, base, head: branch, title, body });
    return { created: true, number: pr.data.number, url: pr.data.html_url, branch };
  } catch (error) {
    if (error.status !== 422) throw error;
    return { created: false, reason: "pull-request-already-exists", branch };
  }
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
