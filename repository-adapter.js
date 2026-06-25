import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseBabel } from "@babel/parser";
import { transformSync } from "@babel/core";
import { parsePatchproofConfig } from "./saas/config.js";
import { languageOf } from "./runtime.js";

const here = dirname(fileURLToPath(import.meta.url));
const pytestExtractor = resolve(here, "sandbox", "pytest-extractor.py");

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "__pycache__",
  "venv"
]);

export async function loadRepositoryConfig(options = {}) {
  const repoRoot = resolve(options.repoRoot || process.cwd());
  const configPath = resolveRepoPath(repoRoot, options.configPath || "patchproof.yml", "config");
  const configText = await readFile(configPath, "utf8");
  return {
    repoRoot,
    configPath,
    config: parsePatchproofConfig(configText)
  };
}

export async function listRepositoryTargets(options = {}) {
  const { config } = await loadRepositoryConfig(options);
  return Object.entries(config.targets || {}).map(([id, target]) => ({
    id,
    language: target.language || config.project.language,
    source: target.source || target.sourcePath || target.file || "",
    tests: target.tests || target.testsPath || "",
    frameworkTests: target.frameworkTests || target.projectTests || target.testFile || "",
    framework: target.framework || "",
    functionName: target.function || target.functionName || ""
  }));
}

export async function inspectRepository(options = {}) {
  const repoRoot = resolve(options.repoRoot || process.cwd());
  const configPath = options.configPath || "patchproof.yml";
  const files = await listRepositoryFiles(repoRoot, options.maxFiles || 2500);
  const packageJson = await readJsonIfExists(repoRoot, "package.json");
  const pyproject = await readTextIfExists(repoRoot, "pyproject.toml");
  const pytestIni = await readTextIfExists(repoRoot, "pytest.ini");
  const setupCfg = await readTextIfExists(repoRoot, "setup.cfg");
  const requirements = await readTextIfExists(repoRoot, "requirements.txt");
  const cmakeLists = await readTextIfExists(repoRoot, "CMakeLists.txt");
  const makefile = await readTextIfExists(repoRoot, "Makefile") || await readTextIfExists(repoRoot, "makefile");
  const conanfile = await readTextIfExists(repoRoot, "conanfile.txt") || await readTextIfExists(repoRoot, "conanfile.py");
  const vcpkg = await readTextIfExists(repoRoot, "vcpkg.json");
  const patchproofConfigText = await readTextIfExists(repoRoot, configPath);
  const patchproof = patchproofConfigText
    ? summarizePatchproofConfig(patchproofConfigText, configPath)
    : { configured: false, config: configPath, targets: [], error: null };
  const sourceFiles = files.filter(isSourceFile);
  const testFiles = files.filter(isTestFile);
  const patchproofTestFiles = testFiles.filter((file) => file.endsWith(".patchproof.json"));
  const packageManager = detectPackageManager(files);
  const frameworks = detectFrameworks({ packageJson, pyproject, pytestIni, setupCfg, requirements, cmakeLists, makefile, conanfile, vcpkg, testFiles, files });
  const languages = detectLanguages({ files, packageJson, pyproject });
  const testCommands = detectTestCommands({ packageJson, frameworks });
  const buildCommands = detectBuildCommands({ packageJson, frameworks });
  const frameworkAdapters = detectFrameworkAdapters({ frameworks, testFiles });
  const dependencyFiles = detectDependencyFiles(files);

  return {
    repoRoot,
    git: gitInfo(repoRoot),
    packageManager,
    languages,
    frameworks,
    frameworkAdapters,
    testCommands,
    buildCommands,
    dependencyFiles,
    sourceFiles: sourceFiles.slice(0, 100),
    testFiles: testFiles.slice(0, 100),
    patchproofTestFiles: patchproofTestFiles.slice(0, 100),
    patchproof,
    suggestions: buildInspectionSuggestions({ patchproof, frameworks, sourceFiles, patchproofTestFiles, testFiles, dependencyFiles })
  };
}

export async function initializeRepositoryConfig(options = {}) {
  const repoRoot = resolve(options.repoRoot || process.cwd());
  const configPath = options.configPath || "patchproof.yml";
  const fullConfigPath = resolveRepoPath(repoRoot, configPath, "config");
  const existing = await readTextIfExists(repoRoot, configPath);
  if (existing && !options.force) {
    throw new Error(`${configPath} already exists. Pass --force to overwrite it.`);
  }
  const report = await inspectRepository({ repoRoot, configPath });
  const configText = await buildInitialConfigText(repoRoot, report);
  await writeFile(fullConfigPath, configText, "utf8");
  return {
    repoRoot,
    config: configPath,
    created: !existing,
    overwritten: Boolean(existing),
    report,
    configText
  };
}

export async function doctorRepository(options = {}) {
  const report = await inspectRepository(options);
  const checks = [];
  addCheck(checks, "node", "ok", `Node ${process.versions.node} is available.`);
  if (!report.patchproof.configured) {
    addCheck(checks, "config", "warning", `${report.patchproof.config} is missing. Run patchproof init --repo ${report.repoRoot}`);
  } else if (report.patchproof.error) {
    addCheck(checks, "config", "error", `Invalid ${report.patchproof.config}: ${report.patchproof.error}`);
  } else {
    addCheck(checks, "config", "ok", `${report.patchproof.config} is valid with ${report.patchproof.targets.length} target(s).`);
  }

  if (!report.testCommands.length) {
    addCheck(checks, "tests", "warning", "No project test command was detected.");
  } else {
    for (const item of report.testCommands) {
      addCheck(checks, `tests:${item.tool}`, "ok", `Detected test command: ${item.command}`);
    }
  }

  if (report.languages.includes("python")) {
    const python = pythonInfo();
    addCheck(
      checks,
      "python",
      python.available ? "ok" : "warning",
      python.available
        ? `${python.executable} is available (${python.version}).`
        : "Python was detected in the checkout but no Python executable was found."
    );
  }

  for (const adapter of report.frameworkAdapters) {
    addCheck(
      checks,
      `adapter:${adapter.framework}`,
      adapter.supported ? "ok" : "warning",
      adapter.supported
        ? `${adapter.framework} adapter can extract simple literal assertions from ${adapter.testFiles.length} file(s).`
        : `${adapter.framework} was detected but no adapter is available.`
    );
  }

  if (report.patchproof.configured && !report.patchproof.error) {
    const targetChecks = await diagnoseTargets(options);
    checks.push(...targetChecks);
  }

  const overall = checks.some((check) => check.status === "error")
    ? "error"
    : checks.some((check) => check.status === "warning")
      ? "warning"
      : "ok";
  return { overall, report, checks };
}

export async function detectRepositoryBugs(options = {}) {
  const repoRoot = resolve(options.repoRoot || process.cwd());
  const configPath = options.configPath || "patchproof.yml";
  const maxFiles = Number(options.maxFiles || 5000);
  const maxScanFiles = Number(options.maxScanFiles || 400);
  const maxTargets = Number(options.maxTargets || 20);
  const report = await inspectRepository({ repoRoot, configPath, maxFiles });
  const files = await listRepositoryFiles(repoRoot, maxFiles);
  const sourceFiles = files.filter(isSourceFile);
  const findings = [];
  const scannedSourceFiles = sourceFiles.slice(0, maxScanFiles);
  let skippedGeneratedFiles = 0;

  if (sourceFiles.length > scannedSourceFiles.length) {
    findings.push(repositoryFinding({
      severity: "info",
      category: "scan-limit",
      title: "Source scan was capped",
      message: `Scanned ${scannedSourceFiles.length} of ${sourceFiles.length} source files. Increase --max-scan-files for a wider pass.`
    }));
  }

  for (const file of scannedSourceFiles) {
    const text = await readTextIfExists(repoRoot, file);
    if (text === null) continue;
    if (isGeneratedSourceFile(file, text)) {
      skippedGeneratedFiles += 1;
      continue;
    }
    findings.push(...scanSourceForBugSignals(file, text));
  }

  if (!report.patchproof.configured) {
    findings.push(repositoryFinding({
      severity: "medium",
      category: "configuration",
      title: "PatchProof config is missing",
      message: "No patchproof.yml was found, so configured target validation could not run.",
      suggestion: "Run `patchproof init --repo <path>` to generate a starter configuration."
    }));
  } else if (report.patchproof.error) {
    findings.push(repositoryFinding({
      severity: "high",
      category: "configuration",
      title: "PatchProof config is invalid",
      message: report.patchproof.error,
      suggestion: "Fix patchproof.yml before running target-level detection."
    }));
  } else {
    findings.push(...await detectConfiguredTargetFailures({ repoRoot, configPath, maxTargets }));
  }

  let projectTest = null;
  if (options.runTests) {
    try {
      projectTest = await runRepositoryTestCommand({
        repoRoot,
        configPath,
        command: options.command,
        install: options.install,
        installCommand: options.installCommand,
        build: options.build,
        buildCommand: options.buildCommand,
        timeoutSeconds: options.timeoutSeconds,
        maxBuffer: options.maxBuffer
      });
      if (!projectTest.ok) {
        projectTest.frameworkFailures = analyzeProjectTestOutput(projectTest, repoRoot);
        findings.push(repositoryFinding({
          severity: "high",
          category: "project-tests",
          title: "Repository test command failed",
          message: `${projectTest.command} exited with status ${projectTest.status ?? "unknown"}.`,
          evidence: summarizeProcessOutput(projectTest),
          suggestion: "Open the failing test output and map the affected function into a PatchProof target."
        }));
        for (const failure of projectTest.frameworkFailures.slice(0, 10)) {
          findings.push(repositoryFinding({
            severity: "high",
            category: "framework-test-failure",
            file: failure.file,
            line: failure.line,
            title: "Framework test failure mapped to file",
            message: failure.name
              ? `${failure.name} failed in ${failure.file || "the repository test output"}.`
              : `A failing test stack frame was mapped to ${failure.file || "the repository test output"}.`,
            evidence: failure.evidence,
            suggestion: "Use this failing test as the starting point for a PatchProof target or repository repair preview."
          }));
        }
      }
    } catch (error) {
      findings.push(repositoryFinding({
        severity: "medium",
        category: "project-tests",
        title: "Repository test command could not run",
        message: error.message,
        suggestion: "Configure project.testCommand in patchproof.yml or pass --command."
      }));
    }
  }

  const suppressionRules = await loadDetectionSuppressions({ repoRoot, configPath, options });
  const suppressionResult = applyFindingSuppressions(findings, suppressionRules);
  const summary = summarizeFindings(suppressionResult.findings);
  return {
    repoRoot,
    generatedAt: new Date().toISOString(),
    summary: {
      ...summary,
      languages: report.languages,
      frameworks: report.frameworks,
      sourceFiles: sourceFiles.length,
      scannedSourceFiles: scannedSourceFiles.length,
      skippedGeneratedFiles,
      testFiles: files.filter(isTestFile).length,
      configuredTargets: report.patchproof.targets.length,
      suppressedFindings: suppressionResult.suppressedFindings.length
    },
    findings: suppressionResult.findings,
    suppressedFindings: suppressionResult.suppressedFindings,
    suppressions: suppressionResult.suppressions,
    inspection: report,
    projectTest
  };
}

export async function extractFrameworkTests(options = {}) {
  const repoRoot = resolve(options.repoRoot || process.cwd());
  const testPath = options.testPath || options.frameworkTests || options.projectTests;
  const functionName = String(options.functionName || options.function || "").trim();
  if (!testPath) throw new Error("framework test extraction requires a testPath.");
  if (!functionName) throw new Error("framework test extraction requires functionName.");
  const fullPath = resolveRepoPath(repoRoot, testPath, "framework tests");
  const text = await readFile(fullPath, "utf8");
  const framework = normalizeFramework(options.framework || inferFrameworkFromPath(testPath));
  const tests = framework === "pytest"
    ? parsePytestAssertions(text, functionName)
    : parseJavaScriptFrameworkAssertions(text, functionName, framework);
  if (!tests.length) {
    throw new Error(`No simple ${framework} assertions for '${functionName}' were found in ${testPath}.`);
  }
  return tests;
}

