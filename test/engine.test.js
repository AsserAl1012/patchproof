import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createInputFromExample, examples, runPatchProof, verifyCertificate } from "../engine.js";

function runExample(example) {
  return runPatchProof({
    source: example.source,
    testsText: JSON.stringify(example.tests),
    bugReport: example.bugReport,
    preconditionText: example.precondition,
    mayChangeText: example.mayChange,
    postconditionText: example.postcondition
  });
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("bundled examples produce certified patches", () => {
  for (const example of examples) {
    const result = runExample(example);
    assert.equal(result.certificate.schema, "patchproof.certificate.v2");
    assert.equal(result.certificate.status, "certified", example.id);
    assert.equal(result.selected.accepted, true, example.id);
    assert.equal(result.selected.fixedBug, true, example.id);
    assert.equal(result.certificate.validation.explicitTests.failed, 0, example.id);
    assert.equal(result.certificate.validation.behavioralPreservation.counterexamples.length, 0, example.id);
    assert.equal(result.certificate.validation.postcondition.counterexamples.length, 0, example.id);
  }
});

test("does not certify when no failing test was observed before repair", () => {
  const example = examples[0];
  const fixedSource = example.source.replace(/>\s*min\b/g, "> max");
  const result = runPatchProof({
    source: fixedSource,
    testsText: JSON.stringify(example.tests),
    bugReport: example.bugReport,
    preconditionText: example.precondition,
    mayChangeText: example.mayChange,
    postconditionText: example.postcondition
  });

  assert.equal(result.certificate.status, "rejected");
  assert.equal(result.selected.accepted, false);
  assert.match(result.selected.rejectionReasons.join(" "), /No failing test was observed/);
});

test("rejects dangerous source tokens", () => {
  const example = examples[0];
  assert.throws(
    () =>
      runPatchProof({
        source: `function clamp(value, min, max) { fetch("/x"); return value; }`,
        testsText: JSON.stringify(example.tests),
        bugReport: example.bugReport,
        preconditionText: example.precondition,
        mayChangeText: example.mayChange,
        postconditionText: example.postcondition
      }),
    /Unsafe source/
  );
  assert.throws(
    () =>
      runPatchProof({
        source: `function clamp(value, min, max) { return (() => {}).constructor("return value")(); }`,
        testsText: JSON.stringify(example.tests),
        bugReport: example.bugReport,
        preconditionText: example.precondition,
        mayChangeText: example.mayChange,
        postconditionText: example.postcondition
      }),
    /Unsafe source/
  );
});

test("verifies replayable certificate", () => {
  const result = runExample(examples[1]);
  const report = verifyCertificate(result.certificate);
  assert.equal(report.valid, true);
  assert.deepEqual(report.mismatches, []);
});

test("verifies signed certificates and detects signed payload tampering", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const oldPrivateKey = process.env.PATCHPROOF_CERTIFICATE_PRIVATE_KEY_PEM;
  const oldPublicKey = process.env.PATCHPROOF_CERTIFICATE_PUBLIC_KEY_PEM;
  const oldIssuer = process.env.PATCHPROOF_CERTIFICATE_ISSUER;
  try {
    process.env.PATCHPROOF_CERTIFICATE_PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" });
    process.env.PATCHPROOF_CERTIFICATE_PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" });
    process.env.PATCHPROOF_CERTIFICATE_ISSUER = "patchproof-test";
    const result = runExample(examples[1]);
    assert.equal(result.certificate.proof.algorithm, "Ed25519");
    assert.equal(result.certificate.proof.issuer, "patchproof-test");

    const report = verifyCertificate(result.certificate);
    assert.equal(report.valid, true);
    assert.equal(report.signature.present, true);
    assert.equal(report.signature.valid, true);

    const tampered = structuredClone(result.certificate);
    tampered.selectedPatch.source = tampered.selectedPatch.source.replace("replace", "replaceAll");
    const tamperedReport = verifyCertificate(tampered);
    assert.equal(tamperedReport.valid, false);
    assert.match(tamperedReport.mismatches.join(" "), /issuer signature|payload hash|selectedPatch\.source/);
  } finally {
    restoreEnv("PATCHPROOF_CERTIFICATE_PRIVATE_KEY_PEM", oldPrivateKey);
    restoreEnv("PATCHPROOF_CERTIFICATE_PUBLIC_KEY_PEM", oldPublicKey);
    restoreEnv("PATCHPROOF_CERTIFICATE_ISSUER", oldIssuer);
  }
});

test("detects tampered certificate replay claims", () => {
  const result = runExample(examples[1]);
  const tampered = structuredClone(result.certificate);
  tampered.selectedPatch.id = "p999";
  const report = verifyCertificate(tampered);
  assert.equal(report.valid, false);
  assert.match(report.mismatches.join(" "), /selectedPatch\.id/);
});

test("detects tampering anywhere in deterministic certificate evidence", () => {
  const result = runExample(examples[0]);
  const tampered = structuredClone(result.certificate);
  tampered.selectedPatch.source = tampered.selectedPatch.source.replace("return max", "return min");
  tampered.validation.mutation.score = 1;
  const report = verifyCertificate(tampered);
  assert.equal(report.valid, false);
  assert.match(report.mismatches.join(" "), /selectedPatch\.source/);
  assert.match(report.mismatches.join(" "), /validation\.mutation\.score/);
});

