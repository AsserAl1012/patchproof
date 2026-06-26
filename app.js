import { examples } from "./examples.js";
import { pythonExamples } from "./python-examples.js";

const allExamples = [...examples, ...pythonExamples];

const elements = {
  scenarioList: document.querySelector("#scenarioList"),
  languageInput: document.querySelector("#languageInput"),
  sourceInput: document.querySelector("#sourceInput"),
  testsInput: document.querySelector("#testsInput"),
  bugReportInput: document.querySelector("#bugReportInput"),
  preconditionInput: document.querySelector("#preconditionInput"),
  mayChangeInput: document.querySelector("#mayChangeInput"),
  postconditionInput: document.querySelector("#postconditionInput"),
  modelProviderInput: document.querySelector("#modelProviderInput"),
  modelNameInput: document.querySelector("#modelNameInput"),
  modelBaseUrlInput: document.querySelector("#modelBaseUrlInput"),
  modelApiKeyEnvInput: document.querySelector("#modelApiKeyEnvInput"),
  modelCandidateCountInput: document.querySelector("#modelCandidateCountInput"),
  modelPromptBudgetInput: document.querySelector("#modelPromptBudgetInput"),
  modelUseInput: document.querySelector("#modelUseInput"),
  modelStatusLabel: document.querySelector("#modelStatusLabel"),
  modelCheckButton: document.querySelector("#modelCheckButton"),
  modelCheckOutput: document.querySelector("#modelCheckOutput"),
  runButton: document.querySelector("#runButton"),
  dashboardRunButton: document.querySelector("#dashboardRunButton"),
  applyPatchButton: document.querySelector("#applyPatchButton"),
  resetButton: document.querySelector("#resetButton"),
  copyCertButton: document.querySelector("#copyCertButton"),
  downloadCertButton: document.querySelector("#downloadCertButton"),
  exportRunsButton: document.querySelector("#exportRunsButton"),
  importCertInput: document.querySelector("#importCertInput"),
  evidenceScore: document.querySelector("#evidenceScore"),
  runState: document.querySelector("#runState"),
  functionName: document.querySelector("#functionName"),
  candidateCount: document.querySelector("#candidateCount"),
  candidateList: document.querySelector("#candidateList"),
  historyList: document.querySelector("#historyList"),
  certificateOutput: document.querySelector("#certificateOutput"),
  diffOutput: document.querySelector("#diffOutput"),
  consoleOutput: document.querySelector("#consoleOutput"),
  authState: document.querySelector("#authState"),
  authEmailInput: document.querySelector("#authEmailInput"),
  authPasswordInput: document.querySelector("#authPasswordInput"),
  authOrgInput: document.querySelector("#authOrgInput"),
  bootstrapButton: document.querySelector("#bootstrapButton"),
  loginButton: document.querySelector("#loginButton"),
  logoutButton: document.querySelector("#logoutButton"),
  orgLabel: document.querySelector("#orgLabel"),
  projectNameInput: document.querySelector("#projectNameInput"),
  projectRepoInput: document.querySelector("#projectRepoInput"),
  createProjectButton: document.querySelector("#createProjectButton"),
  githubInstallationInput: document.querySelector("#githubInstallationInput"),
  githubRepoInput: document.querySelector("#githubRepoInput"),
  linkGithubButton: document.querySelector("#linkGithubButton"),
  projectList: document.querySelector("#projectList"),
  selectedProjectLabel: document.querySelector("#selectedProjectLabel"),
  runList: document.querySelector("#runList"),
  loadSettingsButton: document.querySelector("#loadSettingsButton"),
  loadRunnersButton: document.querySelector("#loadRunnersButton"),
  loadApiKeysButton: document.querySelector("#loadApiKeysButton"),
  createApiKeyButton: document.querySelector("#createApiKeyButton"),
  loadInvitationsButton: document.querySelector("#loadInvitationsButton"),
  createInvitationButton: document.querySelector("#createInvitationButton"),
  createPasswordResetButton: document.querySelector("#createPasswordResetButton"),
  loadSessionsButton: document.querySelector("#loadSessionsButton"),
  revokeSessionButton: document.querySelector("#revokeSessionButton"),
  loadAuditButton: document.querySelector("#loadAuditButton"),
  cancelRunButton: document.querySelector("#cancelRunButton"),
  opsEmailInput: document.querySelector("#opsEmailInput"),
  opsRoleInput: document.querySelector("#opsRoleInput"),
  opsSessionInput: document.querySelector("#opsSessionInput"),
  runnerLabel: document.querySelector("#runnerLabel"),
  opsOutput: document.querySelector("#opsOutput"),
  repoRootInput: document.querySelector("#repoRootInput"),
  repoConfigInput: document.querySelector("#repoConfigInput"),
  repoCommandInput: document.querySelector("#repoCommandInput"),
  repoRunTestsInput: document.querySelector("#repoRunTestsInput"),
  repoInstallInput: document.querySelector("#repoInstallInput"),
  repoBuildInput: document.querySelector("#repoBuildInput"),
  repoForceInitInput: document.querySelector("#repoForceInitInput"),
  repoInspectButton: document.querySelector("#repoInspectButton"),
  repoInitButton: document.querySelector("#repoInitButton"),
  repoDetectButton: document.querySelector("#repoDetectButton"),
  repoRepairPreviewButton: document.querySelector("#repoRepairPreviewButton"),
  repoRepairApplyButton: document.querySelector("#repoRepairApplyButton"),
  repoRepairReportButton: document.querySelector("#repoRepairReportButton"),
  repoExportJsonButton: document.querySelector("#repoExportJsonButton"),
  repoExportSarifButton: document.querySelector("#repoExportSarifButton"),
  repoStatusLabel: document.querySelector("#repoStatusLabel"),
  repoSuggestionCount: document.querySelector("#repoSuggestionCount"),
  repoTargetCount: document.querySelector("#repoTargetCount"),
  repoFindingCount: document.querySelector("#repoFindingCount"),
  repoSuggestionList: document.querySelector("#repoSuggestionList"),
  repoTargetList: document.querySelector("#repoTargetList"),
  repoFindingList: document.querySelector("#repoFindingList"),
  repoOutput: document.querySelector("#repoOutput"),
  viewLinks: document.querySelectorAll("[data-view-link]"),
  viewSections: document.querySelectorAll("[data-view]")
};

