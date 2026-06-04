export const CERTIFICATE_SCHEMA = "patchproof.certificate.v2";
export const PATCHPROOF_VERSION = "0.4.0";
const DEFAULT_LIMITS = Object.freeze({
  maxSourceChars: 12000,
  maxTests: 100,
  maxDomainSize: 2400,
  maxCounterexamples: 8,
  minMutationScore: 0.5
});

const FORBIDDEN_CODE_PATTERNS = [
  /\bFunction\b/,
  /\beval\b/,
  /\bfetch\b/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bWorker\b/,
  /\bSharedWorker\b/,
  /\bimportScripts\b/,
  /\bpostMessage\b/,
  /\bindexedDB\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bdocument\b/,
  /\bwindow\b/,
  /\bglobalThis\b/,
  /\bprocess\b/,
  /\brequire\b/,
  /\bimport\s*\(/
];

export const examples = [
  {
    id: "clamp-range",
    title: "Clamp range regression",
    subtitle: "Wrong upper-bound variable",
    bugReport:
      "clamp(value, min, max) returns max for in-range values above min. It should only return max when value is greater than max.",
    source: `function clamp(value, min, max) {
  if (value < min) return min;
  if (value > min) return max;
  return value;
}`,
    tests: [
      { name: "below min is raised", args: [-5, 0, 10], expect: 0 },
      { name: "above max is lowered", args: [12, 0, 10], expect: 10 },
      { name: "in range is preserved", args: [6, 0, 10], expect: 6 },
      { name: "lower boundary is stable", args: [0, 0, 10], expect: 0 },
      { name: "upper boundary is stable", args: [10, 0, 10], expect: 10 }
    ],
    precondition: "args[1] <= args[2]",
    mayChange: "args[0] > args[1] && args[0] < args[2]",
    postcondition: "result === Math.min(Math.max(args[0], args[1]), args[2])"
  },
  {
    id: "slugify-whitespace",
    title: "Slug whitespace bug",
    subtitle: "Only first space is replaced",
    bugReport:
      "slugify should collapse every run of whitespace into one dash. The current implementation only replaces the first single space.",
    source: `function slugify(title) {
  const cleaned = title.trim().toLowerCase();
  return cleaned.replace(" ", "-");
}`,
    tests: [
      { name: "single word", args: ["Hello"], expect: "hello" },
      { name: "one space", args: ["Hello World"], expect: "hello-world" },
      { name: "multiple spaces", args: ["Hello   World"], expect: "hello-world" },
      { name: "leading and trailing whitespace", args: ["  API Client  "], expect: "api-client" }
    ],
    precondition: "typeof args[0] === 'string'",
    mayChange: "/\\s/.test(args[0].trim())",
    postcondition: "result === args[0].trim().toLowerCase().replace(/\\s+/g, '-')"
  },
  {
    id: "take-limit",
    title: "List limit off by one",
    subtitle: "Drops one valid item",
    bugReport:
      "take(items, limit) should return up to limit items. Positive limits currently return one fewer item than requested.",
    source: `function take(items, limit) {
  if (limit <= 0) return [];
  return items.slice(0, limit - 1);
}`,
    tests: [
      { name: "zero limit", args: [[1, 2, 3], 0], expect: [] },
      { name: "negative limit", args: [[1, 2, 3], -1], expect: [] },
      { name: "two item limit", args: [[1, 2, 3], 2], expect: [1, 2] },
      { name: "limit past length", args: [[1, 2, 3], 9], expect: [1, 2, 3] }
    ],
    precondition: "Array.isArray(args[0]) && Number.isInteger(args[1])",
    mayChange: "args[1] > 0",
    postcondition:
      "Array.isArray(result) && result.length === Math.min(Math.max(args[1], 0), args[0].length) && result.every((value, index) => value === args[0][index])"
  }
];

const repairTemplates = [
  {
    id: "upper-bound-variable",
    label: "Replace lower-bound variable in upper-bound check",
    risk: ["local-branch-change", "range-boundary"],
    apply(source) {
      if (!/\bmax\b/.test(source)) return null;
      return source.replace(/>\s*min\b/g, "> max");
    }
  },
  {
    id: "collapse-whitespace",
    label: "Use global whitespace-regex replacement",
    risk: ["string-normalization", "regex-change"],
    apply(source) {
      return source
        .replace(/\.replace\(" ",\s*"-"\)/g, ".replace(/\\s+/g, '-')")
        .replace(/\.replace\(' ',\s*'-'\)/g, ".replace(/\\s+/g, '-')");
    }
  },
  {
    id: "slice-limit-off-by-one",
    label: "Remove off-by-one from slice limit",
    risk: ["boundary-change", "collection-size"],
    apply(source) {
      return source.replace(/\.slice\(0,\s*limit\s*-\s*1\)/g, ".slice(0, limit)");
    }
  },
  {
    id: "exclusive-to-inclusive-lower",
    label: "Try inclusive lower-bound guard",
    risk: ["boundary-change", "speculative"],
    apply(source) {
      return source.replace(/<\s*min\b/g, "<= min");
    }
  },
  {
    id: "strict-upper-bound",
    label: "Try inclusive upper-bound guard",
    risk: ["boundary-change", "speculative"],
    apply(source) {
      return source.replace(/>\s*max\b/g, ">= max");
    }
  }
];

export function runPatchProof(input) {
  const startedAt = new Date().toISOString();
  const normalized = normalizeRunInput(input);
  const tests = parseTests(normalized.testsText);
  const oldProgram = compileFunction(normalized.source);
  const precondition = compilePredicate(normalized.preconditionText, true, "precondition");
  const mayChange = compilePredicate(normalized.mayChangeText, false, "may-change predicate");
  const postcondition = compilePredicate(normalized.postconditionText, true, "postcondition");
  const baseline = runTestSuite(oldProgram.fn, tests);
  const bugTests = baseline.tests.filter((test) => !test.pass);
  const passingTests = baseline.tests.filter((test) => test.pass);
  const rawDomain = buildFiniteDomain(tests);
  const domain = rawDomain.filter((args) => precondition(deepClone(args), undefined, null));
  if (!domain.length) {
    throw new Error("The precondition excluded every generated input. Relax it or add broader tests.");
  }
  const candidates = generateCandidates(normalized.source, normalized.bugReport);

  const validated = candidates.map((candidate) =>
    validateCandidate({
      candidate,
      oldProgram,
      tests,
      baselineFailingNames: bugTests.map((test) => test.name),
      mayChange,
      postcondition,
      domain,
      limits: normalized.limits
    })
  );

  const accepted = validated.filter((candidate) => candidate.accepted);
  const selected = accepted.length
    ? accepted.reduce((best, candidate) =>
        candidate.evidenceScore > best.evidenceScore ? candidate : best
      )
    : validated.reduce((best, candidate) =>
        candidate.evidenceScore > best.evidenceScore ? candidate : best
      );

  const certificate = buildCertificate({
    input: normalized,
    startedAt,
    oldProgram,
    baseline,
    bugTests,
    passingTests,
    domain,
    candidates: validated,
    selected,
    limits: normalized.limits
  });

  return {
    startedAt,
    functionName: oldProgram.name,
    baseline,
    candidates: validated,
    selected,
    certificate,
    logs: buildLogs(baseline, validated, selected, domain)
  };
}

export function createInputFromExample(example) {
  return {
    source: example.source,
    testsText: JSON.stringify(example.tests, null, 2),
    bugReport: example.bugReport,
    preconditionText: example.precondition,
    mayChangeText: example.mayChange,
    postconditionText: example.postcondition
  };
}

export function verifyCertificate(certificate) {
  const mismatches = [];
  if (!certificate || typeof certificate !== "object") {
    return {
      valid: false,
      mismatches: ["Certificate must be a JSON object."],
      reproduced: null
    };
  }
  if (certificate.schema !== CERTIFICATE_SCHEMA) {
    mismatches.push(`Unsupported schema: expected ${CERTIFICATE_SCHEMA}, got ${certificate.schema || "missing"}.`);
  }
  const replayInput = certificate.replay?.input;
  if (!replayInput) {
    mismatches.push("Certificate does not include replay.input.");
    return {
      valid: false,
      mismatches,
      reproduced: null
    };
  }

  let reproduced;
  try {
    reproduced = runPatchProof(replayInput);
  } catch (error) {
    mismatches.push(`Replay failed: ${error.message}`);
    return {
      valid: false,
      mismatches,
      reproduced: null
    };
  }

  compareField(mismatches, "runId", certificate.runId, reproduced.certificate.runId);
  compareField(mismatches, "status", certificate.status, reproduced.certificate.status);
  compareField(
    mismatches,
    "selectedPatch.id",
    certificate.selectedPatch?.id,
    reproduced.certificate.selectedPatch?.id
  );
  compareField(
    mismatches,
    "selectedPatch.accepted",
    certificate.selectedPatch?.accepted,
    reproduced.certificate.selectedPatch?.accepted
  );
  compareField(
    mismatches,
    "selectedPatch.evidenceScore",
    certificate.selectedPatch?.evidenceScore,
    reproduced.certificate.selectedPatch?.evidenceScore
  );
  compareField(
    mismatches,
    "behavioralEnvelope.finiteDomainSize",
    certificate.behavioralEnvelope?.finiteDomainSize,
    reproduced.certificate.behavioralEnvelope?.finiteDomainSize
  );

  return {
    valid: mismatches.length === 0,
    mismatches,
    reproduced: reproduced.certificate
  };
}

function compareField(mismatches, field, expected, actual) {
  if (!deepEqual(expected, actual)) {
    mismatches.push(`${field} mismatch: expected ${stableStringify(expected)}, got ${stableStringify(actual)}.`);
  }
}

function normalizeRunInput(input) {
  const source = String(input.source || "");
  const testsText = String(input.testsText || JSON.stringify(input.tests || []));
  if (!source.trim()) throw new Error("Source is required.");
  if (source.length > DEFAULT_LIMITS.maxSourceChars) {
    throw new Error(`Source exceeds ${DEFAULT_LIMITS.maxSourceChars} characters.`);
  }
  return {
    source,
    testsText,
    bugReport: String(input.bugReport || ""),
    preconditionText: String(input.preconditionText || input.precondition || ""),
    mayChangeText: String(input.mayChangeText || input.mayChange || ""),
    postconditionText: String(input.postconditionText || input.postcondition || ""),
    executionMode: String(input.executionMode || "local-js-engine"),
    limits: {
      ...DEFAULT_LIMITS,
      ...(input.limits || {})
    }
  };
}

function parseTests(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Tests must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("Tests JSON must be an array.");
  if (parsed.length === 0) throw new Error("At least one executable test is required.");
  if (parsed.length > DEFAULT_LIMITS.maxTests) {
    throw new Error(`Too many tests. The local demo limit is ${DEFAULT_LIMITS.maxTests}.`);
  }
  return parsed.map((test, index) => {
    if (!Array.isArray(test.args)) {
      throw new Error(`Test ${index + 1} must include an args array.`);
    }
    return {
      name: test.name || `case ${index + 1}`,
      args: test.args,
      expect: "expect" in test ? test.expect : undefined,
      expectError: test.expectError || null
    };
  });
}

function compileFunction(source) {
  assertSafeCode(source, "source");
  const match = source.match(/function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (!match) {
    throw new Error("Source must declare a named function.");
  }
  const name = match[1];
  let fn;
  try {
    fn = Function(`"use strict";\n${source}\nreturn ${name};`)();
  } catch (error) {
    throw new Error(`Could not compile ${name}: ${error.message}`);
  }
  if (typeof fn !== "function") throw new Error(`${name} did not compile to a function.`);
  return { name, fn, source };
}

function compilePredicate(text, defaultValue, label) {
  const expression = String(text || "").trim();
  if (!expression) return () => defaultValue;
  assertSafeCode(expression, label);
  try {
    const fn = Function(
      "args",
      "result",
      "observation",
      `"use strict"; return Boolean(${expression});`
    );
    return (args, result, observation) => Boolean(fn(args, result, observation));
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error.message}`);
  }
}

function assertSafeCode(code, label) {
  for (const pattern of FORBIDDEN_CODE_PATTERNS) {
    if (pattern.test(code)) {
      throw new Error(`Unsafe ${label}: forbidden token matched ${pattern}.`);
    }
  }
}

function generateCandidates(source, bugReport) {
  const keywords = String(bugReport || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const candidates = [];
  const seen = new Set();

  for (const template of repairTemplates) {
    const patched = template.apply(source);
    if (!patched || patched === source || seen.has(patched)) continue;
    seen.add(patched);
    candidates.push({
      id: `p${candidates.length + 1}`,
      templateId: template.id,
      title: template.label,
      source: patched,
      diff: unifiedDiff(source, patched),
      risk: template.risk,
      plannerTrace: scoreTemplate(template, keywords)
    });
  }

  if (!candidates.length) {
    candidates.push({
      id: "p1",
      templateId: "no-local-template",
      title: "No safe local template matched",
      source,
      diff: "No diff generated. Add a matching local repair template or edit the source.",
      risk: ["no-change"],
      plannerTrace: {
        score: 0,
        matchedTerms: [],
        rationale: "The local model adapter could not map the bug report to an available repair operator."
      }
    });
  }

  return candidates;
}

function scoreTemplate(template, keywords) {
  const haystack = `${template.id} ${template.label} ${template.risk.join(" ")}`.toLowerCase();
  const matchedTerms = keywords.filter((word) => haystack.includes(word));
  return {
    score: matchedTerms.length,
    matchedTerms,
    rationale:
      matchedTerms.length > 0
        ? `Repair operator selected from issue terms: ${matchedTerms.join(", ")}.`
        : "Repair operator selected because its source-level pattern matched the changed function."
  };
}

function validateCandidate({
  candidate,
  oldProgram,
  tests,
  baselineFailingNames,
  mayChange,
  postcondition,
  domain,
  limits
}) {
  const result = {
    ...candidate,
    accepted: false,
    evidenceScore: 0,
    explicitTests: null,
    preservation: null,
    postcondition: null,
    boundedProof: null,
    mutation: null,
    compileError: null,
    fixedBug: false,
    fixedFailingTests: [],
    rejectionReasons: []
  };

  let newProgram;
  try {
    newProgram = compileFunction(candidate.source);
  } catch (error) {
    result.compileError = error.message;
    return result;
  }

  result.explicitTests = runTestSuite(newProgram.fn, tests);
  result.preservation = checkPreservation(oldProgram.fn, newProgram.fn, domain, mayChange);
  result.postcondition = checkPostcondition(newProgram.fn, domain, postcondition);
  result.boundedProof = {
    status:
      result.preservation.counterexamples.length === 0 &&
      result.postcondition.counterexamples.length === 0
        ? "no-counterexample-in-finite-envelope"
        : "counterexample-found",
    domainSize: domain.length,
    preserveCases: result.preservation.checked,
    mayChangeCases: result.preservation.skippedMayChange,
    postconditionCases: result.postcondition.checked
  };
  result.mutation = mutationCheck(candidate.source, tests, domain, mayChange, postcondition);

  const explicitPass = result.explicitTests.passCount === result.explicitTests.tests.length;
  const passByName = new Map(result.explicitTests.tests.map((test) => [test.name, test.pass]));
  result.fixedFailingTests = baselineFailingNames.filter((name) => passByName.get(name));
  result.fixedBug =
    baselineFailingNames.length > 0 && result.fixedFailingTests.length === baselineFailingNames.length;
  const preservePass = result.preservation.counterexamples.length === 0;
  const postPass = result.postcondition.counterexamples.length === 0;
  const mutationPass = result.mutation.score >= limits.minMutationScore;
  if (baselineFailingNames.length === 0) {
    result.rejectionReasons.push("No failing test was observed before repair.");
  }
  if (!result.fixedBug) {
    result.rejectionReasons.push("The original failing evidence was not fully fixed.");
  }
  if (!explicitPass) {
    result.rejectionReasons.push("One or more executable tests failed after repair.");
  }
  if (!preservePass) {
    result.rejectionReasons.push("Behavior changed outside the may-change predicate.");
  }
  if (!postPass) {
    result.rejectionReasons.push("The postcondition failed within the finite envelope.");
  }
  if (!mutationPass) {
    result.rejectionReasons.push(`Mutation score was below ${limits.minMutationScore}.`);
  }
  result.accepted = result.rejectionReasons.length === 0;
  result.evidenceScore = computeEvidenceScore({
    fixedBug: result.fixedBug,
    explicitPass,
    preservePass,
    postPass,
    mutationScore: result.mutation.score,
    proofStatus: result.boundedProof.status,
    domainSize: domain.length
  });
  return result;
}

function runTestSuite(fn, tests) {
  const results = tests.map((test) => {
    const observation = observe(fn, test.args);
    const pass = test.expectError
      ? !observation.ok && observation.error.includes(test.expectError)
      : observation.ok && deepEqual(observation.value, normalizeValue(test.expect));
    return { ...test, observation, pass };
  });
  return {
    tests: results,
    passCount: results.filter((test) => test.pass).length,
    failCount: results.filter((test) => !test.pass).length
  };
}

function checkPreservation(oldFn, newFn, domain, mayChange) {
  const counterexamples = [];
  let checked = 0;
  let skippedMayChange = 0;

  for (const args of domain) {
    const oldObservation = observe(oldFn, args);
    const newObservation = observe(newFn, args);
    const newResult = newObservation.ok ? denormalizeValue(newObservation.value) : undefined;
    const allowedToChange = mayChange(deepClone(args), newResult, newObservation);
    if (allowedToChange) {
      skippedMayChange += 1;
      continue;
    }
    checked += 1;
    if (!deepEqual(oldObservation, newObservation)) {
      counterexamples.push({
        args,
        old: oldObservation,
        next: newObservation
      });
      if (counterexamples.length >= 5) break;
    }
  }

  return { checked, skippedMayChange, counterexamples };
}

function checkPostcondition(fn, domain, postcondition) {
  const counterexamples = [];
  let checked = 0;

  for (const args of domain) {
    const observation = observe(fn, args);
    const result = observation.ok ? denormalizeValue(observation.value) : undefined;
    checked += 1;
    if (!postcondition(deepClone(args), result, observation)) {
      counterexamples.push({ args, observation });
      if (counterexamples.length >= 5) break;
    }
  }

  return { checked, counterexamples };
}

function mutationCheck(source, tests, domain, mayChange, postcondition) {
  const mutants = generateMutants(source);
  if (!mutants.length) {
    return {
      total: 0,
      killed: 0,
      score: 0.5,
      survivors: [],
      note: "No simple source mutants could be generated."
    };
  }

  const original = compileFunction(source).fn;
  let killed = 0;
  const survivors = [];

  for (const mutant of mutants) {
    let mutantFn;
    try {
      mutantFn = compileFunction(mutant.source).fn;
    } catch {
      killed += 1;
      continue;
    }

    const explicit = runTestSuite(mutantFn, tests);
    const preserve = checkPreservation(original, mutantFn, domain, mayChange);
    const post = checkPostcondition(mutantFn, domain, postcondition);
    const failed =
      explicit.failCount > 0 || preserve.counterexamples.length > 0 || post.counterexamples.length > 0;
    if (failed) {
      killed += 1;
    } else {
      survivors.push(mutant.label);
    }
  }

  return {
    total: mutants.length,
    killed,
    score: killed / mutants.length,
    survivors
  };
}

function generateMutants(source) {
  const replacements = [
    [/>=\s*/g, "> "],
    [/>\s*/g, ">= "],
    [/<=\s*/g, "< "],
    [/<\s*/g, "<= "],
    [/\+\s*1/g, "- 1"],
    [/-\s*1/g, "+ 1"],
    [/return\s+max\b/g, "return min"],
    [/return\s+min\b/g, "return max"],
    [/\\s\+\/g/g, "\\s/"],
    [/\.slice\(0,\s*limit\)/g, ".slice(0, limit - 1)"]
  ];

  const mutants = [];
  const seen = new Set();
  for (const [pattern, replacement] of replacements) {
    const mutated = source.replace(pattern, replacement);
    if (mutated !== source && !seen.has(mutated)) {
      seen.add(mutated);
      mutants.push({
        label: String(pattern),
        source: mutated
      });
    }
  }
  return mutants.slice(0, 8);
}

function buildFiniteDomain(tests) {
  const arity = tests.reduce((max, test) => Math.max(max, test.args.length), 0);
  const valuesByIndex = Array.from({ length: arity }, (_, index) => valuesForIndex(tests, index));
  const domain = cartesian(valuesByIndex).slice(0, DEFAULT_LIMITS.maxDomainSize);
  return domain.map((args) => deepClone(args));
}

function valuesForIndex(tests, index) {
  const observed = tests.map((test) => test.args[index]).filter((value) => value !== undefined);
  const values = [];
  for (const value of observed) pushUnique(values, value);
  const types = new Set(observed.map((value) => Array.isArray(value) ? "array" : typeof value));

  if (types.has("number")) {
    for (const value of [-10, -5, -1, 0, 1, 2, 3, 5, 6, 9, 10, 11, 12, 20]) pushUnique(values, value);
    for (const value of observed.filter((item) => typeof item === "number")) {
      pushUnique(values, value - 1);
      pushUnique(values, value + 1);
    }
  }

  if (types.has("string")) {
    for (const value of [
      "",
      " ",
      "Hello",
      "Hello World",
      "Hello   World",
      "  API Client  ",
      "red blue green",
      "Already-Ok",
      "tabs\tand spaces",
      "MiXeD Case"
    ]) {
      pushUnique(values, value);
    }
  }

  if (types.has("array")) {
    for (const value of [[], [1], [1, 2], [1, 2, 3], [0, 0, 0], ["a", "b", "c"]]) {
      pushUnique(values, value);
    }
  }

  return values.slice(0, 18);
}

function cartesian(lists) {
  if (!lists.length) return [[]];
  return lists.reduce(
    (acc, list) => acc.flatMap((prefix) => list.map((value) => [...prefix, value])),
    [[]]
  );
}

function pushUnique(values, candidate) {
  const key = stableStringify(candidate);
  if (!values.some((value) => stableStringify(value) === key)) values.push(candidate);
}

function observe(fn, args) {
  const clonedArgs = deepClone(args);
  const before = deepClone(clonedArgs);
  try {
    const raw = fn(...clonedArgs);
    const after = deepClone(clonedArgs);
    return {
      ok: true,
      value: normalizeValue(raw),
      mutatedArgs: !deepEqual(before, after) ? normalizeValue(after) : null
    };
  } catch (error) {
    return {
      ok: false,
      error: `${error.name}: ${error.message}`,
      mutatedArgs: null
    };
  }
}

function normalizeValue(value) {
  if (value === undefined) return { __patchproof: "undefined" };
  if (Number.isNaN(value)) return { __patchproof: "NaN" };
  if (value === Infinity) return { __patchproof: "Infinity" };
  if (value === -Infinity) return { __patchproof: "-Infinity" };
  return deepClone(value);
}

function denormalizeValue(value) {
  if (value && value.__patchproof === "undefined") return undefined;
  if (value && value.__patchproof === "NaN") return NaN;
  if (value && value.__patchproof === "Infinity") return Infinity;
  if (value && value.__patchproof === "-Infinity") return -Infinity;
  return deepClone(value);
}

function deepClone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function deepEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value) {
  return JSON.stringify(value, (_, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.keys(item)
        .sort()
        .reduce((acc, key) => {
          acc[key] = item[key];
          return acc;
        }, {});
    }
    return item;
  });
}

function computeEvidenceScore({ fixedBug, explicitPass, preservePass, postPass, mutationScore, proofStatus, domainSize }) {
  let score = 0;
  if (fixedBug) score += 0.16;
  if (explicitPass) score += 0.22;
  if (preservePass) score += 0.22;
  if (postPass) score += 0.18;
  if (proofStatus === "no-counterexample-in-finite-envelope") score += 0.1;
  score += Math.min(0.12, mutationScore * 0.12);
  if (domainSize < 20) score -= 0.05;
  return Math.max(0, Math.min(1, score));
}

function buildCertificate({
  input,
  startedAt,
  oldProgram,
  baseline,
  bugTests,
  passingTests,
  domain,
  candidates,
  selected,
  limits
}) {
  const residualRisk = [];
  if (bugTests.length === 0) {
    residualRisk.push("No failing test was observed before repair, so PatchProof refused certification.");
  }
  if (domain.length < 100) residualRisk.push("Finite behavioral envelope is small; add tests to broaden generated inputs.");
  if (!String(input.postconditionText || "").trim()) {
    residualRisk.push("No postcondition was provided, so bug-fix proof is limited to explicit tests.");
  }
  if (selected?.boundedProof?.status !== "no-counterexample-in-finite-envelope") {
    residualRisk.push("Selected patch has at least one bounded counterexample.");
  }
  if (selected?.mutation?.survivors?.length) {
    residualRisk.push(`${selected.mutation.survivors.length} simple patch mutants survived validation.`);
  }

  return {
    schema: CERTIFICATE_SCHEMA,
    verifierVersion: PATCHPROOF_VERSION,
    runId: simpleHash(
      JSON.stringify({
        source: input.source,
        tests: input.testsText,
        bugReport: input.bugReport,
        precondition: input.preconditionText,
        mayChange: input.mayChangeText,
        postcondition: input.postconditionText,
        limits: input.limits
      })
    ),
    status: selected?.accepted ? "certified" : "rejected",
    generatedAt: startedAt,
    target: {
      language: "javascript",
      function: oldProgram.name,
      execution: input.executionMode
    },
    bugEvidence: {
      report: input.bugReport,
      failingBefore: bugTests.map((test) => test.name),
      passingBefore: passingTests.map((test) => test.name)
    },
    selectedPatch: selected
      ? {
          id: selected.id,
          template: selected.templateId,
          accepted: selected.accepted,
          evidenceScore: Number(selected.evidenceScore.toFixed(3)),
          fixedBug: selected.fixedBug,
          riskTags: selected.risk,
          source: selected.source,
          diff: selected.diff,
          rejectionReasons: selected.rejectionReasons
        }
      : null,
    validation: selected
      ? {
          explicitTests: {
            passed: selected.explicitTests.passCount,
            failed: selected.explicitTests.failCount,
            total: selected.explicitTests.tests.length,
            fixedFailingTests: selected.fixedFailingTests
          },
          behavioralPreservation: {
            checkedCases: selected.preservation.checked,
            mayChangeCases: selected.preservation.skippedMayChange,
            counterexamples: selected.preservation.counterexamples
          },
          postcondition: {
            checkedCases: selected.postcondition.checked,
            counterexamples: selected.postcondition.counterexamples
          },
          boundedProof: selected.boundedProof,
          mutation: selected.mutation
        }
      : null,
    candidateSummary: candidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      accepted: candidate.accepted,
      evidenceScore: Number(candidate.evidenceScore.toFixed(3)),
      compileError: candidate.compileError,
      rejectionReasons: candidate.rejectionReasons,
      failedTests: candidate.explicitTests
        ? candidate.explicitTests.tests.filter((test) => !test.pass).map((test) => test.name)
        : []
    })),
    behavioralEnvelope: {
      precondition: input.preconditionText || "",
      mayChangePredicate: input.mayChangeText || "",
      postcondition: input.postconditionText || "",
      finiteDomainSize: domain.length,
      correctnessClaim:
        "The selected patch fixes the explicit tests and preserves old observations for generated inputs outside the may-change predicate. The postcondition is checked across the generated finite domain."
    },
    limits,
    residualRisk,
    replay: {
      command: "patchproof verify certificate.json",
      deterministic: true,
      input: {
        source: input.source,
        testsText: input.testsText,
        bugReport: input.bugReport,
        preconditionText: input.preconditionText,
        mayChangeText: input.mayChangeText,
        postconditionText: input.postconditionText,
        executionMode: input.executionMode,
        limits: input.limits
      }
    }
  };
}

function simpleHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `run_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function buildLogs(baseline, candidates, selected, domain) {
  const rows = [];
  rows.push(`Baseline: ${baseline.passCount}/${baseline.tests.length} tests passed before repair.`);
  rows.push(`Generated finite behavioral envelope with ${domain.length} input combinations.`);
  for (const candidate of candidates) {
    const status = candidate.accepted ? "accepted" : "rejected";
    const tests = candidate.explicitTests
      ? `${candidate.explicitTests.passCount}/${candidate.explicitTests.tests.length}`
      : "compile error";
    rows.push(
      `${candidate.id}: ${status}; tests=${tests}; preserve_cex=${candidate.preservation?.counterexamples.length ?? "-"}; post_cex=${candidate.postcondition?.counterexamples.length ?? "-"}; mutation=${candidate.mutation ? candidate.mutation.score.toFixed(2) : "-"}; score=${candidate.evidenceScore.toFixed(2)}`
    );
  }
  if (selected) rows.push(`Selected ${selected.id} with evidence score ${selected.evidenceScore.toFixed(2)}.`);
  return rows;
}

function unifiedDiff(oldSource, newSource) {
  const oldLines = oldSource.split("\n");
  const newLines = newSource.split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  const rows = ["--- old", "+++ new"];
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
