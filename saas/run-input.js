export function resolveQueuedRunInput({ project = {}, input, requireExplicitInput = false } = {}) {
  const config = project?.config || {};
  const language = String(input?.language || config.project?.language || "javascript").toLowerCase();
  const explicitInput = input !== undefined && input !== null;

  if (explicitInput) {
    if (!hasSource(input)) {
      throw badInput("Run input must include source. Submit input.source or omit input to use project repairInput.source.");
    }
    return normalizeRunInput(input, language);
  }

  if (requireExplicitInput) {
    throw badInput("Run input is required.");
  }

  const configInput = config.repairInput || config.github?.repairInput;
  if (hasSource(configInput)) {
    return normalizeRunInput(configInput, configInput.language || language);
  }

  throw badInput("Run input is missing. Submit input.source or configure project repairInput.source.");
}

export function hasSource(input) {
  return typeof input?.source === "string" && input.source.trim().length > 0;
}

function normalizeRunInput(input, fallbackLanguage) {
  return {
    ...input,
    language: input.language || fallbackLanguage
  };
}

function badInput(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