export async function createInputFromRepositoryTarget(options = {}) {
  const { repoRoot, configPath, config } = await loadRepositoryConfig(options);
  const targets = config.targets || {};
  const targetId = selectTargetId(targets, options.targetId);
  const target = targets[targetId];
  const configuredLanguage = String(target.language || config.project.language || "javascript").toLowerCase();
  const repositoryLanguage = normalizeRepositoryLanguage(configuredLanguage);
  if (["c", "cpp"].includes(repositoryLanguage)) {
    throw new Error("C/C++ targets use repository-level static repair. Run `patchproof repair-repo --repo <path> --apply --run-tests` instead of function-level repair.");
  }
  const language = repositoryLanguage === "typescript" ? "javascript" : languageOf({ language: repositoryLanguage });

  const sourcePath = target.source || target.sourcePath || target.file;
  const testsPath = target.tests || target.testsPath || (String(target.testFile || "").endsWith(".patchproof.json") ? target.testFile : "");
  const frameworkTestsPath = target.frameworkTests || target.projectTests || (!testsPath ? target.testFile : "");
  if (!sourcePath) throw new Error(`Repository target '${targetId}' is missing source.`);
  if (!testsPath && !frameworkTestsPath) {
    throw new Error(`Repository target '${targetId}' is missing tests or frameworkTests.`);
  }

  assertAllowedTargetPath(config, repoRoot, sourcePath, "source");
  if (testsPath) assertAllowedTargetPath(config, repoRoot, testsPath, "tests");
  if (frameworkTestsPath) assertAllowedTargetPath(config, repoRoot, frameworkTestsPath, "framework tests");
  const sourceFile = resolveRepoPath(repoRoot, sourcePath, "source");
  const testsFile = testsPath ? resolveRepoPath(repoRoot, testsPath, "tests") : null;
  const functionName = target.function || target.functionName || "";
  const sourceText = await readFile(sourceFile, "utf8");
  const tests = testsFile
    ? normalizeTestsFile(await readFile(testsFile, "utf8"), testsFile)
    : JSON.stringify(await extractFrameworkTests({
      repoRoot,
      testPath: frameworkTestsPath,
      functionName,
      framework: target.framework || config.project?.testFramework
    }), null, 2);
  const source = language === "python"
    ? extractPythonFunction(sourceText, functionName, sourcePath)
    : extractJavaScriptFunction(sourceText, functionName, sourcePath);

  return {
    language,
    functionName: functionName || inferredFunctionName(language, source),
    source,
    testsText: tests,
    bugReport: target.bugReport || target.bug || "",
    preconditionText: target.preconditionText || target.precondition || "",
    mayChangeText: target.mayChangeText || target.mayChange || "",
    postconditionText: target.postconditionText || target.postcondition || "",
    executionMode: "repository-adapter",
    limits: buildTargetLimits(config, target),
    repository: {
      root: repoRoot,
      config: relative(repoRoot, configPath),
      target: targetId,
      source: toRepoPath(repoRoot, sourceFile),
      tests: testsFile ? toRepoPath(repoRoot, testsFile) : frameworkTestsPath,
      testSource: testsFile ? "patchproof-json" : "framework-adapter",
      function: functionName || inferredFunctionName(language, source)
    }
  };
}

export async function applyCertificatePatchToRepositoryTarget(options = {}) {
  const certificate = options.certificate;
  if (!certificate || typeof certificate !== "object") throw new Error("certificate is required.");
  const selected = certificate.selectedPatch;
  if (certificate.status !== "certified" || !selected?.accepted || !selected.source) {
    throw new Error("Only an accepted certified patch can be applied.");
  }
  const { repoRoot, config, configPath } = await loadRepositoryConfig(options);
  const targets = config.targets || {};
  const targetId = selectTargetId(targets, options.targetId || certificate.replay?.input?.repository?.target);
  const target = targets[targetId];
  const configuredLanguage = String(target.language || config.project.language || certificate.target?.language || "javascript").toLowerCase();
  const repositoryLanguage = normalizeRepositoryLanguage(configuredLanguage);
  if (["c", "cpp"].includes(repositoryLanguage)) {
    throw new Error("C/C++ patch application is handled by `patchproof repair-repo`; function-level certificate application is only available for JavaScript/TypeScript/Python targets.");
  }
  const language = repositoryLanguage === "typescript" ? "javascript" : languageOf({ language: repositoryLanguage });
  const sourcePath = target.source || target.sourcePath || target.file;
  if (!sourcePath) throw new Error(`Repository target '${targetId}' is missing source.`);
  assertAllowedTargetPath(config, repoRoot, sourcePath, "source");
  const sourceFile = resolveRepoPath(repoRoot, sourcePath, "source");
  const sourceText = await readFile(sourceFile, "utf8");
  const functionName = target.function || target.functionName || certificate.target?.function || "";
  const expectedSource = certificate.replay?.input?.source || "";
  const replacement = language === "python"
    ? replacePythonFunctionSource(sourceText, functionName, selected.source, expectedSource, sourcePath)
    : replaceJavaScriptFunctionSource(sourceText, functionName, selected.source, expectedSource, sourcePath);
  const diff = unifiedSourceDiff(sourceText, replacement.source);
  if (!options.dryRun) await writeFile(sourceFile, replacement.source, "utf8");
  return {
    applied: !options.dryRun,
    dryRun: Boolean(options.dryRun),
    repoRoot,
    config: relative(repoRoot, configPath),
    target: targetId,
    source: toRepoPath(repoRoot, sourceFile),
    function: replacement.functionName,
    diff
  };
}

export async function repairRepository(options = {}) {
  const repoRoot = resolve(options.repoRoot || process.cwd());
  const configPath = options.configPath || "patchproof.yml";
  const dryRun = options.dryRun !== false && !options.apply;
  const maxRepairs = Math.max(1, Number(options.maxRepairs || 25));
  const selection = normalizeRepairSelection(options);
  let repairConfig = null;
  let repairConfigError = null;
  try {
    repairConfig = (await loadRepositoryConfig({ repoRoot, configPath })).config;
  } catch (error) {
    repairConfigError = error.message;
  }
  const detectionBefore = await detectRepositoryBugs({
    repoRoot,
    configPath,
    maxFiles: options.maxFiles,
    maxScanFiles: options.maxScanFiles,
    suppressions: options.suppressions,
    suppressionsPath: options.suppressionsPath,
    defaultSuppressions: options.defaultSuppressions
  });
  const sourceTexts = new Map();
  const plansByFile = new Map();
  const skippedRepairs = [];

  for (const finding of detectionBefore.findings || []) {
    if (repairPlanCount(plansByFile) >= maxRepairs) break;
    if (!finding.file || !finding.line) continue;
    if (!repairSelectionAllows(finding, selection)) continue;
    let fullPath;
    try {
      fullPath = resolveRepoPath(repoRoot, finding.file, "repair target");
      if (repairConfig) assertAllowedTargetPath(repairConfig, repoRoot, finding.file, "repair target");
    } catch (error) {
      skippedRepairs.push(skippedRepairForFinding(finding, error.message));
      continue;
    }
    let text = sourceTexts.get(finding.file);
    if (text === undefined) {
      text = await readFile(fullPath, "utf8");
      sourceTexts.set(finding.file, text);
    }
    const repair = repairForFinding(finding, text);
    if (!repair) continue;
    const existing = plansByFile.get(finding.file) || {
      file: finding.file,
      fullPath,
      original: text,
      replacements: []
    };
    if (existing.replacements.some((item) => item.line === repair.line)) continue;
    existing.replacements.push(repair);
    plansByFile.set(finding.file, existing);
  }

  const changes = buildRepositoryRepairChanges(plansByFile);
  if (!changes.length) {
    return repositoryRepairReport({
      repoRoot,
      configPath,
      status: "no-candidates",
      dryRun,
      changes,
      detectionBefore,
      detectionAfter: detectionBefore,
      projectTest: null,
      repairContext: { selection, repairConfig, repairConfigError, maxRepairs, skippedRepairs },
      message: "No conservative static repair candidates were available for the active findings."
    });
  }

  if (dryRun) {
    return repositoryRepairReport({
      repoRoot,
      configPath,
      status: "preview",
      dryRun,
      changes,
      detectionBefore,
      detectionAfter: projectedDetectionAfter(detectionBefore, changes),
      projectTest: null,
      repairContext: { selection, repairConfig, repairConfigError, maxRepairs, skippedRepairs },
      message: "Repair preview generated. Re-run with --apply to write the changes."
    });
  }

  for (const change of changes) {
    await writeFile(change.fullPath, change.nextSource, "utf8");
  }

  let projectTest = null;
  let status = "applied-unverified";
  let message = "Static repairs were written. No project test command was requested.";
  const shouldRunTests = Boolean(options.runTests || options.command || options.install || options.build);
  if (shouldRunTests) {
    projectTest = await runRepositoryTestCommand({
      repoRoot,
      configPath,
      command: options.command,
      install: options.install,
      installCommand: options.installCommand,
      build: options.build,
      buildCommand: options.buildCommand,
      timeoutSeconds: options.timeoutSeconds,
      maxBuffer: options.maxBuffer
    });
    if (projectTest.ok) {
      status = "certified";
      message = "Static repairs were written and the configured project validation command passed.";
    } else {
      status = "failed";
      message = "Static repairs were written but project validation failed.";
      if (options.revertOnFailure !== false) {
        for (const change of changes) {
          await writeFile(change.fullPath, change.originalSource, "utf8");
        }
        status = "reverted-failed-tests";
        message = "Static repairs failed project validation and were reverted.";
      }
    }
  }

  const detectionAfter = await detectRepositoryBugs({
    repoRoot,
    configPath,
    maxFiles: options.maxFiles,
    maxScanFiles: options.maxScanFiles,
    suppressions: options.suppressions,
    suppressionsPath: options.suppressionsPath,
    defaultSuppressions: options.defaultSuppressions
  });

  return repositoryRepairReport({
    repoRoot,
    configPath,
    status,
    dryRun: false,
    changes,
    detectionBefore,
    detectionAfter,
    projectTest,
    repairContext: { selection, repairConfig, repairConfigError, maxRepairs, skippedRepairs },
    message
  });
}