const RUN_HISTORY_KEY = "patchproof.runHistory.v1";
const AUTH_KEY = "patchproof.auth.v1";
const MAX_SAVED_RUNS = 20;
let activeExample = allExamples[0];
let lastResult = null;
let selectedCandidateId = null;
let auth = readAuth();
let selectedProject = null;
let runPollTimer = null;
let pendingProjectRunId = null;
let lastRepositoryDetectionReport = null;
let lastRepositoryRepairReport = null;
let selectedRunId = null;

function init() {
  bindViewNavigation();
  activateViewFromHash();
  renderScenarios();
  loadExample(activeExample);
  bindEvents();
  renderHistory();
  refreshSession();
}

function renderScenarios() {
  elements.scenarioList.innerHTML = "";
  for (const example of allExamples) {
    const button = document.createElement("button");
    button.className = `scenario-item${example.id === activeExample.id ? " active" : ""}`;
    button.innerHTML = `<strong>${escapeHtml(example.title)}</strong><span>${escapeHtml(example.subtitle)}</span>`;
    button.addEventListener("click", () => {
      activeExample = example;
      renderScenarios();
      loadExample(example);
    });
    elements.scenarioList.appendChild(button);
  }
}

function loadExample(example) {
  elements.languageInput.value = example.language || "javascript";
  elements.sourceInput.value = example.source;
  elements.testsInput.value = JSON.stringify(example.tests, null, 2);
  elements.bugReportInput.value = example.bugReport;
  elements.preconditionInput.value = example.precondition;
  elements.mayChangeInput.value = example.mayChange;
  elements.postconditionInput.value = example.postcondition;
  elements.evidenceScore.textContent = "--";
  elements.runState.textContent = "Idle";
  elements.functionName.textContent = "not compiled";
  elements.candidateCount.textContent = "0 candidates";
  elements.candidateList.textContent = "Run the engine to generate patches.";
  elements.candidateList.className = "candidate-list empty-state";
  elements.certificateOutput.textContent = "{}";
  elements.diffOutput.textContent = "No selected patch yet.";
  elements.consoleOutput.textContent = "No run yet.";
  lastResult = null;
  selectedCandidateId = null;
}

function bindEvents() {
  elements.runButton.addEventListener("click", runEngine);
  elements.dashboardRunButton.addEventListener("click", runProject);
  elements.applyPatchButton.addEventListener("click", applySelectedPatch);
  elements.resetButton.addEventListener("click", () => loadExample(activeExample));
  elements.copyCertButton.addEventListener("click", copyCertificate);
  elements.downloadCertButton.addEventListener("click", downloadCertificate);
  elements.exportRunsButton.addEventListener("click", exportRuns);
  elements.importCertInput.addEventListener("change", importCertificate);
  elements.modelCheckButton.addEventListener("click", checkModelSetup);
  elements.bootstrapButton.addEventListener("click", bootstrapAdmin);
  elements.loginButton.addEventListener("click", login);
  elements.logoutButton.addEventListener("click", logout);
  elements.createProjectButton.addEventListener("click", createProject);
  elements.linkGithubButton.addEventListener("click", linkGithubProject);
  elements.loadSettingsButton.addEventListener("click", loadSettings);
  elements.loadRunnersButton.addEventListener("click", loadRunners);
  elements.loadApiKeysButton.addEventListener("click", loadApiKeys);
  elements.createApiKeyButton.addEventListener("click", createApiKey);
  elements.loadInvitationsButton.addEventListener("click", loadInvitations);
  elements.createInvitationButton.addEventListener("click", createInvitation);
  elements.createPasswordResetButton.addEventListener("click", createPasswordReset);
  elements.loadSessionsButton.addEventListener("click", loadSessions);
  elements.revokeSessionButton.addEventListener("click", revokeSession);
  elements.loadAuditButton.addEventListener("click", loadAudit);
  elements.cancelRunButton.addEventListener("click", cancelSelectedRun);
  elements.repoInspectButton.addEventListener("click", inspectLocalRepository);
  elements.repoInitButton.addEventListener("click", initializeLocalRepository);
  elements.repoDetectButton.addEventListener("click", detectLocalRepository);
  elements.repoRepairPreviewButton.addEventListener("click", previewRepositoryRepairs);
  elements.repoRepairApplyButton.addEventListener("click", applyRepositoryRepairPreview);
  elements.repoRepairReportButton.addEventListener("click", downloadRepositoryRepairReport);
  elements.repoExportJsonButton.addEventListener("click", exportRepositoryJson);
  elements.repoExportSarifButton.addEventListener("click", exportRepositorySarif);
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  });
}

function bindViewNavigation() {
  elements.viewLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      const view = link.dataset.viewLink;
      if (!view) return;
      event.preventDefault();
      showView(view, {
        hash: link.getAttribute("href") || `#${view}`,
        scrollTarget: link.dataset.scrollTarget || ""
      });
    });
  });
  window.addEventListener("hashchange", activateViewFromHash);
}

function activateViewFromHash() {
  const hash = window.location.hash || "#repair";
  if (hash === "#projects" || hash === "#private-workspace") {
    showView("projects", { hash: "#projects" });
    return;
  }
  if (hash === "#repository" || hash === "#repository-workspace") {
    showView("repository", { hash: "#repository" });
    return;
  }
  showView("repair", {
    hash: hash === "#evidence" || hash === "#evidence-workspace" ? "#evidence" : "#repair",
    scrollTarget: hash === "#evidence" || hash === "#evidence-workspace" ? "#evidence-workspace" : ""
  });
}

