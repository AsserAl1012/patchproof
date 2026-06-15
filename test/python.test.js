import test from "node:test";
import assert from "node:assert/strict";
import { createInputFromExample, pythonExamples, runPatchProof, verifyCertificate } from "../runtime.js";
import { createPatchProofServer } from "../server.js";

test("Python example produces and replays a certified patch", () => {
  const result = runPatchProof(createInputFromExample(pythonExamples[0]));
  assert.equal(result.certificate.status, "certified");
  assert.equal(result.certificate.target.language, "python");
  assert.equal(result.certificate.selectedPatch.source.includes("value > max"), true);
  assert.equal(verifyCertificate(result.certificate).valid, true);
});

test("Python validates supplied model candidates for user functions", () => {
  const result = runPatchProof({
    language: "python",
    source: "def increment(value):\n    return value",
    tests: [
      { name: "zero", args: [0], expect: 1 },
      { name: "four", args: [4], expect: 5 }
    ],
    bugReport: "increment should add one",
    precondition: "isinstance(args[0], int)",
    mayChange: "True",
    postcondition: "result == args[0] + 1",
    candidatePatches: [
      {
        source: "def increment(value):\n    return value + 1",
        generator: "local",
        title: "Add one"
      }
    ]
  });
  assert.equal(result.certificate.status, "certified");
  assert.equal(result.certificate.selectedPatch.generator, "local");
});

test("Python rejects imports and unsafe builtins", () => {
  assert.throws(
    () =>
      runPatchProof({
        language: "python",
        source: "import os\ndef unsafe(value):\n    return os.listdir('.')",
        tests: [{ args: [1], expect: [] }]
      }),
    /exactly one named function|Import is not allowed/
  );
});

test("hosted API runs Python in the isolated Python process", async () => {
  const server = createPatchProofServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createInputFromExample(pythonExamples[0]))
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.result.certificate.status, "certified");
    assert.equal(body.result.certificate.target.execution, "isolated-python-process-runner");
  } finally {
    server.close();
  }
});