export async function runRepositoryTestCommand(options = {}) {
  const repoRoot = resolve(options.repoRoot || process.cwd());
  let config = null;
  let target = null;
  try {
    const loaded = await loadRepositoryConfig(options);
    config = loaded.config;
    const targets = config.targets || {};
    if (options.targetId || Object.keys(targets).length === 1) {
      target = targets[selectTargetId(targets, options.targetId)];
    }
  } catch (error) {
    if (!options.command) {
      throw error;
    }
  }
  const command = String(
    options.command ||
      target?.testCommand ||
      config?.project?.testCommand ||
      (await inspectRepository({ repoRoot, configPath: options.configPath || "patchproof.yml" })).testCommands[0]?.command ||
      ""
  ).trim();
  assertSafeProjectCommand(command);
  const installCommand = String(
    options.installCommand ||
      target?.installCommand ||
      config?.project?.installCommand ||
      ""
  ).trim();
  const buildCommand = String(
    options.buildCommand ||
      target?.buildCommand ||
      config?.project?.buildCommand ||
      ""
  ).trim();
  if (options.install && installCommand) assertSafeProjectCommand(installCommand);
  if (options.build && buildCommand) assertSafeProjectCommand(buildCommand);
  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs || options.timeoutSeconds * 1000 || target?.testTimeoutSeconds * 1000 || config?.runner?.timeoutSeconds * 1000 || 600000)
  );
  let install = null;
  const startedAt = Date.now();
  if (options.install && installCommand) {
    install = await spawnProjectCommand({ repoRoot, command: installCommand, timeoutMs, maxBuffer: options.maxBuffer });
    if (!install.ok) {
      return {
        ok: false,
        phase: "install",
        command,
        installCommand,
        install,
        repoRoot,
        status: install.status,
        signal: install.signal,
        durationMs: Date.now() - startedAt,
        timedOut: install.timedOut,
        error: install.error,
        stdout: install.stdout,
        stderr: install.stderr
      };
    }
  }
  let build = null;
  if (options.build && buildCommand) {
    build = await spawnProjectCommand({ repoRoot, command: buildCommand, timeoutMs, maxBuffer: options.maxBuffer });
    if (!build.ok) {
      return {
        ok: false,
        phase: "build",
        command,
        installCommand,
        buildCommand,
        install,
        build,
        repoRoot,
        status: build.status,
        signal: build.signal,
        durationMs: Date.now() - startedAt,
        timedOut: build.timedOut,
        error: build.error,
        stdout: build.stdout,
        stderr: build.stderr
      };
    }
  }
  const result = await spawnProjectCommand({ repoRoot, command, timeoutMs, maxBuffer: options.maxBuffer });
  return {
    ...result,
    phase: "test",
    command,
    installCommand: installCommand || "",
    buildCommand: buildCommand || "",
    install,
    build,
    repoRoot,
    durationMs: Date.now() - startedAt
  };
}