function showView(view, { hash = `#${view}`, scrollTarget = "" } = {}) {
  elements.viewSections.forEach((section) => {
    section.classList.toggle("active", section.dataset.view === view);
  });
  elements.viewLinks.forEach((link) => {
    const active = link.getAttribute("href") === hash;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (window.location.hash !== hash) {
    history.pushState(null, "", hash);
  }
  if (scrollTarget) {
    window.requestAnimationFrame(() => {
      document.querySelector(scrollTarget)?.scrollIntoView({ block: "start" });
    });
  }
}

function runEngine() {
  elements.runState.textContent = "Running";
  elements.runButton.disabled = true;

  runVerifier(repairPayloadFromUi())
    .then((result) => {
      lastResult = result;
      selectedCandidateId = result.selected.id;
      renderResult(lastResult);
      saveRun(result.certificate);
      renderHistory();
      elements.runState.textContent = lastResult.selected.accepted ? "Certified" : "Needs work";
    })
    .catch((error) => {
      renderError(error);
      elements.runState.textContent = "Error";
    })
    .finally(() => {
      elements.runButton.disabled = false;
    });
}

async function runVerifier(payload) {
  return runViaApi(await maybeAttachBrowserModelCandidates(payload));
}

function repairPayloadFromUi() {
  return {
    language: elements.languageInput.value,
    source: elements.sourceInput.value,
    testsText: elements.testsInput.value,
    bugReport: elements.bugReportInput.value,
    preconditionText: elements.preconditionInput.value,
    mayChangeText: elements.mayChangeInput.value,
    postconditionText: elements.postconditionInput.value
  };
}

function modelSettingsFromUi() {
  return {
    provider: elements.modelProviderInput.value,
    model: elements.modelNameInput.value.trim(),
    baseUrl: elements.modelBaseUrlInput.value.trim(),
    apiKeyEnv: elements.modelApiKeyEnvInput.value.trim() || "PATCHPROOF_MODEL_API_KEY",
    maxCandidates: Number(elements.modelCandidateCountInput.value || 4),
    maxPromptChars: Number(elements.modelPromptBudgetInput.value || 20000)
  };
}

async function maybeAttachBrowserModelCandidates(payload) {
  if (!elements.modelUseInput?.checked || elements.modelProviderInput.value === "disabled") return payload;
  elements.modelStatusLabel.textContent = "Generating";
  const response = await api("/api/model/generate", {
    method: "POST",
    auth: false,
    body: {
      settings: modelSettingsFromUi(),
      input: payload
    }
  });
  elements.modelStatusLabel.textContent = response.candidates.length ? "Generated" : "No candidates";
  elements.modelCheckOutput.textContent = JSON.stringify(response, null, 2);
  return {
    ...payload,
    candidatePatches: response.candidates.map((candidate) => ({
      source: candidate.source,
      title: candidate.title,
      rationale: candidate.rationale,
      generator: candidate.generator,
      provenance: candidate.provenance
    }))
  };
}

async function checkModelSetup() {
  elements.modelStatusLabel.textContent = "Checking";
  elements.modelCheckButton.disabled = true;
  try {
    const response = await api("/api/model/check", {
      method: "POST",
      auth: false,
      body: {
        settings: {
          ...modelSettingsFromUi()
        },
        input: repairPayloadFromUi()
      }
    });
    elements.modelStatusLabel.textContent = response.ok ? "Ready" : "Needs settings";
    elements.modelCheckOutput.textContent = JSON.stringify(response, null, 2);
  } catch (error) {
    elements.modelStatusLabel.textContent = "Error";
    elements.modelCheckOutput.textContent = error.stack || error.message;
  } finally {
    elements.modelCheckButton.disabled = false;
  }
}

async function runViaApi(payload) {
  try {
    const response = await fetch("./api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (response.status === 404) return null;
    const body = await response.json();
    if (!response.ok || !body.ok) {
      throw new Error(body.error?.message || `API run failed with ${response.status}.`);
    }
    return body.result;
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("PatchProof verification requires the local server or CLI. Browser-only execution is disabled for safety.");
    }
    throw error;
  }
}

function renderResult(result) {
  elements.functionName.textContent = result.functionName;
  elements.evidenceScore.textContent = `${Math.round(result.selected.evidenceScore * 100)}%`;
  elements.candidateCount.textContent = `${result.candidates.length} candidates`;
  elements.candidateList.className = "candidate-list";
  elements.candidateList.innerHTML = "";

  for (const candidate of result.candidates) {
    const item = document.createElement("article");
    item.className = `candidate ${candidate.accepted ? "accepted" : "rejected"}${
      candidate.id === result.selected.id ? " selected" : ""
    }`;
    const failedTests = candidate.explicitTests
      ? candidate.explicitTests.tests.filter((test) => !test.pass).map((test) => test.name)
      : [];
    item.innerHTML = `
      <div class="candidate-top">
        <strong>${escapeHtml(candidate.id)}: ${escapeHtml(candidate.title)}</strong>
        <span>${Math.round(candidate.evidenceScore * 100)}%</span>
      </div>
      <div class="candidate-meta">
        <span class="pill ${candidate.accepted ? "ok" : "bad"}">${candidate.accepted ? "accepted" : "rejected"}</span>
        <span class="pill">tests ${candidate.explicitTests ? `${candidate.explicitTests.passCount}/${candidate.explicitTests.tests.length}` : "compile error"}</span>
        <span class="pill">mutation ${candidate.mutation ? candidate.mutation.score.toFixed(2) : "-"}</span>
      </div>
      <p>${escapeHtml(candidate.plannerTrace.rationale)}</p>
      ${failedTests.length ? `<p class="warn">Failed: ${escapeHtml(failedTests.join(", "))}</p>` : ""}
    `;
    item.addEventListener("click", () => {
      selectedCandidateId = candidate.id;
      document.querySelectorAll(".candidate").forEach((candidateNode) => {
        candidateNode.classList.remove("selected");
      });
      item.classList.add("selected");
      elements.diffOutput.textContent = candidate.diff;
      activateTab("diff");
    });
    elements.candidateList.appendChild(item);
  }

  elements.certificateOutput.textContent = JSON.stringify(result.certificate, null, 2);
  elements.diffOutput.textContent = findSelectedCandidate()?.diff || result.selected.diff;
  elements.consoleOutput.innerHTML = result.logs.map((line) => `<div>${escapeHtml(line)}</div>`).join("");
}

function renderError(error) {
  elements.evidenceScore.textContent = "0%";
  elements.candidateCount.textContent = "0 candidates";
  elements.candidateList.className = "candidate-list empty-state";
  elements.candidateList.textContent = error.message;
  elements.certificateOutput.textContent = JSON.stringify(
    {
      schema: "patchproof.certificate.v2",
      status: "error",
      error: error.message
    },
    null,
    2
  );
  elements.diffOutput.textContent = "No diff generated.";
  elements.consoleOutput.textContent = error.stack || error.message;
}

function activateTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === name);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.remove("active"));
  document.querySelector(`#${name}Panel`).classList.add("active");
}

async function copyCertificate() {
  const text = lastResult ? JSON.stringify(lastResult.certificate, null, 2) : elements.certificateOutput.textContent;
  try {
    await writeClipboardText(text);
    elements.runState.textContent = "Copied";
  } catch {
    elements.runState.textContent = "Copy failed";
  }
}

function applySelectedPatch() {
  const candidate = findSelectedCandidate();
  if (!candidate) {
    elements.runState.textContent = "No patch";
    return;
  }
  elements.sourceInput.value = candidate.source;
  elements.runState.textContent = `Applied ${candidate.id}`;
}

