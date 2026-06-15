import test from "node:test";
import assert from "node:assert/strict";
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
});

test("verifies replayable certificate", () => {
  const result = runExample(examples[1]);
  const report = verifyCertificate(result.certificate);
  assert.equal(report.valid, true);
  assert.deepEqual(report.mismatches, []);
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