function spawnProjectCommand({ repoRoot, command, timeoutMs, maxBuffer }) {
  const startedAt = Date.now();
  const result = spawnSync(command, {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: Number(maxBuffer || 10 * 1024 * 1024),
    env: {
      ...process.env,
      CI: process.env.CI || "true",
      PATCHPROOF: "1"
    }
  });
  return {
    ok: result.status === 0 && !result.error,
    command,
    status: result.status,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    timedOut: result.error?.code === "ETIMEDOUT",
    error: result.error ? result.error.message : null,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function normalizeRepairSelection(options = {}) {
  const fingerprints = normalizeStringList(
    options.fingerprints || options.findings || options.finding || options.fingerprint
  );
  const categories = normalizeStringList(options.categories || options.category);
  const files = normalizeStringList(options.files || options.file);
  return {
    fingerprints,
    categories,
    files,
    active: Boolean(fingerprints.length || categories.length || files.length)
  };
}

function repairSelectionAllows(finding, selection = normalizeRepairSelection()) {
  if (selection.fingerprints.length && !selection.fingerprints.includes(String(finding.fingerprint || ""))) {
    return false;
  }
  if (selection.categories.length && !selection.categories.includes(String(finding.category || ""))) {
    return false;
  }
  if (selection.files.length) {
    const file = String(finding.file || "");
    if (!file || !selection.files.some((pattern) => matchPath(pattern, file))) return false;
  }
  return true;
}

function skippedRepairForFinding(finding, reason) {
  return {
    fingerprint: finding.fingerprint || "",
    file: finding.file || null,
    line: finding.line || null,
    title: finding.title,
    category: finding.category,
    reason
  };
}

function normalizeStringList(value) {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return values
    .flatMap((item) => String(item || "").split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function repairPlanCount(plansByFile) {
  let total = 0;
  for (const plan of plansByFile.values()) total += plan.replacements.length;
  return total;
}

function repairForFinding(finding, sourceText) {
  const lines = String(sourceText || "").split(/\r?\n/);
  const line = lines[Number(finding.line) - 1];
  if (line === undefined) return null;
  const title = String(finding.title || "");
  if (finding.category === "static-c-cpp") {
    return repairCLine({ finding, line, title, sourceText });
  }
  if (finding.category === "static-python") {
    return repairPythonLine({ finding, line, title });
  }
  if (finding.category === "static-javascript" && title === "Loose equality comparison") {
    const nextLine = line
      .replace(/([^=!<>])==([^=])/g, "$1===$2")
      .replace(/([^=!<>])!=([^=])/g, "$1!==$2");
    if (nextLine !== line) {
      return lineRepair(finding, line, nextLine, "Replace loose equality with strict equality.");
    }
  }
  return null;
}

function repairCLine({ finding, line, title, sourceText }) {
  if (title === "Unsafe gets call") {
    const match = line.match(/^(\s*)gets\s*\(\s*([A-Za-z_]\w*)\s*\)\s*;\s*$/);
    if (!match) return null;
    if (!isKnownLocalCCharArray(sourceText, finding.line, match[2])) return null;
    return lineRepair(
      finding,
      line,
      `${match[1]}fgets(${match[2]}, sizeof(${match[2]}), stdin);`,
      "Replace gets with fgets only when the destination is a local fixed array."
    );
  }
  if (title !== "Unbounded C string API") return null;
  let match = line.match(/^(\s*)strcpy\s*\(\s*([A-Za-z_]\w*)\s*,\s*(.+?)\s*\)\s*;\s*$/);
  if (match) {
    if (!isKnownLocalCCharArray(sourceText, finding.line, match[2])) return null;
    return lineRepair(
      finding,
      line,
      `${match[1]}snprintf(${match[2]}, sizeof(${match[2]}), "%s", ${match[3]});`,
      "Replace strcpy with snprintf only when the destination is a local fixed array."
    );
  }
  match = line.match(/^(\s*)strcat\s*\(\s*([A-Za-z_]\w*)\s*,\s*(.+?)\s*\)\s*;\s*$/);
  if (match) {
    if (!isKnownLocalCCharArray(sourceText, finding.line, match[2])) return null;
    return lineRepair(
      finding,
      line,
      `${match[1]}strncat(${match[2]}, ${match[3]}, sizeof(${match[2]}) - strlen(${match[2]}) - 1);`,
      "Replace strcat with strncat only when the destination is a local fixed array."
    );
  }
  match = line.match(/^(\s*)sprintf\s*\(\s*([A-Za-z_]\w*)\s*,\s*(.+)\)\s*;\s*$/);
  if (match) {
    if (!isKnownLocalCCharArray(sourceText, finding.line, match[2])) return null;
    return lineRepair(
      finding,
      line,
      `${match[1]}snprintf(${match[2]}, sizeof(${match[2]}), ${match[3]});`,
      "Replace sprintf with snprintf only when the destination is a local fixed array."
    );
  }
  return null;
}

function isKnownLocalCCharArray(sourceText, lineNumber, variableName) {
  const lines = String(sourceText || "").split(/\r?\n/);
  const targetIndex = Math.max(0, Number(lineNumber) - 1);
  const name = String(variableName || "");
  if (!name || !lines[targetIndex]) return false;

  let depth = 0;
  let functionBodyStart = 0;
  for (let index = 0; index < targetIndex; index += 1) {
    const before = depth;
    for (const char of stripCStringAndCommentSyntax(lines[index])) {
      if (char === "{") depth += 1;
      else if (char === "}") depth = Math.max(0, depth - 1);
    }
    if (before === 0 && depth > 0) {
      functionBodyStart = index + 1;
    }
  }

  const declarationName = escapeRegex(name);
  for (let index = functionBodyStart; index < targetIndex; index += 1) {
    const line = stripCStringAndCommentSyntax(lines[index]).trim();
    const declaration = line.match(/^(?:static\s+)?(?:const\s+)?(?:unsigned\s+char|signed\s+char|char|wchar_t)\s+(.+);\s*$/);
    if (!declaration) continue;
    const declarators = splitTopLevel(declaration[1]);
    if (declarators.some((item) => new RegExp(`^${declarationName}\\s*\\[[^\\]]+\\]`).test(item.trim()))) {
      return true;
    }
  }
  return false;
}

function stripCStringAndCommentSyntax(line) {
  return String(line || "")
    .replace(/\/\/.*$/, "")
    .replace(/\/\*.*?\*\//g, "")
    .replace(/"(?:\\.|[^"\\])*"/g, "\"\"")
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

function repairPythonLine({ finding, line, title }) {
  if (title === "Returning list.append result") {
    const match = line.match(/^(\s*)return\s+([A-Za-z_]\w*)\.append\((.*)\)\s*$/);
    if (!match) return null;
    return lineRepair(
      finding,
      line,
      `${match[1]}${match[2]}.append(${match[3]})\n${match[1]}return ${match[2]}`,
      "Append first, then return the mutated list."
    );
  }
  if (title === "Mutable default argument") {
    const match = line.match(/^(\s*def\s+\w+\([^)]*?)([A-Za-z_]\w*)\s*=\s*(\[\]|\{\}|set\(\))([^)]*\):\s*)$/);
    if (!match) return null;
    const indent = line.match(/^\s*/)?.[0] || "";
    const factory = match[3];
    const nextDef = `${match[1]}${match[2]}=None${match[4]}`;
    const guard = `${indent}    if ${match[2]} is None:\n${indent}        ${match[2]} = ${factory}`;
    return lineRepair(
      finding,
      line,
      `${nextDef}\n${guard}`,
      "Use None as the default and create a fresh container inside the function."
    );
  }
  return null;
}

function lineRepair(finding, oldLine, newLine, rationale) {
  return {
    line: Number(finding.line),
    title: finding.title,
    category: finding.category,
    severity: finding.severity,
    fingerprint: finding.fingerprint,
    oldLine,
    newLine,
    rationale
  };
}

function buildRepositoryRepairChanges(plansByFile) {
  const changes = [];
  for (const plan of plansByFile.values()) {
    const lineEnding = plan.original.includes("\r\n") ? "\r\n" : "\n";
    const lines = plan.original.split(/\r?\n/);
    const replacements = [...plan.replacements].sort((a, b) => b.line - a.line);
    for (const replacement of replacements) {
      lines.splice(replacement.line - 1, 1, ...String(replacement.newLine).split(/\r?\n/));
    }
    const nextSource = lines.join(lineEnding);
    if (nextSource === plan.original) continue;
    changes.push({
      file: plan.file,
      fullPath: plan.fullPath,
      repairCount: replacements.length,
      replacements: [...plan.replacements].sort((a, b) => a.line - b.line),
      originalSource: plan.original,
      nextSource,
      diff: unifiedSourceDiff(plan.original, nextSource)
    });
  }
  return changes;
}

function projectedDetectionAfter(detectionBefore, changes) {
  const changedFingerprints = new Set(
    changes.flatMap((change) => change.replacements.map((replacement) => replacement.fingerprint).filter(Boolean))
  );
  const findings = (detectionBefore.findings || []).filter((finding) => !changedFingerprints.has(finding.fingerprint));
  return {
    ...detectionBefore,
    projected: true,
    summary: summarizeFindings(findings),
    findings
  };
}

function repositoryRepairReport({ repoRoot, configPath, status, dryRun, changes, detectionBefore, detectionAfter, projectTest, repairContext = {}, message }) {
  const publicChanges = changes.map((change) => ({
    file: change.file,
    repairCount: change.repairCount,
    replacements: change.replacements,
    diff: change.diff
  }));
  return {
    schema: "patchproof.repository-repair.v1",
    status,
    dryRun,
    repoRoot,
    config: configPath,
    generatedAt: new Date().toISOString(),
    message,
    repairMode: "static-rewrite-project-test",
    semanticClaim: false,
    selection: repairContext.selection || normalizeRepairSelection(),
    skippedRepairs: repairContext.skippedRepairs || [],
    writePolicy: {
      maxRepairs: repairContext.maxRepairs || 25,
      configLoaded: Boolean(repairContext.repairConfig),
      configError: repairContext.repairConfigError || null,
      allowedPathsEnforced: Boolean(repairContext.repairConfig?.project?.allowedPaths?.length),
      forbiddenPathsEnforced: Boolean(repairContext.repairConfig?.project?.forbiddenPaths?.length),
      lineEndingsPreserved: true,
      bomPreserved: true
    },
    changes: publicChanges,
    projectTest,
    certificate: {
      type: "repository-static-repair",
      status,
      claim: status === "certified"
        ? "Conservative static source repairs were applied and the configured project validation command passed."
        : "Conservative static source repairs were generated or applied without a passing project validation command.",
      boundedBy: [
        "static pattern matchers",
        "repair write policy",
        "changed files listed in this report",
        projectTest ? `project command: ${projectTest.command}` : "no project command"
      ],
      residualRisks: [
        "No C/C++ semantic verifier is claimed.",
        "Repository repair is static source rewriting, not autonomous whole-program repair.",
        "Static replacements only cover simple one-line patterns.",
        "Project-test certification is only as strong as the configured repository tests."
      ]
    },
    detectionBefore: {
      summary: detectionBefore.summary,
      findings: detectionBefore.findings
    },
    detectionAfter: detectionAfter
      ? {
          projected: Boolean(detectionAfter.projected),
          summary: detectionAfter.summary,
          findings: detectionAfter.findings
        }
      : null
  };
}

function selectTargetId(targets, requested) {
  const ids = Object.keys(targets);
  if (!ids.length) throw new Error("patchproof.yml does not define any repository targets.");
  if (requested) {
    if (!targets[requested]) {
      throw new Error(`Unknown repository target '${requested}'. Available targets: ${ids.join(", ")}.`);
    }
    return requested;
  }
  if (ids.length === 1) return ids[0];
  throw new Error(`Multiple repository targets exist. Pass --target <id>. Available targets: ${ids.join(", ")}.`);
}

function assertSafeProjectCommand(command) {
  if (!command) throw new Error("No repository test command is configured. Set project.testCommand or pass --command.");
  if (command.length > 1000 || /[\0\r\n]/.test(command)) {
    throw new Error("Repository test command must be a single line under 1000 characters.");
  }
  if (/[;&|<>`]/.test(command) || /\$\s*\(/.test(command)) {
    throw new Error("Repository test command must not contain shell chaining, pipes, redirects, or command substitution.");
  }
}

function buildTargetLimits(config, target) {
  return {
    ...(config.repair?.maxCandidates !== undefined ? { maxCandidates: config.repair.maxCandidates } : {}),
    ...(config.repair?.minEvidenceScore !== undefined ? { minEvidenceScore: config.repair.minEvidenceScore } : {}),
    ...(target.limits || {})
  };
}

function normalizeTestsFile(text, testsFile) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse tests file '${testsFile}': ${error.message}`);
  }
  const tests = Array.isArray(parsed) ? parsed : parsed.tests;
  if (!Array.isArray(tests)) {
    throw new Error(`Tests file '${testsFile}' must contain a JSON array or an object with a tests array.`);
  }
  return JSON.stringify(tests, null, 2);
}

async function buildInitialConfigText(repoRoot, report) {
  const language = preferredLanguage(report.languages);
  const allowedPaths = inferredAllowedPaths(report);
  const targetSuggestions = await suggestInitialTargets(repoRoot, report, language);
  const testCommand = report.testCommands[0]?.command || (language === "python" ? "python -m pytest" : "npm test");
  const buildCommand =
    report.buildCommands?.find((item) => item.tool !== "cmake-configure")?.command ||
    buildCommandFor(report.packageManager, language);
  const installCommand = installCommandFor(report.packageManager, language);
  const rows = [
    "version: 1",
    "project:",
    `  language: ${language}`,
    `  testCommand: ${quoteYaml(testCommand)}`,
    `  buildCommand: ${quoteYaml(buildCommand)}`,
    `  installCommand: ${quoteYaml(installCommand)}`,
    "  allowedPaths:",
    ...allowedPaths.map((path) => `    - ${path}`),
    "  forbiddenPaths:",
    "    - .env",
    "    - secrets/**",
    "runner:",
    "  timeoutSeconds: 600",
    "  memoryMb: 2048",
    "  cpus: 2",
    "  network: disabled",
    "repair:",
    "  maxCandidates: 8",
    "  requireCertificate: true",
    "  minEvidenceScore: 0.75",
    "model:",
    "  provider: disabled",
    "  baseUrl: \"\"",
    "  apiKeyEnv: PATCHPROOF_MODEL_API_KEY",
    "  model: \"\"",
    "targets:"
  ];
  if (targetSuggestions.length) {
    for (const target of targetSuggestions) {
      rows.push(
        `  ${target.id}:`,
        `    source: ${target.source}`,
        `    function: ${target.functionName}`,
        target.tests
          ? `    tests: ${target.tests}`
          : `    framework: ${target.framework}`,
        ...(target.frameworkTests ? [`    frameworkTests: ${target.frameworkTests}`] : []),
        "    bugReport: Describe the observed bug and expected behavior.",
        "    precondition: true",
        "    mayChange: false",
        "    postcondition: true"
      );
    }
  } else {
    rows.push(
      "  # Add one target per function you want PatchProof to certify.",
      "  # example:",
      "  #   source: src/example.js",
      "  #   function: example",
      "  #   tests: tests/example.patchproof.json",
      "  #   bugReport: Describe the observed bug and expected behavior.",
      "  #   precondition: true",
      "  #   mayChange: false",
      "  #   postcondition: true"
    );
  }
  return `${rows.join("\n")}\n`;
}

async function suggestInitialTargets(repoRoot, report, language) {
  if (!["javascript", "typescript", "python"].includes(language)) return [];
  const sourceByStem = new Map(report.sourceFiles.map((file) => [basename(file).replace(/\.[^.]+$/, ""), file]));
  const targets = [];
  for (const tests of report.patchproofTestFiles) {
    const stem = basename(tests).replace(/\.patchproof\.json$/, "").replace(/\.(?:test|spec)$/, "");
    const source = sourceByStem.get(stem);
    if (!source) continue;
    const functionName = await inferSingleFunctionName(repoRoot, source, language);
    if (!functionName) continue;
    targets.push({ id: slugId(stem), source, functionName, tests });
  }
  if (targets.length) return targets.slice(0, 5);

  for (const testFile of report.testFiles.filter((file) => !file.endsWith(".patchproof.json"))) {
    const stem = basename(testFile).replace(/\.(?:test|spec)\.[^.]+$/, "").replace(/^test_/, "").replace(/_test$/, "");
    const source = sourceByStem.get(stem);
    if (!source) continue;
    const functionName = await inferSingleFunctionName(repoRoot, source, language);
    if (!functionName) continue;
    const framework = inferFrameworkFromPath(testFile);
    if (!["jest", "vitest", "node:test", "pytest"].includes(framework)) continue;
    targets.push({ id: slugId(stem), source, functionName, framework, frameworkTests: testFile });
  }
  return targets.slice(0, 5);
}

async function inferSingleFunctionName(repoRoot, sourcePath, language) {
  if (!["javascript", "typescript", "python"].includes(language)) return "";
  try {
    const text = await readFile(resolveRepoPath(repoRoot, sourcePath, "source"), "utf8");
    const matches = language === "python"
      ? [...text.matchAll(/^def\s+([A-Za-z_]\w*)\s*\(/gm)].map((match) => match[1])
      : listJavaScriptFunctionCandidates(text, sourcePath).map((candidate) => candidate.functionName);
    return matches.length === 1 ? matches[0] : "";
  } catch {
    return "";
  }
}

function preferredLanguage(languages) {
  if (languages.includes("python") && !languages.includes("javascript")) return "python";
  if (languages.includes("cpp") && !languages.some((language) => ["javascript", "python"].includes(language))) return "cpp";
  if (languages.includes("c") && !languages.some((language) => ["javascript", "python", "cpp"].includes(language))) return "c";
  return languages.includes("javascript") ? "javascript" : languages[0] || "javascript";
}

function inferredAllowedPaths(report) {
  const roots = new Set(["src/**", "lib/**", "tests/**", "test/**"]);
  for (const file of [...report.sourceFiles, ...report.testFiles]) {
    const first = file.split("/")[0];
    if (first && first !== file && !["node_modules", ".git"].includes(first)) roots.add(`${first}/**`);
  }
  return [...roots].sort();
}

function installCommandFor(packageManager, language) {
  if (packageManager === "pnpm") return "pnpm install --frozen-lockfile";
  if (packageManager === "yarn") return "yarn install --frozen-lockfile";
  if (packageManager === "npm") return "npm ci";
  if (packageManager === "poetry") return "poetry install";
  if (packageManager === "uv") return "uv sync";
  if (packageManager === "cmake") return "cmake -S . -B build";
  if (packageManager === "make") return "make";
  if (packageManager === "conan") return "conan install .";
  if (packageManager === "vcpkg") return "vcpkg install";
  return language === "python" ? "python -m pip install -r requirements.txt" : "npm install";
}

function buildCommandFor(packageManager, language) {
  if (packageManager === "cmake") return "cmake --build build";
  if (packageManager === "make") return "make";
  if (["c", "cpp"].includes(language)) return "cmake --build build";
  return "";
}

async function diagnoseTargets(options) {
  let targets;
  try {
    targets = await listRepositoryTargets(options);
  } catch (error) {
    return [{ name: "targets", status: "error", message: error.message }];
  }
  if (!targets.length) {
    return [{ name: "targets", status: "warning", message: "No PatchProof targets are configured yet." }];
  }
  const checks = [];
  for (const target of targets) {
    try {
      const language = normalizeRepositoryLanguage(target.language || "");
      if (["c", "cpp"].includes(language)) {
        addCheck(
          checks,
          `target:${target.id}`,
          "warning",
          `${target.id}: C/C++ function-level certificates are not supported; use repository-level repair-repo for conservative static repairs plus project-test certification.`
        );
        continue;
      }
      const input = await createInputFromRepositoryTarget({ ...options, targetId: target.id });
      const tests = JSON.parse(input.testsText);
      addCheck(
        checks,
        `target:${target.id}`,
        "ok",
        `${target.id} resolves ${input.language} function '${input.repository.function}' with ${tests.length} test(s).`
      );
    } catch (error) {
      addCheck(checks, `target:${target.id}`, "error", `${target.id}: ${error.message}`);
    }
  }
  return checks;
}

function addCheck(checks, name, status, message) {
  checks.push({ name, status, message });
}

async function detectConfiguredTargetFailures({ repoRoot, configPath, maxTargets }) {
  let targets;
  try {
    targets = await listRepositoryTargets({ repoRoot, configPath });
  } catch (error) {
    return [repositoryFinding({
      severity: "high",
      category: "configuration",
      title: "Configured targets could not be loaded",
      message: error.message
    })];
  }

  const findings = [];
  if (targets.length > maxTargets) {
    findings.push(repositoryFinding({
      severity: "info",
      category: "scan-limit",
      title: "Target detection was capped",
      message: `Checked ${maxTargets} of ${targets.length} configured targets.`
    }));
  }

  const { runPatchProofIsolated } = await import("./sandbox/hosted-runner.js");
  for (const target of targets.slice(0, maxTargets)) {
    const targetLanguage = normalizeRepositoryLanguage(target.language || "");
    if (["c", "cpp"].includes(targetLanguage)) {
      findings.push(repositoryFinding({
        severity: "info",
        category: "c-cpp-foundation",
        file: target.source,
        title: `C/C++ target '${target.id}' detected`,
        message: "PatchProof can inspect, statically scan, and apply conservative repository-level C/C++ safety repairs for this target.",
        suggestion: "Use `patchproof repair-repo --repo <path> --apply --run-tests` to apply supported static repairs and certify them with the project test command."
      }));
      continue;
    }

    let input;
    try {
      input = await createInputFromRepositoryTarget({ repoRoot, configPath, targetId: target.id });
    } catch (error) {
      findings.push(repositoryFinding({
        severity: "medium",
        category: "target-resolution",
        file: target.source || target.tests,
        title: `Target '${target.id}' could not be resolved`,
        message: error.message,
        suggestion: "Fix the target source/tests paths or function name."
      }));
      continue;
    }

    const runner = await runPatchProofIsolated({
      ...input,
      limits: {
        ...(input.limits || {}),
        maxCandidates: Math.min(Number(input.limits?.maxCandidates || 1), 1),
        minEvidenceScore: 0
      }
    }, { limits: { timeoutMs: 10000, maxInputBytes: 512 * 1024 } });

    if (!runner.ok) {
      findings.push(repositoryFinding({
        severity: "medium",
        category: "target-execution",
        file: input.repository?.source || target.source,
        title: `Target '${target.id}' could not be executed`,
        message: runner.error?.message || "The isolated verifier failed.",
        suggestion: "Run `patchproof doctor --repo <path>` and inspect the target tests/source."
      }));
      continue;
    }

    const failing = (runner.result?.baseline?.tests || []).filter((test) => !test.pass);
    if (failing.length) {
      findings.push(repositoryFinding({
        severity: "high",
        category: "failing-evidence",
        file: input.repository?.source || target.source,
        title: `Target '${target.id}' has failing executable evidence`,
        message: `${failing.length} baseline test(s) failed before any repair was applied.`,
        evidence: failing.slice(0, 5).map((test) => `${test.name}: ${JSON.stringify(test.observation)}`).join("\n"),
        suggestion: "Open this target in PatchProof to generate and certify candidate patches."
      }));
    }
  }
  return findings;
}

function scanSourceForBugSignals(file, text) {
  const language = languageFromPath(file);
  const findings = [];
  const lines = String(text || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const comment = commentTextForLine(line, language);
    if (/\b(?:BUG|FIXME|HACK|TODO)\b/.test(comment)) {
      findings.push(repositoryFinding({
        severity: "low",
        category: "comment-marker",
        file,
        line: lineNumber,
        title: "Bug marker comment found",
        message: "The source contains an explicit bug/fixme marker.",
        evidence: comment.trim(),
        suggestion: "Review this marker and convert it into an executable test if it describes real failing behavior."
      }));
    }
    if (language === "javascript" || language === "typescript") {
      scanJavaScriptLine(findings, file, line, lineNumber);
    } else if (language === "python") {
      scanPythonLine(findings, file, lines, index);
    } else if (language === "c" || language === "cpp") {
      scanCLine(findings, file, line, lineNumber);
    }
  }
  return findings;
}

function commentTextForLine(line, language) {
  const value = String(line || "");
  if (language === "python") {
    const hash = value.indexOf("#");
    return hash >= 0 ? value.slice(hash) : "";
  }
  const slash = value.indexOf("//");
  const block = value.indexOf("/*");
  const indexes = [slash, block].filter((index) => index >= 0);
  if (!indexes.length) return "";
  return value.slice(Math.min(...indexes));
}

function scanJavaScriptLine(findings, file, line, lineNumber) {
  if (/\bif\s*\([^)]*[^=!<>]=[^=][^)]*\)/.test(line)) {
    findings.push(repositoryFinding({
      severity: "medium",
      category: "static-javascript",
      file,
      line: lineNumber,
      title: "Assignment inside conditional",
      message: "This may be an accidental assignment where a comparison was intended.",
      evidence: line.trim()
    }));
  }
  if (/[^=!]==[^=]/.test(line) || /!=[^=]/.test(line)) {
    findings.push(repositoryFinding({
      severity: "low",
      category: "static-javascript",
      file,
      line: lineNumber,
      title: "Loose equality comparison",
      message: "Loose equality can hide coercion bugs in boundary or validation code.",
      evidence: line.trim(),
      suggestion: "Prefer strict equality unless coercion is intentional and tested."
    }));
  }
}

function scanPythonLine(findings, file, lines, index) {
  const line = lines[index];
  const lineNumber = index + 1;
  if (/^\s*def\s+\w+\([^)]*=\s*(?:\[\]|\{\}|set\(\))/.test(line)) {
    findings.push(repositoryFinding({
      severity: "high",
      category: "static-python",
      file,
      line: lineNumber,
      title: "Mutable default argument",
      message: "Mutable defaults are shared across calls and commonly cause state leakage.",
      evidence: line.trim(),
      suggestion: "Use None as the default and create a new list/dict/set inside the function."
    }));
  }
  if (/^\s*return\s+\w+\.append\(/.test(line)) {
    findings.push(repositoryFinding({
      severity: "high",
      category: "static-python",
      file,
      line: lineNumber,
      title: "Returning list.append result",
      message: "list.append mutates the list and returns None.",
      evidence: line.trim(),
      suggestion: "Append first, then return the list."
    }));
  }
  if (/^\s*except\s*:/.test(line) && /^\s*pass\s*$/.test(lines[index + 1] || "")) {
    findings.push(repositoryFinding({
      severity: "medium",
      category: "static-python",
      file,
      line: lineNumber,
      title: "Bare except swallows failures",
      message: "A bare except followed by pass can hide real runtime bugs.",
      evidence: `${line.trim()} ${(lines[index + 1] || "").trim()}`.trim(),
      suggestion: "Catch a specific exception and assert expected behavior in tests."
    }));
  }
}

function scanCLine(findings, file, line, lineNumber) {
  if (/\bgets\s*\(/.test(line)) {
    findings.push(repositoryFinding({
      severity: "critical",
      category: "static-c-cpp",
      file,
      line: lineNumber,
      title: "Unsafe gets call",
      message: "gets cannot bound input and is unsafe.",
      evidence: line.trim(),
      suggestion: "Use fgets or a bounded input API."
    }));
  }
  if (/\b(?:strcpy|strcat|sprintf|vsprintf)\s*\(/.test(line)) {
    findings.push(repositoryFinding({
      severity: "high",
      category: "static-c-cpp",
      file,
      line: lineNumber,
      title: "Unbounded C string API",
      message: "This call can overflow buffers when inputs are not tightly controlled.",
      evidence: line.trim(),
      suggestion: "Use bounded alternatives and add tests for maximum-length inputs."
    }));
  }
  if (/\bscanf\s*\(\s*"[^"]*%s/.test(line)) {
    findings.push(repositoryFinding({
      severity: "high",
      category: "static-c-cpp",
      file,
      line: lineNumber,
      title: "Unbounded scanf string read",
      message: "scanf with %s and no width limit can overflow the destination buffer.",
      evidence: line.trim(),
      suggestion: "Add a field width or use fgets."
    }));
  }
  if (/\bif\s*\([^)]*[^=!<>]=[^=][^)]*\)/.test(line)) {
    findings.push(repositoryFinding({
      severity: "medium",
      category: "static-c-cpp",
      file,
      line: lineNumber,
      title: "Assignment inside conditional",
      message: "This may be intentional, but it is a common C/C++ bug pattern.",
      evidence: line.trim()
    }));
  }
}

async function loadDetectionSuppressions({ repoRoot, configPath, options }) {
  const suppressions = [];
  const add = (entries, source) => {
    for (const value of normalizeSuppressionEntries(entries)) {
      suppressions.push({ value, source });
    }
  };

  try {
    const { config } = await loadRepositoryConfig({ repoRoot, configPath });
    add(config.detect?.suppressions, "config:detect.suppressions");
    add(config.suppressions, "config:suppressions");
  } catch {
    // Invalid or missing config is itself reported elsewhere; suppression loading should not hide that finding.
  }

  const defaultSuppressionText = options.defaultSuppressions === false
    ? null
    : await readTextIfExists(repoRoot, ".patchproofignore");
  if (defaultSuppressionText !== null) {
    add(parseSuppressionFile(defaultSuppressionText), ".patchproofignore");
  }

  if (options.suppressionsPath) {
    const suppressionPath = resolveRepoPath(repoRoot, options.suppressionsPath, "suppressions");
    add(parseSuppressionFile(await readFile(suppressionPath, "utf8")), options.suppressionsPath);
  }
  add(options.suppressions, "request");
  return suppressions;
}

function normalizeSuppressionEntries(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return [String(value).trim()].filter(Boolean);
}

function parseSuppressionFile(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

function applyFindingSuppressions(findings, suppressions) {
  if (!suppressions.length) {
    return { findings, suppressedFindings: [], suppressions: [] };
  }
  const active = [];
  const suppressedFindings = [];
  for (const finding of findings) {
    const match = suppressions.find((suppression) => matchesSuppression(finding, suppression.value));
    if (match) {
      suppressedFindings.push({ ...finding, suppressedBy: match });
    } else {
      active.push(finding);
    }
  }
  return { findings: active, suppressedFindings, suppressions };
}

function matchesSuppression(finding, rule) {
  const text = String(rule || "").trim();
  if (!text) return false;
  if (text === finding.fingerprint) return true;
  if (text.startsWith("fingerprint:")) return text.slice("fingerprint:".length).trim() === finding.fingerprint;
  if (text.startsWith("category:")) return text.slice("category:".length).trim() === finding.category;
  if (text.startsWith("title:")) return text.slice("title:".length).trim() === finding.title;
  if (text.startsWith("file:")) return Boolean(finding.file) && matchPath(text.slice("file:".length).trim(), finding.file);
  if (text.includes("@")) {
    const [left, filePattern] = text.split("@");
    return matchesSuppression(finding, left.trim()) && Boolean(finding.file) && matchPath(filePattern.trim(), finding.file);
  }
  if (text.includes(":")) {
    const [category, ...titleParts] = text.split(":");
    const title = titleParts.join(":").trim();
    return finding.category === category.trim() && (!title || finding.title === title);
  }
  return finding.category === text || finding.title === text;
}

function repositoryFinding({ severity, category, file = null, line = null, title, message, evidence = "", suggestion = "" }) {
  const finding = {
    severity,
    category,
    file,
    line,
    title,
    message,
    evidence,
    suggestion
  };
  return {
    ...finding,
    fingerprint: findingFingerprint(finding)
  };
}

function findingFingerprint(finding) {
  return createHash("sha256")
    .update(JSON.stringify({
      category: finding.category,
      title: finding.title,
      file: finding.file || "",
      line: finding.line || 0,
      evidence: finding.evidence || ""
    }))
    .digest("hex")
    .slice(0, 16);
}

function summarizeFindings(findings) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byCategory = {};
  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
    byCategory[finding.category] = (byCategory[finding.category] || 0) + 1;
  }
  return {
    totalFindings: findings.length,
    bySeverity,
    byCategory,
    highestSeverity: ["critical", "high", "medium", "low", "info"].find((severity) => bySeverity[severity]) || "none"
  };
}

export function repositoryDetectionToSarif(report) {
  const rules = new Map();
  const results = [];
  for (const finding of report.findings || []) {
    const ruleId = `${finding.category}/${slugId(finding.title)}`;
    if (!rules.has(ruleId)) {
      rules.set(ruleId, {
        id: ruleId,
        name: finding.title,
        shortDescription: { text: finding.title },
        fullDescription: { text: finding.message || finding.title },
        help: { text: finding.suggestion || finding.message || finding.title }
      });
    }
    results.push({
      ruleId,
      level: sarifLevel(finding.severity),
      message: { text: finding.message || finding.title },
      partialFingerprints: { patchproof: finding.fingerprint },
      properties: {
        severity: finding.severity,
        category: finding.category,
        evidence: finding.evidence || "",
        suggestion: finding.suggestion || ""
      },
      locations: finding.file
        ? [{
            physicalLocation: {
              artifactLocation: { uri: finding.file },
              region: finding.line ? { startLine: finding.line } : undefined
            }
          }]
        : []
    });
  }
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: {
        driver: {
          name: "PatchProof",
          informationUri: "https://github.com/AsserAl1012/patchproof",
          rules: [...rules.values()]
        }
      },
      originalUriBaseIds: {
        SRCROOT: { uri: pathToSarifUri(report.repoRoot || ".") }
      },
      results,
      properties: {
        generatedAt: report.generatedAt,
        summary: report.summary
      }
    }]
  };
}

