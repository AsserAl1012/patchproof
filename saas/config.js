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
  }
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
  if (!["javascript", "typescript", "python"].includes(config.project.language)) {
    throw new Error("project.language must be javascript, typescript, or python.");
  }
  if (!["disabled", "allow-install"].includes(config.runner.network)) {
    throw new Error("runner.network must be disabled or allow-install.");
  }
  if (config.repair.minEvidenceScore < 0 || config.repair.minEvidenceScore > 1) {
    throw new Error("repair.minEvidenceScore must be between 0 and 1.");
  }
  return config;
}

function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  let pendingList = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const current = stack[stack.length - 1].value;
    if (line.startsWith("- ")) {
      if (!pendingList) throw new Error("Invalid list item in patchproof.yml.");
      pendingList.push(parseScalar(line.slice(2)));
      continue;
    }
    const [key, ...rest] = line.split(":");
    const valueText = rest.join(":").trim();
    if (!key) throw new Error("Invalid key in patchproof.yml.");
    if (valueText === "") {
      const child = {};
      current[key] = child;
      stack.push({ indent, value: child });
      pendingList = null;
    } else if (valueText === "[]") {
      current[key] = [];
      pendingList = current[key];
    } else {
      current[key] = parseScalar(valueText);
      pendingList = null;
    }
    if (valueText === "") {
      const nextRaw = String(text).split(/\r?\n/).find((candidate) => candidate.trim().startsWith("- "));
      if (nextRaw) {
        // Lists are also accepted by setting "key:" then list items; convert lazily when first item arrives.
      }
    }
    if (valueText === "" && ["allowedPaths", "forbiddenPaths"].includes(key)) {
      current[key] = [];
      stack.pop();
      pendingList = current[key];
    }
  }
  return root;
}

function parseScalar(value) {
  const text = String(value).trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text.replace(/^["']|["']$/g, "");
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
