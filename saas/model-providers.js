import { createHash } from "node:crypto";

export function normalizeModelProvider(settings = {}) {
  const provider = settings.provider || "disabled";
  if (!["disabled", "openai-compatible", "azure-openai", "local"].includes(provider)) {
    throw new Error("Unsupported model provider.");
  }
  return {
    provider,
    baseUrl: settings.baseUrl || "",
    model: settings.model || (provider === "disabled" ? "local-repair-templates" : ""),
    maxTokens: Number(settings.maxTokens || 4096),
    maxCandidates: Number(settings.maxCandidates || 8),
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

function hash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}