function sarifLevel(severity) {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "note";
}

function pathToSarifUri(path) {
  return pathToFileURL(resolve(path || ".")).href.replace(/\/?$/, "/");
}

function summarizeProcessOutput(result) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  return output.length <= 3000 ? output : `${output.slice(0, 3000)}\n... output truncated ...`;
}

function analyzeProjectTestOutput(result, repoRoot) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const failures = [];
  const seen = new Set();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const pytest = line.match(/\bFAILED\s+([^\s]+?\.(?:py|mjs|cjs|js|jsx|ts|tsx|c|cc|cpp|cxx)(?:::[^\s]+)?)/);
    if (pytest) {
      const [filePart, ...nameParts] = pytest[1].split("::");
      pushMappedFailure(failures, seen, {
        repoRoot,
        fileText: filePart,
        line: null,
        name: nameParts.join("::") || "pytest failure",
        evidence: line
      });
      continue;
    }

    const stackFrame = line.match(/(?:^|[\s(])([A-Za-z]:[^\s()]+|(?:\.{0,2}[\\/])?[\w./\\-]+\.(?:mjs|cjs|js|jsx|ts|tsx|py|c|cc|cpp|cxx|h|hpp)):(\d+)(?::\d+)?/);
    if (stackFrame) {
      pushMappedFailure(failures, seen, {
        repoRoot,
        fileText: stackFrame[1],
        line: Number(stackFrame[2]),
        name: "",
        evidence: line
      });
    }
  }
  return failures.slice(0, 25);
}

