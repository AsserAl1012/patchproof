import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { parsePatchproofConfig } from "./saas/config.js";
import { languageOf } from "./runtime.js";

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
  const patchproofConfigText = await readTextIfExists(repoRoot, configPath);
  const patchproof = patchproofConfigText
    ? summarizePatchproofConfig(patchproofConfigText, configPath)
    : { configured: false, config: configPath, targets: [], error: null };
  const sourceFiles = files.filter(isSourceFile);
  const testFiles = files.filter(isTestFile);
  const patchproofTestFiles = testFiles.filter((file) => file.endsWith(".patchproof.json"));
  const packageManager = detectPackageManager(files);
  const frameworks = detectFrameworks({ packageJson, pyproject, pytestIni, setupCfg, requirements, testFiles });
  const languages = detectLanguages({ files, packageJson, pyproject });
  const testCommands = detectTestCommands({ packageJson, frameworks });
  const frameworkAdapters = detectFrameworkAdapters({ frameworks, testFiles });

  return {
    repoRoot,
    git: gitInfo(repoRoot),
    packageManager,
    languages,
    frameworks,
    frameworkAdapters,
    testCommands,
    sourceFiles: sourceFiles.slice(0, 100),
    testFiles: testFiles.slice(0, 100),
    patchproofTestFiles: patchproofTestFiles.slice(0, 100),
    patchproof,
    suggestions: buildInspectionSuggestions({ patchproof, frameworks, sourceFiles, patchproofTestFiles, testFiles })
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
  if (configuredLanguage === "typescript") {
    throw new Error("Repository adapter does not support TypeScript targets yet.");
  }
  const language = languageOf({ language: configuredLanguage });

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
  const language = languageOf({ language: configuredLanguage });
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
  const installCommand = installCommandFor(report.packageManager, language);
  const rows = [
    "version: 1",
    "project:",
    `  language: ${language}`,
    `  testCommand: ${quoteYaml(testCommand)}`,
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
  try {
    const text = await readFile(resolveRepoPath(repoRoot, sourcePath, "source"), "utf8");
    const matches = language === "python"
      ? [...text.matchAll(/^def\s+([A-Za-z_]\w*)\s*\(/gm)].map((match) => match[1])
      : [...text.matchAll(/(?:export\s+)?(?:default\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]);
    return matches.length === 1 ? matches[0] : "";
  } catch {
    return "";
  }
}

function preferredLanguage(languages) {
  if (languages.includes("python") && !languages.includes("javascript")) return "python";
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
  return language === "python" ? "python -m pip install -r requirements.txt" : "npm install";
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
  return null;
}

function detectLanguages({ files, packageJson, pyproject }) {
  const languages = new Set();
  if (packageJson || files.some((file) => /\.(?:mjs|cjs|js|jsx)$/.test(file))) languages.add("javascript");
  if (files.some((file) => /\.(?:ts|tsx)$/.test(file))) languages.add("typescript");
  if (pyproject || files.some((file) => /\.py$/.test(file))) languages.add("python");
  return [...languages].sort();
}

function detectFrameworks({ packageJson, pyproject, pytestIni, setupCfg, requirements, testFiles }) {
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
  return commands;
}

function frameworkMatchesFile(framework, file) {
  if (framework === "pytest") return /(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.py$/.test(file);
  if (["jest", "vitest", "node:test"].includes(framework)) {
    return /\.(?:test|spec)\.(?:mjs|cjs|js|jsx|ts|tsx)$/.test(file) || /(?:^|\/)(?:test|tests|__tests__)\//.test(file);
  }
  return false;
}

function inferFrameworkFromPath(testPath) {
  if (/\.py$/.test(testPath)) return "pytest";
  if (/\.(?:mjs|cjs|js|jsx|ts|tsx)$/.test(testPath)) return "jest";
  return "unknown";
}

function normalizeFramework(framework) {
  const value = String(framework || "").toLowerCase();
  if (value === "node" || value === "node:test") return "node:test";
  if (value === "py" || value === "pytest") return "pytest";
  if (value === "vitest") return "vitest";
  if (value === "jest") return "jest";
  return value || "unknown";
}

function parseJavaScriptFrameworkAssertions(text, functionName, framework) {
  const tests = [];
  const source = String(text || "");
  const name = escapeRegex(functionName);
  const expectPattern = new RegExp(
    `expect\\s*\\(\\s*${name}\\s*\\(([^\\)]*)\\)\\s*\\)\\s*\\.\\s*(?:toBe|toEqual|toStrictEqual)\\s*\\(([^\\n;]*)\\)`,
    "g"
  );
  const assertPattern = new RegExp(
    `assert\\s*\\.\\s*(?:equal|strictEqual|deepEqual|deepStrictEqual)\\s*\\(\\s*${name}\\s*\\(([^\\)]*)\\)\\s*,\\s*([^\\n;]*)\\)`,
    "g"
  );
  for (const match of source.matchAll(expectPattern)) {
    pushExtractedTest(tests, functionName, match[1], match[2], framework);
  }
  for (const match of source.matchAll(assertPattern)) {
    pushExtractedTest(tests, functionName, match[1], match[2], framework);
  }
  return tests;
}

function parsePytestAssertions(text, functionName) {
  const tests = [];
  const name = escapeRegex(functionName);
  const pattern = new RegExp(`assert\\s+${name}\\s*\\(([^\\)]*)\\)\\s*==\\s*([^#\\n]+)`, "g");
  for (const match of String(text || "").matchAll(pattern)) {
    pushExtractedTest(tests, functionName, match[1], match[2], "pytest");
  }
  return tests;
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
  if (!/\.(?:mjs|cjs|js|jsx|ts|tsx|py)$/.test(file)) return false;
  return /^(?:src|lib|app|packages|server|services)\//.test(file) || !file.includes("/");
}

function isTestFile(file) {
  const name = basename(file);
  return /(?:^|\/)(?:test|tests|__tests__)\//.test(file) ||
    /\.(?:test|spec)\.(?:mjs|cjs|js|jsx|ts|tsx)$/.test(file) ||
    /(?:^test_.*|.*_test)\.py$/.test(name) ||
    /\.patchproof\.json$/.test(file);
}

function buildInspectionSuggestions({ patchproof, frameworks, sourceFiles, patchproofTestFiles, testFiles }) {
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
  return {
    readyTargets: patchproof.targets.length,
    candidateSourceFiles: sourceFiles.slice(0, 10),
    candidatePatchProofTests: patchproofTestFiles.slice(0, 10),
    candidateProjectTests: testFiles.filter((file) => !file.endsWith(".patchproof.json")).slice(0, 10),
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
  const namePattern = functionName ? escapeRegex(functionName) : "[A-Za-z_$][\\w$]*";
  const pattern = new RegExp(`(?:export\\s+)?(?:default\\s+)?function\\s+(${namePattern})\\s*\\(`, "g");
  const matches = [...source.matchAll(pattern)];
  if (!matches.length) {
    throw new Error(functionName
      ? `Could not find JavaScript function '${functionName}' in ${sourcePath}.`
      : `Could not find a named JavaScript function in ${sourcePath}.`);
  }
  if (!functionName && matches.length > 1) {
    throw new Error(`Multiple JavaScript functions found in ${sourcePath}. Set function: <name> on the target.`);
  }

  const match = matches[0];
  const functionOffset = match[0].indexOf("function");
  const start = match.index + functionOffset;
  const bodyStart = source.indexOf("{", start);
  if (bodyStart === -1) throw new Error(`Could not find function body in ${sourcePath}.`);
  const end = findMatchingBrace(source, bodyStart);
  return {
    functionName: match[1],
    start,
    end: end + 1,
    source: source.slice(start, end + 1).trim()
  };
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
  return {
    functionName: span.functionName,
    source: `${sourceText.slice(0, span.start)}${String(nextSource).trim()}${sourceText.slice(span.end)}`
  };
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
