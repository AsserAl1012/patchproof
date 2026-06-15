import { createHash } from "node:crypto";

const SUPPORTED_PROVIDERS = new Set([
  "disabled",
  "openai-compatible",
  "azure-openai",
  "local"
]);

export function normalizeModelProvider(settings = {}) {
  const provider = process.env.PATCHPROOF_MODEL_PROVIDER || settings.provider || "disabled";
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error("Unsupported model provider.");
  }

  const baseUrl =
    process.env.PATCHPROOF_MODEL_BASE_URL ||
    settings.baseUrl ||
    (provider === "openai-compatible" ? "https://api.openai.com/v1" : "");
  const model =
    process.env.PATCHPROOF_MODEL_NAME ||
    settings.model ||
    (provider === "disabled" ? "local-repair-templates" : "");
  const maxTokens = positiveInteger(settings.maxTokens, 4096, "maxTokens");
  const maxCandidates = positiveInteger(settings.maxCandidates, 8, "maxCandidates");
  const timeoutMs = positiveInteger(settings.timeoutMs, 60000, "timeoutMs");

  if (provider !== "disabled" && !baseUrl) {
    throw new Error("Model provider baseUrl is required.");
  }
  if (provider !== "disabled" && !model) {
    throw new Error("Model provider model is required.");
  }

  return {
    provider,
    baseUrl: String(baseUrl).replace(/\/$/, ""),
    model: String(model),
    maxTokens,
    maxCandidates,
    timeoutMs,
    apiVersion: String(settings.apiVersion || "2024-10-21"),
    promptLogging: Boolean(settings.promptLogging),
    privacyMode: settings.privacyMode !== false
  };
}

export function modelProvenance(settings, prompt = "", candidate = "") {
  const normalized = normalizeModelProvider(settings);
  return {
    provider: normalized.provider,
    model: normalized.model,
    promptHash: hash(prompt),
    candidateHash: hash(candidate),
    promptStored: normalized.promptLogging && !normalized.privacyMode
  };
}

export function buildRepairPrompt(input = {}) {
  const language = String(input.language || "javascript").toLowerCase();
  const tests = input.testsText || JSON.stringify(input.tests || [], null, 2);
  return [
    `You generate small ${language} bug-fix candidates for bounded verification.`,
    "Return only JSON with this shape:",
    '{"candidates":[{"title":"short title","rationale":"why this fixes the bug","source":"complete named function source"}]}',
    "Do not add imports, dependencies, network access, filesystem access, eval, exec, or dynamic code generation.",
    `Each source value must contain the complete replacement for the submitted named ${language} function.`,
    "Prefer the smallest behaviorally focused change and provide distinct candidates.",
    "",
    `Bug report:\n${String(input.bugReport || "")}`,
    `Precondition:\n${String(input.preconditionText || input.precondition || "true")}`,
    `May-change predicate:\n${String(input.mayChangeText || input.mayChange || "false")}`,
    `Postcondition:\n${String(input.postconditionText || input.postcondition || "true")}`,
    `Tests:\n${String(tests)}`,
    `Source:\n${String(input.source || "")}`
  ].join("\n");
}

export async function generateModelCandidates({ settings = {}, input = {}, fetchImpl = globalThis.fetch } = {}) {
  const normalized = normalizeModelProvider(settings);
  if (normalized.provider === "disabled") {
    return {
      candidates: [],
      provenance: modelProvenance(normalized),
      provider: normalized.provider,
      model: normalized.model
    };
  }
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required for model generation.");

  const prompt = buildRepairPrompt(input);
  const apiKey = settings.apiKey || process.env.PATCHPROOF_MODEL_API_KEY || "";
  if (normalized.provider !== "local" && !apiKey) {
    throw new Error("Model provider apiKey is required.");
  }

  const headers = { "Content-Type": "application/json" };
  if (normalized.provider === "azure-openai") headers["api-key"] = apiKey;
  else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetchImpl(modelEndpoint(normalized), {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(normalized.timeoutMs),
    body: JSON.stringify({
      model: normalized.model,
      messages: [
        {
          role: "system",
          content: "You are a conservative JavaScript repair generator. Output valid JSON only."
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      max_tokens: normalized.maxTokens,
      n: Math.min(normalized.maxCandidates, 8)
    })
  }).catch((error) => {
    throw new Error(`Model provider request failed: ${error.message}`);
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Model provider returned HTTP ${response.status}: ${responseText.slice(0, 500) || response.statusText}`
    );
  }

  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`Model provider returned invalid JSON: ${error.message}`);
  }

  const candidates = [];
  const seen = new Set();
  for (const choice of payload.choices || []) {
    const content = messageText(choice?.message?.content ?? choice?.text ?? "");
    for (const candidate of parseCandidateContent(content)) {
      const source = String(candidate.source || "").trim();
      if (!source || source === String(input.source || "").trim() || seen.has(source)) continue;
      seen.add(source);
      candidates.push({
        source,
        title: String(candidate.title || `Model candidate ${candidates.length + 1}`),
        rationale: String(candidate.rationale || "Generated by the configured model provider."),
        generator: normalized.provider,
        provenance: modelProvenance(normalized, prompt, source)
      });
      if (candidates.length >= normalized.maxCandidates) break;
    }
    if (candidates.length >= normalized.maxCandidates) break;
  }

  if (!candidates.length) {
    throw new Error("Model provider returned no usable JavaScript repair candidates.");
  }

  return {
    candidates,
    provenance: modelProvenance(normalized, prompt, candidates.map((candidate) => candidate.source).join("\n\n")),
    provider: normalized.provider,
    model: normalized.model
  };
}

function modelEndpoint(settings) {
  if (settings.provider !== "azure-openai") {
    return /\/chat\/completions(?:\?|$)/.test(settings.baseUrl)
      ? settings.baseUrl
      : `${settings.baseUrl}/chat/completions`;
  }

  const base = /\/chat\/completions(?:\?|$)/.test(settings.baseUrl)
    ? settings.baseUrl
    : /\/openai\/deployments\//.test(settings.baseUrl)
      ? `${settings.baseUrl}/chat/completions`
      : `${settings.baseUrl}/openai/deployments/${encodeURIComponent(settings.model)}/chat/completions`;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}api-version=${encodeURIComponent(settings.apiVersion)}`;
}

function parseCandidateContent(content) {
  const trimmed = String(content || "").trim();
  if (!trimmed) return [];
  const unfenced = trimmed
    .replace(/^```(?:json|javascript|js|python|py)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const parsed = parseJsonCandidate(unfenced);
  if (parsed) {
    const values = Array.isArray(parsed) ? parsed : parsed.candidates || [parsed];
    return values.filter((value) => value && typeof value === "object");
  }
  if (/function\s+[A-Za-z_$][\w$]*\s*\(/.test(unfenced) || /^def\s+[A-Za-z_]\w*\s*\(/m.test(unfenced)) {
    return [{ source: unfenced }];
  }
  return [];
}

function parseJsonCandidate(text) {
  try {
    return JSON.parse(text);
  } catch {}

  for (const [startToken, endToken] of [["{", "}"], ["[", "]"]]) {
    const start = text.indexOf(startToken);
    const end = text.lastIndexOf(endToken);
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text || part?.content || "").join("");
}

function positiveInteger(value, fallback, label) {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < 1) throw new Error(`${label} must be a positive integer.`);
  return result;
}

function hash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}