function pushMappedFailure(failures, seen, { repoRoot, fileText, line, name, evidence }) {
  const file = outputPathToRepoPath(repoRoot, fileText);
  const key = `${file || fileText}:${line || ""}:${name || ""}:${evidence}`;
  if (seen.has(key)) return;
  seen.add(key);
  failures.push({
    file,
    line: line || null,
    name,
    evidence
  });
}

function outputPathToRepoPath(repoRoot, fileText) {
  const clean = String(fileText || "")
    .replace(/^file:\/\//, "")
    .replace(/^["'(<]+|[>"')]+$/g, "")
    .split("\\").join("/");
  if (!clean) return null;
  try {
    const candidate = isAbsolute(clean) ? resolve(clean) : resolve(repoRoot, clean.replace(/^\.?\//, ""));
    const rel = relative(repoRoot, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return toRepoPath(repoRoot, candidate);
  } catch {
    return null;
  }
}

function languageFromPath(file) {
  if (/\.(?:ts|tsx)$/.test(file)) return "typescript";
  if (/\.(?:mjs|cjs|js|jsx)$/.test(file)) return "javascript";
  if (/\.py$/.test(file)) return "python";
  if (/\.(?:cc|cpp|cxx|hpp|hh|hxx)$/.test(file)) return "cpp";
  if (/\.(?:c|h)$/.test(file)) return "c";
  return "unknown";
}

function pythonInfo() {
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  for (const executable of candidates) {
    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000
    });
    if (result.status === 0) {
      return {
        available: true,
        executable,
        version: String(result.stdout || result.stderr || "").trim()
      };
    }
  }
  return { available: false, executable: null, version: null };
}

async function listRepositoryFiles(repoRoot, maxFiles) {
  const files = [];
  async function visit(directory) {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = resolve(directory, entry.name);
      const repoPath = toRepoPath(repoRoot, fullPath);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await visit(fullPath);
      } else if (entry.isFile()) {
        files.push(repoPath);
      }
    }
  }
  await visit(repoRoot);
  return files.sort();
}

async function readTextIfExists(repoRoot, repoPath) {
  try {
    return await readFile(resolveRepoPath(repoRoot, repoPath, repoPath), "utf8");
  } catch {
    return null;
  }
}

async function readJsonIfExists(repoRoot, repoPath) {
  const text = await readTextIfExists(repoRoot, repoPath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summarizePatchproofConfig(text, configPath) {
  try {
    const config = parsePatchproofConfig(text);
    return {
      configured: true,
      config: configPath,
      targets: Object.entries(config.targets || {}).map(([id, target]) => ({
        id,
        language: target.language || config.project.language,
        source: target.source || target.sourcePath || target.file || "",
        tests: target.tests || target.testsPath || target.testFile || "",
        functionName: target.function || target.functionName || ""
      })),
      error: null
    };
  } catch (error) {
    return { configured: true, config: configPath, targets: [], error: error.message };
  }
}

function detectPackageManager(files) {
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("package-lock.json")) return "npm";
  if (files.includes("package.json")) return "npm";
  if (files.includes("poetry.lock")) return "poetry";
  if (files.includes("uv.lock")) return "uv";
  if (files.includes("pyproject.toml")) return "python";
  if (files.includes("vcpkg.json")) return "vcpkg";
  if (files.includes("conanfile.txt") || files.includes("conanfile.py")) return "conan";
  if (files.includes("CMakeLists.txt")) return "cmake";
  if (files.includes("Makefile") || files.includes("makefile")) return "make";
  return null;
}

function detectDependencyFiles(files) {
  return files.filter((file) =>
    /^(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements(?:-[\w.-]+)?\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile|Pipfile\.lock|CMakeLists\.txt|Makefile|makefile|conanfile\.(?:txt|py)|vcpkg\.json)$/.test(file) ||
    /(?:^|\/)(?:requirements(?:-[\w.-]+)?\.txt|pyproject\.toml|CMakeLists\.txt|conanfile\.(?:txt|py)|vcpkg\.json)$/.test(file)
  ).slice(0, 100);
}

function detectLanguages({ files, packageJson, pyproject }) {
  const languages = new Set();
  if (packageJson || files.some((file) => /\.(?:mjs|cjs|js|jsx)$/.test(file))) languages.add("javascript");
  if (files.some((file) => /\.(?:ts|tsx)$/.test(file))) languages.add("typescript");
  if (pyproject || files.some((file) => /\.py$/.test(file))) languages.add("python");
  if (files.some((file) => /\.(?:c|h)$/.test(file))) languages.add("c");
  if (files.some((file) => /\.(?:cc|cpp|cxx|hpp|hh|hxx)$/.test(file))) languages.add("cpp");
  return [...languages].sort();
}

function detectFrameworks({ packageJson, pyproject, pytestIni, setupCfg, requirements, cmakeLists, makefile, conanfile, vcpkg, testFiles, files }) {
  const frameworks = new Set();
  const scripts = Object.values(packageJson?.scripts || {}).join(" ");
  const dependencies = {
    ...(packageJson?.dependencies || {}),
    ...(packageJson?.devDependencies || {})
  };
  const dependencyText = `${Object.keys(dependencies).join(" ")} ${scripts}`;
  if (/\bvitest\b/.test(dependencyText)) frameworks.add("vitest");
  if (/\bjest\b/.test(dependencyText)) frameworks.add("jest");
  if (/\bnode\s+--test\b/.test(scripts) || testFiles.some((file) => /\.(?:test|spec)\.(?:mjs|cjs|js)$/.test(file))) {
    frameworks.add("node:test");
  }
  const pythonConfig = [pyproject, pytestIni, setupCfg, requirements].filter(Boolean).join("\n");
  if (/\bpytest\b/i.test(pythonConfig) || testFiles.some((file) => /(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.py$/.test(file))) {
    frameworks.add("pytest");
  }
  const nativeConfig = [cmakeLists, makefile, conanfile, vcpkg].filter(Boolean).join("\n");
  if (cmakeLists) frameworks.add("cmake");
  if (makefile && /^test\s*:/m.test(makefile)) frameworks.add("make");
  if (/\b(?:enable_testing|add_test|ctest)\b/i.test(nativeConfig)) frameworks.add("ctest");
  if (/\b(?:gtest|googletest|GTest)\b/.test(nativeConfig) || testFiles.some((file) => /(?:gtest|google|_test)\.(?:c|cc|cpp|cxx)$/.test(file))) {
    frameworks.add("gtest");
  }
  if (/\bCatch2?\b/.test(nativeConfig) || testFiles.some((file) => /(?:catch|catch2|_test)\.(?:cc|cpp|cxx)$/.test(file))) {
    frameworks.add("catch2");
  }
  if (/\bdoctest\b/.test(nativeConfig) || testFiles.some((file) => /(?:doctest|_test)\.(?:cc|cpp|cxx)$/.test(file))) {
    frameworks.add("doctest");
  }
  if (files.some((file) => /\.(?:c|cc|cpp|cxx|h|hpp|hh|hxx)$/.test(file)) && ![...frameworks].some((framework) => ["cmake", "make", "ctest", "gtest", "catch2", "doctest"].includes(framework))) {
    frameworks.add("native-c-cpp");
  }
  return [...frameworks].sort();
}

function detectFrameworkAdapters({ frameworks, testFiles }) {
  return frameworks.map((framework) => {
    const adapter = normalizeFramework(framework);
    const supported = ["jest", "vitest", "node:test", "pytest"].includes(adapter);
    return {
      framework,
      adapter,
      supported,
      testFiles: testFiles.filter((file) => frameworkMatchesFile(adapter, file)).slice(0, 50),
      limitation: supported
        ? "Extracts direct literal assertions such as expect(fn(args)).toEqual(value) or assert fn(args) == value."
        : ["cmake", "make", "ctest", "gtest", "catch2", "doctest", "native-c-cpp"].includes(adapter)
          ? "C/C++ uses project-test certification rather than direct assertion extraction; PatchProof can inspect, statically repair selected findings, and certify with project test commands."
        : "No direct framework adapter yet."
    };
  });
}

function detectTestCommands({ packageJson, frameworks }) {
  const commands = [];
  if (packageJson?.scripts?.test) commands.push({ tool: "npm", command: "npm test" });
  if (frameworks.includes("vitest") && !commands.some((item) => item.command.includes("vitest"))) {
    commands.push({ tool: "vitest", command: "npx vitest run" });
  }
  if (frameworks.includes("jest") && !commands.some((item) => item.command.includes("jest"))) {
    commands.push({ tool: "jest", command: "npx jest" });
  }
  if (frameworks.includes("pytest")) commands.push({ tool: "pytest", command: "python -m pytest" });
  if (frameworks.includes("ctest")) commands.push({ tool: "ctest", command: "ctest --test-dir build --output-on-failure" });
  if (frameworks.includes("make")) commands.push({ tool: "make", command: "make test" });
  return commands;
}

function detectBuildCommands({ packageJson, frameworks }) {
  const commands = [];
  if (packageJson?.scripts?.build) commands.push({ tool: "npm", command: "npm run build" });
  if (frameworks.includes("cmake")) {
    commands.push({ tool: "cmake-configure", command: "cmake -S . -B build" });
    commands.push({ tool: "cmake-build", command: "cmake --build build" });
  }
  if (frameworks.includes("make")) commands.push({ tool: "make", command: "make" });
  return commands;
}

function frameworkMatchesFile(framework, file) {
  if (framework === "pytest") return /(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.py$/.test(file);
  if (["cmake", "make", "ctest", "gtest", "catch2", "doctest", "native-c-cpp"].includes(framework)) {
    return /(?:^|\/)(?:test|tests)\//.test(file) && /\.(?:c|cc|cpp|cxx|h|hpp|hh|hxx)$/.test(file) ||
      /(?:^test_|_test\.|\.test\.|spec\.)/.test(file) && /\.(?:c|cc|cpp|cxx)$/.test(file);
  }
  if (["jest", "vitest", "node:test"].includes(framework)) {
    return /\.(?:test|spec)\.(?:mjs|cjs|js|jsx|ts|tsx)$/.test(file) || /(?:^|\/)(?:test|tests|__tests__)\//.test(file);
  }
  return false;
}

function inferFrameworkFromPath(testPath) {
  if (/\.py$/.test(testPath)) return "pytest";
  if (/\.(?:mjs|cjs|js|jsx|ts|tsx)$/.test(testPath)) return "jest";
  if (/\.(?:c|cc|cpp|cxx)$/.test(testPath)) return "native-c-cpp";
  return "unknown";
}

function normalizeFramework(framework) {
  const value = String(framework || "").toLowerCase();
  if (value === "node" || value === "node:test") return "node:test";
  if (value === "py" || value === "pytest") return "pytest";
  if (value === "vitest") return "vitest";
  if (value === "jest") return "jest";
  if (value === "c++") return "cpp";
  if (["cmake", "make", "ctest", "gtest", "googletest", "catch2", "doctest", "native-c-cpp"].includes(value)) {
    return value === "googletest" ? "gtest" : value;
  }
  return value || "unknown";
}

function parseJavaScriptModule(source, sourcePath) {
  try {
    return parseBabel(String(source || ""), {
      sourceType: "unambiguous",
      errorRecovery: false,
      plugins: [
        "typescript",
        "jsx",
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "objectRestSpread",
        "optionalChaining",
        "nullishCoalescingOperator",
        "decorators-legacy"
      ]
    });
  } catch (error) {
    throw new Error(`Could not parse JavaScript/TypeScript in ${sourcePath}: ${error.message}`);
  }
}

function walkAst(node, visit, parent = null) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "extra", "leadingComments", "trailingComments", "innerComments"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) walkAst(item, visit, node);
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      walkAst(value, visit, node);
    }
  }
}

function parseJavaScriptFrameworkAssertions(text, functionName, framework) {
  const tests = [];
  const source = String(text || "");
  const ast = parseJavaScriptModule(source, "framework tests");
  walkAst(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const expectCase = extractExpectAssertion(node, functionName);
    if (expectCase) {
      tests.push({
        name: `${framework} ${functionName} case ${tests.length + 1}`,
        ...expectCase
      });
      return;
    }
    const assertCase = extractAssertAssertion(node, functionName);
    if (assertCase) {
      tests.push({
        name: `${framework} ${functionName} case ${tests.length + 1}`,
        ...assertCase
      });
    }
  });
  return tests;
}