function downloadCertificate() {
  const text = lastResult ? JSON.stringify(lastResult.certificate, null, 2) : elements.certificateOutput.textContent;
  const blob = new Blob([text], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${lastResult?.certificate?.runId || "patchproof"}-certificate.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
  elements.runState.textContent = "Downloaded";
}

function downloadJson(filename, value) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json"
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function saveRun(certificate) {
  const history = readHistory().filter((item) => item.runId !== certificate.runId);
  history.unshift({
    runId: certificate.runId,
    status: certificate.status,
    generatedAt: certificate.generatedAt,
    functionName: certificate.target?.function || "unknown",
    score: certificate.selectedPatch?.evidenceScore || 0,
    certificate
  });
  localStorage.setItem(RUN_HISTORY_KEY, JSON.stringify(history.slice(0, MAX_SAVED_RUNS)));
}

function readHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(RUN_HISTORY_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function renderHistory() {
  const history = readHistory();
  if (!history.length) {
    elements.historyList.textContent = "No saved runs yet.";
    return;
  }
  elements.historyList.innerHTML = "";
  for (const item of history) {
    const button = document.createElement("button");
    button.className = `history-item ${item.status}`;
    button.innerHTML = `<strong>${escapeHtml(item.functionName)}</strong><span>${escapeHtml(item.status)} - ${Math.round(item.score * 100)}% - ${escapeHtml(item.runId)}</span>`;
    button.addEventListener("click", () => loadCertificate(item.certificate));
    elements.historyList.appendChild(button);
  }
}

function loadCertificate(certificate) {
  if (certificate.replay?.input) {
    const input = certificate.replay.input;
    elements.sourceInput.value = input.source || "";
    elements.languageInput.value = input.language || certificate.target?.language || "javascript";
    elements.testsInput.value = input.testsText || "[]";
    elements.bugReportInput.value = input.bugReport || "";
    elements.preconditionInput.value = input.preconditionText || "";
    elements.mayChangeInput.value = input.mayChangeText || "";
    elements.postconditionInput.value = input.postconditionText || "";
  }
  elements.certificateOutput.textContent = JSON.stringify(certificate, null, 2);
  elements.diffOutput.textContent = certificate.selectedPatch?.diff || "No diff recorded.";
  elements.consoleOutput.textContent = `Loaded saved certificate ${certificate.runId || ""}. Run PatchProof again to replay it.`;
  elements.evidenceScore.textContent = `${Math.round((certificate.selectedPatch?.evidenceScore || 0) * 100)}%`;
  elements.runState.textContent = certificate.status || "Loaded";
  elements.functionName.textContent = certificate.target?.function || "loaded";
  elements.candidateCount.textContent = `${certificate.candidateSummary?.length || 0} candidates`;
  elements.candidateList.className = "candidate-list empty-state";
  elements.candidateList.textContent = "Saved certificate loaded. Run PatchProof to regenerate candidates.";
  lastResult = null;
  selectedCandidateId = null;
}

function exportRuns() {
  const history = readHistory();
  const blob = new Blob([JSON.stringify(history.map((item) => item.certificate), null, 2)], {
    type: "application/json"
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "patchproof-run-history.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
  elements.runState.textContent = "Exported";
}

async function importCertificate(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const certificates = Array.isArray(parsed) ? parsed : [parsed];
    for (const certificate of certificates) saveRun(certificate);
    renderHistory();
    loadCertificate(certificates[0]);
  } catch (error) {
    renderError(error);
  } finally {
    event.target.value = "";
  }
}

async function inspectLocalRepository() {
  setRepositoryBusy("Inspecting");
  try {
    const response = await api("/api/repository/inspect", {
      method: "POST",
      body: repositoryRequestBody(),
      auth: false
    });
    lastRepositoryDetectionReport = null;
    renderRepositoryInspection(response.report);
    resetRepositoryFindings("Run detection to highlight likely bugs.");
    elements.repoStatusLabel.textContent = "Inspected";
  } catch (error) {
    renderRepositoryError(error);
  }
}

async function initializeLocalRepository() {
  setRepositoryBusy("Creating config");
  try {
    const response = await api("/api/repository/init", {
      method: "POST",
      body: {
        ...repositoryRequestBody(),
        force: elements.repoForceInitInput.checked
      },
      auth: false
    });
    lastRepositoryDetectionReport = null;
    lastRepositoryRepairReport = null;
    updateRepositoryRepairActions();
    renderRepositoryInspection(response.result.report);
    resetRepositoryFindings("Run detection after reviewing the generated config.");
    elements.repoOutput.textContent = JSON.stringify({
      config: response.result.config,
      created: response.result.created,
      overwritten: response.result.overwritten,
      next: "Review generated target fields, then load a target into the Repair Lab."
    }, null, 2);
    elements.repoStatusLabel.textContent = response.result.overwritten ? "Config updated" : "Config created";
  } catch (error) {
    renderRepositoryError(error);
  }
}

async function detectLocalRepository() {
  setRepositoryBusy("Detecting");
  try {
    const response = await api("/api/repository/detect", {
      method: "POST",
      body: {
        ...repositoryRequestBody(),
        runTests: elements.repoRunTestsInput.checked,
        install: elements.repoInstallInput.checked,
        build: elements.repoBuildInput.checked,
        command: elements.repoCommandInput.value.trim() || undefined
      },
      auth: false
    });
    lastRepositoryDetectionReport = response.report;
    lastRepositoryRepairReport = null;
    updateRepositoryRepairActions();
    renderRepositoryInspection(response.report.inspection);
    renderRepositoryFindings(response.report);
    elements.repoOutput.textContent = JSON.stringify(response.report, null, 2);
    elements.repoStatusLabel.textContent = response.report.summary.highestSeverity === "none" ? "Clean" : "Findings";
  } catch (error) {
    renderRepositoryError(error);
  }
}

async function previewRepositoryRepairs(selection = {}) {
  setRepositoryBusy("Repair preview");
  try {
    const response = await api("/api/repository/repair", {
      method: "POST",
      body: {
        ...repositoryRequestBody(),
        dryRun: true,
        apply: false,
        runTests: elements.repoRunTestsInput.checked,
        install: elements.repoInstallInput.checked,
        build: elements.repoBuildInput.checked,
        command: elements.repoCommandInput.value.trim() || undefined,
        fingerprints: selection.fingerprints,
        categories: selection.categories,
        files: selection.files
      },
      auth: false
    });
    lastRepositoryRepairReport = response.report;
    lastRepositoryDetectionReport = {
      ...response.report.detectionBefore,
      repoRoot: response.report.repoRoot,
      generatedAt: response.report.generatedAt
    };
    renderRepositoryFindings({
      summary: response.report.detectionBefore.summary,
      findings: response.report.detectionBefore.findings || []
    });
    elements.repoOutput.textContent = JSON.stringify(response.report, null, 2);
    elements.repoStatusLabel.textContent = response.report.changes.length ? "Repair preview" : "No repairs";
    updateRepositoryRepairActions();
  } catch (error) {
    renderRepositoryError(error);
  } finally {
    clearRepositoryBusy();
  }
}

async function applyRepositoryRepairPreview() {
  if (!lastRepositoryRepairReport?.changes?.length) {
    elements.repoStatusLabel.textContent = "Preview required";
    return;
  }
  const files = [...new Set(lastRepositoryRepairReport.changes.map((change) => change.file))];
  const repairCount = lastRepositoryRepairReport.changes.reduce((total, change) => total + Number(change.repairCount || 0), 0);
  const shouldRunTests = elements.repoRunTestsInput.checked || elements.repoInstallInput.checked || elements.repoBuildInput.checked || Boolean(elements.repoCommandInput.value.trim());
  const confirmation = [
    `Apply ${repairCount} repair(s) across ${files.length} file(s)?`,
    "",
    ...files.slice(0, 12).map((file) => `- ${file}`),
    files.length > 12 ? `- ... ${files.length - 12} more` : "",
    "",
    shouldRunTests
      ? "Project validation will run and failed validation will roll back the file writes."
      : "No project validation is selected; enable Run project tests for stronger certification."
  ].filter(Boolean).join("\n");
  if (!window.confirm(confirmation)) return;

  setRepositoryBusy("Applying repairs");
  try {
    const response = await api("/api/repository/repair", {
      method: "POST",
      body: {
        ...repositoryRequestBody(),
        dryRun: false,
        apply: true,
        runTests: elements.repoRunTestsInput.checked,
        install: elements.repoInstallInput.checked,
        build: elements.repoBuildInput.checked,
        command: elements.repoCommandInput.value.trim() || undefined,
        revertOnFailure: true,
        fingerprints: lastRepositoryRepairReport.selection?.fingerprints,
        categories: lastRepositoryRepairReport.selection?.categories,
        files: lastRepositoryRepairReport.selection?.files
      },
      auth: false
    });
    lastRepositoryRepairReport = response.report;
    lastRepositoryDetectionReport = {
      ...response.report.detectionAfter,
      repoRoot: response.report.repoRoot,
      generatedAt: response.report.generatedAt
    };
    renderRepositoryFindings({
      summary: response.report.detectionAfter?.summary || response.report.detectionBefore?.summary || { highestSeverity: "none" },
      findings: response.report.detectionAfter?.findings || []
    });
    elements.repoOutput.textContent = JSON.stringify(response.report, null, 2);
    elements.repoStatusLabel.textContent = repairStatusLabel(response.report.status);
    updateRepositoryRepairActions();
  } catch (error) {
    renderRepositoryError(error);
  } finally {
    clearRepositoryBusy();
  }
}

function repositoryRequestBody() {
  return {
    repoRoot: elements.repoRootInput.value.trim() || ".",
    configPath: elements.repoConfigInput.value.trim() || "patchproof.yml"
  };
}

function setRepositoryBusy(label) {
  elements.repoStatusLabel.textContent = label;
  elements.repoInspectButton.disabled = true;
  elements.repoInitButton.disabled = true;
  elements.repoDetectButton.disabled = true;
  elements.repoRepairPreviewButton.disabled = true;
  elements.repoRepairApplyButton.disabled = true;
  elements.repoRepairReportButton.disabled = true;
  elements.repoExportJsonButton.disabled = true;
  elements.repoExportSarifButton.disabled = true;
}

function clearRepositoryBusy() {
  elements.repoInspectButton.disabled = false;
  elements.repoInitButton.disabled = false;
  elements.repoDetectButton.disabled = false;
  elements.repoRepairPreviewButton.disabled = false;
  elements.repoExportJsonButton.disabled = false;
  elements.repoExportSarifButton.disabled = false;
  updateRepositoryRepairActions();
}

function updateRepositoryRepairActions() {
  const canApply = Boolean(lastRepositoryRepairReport?.dryRun && lastRepositoryRepairReport?.changes?.length);
  const hasReport = Boolean(lastRepositoryRepairReport);
  if (elements.repoRepairApplyButton) elements.repoRepairApplyButton.disabled = !canApply;
  if (elements.repoRepairReportButton) elements.repoRepairReportButton.disabled = !hasReport;
}

function renderRepositoryInspection(report) {
  clearRepositoryBusy();
  renderRepositorySuggestions(report);
  const targets = report.patchproof?.targets || [];
  elements.repoTargetCount.textContent = `${targets.length} target${targets.length === 1 ? "" : "s"}`;
  if (!targets.length) {
    elements.repoTargetList.className = "dashboard-list empty-state";
    elements.repoTargetList.textContent = report.patchproof?.configured
      ? "No configured targets were found in patchproof.yml."
      : "No patchproof.yml found. Run `patchproof init` from the CLI to create one.";
  } else {
    elements.repoTargetList.className = "dashboard-list";
    elements.repoTargetList.innerHTML = "";
    for (const target of targets) {
      const button = document.createElement("button");
      button.className = "dashboard-item";
      button.innerHTML = `<strong>${escapeHtml(target.id)}</strong><span>${escapeHtml(target.language || "unknown")} - ${escapeHtml(target.source || "no source")} - ${escapeHtml(target.functionName || "no function")}</span>`;
      button.addEventListener("click", () => loadRepositoryTarget(target.id));
      elements.repoTargetList.appendChild(button);
    }
  }
  elements.repoOutput.textContent = JSON.stringify({
    repoRoot: report.repoRoot,
    languages: report.languages,
    frameworks: report.frameworks,
    testCommands: report.testCommands,
    patchproof: report.patchproof,
    suggestions: report.suggestions
  }, null, 2);
}

function renderRepositorySuggestions(report) {
  const suggestions = [
    ...(report.suggestions?.candidateSourceFiles || []).slice(0, 8).map((file) => ({
      kind: "source",
      text: file
    })),
    ...(report.suggestions?.candidatePatchProofTests || []).slice(0, 6).map((file) => ({
      kind: "patchproof tests",
      text: file
    })),
    ...(report.suggestions?.candidateProjectTests || []).slice(0, 6).map((file) => ({
      kind: "project tests",
      text: file
    })),
    ...(report.suggestions?.next || []).slice(0, 6).map((text) => ({
      kind: "next",
      text
    }))
  ];
  elements.repoSuggestionCount.textContent = `${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"}`;
  if (!suggestions.length) {
    elements.repoSuggestionList.className = "dashboard-list empty-state";
    elements.repoSuggestionList.textContent = "No onboarding suggestions were produced for this repository.";
    return;
  }
  elements.repoSuggestionList.className = "dashboard-list";
  elements.repoSuggestionList.innerHTML = "";
  for (const suggestion of suggestions) {
    const item = document.createElement("article");
    item.className = "suggestion-item";
    item.innerHTML = `<strong>${escapeHtml(suggestion.kind)}</strong><span>${escapeHtml(suggestion.text)}</span>`;
    elements.repoSuggestionList.appendChild(item);
  }
}

function renderRepositoryFindings(report) {
  const findings = report.findings || [];
  elements.repoFindingCount.textContent = `${findings.length} finding${findings.length === 1 ? "" : "s"}`;
  if (!findings.length) {
    elements.repoFindingList.className = "dashboard-list empty-state";
    elements.repoFindingList.textContent = report.summary.suppressedFindings
      ? `No active findings. ${report.summary.suppressedFindings} finding(s) suppressed.`
      : "No bug signals were detected.";
    return;
  }
  elements.repoFindingList.className = "dashboard-list";
  elements.repoFindingList.innerHTML = "";
  for (const finding of findings.slice(0, 50)) {
    const item = document.createElement("article");
    item.className = `finding-item severity-${finding.severity}`;
    const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "repository";
    item.innerHTML = `
      <div class="finding-top">
        <strong>${escapeHtml(finding.title)}</strong>
        <span>${escapeHtml(finding.severity)}</span>
      </div>
      <p>${escapeHtml(location)}</p>
      <p>${escapeHtml(finding.message)}</p>
      ${finding.evidence ? `<p class="finding-evidence">${escapeHtml(finding.evidence)}</p>` : ""}
      ${finding.suggestion ? `<p class="finding-suggestion">${escapeHtml(finding.suggestion)}</p>` : ""}
      <code>${escapeHtml(finding.fingerprint || "")}</code>
      <div class="finding-actions">
        <button class="small-button" type="button" data-suppression="${escapeHtml(suppressionRuleForFinding(finding))}">Copy suppression</button>
        ${finding.fingerprint ? `<button class="small-button" type="button" data-repair-fingerprint="${escapeHtml(finding.fingerprint)}">Preview this repair</button>` : ""}
      </div>
    `;
    item.querySelector("[data-suppression]")?.addEventListener("click", async (event) => {
      event.stopPropagation();
      await copyRepositorySuppression(event.currentTarget.dataset.suppression || "");
    });
    item.querySelector("[data-repair-fingerprint]")?.addEventListener("click", async (event) => {
      event.stopPropagation();
      await previewRepositoryRepairs({ fingerprints: [event.currentTarget.dataset.repairFingerprint] });
    });
    elements.repoFindingList.appendChild(item);
  }
}

function resetRepositoryFindings(message) {
  elements.repoFindingCount.textContent = "0 findings";
  elements.repoFindingList.className = "dashboard-list empty-state";
  elements.repoFindingList.textContent = message;
}

function suppressionRuleForFinding(finding) {
  const base = `${finding.category}:${finding.title}`;
  return finding.file ? `${base}@${finding.file}` : base;
}

async function copyRepositorySuppression(rule) {
  try {
    await writeClipboardText(rule);
    elements.repoStatusLabel.textContent = "Suppression copied";
  } catch {
    elements.repoOutput.textContent = `Add this line to .patchproofignore:\n\n${rule}\n`;
    elements.repoStatusLabel.textContent = "Suppression ready";
  }
}

async function writeClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the textarea path for local/dev browser contexts without clipboard permission.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard copy was blocked.");
}

function exportRepositoryJson() {
  if (!lastRepositoryDetectionReport) {
    elements.repoStatusLabel.textContent = "Run detection first";
    return;
  }
  downloadJson("patchproof-detect-report.json", lastRepositoryDetectionReport);
  elements.repoOutput.textContent = JSON.stringify(lastRepositoryDetectionReport, null, 2);
  elements.repoStatusLabel.textContent = "JSON exported";
}

function downloadRepositoryRepairReport() {
  if (!lastRepositoryRepairReport) {
    elements.repoStatusLabel.textContent = "No repair report";
    return;
  }
  downloadJson("patchproof-repair-report.json", lastRepositoryRepairReport);
  elements.repoStatusLabel.textContent = "Repair report downloaded";
}

function repairStatusLabel(status) {
  if (status === "certified") return "Applied and certified";
  if (status === "reverted-failed-tests") return "Rolled back";
  if (status === "failed") return "Applied, tests failed";
  if (status === "applied-unverified") return "Applied unverified";
  return status || "Repair complete";
}

async function exportRepositorySarif() {
  setRepositoryBusy("Exporting SARIF");
  try {
    const response = await api("/api/repository/detect", {
      method: "POST",
      body: {
        ...repositoryRequestBody(),
        runTests: elements.repoRunTestsInput.checked,
        install: elements.repoInstallInput.checked,
        build: elements.repoBuildInput.checked,
        command: elements.repoCommandInput.value.trim() || undefined,
        format: "sarif"
      },
      auth: false
    });
    lastRepositoryDetectionReport = response.report;
    renderRepositoryInspection(response.report.inspection);
    renderRepositoryFindings(response.report);
    downloadJson("patchproof-detect-report.sarif", response.sarif);
    elements.repoOutput.textContent = JSON.stringify(response.sarif, null, 2);
    elements.repoStatusLabel.textContent = "SARIF exported";
  } catch (error) {
    renderRepositoryError(error);
  } finally {
    clearRepositoryBusy();
  }
}

async function loadRepositoryTarget(targetId) {
  setRepositoryBusy("Loading target");
  try {
    const response = await api("/api/repository/target", {
      method: "POST",
      body: { ...repositoryRequestBody(), targetId },
      auth: false
    });
    loadInputIntoRepairLab(response.input);
    elements.repoStatusLabel.textContent = "Target loaded";
    showView("repair", { hash: "#repair" });
  } catch (error) {
    renderRepositoryError(error);
  } finally {
    clearRepositoryBusy();
  }
}

function loadInputIntoRepairLab(input) {
  elements.languageInput.value = input.language || "javascript";
  elements.sourceInput.value = input.source || "";
  elements.testsInput.value = input.testsText || JSON.stringify(input.tests || [], null, 2);
  elements.bugReportInput.value = input.bugReport || "";
  elements.preconditionInput.value = input.preconditionText || input.precondition || "";
  elements.mayChangeInput.value = input.mayChangeText || input.mayChange || "";
  elements.postconditionInput.value = input.postconditionText || input.postcondition || "";
  elements.runState.textContent = `Loaded ${input.repository?.target || "target"}`;
  elements.functionName.textContent = input.repository?.function || "not compiled";
}

function renderRepositoryError(error) {
  clearRepositoryBusy();
  elements.repoStatusLabel.textContent = "Error";
  elements.repoOutput.textContent = error.stack || error.message;
}

async function bootstrapAdmin() {
  try {
    const response = await api("/api/bootstrap", {
      method: "POST",
      body: {
        email: elements.authEmailInput.value,
        password: elements.authPasswordInput.value,
        orgName: elements.authOrgInput.value || "PatchProof"
      },
      auth: false
    });
    elements.authState.textContent = `Bootstrapped ${response.orgs?.[0]?.name || "organization"}`;
    await login();
  } catch (error) {
    elements.authState.textContent = error.message;
  }
}

async function login() {
  try {
    const response = await api("/api/auth/login", {
      method: "POST",
      body: {
        email: elements.authEmailInput.value,
        password: elements.authPasswordInput.value
      },
      auth: false
    });
    auth = { user: response.user, orgs: response.orgs, orgId: response.orgs[0]?.id };
    persistAuth();
    await refreshSession();
  } catch (error) {
    elements.authState.textContent = error.message;
  }
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // Local logout should still clear browser state.
  }
  auth = null;
  selectedProject = null;
  stopRunPolling();
  localStorage.removeItem(AUTH_KEY);
  renderSaasState();
}

async function refreshSession() {
  try {
    const me = await api("/api/me");
    auth = {
      ...(auth || {}),
      user: me.user,
      orgs: me.orgs,
      orgId: auth?.orgId || me.orgs[0]?.id
    };
    persistAuth();
    renderSaasState();
    await loadProjects();
  } catch {
    auth = null;
    localStorage.removeItem(AUTH_KEY);
    renderSaasState();
  }
}

function renderSaasState() {
  if (!auth?.user) {
    elements.authState.textContent = "Not signed in";
    elements.orgLabel.textContent = "No org";
    elements.projectList.textContent = "Login to load projects.";
    elements.runList.textContent = "Create or select a project.";
    elements.opsOutput.textContent = "Login to inspect operations.";
    elements.selectedProjectLabel.textContent = "No project selected";
    elements.runnerLabel.textContent = "Runner unknown";
    stopRunPolling();
    return;
  }
  const org = auth.orgs?.find((item) => item.id === auth.orgId) || auth.orgs?.[0];
  auth.orgId = org?.id;
  elements.authState.textContent = `${auth.user.email}`;
  elements.orgLabel.textContent = `${org?.name || "Org"} - ${org?.role || "member"}`;
}

async function createProject() {
  try {
    const response = await api("/api/projects", {
      method: "POST",
      body: {
        name: elements.projectNameInput.value || "Untitled Project",
        repoUrl: elements.projectRepoInput.value || ""
      }
    });
    selectedProject = response.project;
    await loadProjects();
  } catch (error) {
    elements.projectList.textContent = error.message;
  }
}

async function linkGithubProject() {
  if (!selectedProject) {
    elements.projectList.textContent = "Select a project before linking GitHub.";
    return;
  }
  try {
    const fullName = elements.githubRepoInput.value.trim();
    const response = await api(`/api/projects/${selectedProject.id}/integrations/github`, {
      method: "POST",
      body: {
        installationId: elements.githubInstallationInput.value.trim(),
        fullName
      }
    });
    elements.opsOutput.textContent = JSON.stringify(response.integration, null, 2);
    await loadAudit();
  } catch (error) {
    elements.opsOutput.textContent = error.message;
  }
}

async function loadProjects() {
  if (!auth?.user) return;
  const response = await api("/api/projects");
  if (!response.projects.length) {
    elements.projectList.textContent = "No projects yet.";
    return;
  }
  if (!selectedProject) selectedProject = response.projects[0];
  elements.projectList.innerHTML = "";
  for (const project of response.projects) {
    const button = document.createElement("button");
    button.className = `dashboard-item${selectedProject?.id === project.id ? " active" : ""}`;
    button.innerHTML = `<strong>${escapeHtml(project.name)}</strong><span>${escapeHtml(project.repoUrl || "manual project")}</span>`;
    button.addEventListener("click", async () => {
      selectedProject = project;
      await loadProjects();
      await loadRuns();
    });
    elements.projectList.appendChild(button);
  }
  elements.selectedProjectLabel.textContent = selectedProject?.name || "No project selected";
  await loadRuns();
}

async function runProject() {
  if (!selectedProject) {
    elements.runState.textContent = "No project";
    return;
  }
  elements.runState.textContent = "Project queued";
  try {
    const response = await api(`/api/projects/${selectedProject.id}/runs`, {
      method: "POST",
      body: {
        trigger: "manual-dashboard",
        input: {
          language: elements.languageInput.value,
          source: elements.sourceInput.value,
          testsText: elements.testsInput.value,
          bugReport: elements.bugReportInput.value,
          preconditionText: elements.preconditionInput.value,
          mayChangeText: elements.mayChangeInput.value,
          postconditionText: elements.postconditionInput.value
        }
      }
    });
    elements.opsOutput.textContent = JSON.stringify(response.job || response.run, null, 2);
    elements.runState.textContent = response.run.status;
    pendingProjectRunId = response.run.id;
    await loadRuns();
    startRunPolling();
  } catch (error) {
    renderError(error);
  }
}

async function loadRuns() {
  if (!selectedProject) return;
  const response = await api(`/api/projects/${selectedProject.id}/runs`);
  if (!response.runs.length) {
    elements.runList.textContent = "No runs yet.";
    return;
  }
  elements.runList.innerHTML = "";
  let shouldPoll = false;
  let finishedPendingRun = null;
  for (const run of response.runs.slice(0, 12)) {
    const button = document.createElement("button");
    button.className = "dashboard-item";
    if (["queued", "running"].includes(run.status)) shouldPoll = true;
    if (run.id === pendingProjectRunId && !["queued", "running"].includes(run.status)) finishedPendingRun = run;
    button.innerHTML = `<strong>${escapeHtml(run.status)}</strong><span>${escapeHtml(run.id)} - ${Math.round((run.evidenceScore || 0) * 100)}% - ${escapeHtml(run.createdAt)}</span>`;
    button.addEventListener("click", () => loadRunDetail(run.id));
    elements.runList.appendChild(button);
  }
  if (finishedPendingRun) {
    pendingProjectRunId = null;
    await loadRunDetail(finishedPendingRun.id);
  }
  if (shouldPoll) startRunPolling();
  else stopRunPolling();
}

async function loadRunDetail(runId) {
  try {
    selectedRunId = runId;
    const detail = await api(`/api/runs/${runId}`);
    if (detail.certificate?.certificate) loadCertificate(detail.certificate.certificate);
    else {
      elements.runState.textContent = detail.job?.phase || detail.run.status;
      elements.consoleOutput.textContent = (detail.job?.logs || []).join("\n") || "Run is waiting for a runner.";
    }
    elements.opsOutput.textContent = JSON.stringify({ run: detail.run, job: detail.job, artifacts: detail.artifacts || [] }, null, 2);
  } catch (error) {
    elements.opsOutput.textContent = error.message;
  }
}

function startRunPolling() {
  if (runPollTimer || !selectedProject) return;
  runPollTimer = window.setInterval(async () => {
    if (!auth?.user || !selectedProject) {
      stopRunPolling();
      return;
    }
    try {
      await loadRuns();
    } catch {
      stopRunPolling();
    }
  }, 2500);
}

function stopRunPolling() {
  if (!runPollTimer) return;
  window.clearInterval(runPollTimer);
  runPollTimer = null;
}

async function loadSettings() {
  try {
    const response = await api("/api/admin/settings");
    elements.opsOutput.textContent = JSON.stringify(response.settings, null, 2);
  } catch (error) {
    elements.opsOutput.textContent = error.message;
  }
}

async function loadRunners() {
  try {
    const response = await api("/api/admin/runners");
    elements.runnerLabel.textContent = response.runners[0]?.status || "unknown";
    elements.opsOutput.textContent = JSON.stringify(response.runners, null, 2);
  } catch (error) {
    elements.opsOutput.textContent = error.message;
  }
}

async function loadApiKeys() {
  try {
    const response = await api("/api/admin/api-keys");
    elements.opsOutput.textContent = JSON.stringify(response.apiKeys, null, 2);
  } catch (error) {
    elements.opsOutput.textContent = error.message;
  }
}

async function createApiKey() {
  try {
    const response = await api("/api/admin/api-keys", {
      method: "POST",
      body: { name: `Dashboard key ${new Date().toISOString()}`, role: "developer" }
    });
    elements.opsOutput.textContent = JSON.stringify(
      {
        message: "Store this token now; it is shown once.",
        token: response.token,
        apiKey: response.apiKey
      },
      null,
      2
    );
  } catch (error) {
    elements.opsOutput.textContent = error.message;
  }
}

async function loadInvitations() {
  try {
    const response = await api("/api/admin/invitations");
    elements.opsOutput.textContent = JSON.stringify(response.invitations, null, 2);
  } catch (error) {
    elements.opsOutput.textContent = error.message;
  }
}

async function createInvitation() {
  try {
    const email = elements.opsEmailInput.value.trim();
    if (!email) throw new Error("Enter an email in the operations email field.");
    const response = await api("/api/admin/invitations", {
      method: "POST",
      body: {
        email,
        role: elements.opsRoleInput.value.trim() || "developer"
      }
    });
    elements.opsOutput.textContent = JSON.stringify(
      {
        message: "Deliver this invitation token out of band; it is shown once.",
        token: response.token,
        invitation: response.invitation
      },
      null,
      2
    );
  } catch (error) {
    elements.opsOutput.textContent = error.message;
  }
}

async function createPasswordReset() {
  try {
    const email = elements.opsEmailInput.value.trim();
    if (!email) throw new Error("Enter an email in the operations email field.");
    const response = await api("/api/admin/password-resets", {
      method: "POST",
      body: { email }
    });
    elements.opsOutput.textContent = JSON.stringify(
      {
        message: "Deliver this password reset token out of band; it is shown once.",
        token: response.token,
        passwordReset: response.passwordReset
      },
      null,
      2
    );
  } catch (error) {
    elements.opsOutput.textContent = error.message;
  }
}

async function loadSessions() {
  try {
    const response = await api("/api/admin/sessions");
    elements.opsOutput.textContent = JSON.stringify(response.sessions, null, 2);
  } catch (error) {
    elements.opsOutput.textContent = error.message;
  }
}

async function revokeSession() {
  try {
    const sessionId = elements.opsSessionInput.value.trim();
    if (!sessionId) throw new Error("Enter a session id in the operations session field.");
    const response = await api(`/api/admin/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE"
    });
    elements.opsOutput.textContent = JSON.stringify(response.session, null, 2);
  } catch (error) {
    elements.opsOutput.textContent = error.message;
  }
}

async function loadAudit() {
  try {
    const response = await api("/api/audit-events");
    elements.opsOutput.textContent = JSON.stringify(response.auditEvents.slice(0, 20), null, 2);
  } catch (error) {
    elements.opsOutput.textContent = error.message;
  }
}

async function api(path, { method = "GET", body = null, auth: useAuth = true } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(useAuth && auth?.orgId ? { "X-PatchProof-Org": auth.orgId } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error?.message || `Request failed with ${response.status}.`);
  }
  return payload;
}

function readAuth() {
  try {
    const value = JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
    if (!value || typeof value !== "object") return null;
    const { token, ...rest } = value;
    return rest.user ? rest : null;
  } catch {
    return null;
  }
}

async function cancelSelectedRun() {
  if (!selectedRunId) {
    elements.opsOutput.textContent = "Select a queued or running run first.";
    return;
  }
  try {
    const result = await api(`/api/runs/${selectedRunId}/cancel`, {
      method: "POST",
      body: { message: "Cancelled from dashboard." }
    });
    elements.opsOutput.textContent = JSON.stringify({ run: result.run, job: result.job }, null, 2);
    await loadRuns();
    await loadRunDetail(selectedRunId);
  } catch (error) {
    elements.opsOutput.textContent = error.message;
  }
}

function persistAuth() {
  if (!auth?.user) return;
  const { token, ...safeAuth } = auth;
  localStorage.setItem(AUTH_KEY, JSON.stringify(safeAuth));
}

function findSelectedCandidate() {
  if (!lastResult) return null;
  return (
    lastResult.candidates.find((candidate) => candidate.id === selectedCandidateId) ||
    lastResult.selected ||
    null
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

init();
