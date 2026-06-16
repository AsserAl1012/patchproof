import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
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
    tests: target.tests || target.testsPath || target.testFile || "",
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

  return {
    repoRoot,
    git: gitInfo(repoRoot),
    packageManager,
    languages,
    frameworks,
    testCommands,
    sourceFiles: sourceFiles.slice(0, 100),
    testFiles: testFiles.slice(0, 100),
    patchproofTestFiles: patchproofTestFiles.slice(0, 100),
    patchproof,
    suggestions: buildInspectionSuggestions({ patchproof, frameworks, sourceFiles, patchproofTestFiles, testFiles })
  };
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
  const testsPath = target.tests || target.testsPath || target.testFile;
  if (!sourcePath) throw new Error(`Repository target '${targetId}' is missing source.`);
  if (!testsPath) throw new Error(`Repository target '${targetId}' is missing tests.`);

  assertAllowedTargetPath(config, repoRoot, sourcePath, "source");
  assertAllowedTargetPath(config, repoRoot, testsPath, "tests");
  const sourceFile = resolveRepoPath(repoRoot, sourcePath, "source");
  const testsFile = resolveRepoPath(repoRoot, testsPath, "tests");
  const functionName = target.function || target.functionName || "";
  const sourceText = await readFile(sourceFile, "utf8");
  const testsText = normalizeTestsFile(await readFile(testsFile, "utf8"), testsFile);
  const source = language === "python"
    ? extractPythonFunction(sourceText, functionName, sourcePath)
    : extractJavaScriptFunction(sourceText, functionName, sourcePath);

  return {
    language,
    source,
    testsText,
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
      tests: toRepoPath(repoRoot, testsFile),
      function: functionName || inferredFunctionName(language, source)
    }
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
    next.push("Framework tests were detected; direct Jest/Vitest/pytest extraction is the next adapter layer.");
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
  return source.slice(start, end + 1).trim();
}

function extractPythonFunction(source, functionName, sourcePath) {
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
  return lines.slice(start, end).map((line) => line.slice(indent)).join("\n").trim();
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

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