function extractExpectAssertion(node, functionName) {
  if (node.callee?.type !== "MemberExpression") return null;
  const matcher = memberPropertyName(node.callee);
  if (!["toBe", "toEqual", "toStrictEqual", "toBeTruthy", "toBeFalsy"].includes(matcher)) return null;
  const chain = unwrapExpectMatcherChain(node.callee.object);
  const expectCall = chain.expectCall;
  if (expectCall?.type !== "CallExpression" || expectCall.callee?.name !== "expect") return null;
  const actualCall = expectCall.arguments?.[0];
  if (!isTargetCall(actualCall, functionName)) return null;
  if (matcher === "toBeTruthy" || matcher === "toBeFalsy") {
    if (node.arguments.length !== 0) return null;
    try {
      return {
        args: actualCall.arguments.map(evaluateJavaScriptLiteral),
        expect: chain.negated ? matcher === "toBeFalsy" : matcher === "toBeTruthy"
      };
    } catch {
      return null;
    }
  }
  if (node.arguments.length !== 1) return null;
  if (chain.negated) {
    const expected = evaluateJavaScriptLiteralOrNull(node.arguments[0]);
    if (typeof expected !== "boolean") return null;
    try {
      return {
        args: actualCall.arguments.map(evaluateJavaScriptLiteral),
        expect: !expected
      };
    } catch {
      return null;
    }
  }
  return literalTestCase(actualCall.arguments, node.arguments[0]);
}

function unwrapExpectMatcherChain(node) {
  if (node?.type === "MemberExpression" && memberPropertyName(node) === "not") {
    return { expectCall: node.object, negated: true };
  }
  return { expectCall: node, negated: false };
}

function extractAssertAssertion(node, functionName) {
  if (node.callee?.type !== "MemberExpression") return null;
  if (node.callee.object?.name !== "assert") return null;
  const matcher = memberPropertyName(node.callee);
  if (!["equal", "strictEqual", "deepEqual", "deepStrictEqual"].includes(matcher)) return null;
  const actualCall = node.arguments?.[0];
  if (!isTargetCall(actualCall, functionName)) return null;
  if (node.arguments.length < 2) return null;
  return literalTestCase(actualCall.arguments, node.arguments[1]);
}

function isTargetCall(node, functionName) {
  if (node?.type !== "CallExpression") return false;
  if (node.callee?.type === "Identifier") return node.callee.name === functionName;
  if (node.callee?.type === "MemberExpression") return memberPropertyName(node.callee) === functionName;
  return false;
}

function literalTestCase(argsNodes, expectedNode) {
  try {
    return {
      args: argsNodes.map(evaluateJavaScriptLiteral),
      expect: evaluateJavaScriptLiteral(expectedNode)
    };
  } catch {
    return null;
  }
}

function evaluateJavaScriptLiteralOrNull(node) {
  try {
    return evaluateJavaScriptLiteral(node);
  } catch {
    return null;
  }
}

function evaluateJavaScriptLiteral(node) {
  if (!node) throw new Error("missing literal");
  if (node.type === "NumericLiteral" || node.type === "StringLiteral" || node.type === "BooleanLiteral") return node.value;
  if (node.type === "NullLiteral") return null;
  if (node.type === "Identifier" && node.name === "undefined") return undefined;
  if (node.type === "UnaryExpression" && node.operator === "-") {
    const value = evaluateJavaScriptLiteral(node.argument);
    if (typeof value !== "number") throw new Error("unsupported unary literal");
    return -value;
  }
  if (node.type === "ArrayExpression") return node.elements.map(evaluateJavaScriptLiteral);
  if (node.type === "ObjectExpression") {
    const object = {};
    for (const property of node.properties) {
      if (property.type !== "ObjectProperty" || property.computed) throw new Error("unsupported object literal");
      const key = property.key.type === "Identifier" ? property.key.name : evaluateJavaScriptLiteral(property.key);
      object[key] = evaluateJavaScriptLiteral(property.value);
    }
    return object;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked).join("");
  }
  throw new Error(`unsupported literal: ${node.type}`);
}

function memberPropertyName(node) {
  if (!node || node.type !== "MemberExpression") return "";
  if (node.property?.type === "Identifier") return node.property.name;
  if (node.property?.type === "StringLiteral") return node.property.value;
  return "";
}

function parsePytestAssertions(text, functionName) {
  const executable = process.env.PATCHPROOF_PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
  const result = spawnSync(executable, ["-I", "-S", pytestExtractor], {
    input: JSON.stringify({ source: String(text || ""), functionName }),
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0 || result.error) {
    return [];
  }
  try {
    return JSON.parse(result.stdout || "{}").tests || [];
  } catch {
    return [];
  }
}

function pushExtractedTest(tests, functionName, argsText, expectText, framework) {
  try {
    tests.push({
      name: `${framework} ${functionName} case ${tests.length + 1}`,
      args: splitTopLevel(argsText).map(parseSimpleLiteral),
      expect: parseSimpleLiteral(expectText)
    });
  } catch {
    // Ignore assertions that use variables, matchers, callbacks, snapshots, or other non-literal values.
  }
}

function splitTopLevel(text) {
  const values = [];
  let current = "";
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (const char of String(text || "")) {
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
    } else if (char === "[" || char === "{" || char === "(") {
      depth += 1;
      current += char;
    } else if (char === "]" || char === "}" || char === ")") {
      depth -= 1;
      current += char;
    } else if (char === "," && depth === 0) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) values.push(current.trim());
  return values;
}

function parseSimpleLiteral(text) {
  const value = String(text || "").trim().replace(/;$/, "");
  if (!value) throw new Error("empty literal");
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (["true", "True"].includes(value)) return true;
  if (["false", "False"].includes(value)) return false;
  if (["null", "None"].includes(value)) return null;
  if (value === "undefined") return undefined;
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return parseQuotedString(value);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner ? splitTopLevel(inner).map(parseSimpleLiteral) : [];
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    return parseSimpleObject(value);
  }
  throw new Error(`unsupported literal: ${value}`);
}

