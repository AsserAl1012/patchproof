const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  project: {
    language: "javascript",
    testCommand: "npm test",
    installCommand: "npm ci",
    allowedPaths: ["src/**", "tests/**"],
    forbiddenPaths: [".env", "secrets/**"]
  },
  runner: {
    timeoutSeconds: 600,
    memoryMb: 2048,
    cpus: 2,
    network: "disabled"
  },
  repair: {
    maxCandidates: 8,
    requireCertificate: true,
    minEvidenceScore: 0.75
  },
  model: {
    provider: "disabled",
    endpointEnv: "PATCHPROOF_MODEL_BASE_URL",
    apiKeyEnv: "PATCHPROOF_MODEL_API_KEY",
    model: "configurable-by-admin"
  },
  github: {
    allowedRepositories: [],
    allowedFilePaths: []
  },
  targets: {}
});

export function defaultProjectConfig() {
  return structuredClone(DEFAULT_CONFIG);
}

export function parsePatchproofConfig(text) {
  if (!String(text || "").trim()) return defaultProjectConfig();
  const parsed = parseSimpleYaml(text);
  return validatePatchproofConfig(deepMerge(defaultProjectConfig(), parsed));
}

export function validatePatchproofConfig(config) {
  if (config.version !== 1) throw new Error("patchproof.yml version must be 1.");
  if (!["javascript", "typescript", "python", "c", "cpp", "c++"].includes(config.project.language)) {
    throw new Error("project.language must be javascript, typescript, python, c, cpp, or c++.");
  }
  if (!["disabled", "allow-install"].includes(config.runner.network)) {
    throw new Error("runner.network must be disabled or allow-install.");
  }
  if (config.repair.minEvidenceScore < 0 || config.repair.minEvidenceScore > 1) {
    throw new Error("repair.minEvidenceScore must be between 0 and 1.");
  }
  if (!config.targets || typeof config.targets !== "object" || Array.isArray(config.targets)) {
    throw new Error("targets must be an object keyed by target id.");
  }
  if (config.github) {
    if (config.github.allowedRepositories !== undefined && !isStringArray(config.github.allowedRepositories)) {
      throw new Error("github.allowedRepositories must be a list of repository patterns.");
    }
    if (config.github.allowedFilePaths !== undefined && !isStringArray(config.github.allowedFilePaths)) {
      throw new Error("github.allowedFilePaths must be a list of repository-relative path patterns.");
    }
  }
  for (const [id, target] of Object.entries(config.targets)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error(`Invalid target id '${id}'.`);
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error(`target '${id}' must be an object.`);
    }
    if (target.language && !["javascript", "typescript", "python", "c", "cpp", "c++"].includes(target.language)) {
      throw new Error(`target '${id}' language must be javascript, typescript, python, c, cpp, or c++.`);
    }
  }
  return config;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim());
}

function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const current = stack[stack.length - 1].value;
    if (line.startsWith("- ")) {
      if (!Array.isArray(current)) throw new Error("Invalid list item in patchproof.yml.");
      current.push(parseScalar(line.slice(2)));
      continue;
    }
    const [key, ...rest] = line.split(":");
    const valueText = rest.join(":").trim();
    if (!key) throw new Error("Invalid key in patchproof.yml.");
    if (valueText === "") {
      const child = nextMeaningfulLineIsList(lines, index, indent) ? [] : {};
      current[key] = child;
      stack.push({ indent, value: child });
    } else if (valueText === "[]") {
      current[key] = [];
    } else {
      current[key] = parseScalar(valueText);
    }
  }
  return root;
}

function nextMeaningfulLineIsList(lines, fromIndex, parentIndent) {
  for (let index = fromIndex + 1; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^\s*/)[0].length;
    if (indent <= parentIndent) return false;
    return raw.trim().startsWith("- ");
  }
  return false;
}

function parseScalar(value) {
  const text = String(value).trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith("[") && text.endsWith("]")) {
    const body = text.slice(1, -1).trim();
    return body ? splitInlineArray(body).map(parseScalar) : [];
  }
  return text.replace(/^["']|["']$/g, "");
}

function splitInlineArray(text) {
  const values = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of String(text || "")) {
    if (quote) {
      current += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
    } else if (char === ",") {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) values.push(current.trim());
  return values;
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
