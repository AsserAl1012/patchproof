import test from "node:test";
import assert from "node:assert/strict";
import { examples, runPatchProof, verifyCertificate } from "../engine.js";

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