function parseQuotedString(value) {
  const quote = value[0];
  const body = value.slice(1, -1);
  if (quote === "\"") return JSON.parse(value);
  return body.replace(/\\'/g, "'").replace(/\\\\/g, "\\").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

function parseSimpleObject(value) {
  const body = value.slice(1, -1).trim();
  if (!body) return {};
  const object = {};
  for (const entry of splitTopLevel(body)) {
    const separator = entry.indexOf(":");
    if (separator === -1) throw new Error("unsupported object literal");
    const keyText = entry.slice(0, separator).trim();
    const rawKey = keyText.startsWith("\"") || keyText.startsWith("'")
      ? parseQuotedString(keyText)
      : keyText;
    if (!/^[A-Za-z_$][\w$]*$/.test(rawKey)) throw new Error("unsupported object key");
    object[rawKey] = parseSimpleLiteral(entry.slice(separator + 1));
  }
  return object;
}

function isSourceFile(file) {
  if (isTestFile(file)) return false;
  if (!/\.(?:mjs|cjs|js|jsx|ts|tsx|py|c|cc|cpp|cxx|h|hpp|hh|hxx)$/.test(file)) return false;
  return /^(?:src|lib|app|packages|server|services)\//.test(file) || !file.includes("/");
}

function isGeneratedSourceFile(file, text) {
  if (/\.min\.(?:js|css)$/.test(file) || /\.(?:generated|g)\.(?:js|ts|py|c|cc|cpp|h|hpp)$/.test(file)) {
    return true;
  }
  const header = String(text || "").split(/\r?\n/).slice(0, 20).join("\n");
  return /(?:@generated|auto-generated|autogenerated|generated by|do not edit)/i.test(header);
}

function isTestFile(file) {
  const name = basename(file);
  return /(?:^|\/)(?:test|tests|__tests__)\//.test(file) ||
    /\.(?:test|spec)\.(?:mjs|cjs|js|jsx|ts|tsx)$/.test(file) ||
    /(?:^test_.*|.*_test)\.py$/.test(name) ||
    /(?:^test_|_test\.|\.test\.|spec\.).*\.(?:c|cc|cpp|cxx)$/.test(name) ||
    /\.patchproof\.json$/.test(file);
}

function normalizeRepositoryLanguage(language) {
  const value = String(language || "javascript").toLowerCase();
  if (value === "js") return "javascript";
  if (value === "ts") return "typescript";
  if (value === "py") return "python";
  if (["cc", "cxx", "c++"].includes(value)) return "cpp";
  return value;
}

function buildInspectionSuggestions({ patchproof, frameworks, sourceFiles, patchproofTestFiles, testFiles, dependencyFiles = [] }) {
  const next = [];
  if (!patchproof.configured) {
    next.push("Add patchproof.yml with targets that map source files to JSON PatchProof tests.");
  } else if (patchproof.error) {
    next.push(`Fix patchproof.yml: ${patchproof.error}`);
  } else if (!patchproof.targets.length) {
    next.push("Add at least one target under patchproof.yml targets.");
  }
  if (!patchproofTestFiles.length) {
    next.push("Add *.patchproof.json tests for functions you want PatchProof to certify.");
  }
  if (frameworks.some((framework) => ["jest", "vitest", "pytest"].includes(framework))) {
    next.push("Framework tests were detected; configure frameworkTests on targets or run patchproof init to generate starter targets.");
  }
  if (frameworks.includes("pytest") && dependencyFiles.some((file) => /(?:requirements.*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile)/.test(file))) {
    next.push("Python dependencies were detected; run detection with --install or set project.installCommand before project-test validation.");
  }
  if (frameworks.some((framework) => ["cmake", "make", "ctest", "gtest", "catch2", "doctest"].includes(framework))) {
    next.push("Native build/test metadata was detected; use --build --run-tests when previewing repository repairs.");
  }
  return {
    readyTargets: patchproof.targets.length,
    candidateSourceFiles: sourceFiles.slice(0, 10),
    candidatePatchProofTests: patchproofTestFiles.slice(0, 10),
    candidateProjectTests: testFiles.filter((file) => !file.endsWith(".patchproof.json")).slice(0, 10),
    dependencyFiles: dependencyFiles.slice(0, 10),
    next
  };
}

function gitInfo(repoRoot) {
  const commit = runGit(repoRoot, ["rev-parse", "--short", "HEAD"]);
  const branch = runGit(repoRoot, ["branch", "--show-current"]);
  const status = runGit(repoRoot, ["status", "--porcelain"]);
  return {
    available: Boolean(commit),
    branch: branch || null,
    commit: commit || null,
    dirty: Boolean(status)
  };
}

function runGit(repoRoot, args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000
  });
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

function extractJavaScriptFunction(source, functionName, sourcePath) {
  return extractJavaScriptFunctionSpan(source, functionName, sourcePath).source;
}

function extractJavaScriptFunctionSpan(source, functionName, sourcePath) {
  const candidates = listJavaScriptFunctionCandidates(source, sourcePath)
    .filter((candidate) => !functionName || candidate.functionName === functionName);
  if (!candidates.length) {
    throw new Error(functionName
      ? `Could not find JavaScript function '${functionName}' in ${sourcePath}.`
      : `Could not find a named JavaScript function in ${sourcePath}.`);
  }
  if (!functionName && candidates.length > 1) {
    throw new Error(`Multiple JavaScript functions found in ${sourcePath}. Set function: <name> on the target.`);
  }

  return candidates[0];
}

function listJavaScriptFunctionCandidates(source, sourcePath = "source") {
  const ast = parseJavaScriptModule(source, sourcePath);
  const candidates = [];
  walkAst(ast, (node, parent) => {
    if (node.type === "FunctionDeclaration") {
      const name = node.id?.name || (parent?.type === "ExportDefaultDeclaration" ? "default" : "");
      if (!name || name === "default") return;
      const start = functionKeywordStart(source, node.start);
      candidates.push({
        functionName: name,
        start,
        end: node.end,
        replacementStyle: "declaration",
        source: normalizeJavaScriptFunctionSource(source.slice(start, node.end), sourcePath)
      });
      return;
    }

    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
      const init = unwrapExpression(node.init);
      if (!["ArrowFunctionExpression", "FunctionExpression"].includes(init?.type)) return;
      candidates.push({
        functionName: node.id.name,
        start: init.start,
        end: init.end,
        replacementStyle: "variable-init",
        source: normalizeJavaScriptFunctionSource(functionSourceFromExpression(source, node.id.name, init), sourcePath)
      });
      return;
    }

    if (node.type === "AssignmentExpression") {
      const name = assignmentFunctionName(node.left);
      const right = unwrapExpression(node.right);
      if (!name || !["ArrowFunctionExpression", "FunctionExpression"].includes(right?.type)) return;
      candidates.push({
        functionName: name,
        start: right.start,
        end: right.end,
        replacementStyle: "variable-init",
        source: normalizeJavaScriptFunctionSource(functionSourceFromExpression(source, name, right), sourcePath)
      });
      return;
    }

    if (["ObjectMethod", "ClassMethod", "ClassPrivateMethod"].includes(node.type)) {
      const name = methodFunctionName(node);
      if (!name || node.kind === "constructor") return;
      candidates.push({
        functionName: name,
        start: node.start,
        end: node.end,
        replacementStyle: "method",
        source: normalizeJavaScriptFunctionSource(functionSourceFromMethod(source, name, node), sourcePath)
      });
    }
  });
  return dedupeFunctionCandidates(candidates);
}

function functionKeywordStart(source, start) {
  const index = source.indexOf("function", start);
  return index === -1 ? start : index;
}

function functionSourceFromExpression(source, name, node) {
  if (node.type === "FunctionExpression") {
    const body = source.slice(node.body.start, node.body.end);
    const params = sourceForParams(source, node.params);
    return `function ${name}(${params}) ${body}`;
  }
  const params = sourceForParams(source, node.params);
  const body = node.body.type === "BlockStatement"
    ? source.slice(node.body.start, node.body.end)
    : `{ return ${source.slice(node.body.start, node.body.end)}; }`;
  return `function ${name}(${params}) ${body}`;
}

function functionSourceFromMethod(source, name, node) {
  const params = sourceForParams(source, node.params);
  const body = source.slice(node.body.start, node.body.end);
  return `function ${name}(${params}) ${body}`;
}

function sourceForParams(source, params = []) {
  return params.map((param) => source.slice(param.start, param.end)).join(", ");
}

function normalizeJavaScriptFunctionSource(functionSource, sourcePath) {
  const transformed = transformSync(functionSource, {
    filename: sourcePath,
    babelrc: false,
    configFile: false,
    parserOpts: { sourceType: "script", plugins: ["typescript", "jsx"] },
    comments: false,
    compact: false,
    plugins: [["@babel/plugin-transform-typescript", { allowDeclareFields: true }]]
  });
  return String(transformed?.code || functionSource).trim().replace(/;$/, "");
}

function unwrapExpression(node) {
  let current = node;
  while (["TSAsExpression", "TSTypeAssertion", "TSNonNullExpression", "TypeCastExpression"].includes(current?.type)) {
    current = current.expression;
  }
  return current;
}

function assignmentFunctionName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "MemberExpression") return memberPropertyName(node);
  return "";
}

function methodFunctionName(node) {
  if (node.key?.type === "Identifier") return node.key.name;
  if (node.key?.type === "StringLiteral") return node.key.value;
  return "";
}

function dedupeFunctionCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = `${candidate.functionName}:${candidate.start}:${candidate.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result.sort((a, b) => a.start - b.start);
}

function extractPythonFunction(source, functionName, sourcePath) {
  return extractPythonFunctionSpan(source, functionName, sourcePath).source;
}

function extractPythonFunctionSpan(source, functionName, sourcePath) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const pattern = functionName
    ? new RegExp(`^(\\s*)def\\s+${escapeRegex(functionName)}\\s*\\(`)
    : /^(\s*)def\s+([A-Za-z_]\w*)\s*\(/;
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(pattern);
    if (match) matches.push({ index, indent: match[1].length });
  }
  if (!matches.length) {
    throw new Error(functionName
      ? `Could not find Python function '${functionName}' in ${sourcePath}.`
      : `Could not find a named Python function in ${sourcePath}.`);
  }
  if (!functionName && matches.length > 1) {
    throw new Error(`Multiple Python functions found in ${sourcePath}. Set function: <name> on the target.`);
  }

  const { index: start, indent } = matches[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const currentIndent = line.match(/^\s*/)[0].length;
    if (currentIndent <= indent) {
      end = index;
      break;
    }
  }
  const lineOffsets = lineStartOffsets(source.replace(/\r\n/g, "\n"));
  const startOffset = lineOffsets[start] + indent;
  const endOffset = end >= lineOffsets.length ? source.length : lineOffsets[end];
  return {
    functionName: functionName || lines[start].match(/def\s+([A-Za-z_]\w*)\s*\(/)?.[1] || "",
    start: startOffset,
    end: endOffset,
    indent,
    source: lines.slice(start, end).map((line) => line.slice(indent)).join("\n").trim()
  };
}

function replaceJavaScriptFunctionSource(sourceText, functionName, nextSource, expectedSource, sourcePath) {
  const span = extractJavaScriptFunctionSpan(sourceText, functionName, sourcePath);
  assertCurrentSourceMatches(span.source, expectedSource, sourcePath);
  const replacement = replacementForJavaScriptSpan(nextSource, span);
  return {
    functionName: span.functionName,
    source: `${sourceText.slice(0, span.start)}${replacement}${sourceText.slice(span.end)}`
  };
}

function replacementForJavaScriptSpan(nextSource, span) {
  const normalized = String(nextSource || "").trim();
  if (span.replacementStyle !== "method") return normalized;
  return normalized.replace(/^function\s+[A-Za-z_$][\w$]*/, span.functionName);
}

function replacePythonFunctionSource(sourceText, functionName, nextSource, expectedSource, sourcePath) {
  const span = extractPythonFunctionSpan(sourceText, functionName, sourcePath);
  assertCurrentSourceMatches(span.source, expectedSource, sourcePath);
  const indent = " ".repeat(span.indent || 0);
  const replacement = String(nextSource)
    .trim()
    .split(/\r?\n/)
    .map((line) => `${indent}${line}`)
    .join("\n");
  return {
    functionName: span.functionName,
    source: `${sourceText.slice(0, span.start)}${replacement}${sourceText.slice(span.end)}`
  };
}

function assertCurrentSourceMatches(currentSource, expectedSource, sourcePath) {
  if (!String(expectedSource || "").trim()) return;
  if (String(currentSource).trim() !== String(expectedSource).trim()) {
    throw new Error(`Current source for ${sourcePath} does not match the certificate replay input. Re-run PatchProof before applying.`);
  }
}

function lineStartOffsets(source) {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") offsets.push(index + 1);
  }
  return offsets;
}

function unifiedSourceDiff(oldSource, newSource) {
  const oldLines = oldSource.split("\n");
  const newLines = newSource.split("\n");
  const rows = ["--- source", "+++ source"];
  const max = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < max; index += 1) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];
    if (oldLine === newLine) {
      rows.push(` ${oldLine ?? ""}`);
    } else {
      if (oldLine !== undefined) rows.push(`-${oldLine}`);
      if (newLine !== undefined) rows.push(`+${newLine}`);
    }
  }
  return rows.join("\n");
}

function inferredFunctionName(language, source) {
  const pattern = language === "python" ? /def\s+([A-Za-z_]\w*)\s*\(/ : /function\s+([A-Za-z_$][\w$]*)\s*\(/;
  return source.match(pattern)?.[1] || "";
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let state = "code";
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (char === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if ((state === "single" && char === "'") || (state === "double" && char === "\"") || (state === "template" && char === "`")) {
        state = "code";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (char === "'") state = "single";
    else if (char === "\"") state = "double";
    else if (char === "`") state = "template";
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Could not find the end of the JavaScript function body.");
}

function assertAllowedTargetPath(config, repoRoot, path, label) {
  const resolved = resolveRepoPath(repoRoot, path, label);
  const repoPath = toRepoPath(repoRoot, resolved);
  const allowed = config.project?.allowedPaths || [];
  const forbidden = config.project?.forbiddenPaths || [];
  if (allowed.length && !allowed.some((pattern) => matchPath(pattern, repoPath))) {
    throw new Error(`${label} path '${repoPath}' is not allowed by project.allowedPaths.`);
  }
  if (forbidden.some((pattern) => matchPath(pattern, repoPath))) {
    throw new Error(`${label} path '${repoPath}' is forbidden by project.forbiddenPaths.`);
  }
}

function resolveRepoPath(repoRoot, path, label) {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(repoRoot, path);
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} path must stay inside the repository root.`);
  }
  return resolved;
}

function toRepoPath(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join("/");
}

function matchPath(pattern, path) {
  const normalized = String(pattern).split("\\").join("/");
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (!normalized.includes("*")) return path === normalized;
  const regex = new RegExp(`^${normalized.split("*").map(escapeRegex).join(".*")}$`);
  return regex.test(path);
}

function slugId(value) {
  return String(value || "target")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "target";
}

function quoteYaml(value) {
  return JSON.stringify(String(value || ""));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