test("validates supplied model candidates and replays their provenance", () => {
  const result = runPatchProof({
    source: `function increment(value) {
  return value;
}`,
    tests: [
      { name: "increments zero", args: [0], expect: 1 },
      { name: "increments positive", args: [4], expect: 5 }
    ],
    bugReport: "increment should add one",
    precondition: "Number.isFinite(args[0])",
    mayChange: "true",
    postcondition: "result === args[0] + 1",
    candidatePatches: [
      {
        title: "Add the missing increment",
        source: `function increment(value) {
  return value + 1;
}`,
        generator: "openai-compatible",
        provenance: {
          provider: "openai-compatible",
          model: "repair-model",
          promptHash: "a".repeat(64),
          candidateHash: "b".repeat(64),
          promptStored: false
        }
      }
    ],
    modelProvenance: {
      provider: "openai-compatible",
      model: "repair-model",
      promptHash: "a".repeat(64),
      candidateHash: "b".repeat(64),
      promptStored: false
    }
  });

  assert.equal(result.certificate.status, "certified");
  assert.equal(result.certificate.selectedPatch.generator, "openai-compatible");
  assert.equal(result.certificate.repair.suppliedCandidates, 1);
  assert.equal(verifyCertificate(result.certificate).valid, true);
});

test("honors configured domain, candidate, and evidence limits", () => {
  const example = examples[0];
  const result = runPatchProof({
    ...createInputFromExample(example),
    limits: {
      maxDomainSize: 3,
      maxCandidates: 1,
      minEvidenceScore: 0.99
    }
  });
  assert.equal(result.certificate.behavioralEnvelope.finiteDomainSize, 3);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.certificate.status, "rejected");
  assert.match(result.selected.rejectionReasons.join(" "), /Evidence score was below 0\.99/);
});

test("generated property cases broaden the finite domain within caps", () => {
  const result = runPatchProof({
    source: `function clamp(value, min, max) {
  if (value < min) return min;
  if (value > min) return max;
  return value;
}`,
    tests: [
      { name: "above max", args: [12, 0, 10], expect: 10 },
      { name: "in range", args: [6, 0, 10], expect: 6 }
    ],
    bugReport: "upper guard compares value to min",
    precondition: "args[1] <= args[2]",
    mayChange: "args[0] > args[1] && args[0] < args[2]",
    postcondition: "result === Math.min(Math.max(args[0], args[1]), args[2])",
    limits: { maxDomainSize: 80, propertyRuns: 40 }
  });
  assert.equal(result.certificate.behavioralEnvelope.finiteDomainSize, 80);
});

test("token-aware mutation does not mutate operators inside strings", () => {
  const result = runPatchProof({
    source: `function message(value) {
  if (value > 0) return "value > zero";
  return "zero";
}`,
    tests: [
      { name: "positive", args: [1], expect: "ok" },
      { name: "zero", args: [0], expect: "zero" }
    ],
    bugReport: "positive values should return ok",
    mayChange: "args[0] > 0",
    postcondition: "args[0] > 0 ? result === 'ok' : result === 'zero'",
    candidatePatches: [`function message(value) {
  if (value > 0) return "ok";
  return "zero";
}`]
  });
  assert.equal(result.certificate.status, "certified");
  assert.ok(result.selected.mutation.survivors.every((label) => !label.includes("string")));
});

test("rejects invalid supplied candidates without failing certificate construction", () => {
  const input = {
    source: "function increment(value) { return value; }",
    tests: [{ name: "increments", args: [1], expect: 2 }],
    bugReport: "increment should add one",
    mayChange: "true",
    postcondition: "result === args[0] + 1",
    limits: { maxCandidates: 1 }
  };
  const invalid = runPatchProof({
    ...input,
    candidatePatches: ["function increment(value) { return value + ; }"]
  });
  assert.equal(invalid.certificate.status, "rejected");
  assert.match(invalid.certificate.validation.compileError, /Could not compile/);

  const renamed = runPatchProof({
    ...input,
    candidatePatches: ["function changed(value) { return value + 1; }"]
  });
  assert.equal(renamed.certificate.status, "rejected");
  assert.match(renamed.selected.rejectionReasons.join(" "), /target function name/);
});

test("does not allow request limits to raise verifier resource caps", () => {
  const example = examples[0];
  assert.throws(
    () =>
      runPatchProof({
        ...createInputFromExample(example),
        limits: { maxDomainSize: 2401 }
      }),
    /cannot exceed the verifier cap/
  );
});

test("fails clearly when precondition excludes every generated input", () => {
  const example = examples[0];
  assert.throws(
    () =>
      runPatchProof({
        source: example.source,
        testsText: JSON.stringify(example.tests),
        bugReport: example.bugReport,
        preconditionText: "false",
        mayChangeText: example.mayChange,
        postconditionText: example.postcondition
      }),
    /precondition excluded every generated input/
  );
});
