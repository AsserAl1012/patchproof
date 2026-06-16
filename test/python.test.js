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

test("Python local templates repair whitespace slug bugs", () => {
  const result = runPatchProof({
    language: "python",
    source: `def slugify(title):
    cleaned = title.strip().lower()
    return cleaned.replace(" ", "-")`,
    tests: [
      { name: "one space", args: ["Hello World"], expect: "hello-world" },
      { name: "many spaces", args: ["Hello   World"], expect: "hello-world" },
      { name: "trim", args: ["  API Client  "], expect: "api-client" }
    ],
    bugReport: "slugify should collapse every whitespace run into one dash",
    precondition: "isinstance(args[0], str)",
    mayChange: "' ' in args[0].strip()",
    postcondition: "result == '-'.join(args[0].strip().lower().split())"
  });
  assert.equal(result.certificate.status, "certified");
  assert.equal(result.certificate.selectedPatch.template, "collapse-whitespace-slug");
});

test("Python local templates repair append return bugs", () => {
  const result = runPatchProof({
    language: "python",
    source: `def add_item(items, value):
    return items.append(value)`,
    tests: [
      { name: "adds to empty", args: [[], 1], expect: [1] },
      { name: "adds to existing", args: [[1, 2], 3], expect: [1, 2, 3] }
    ],
    bugReport: "append mutates the list but returns None; return the updated list",
    precondition: "isinstance(args[0], list)",
    mayChange: "True",
    postcondition: "isinstance(result, list) and len(result) == len(args[0]) + 1"
  });
  assert.equal(result.certificate.status, "certified");
  assert.equal(result.certificate.selectedPatch.template, "append-return-list");
});

test("Python supplied candidates may raise safe built-in exceptions", () => {
  const result = runPatchProof({
    language: "python",
    source: `def require_positive(value):
    if value < 0:
        return None
    return value`,
    tests: [
      { name: "negative rejected", args: [-1], expectError: "ValueError" },
      { name: "positive preserved", args: [2], expect: 2 }
    ],
    bugReport: "negative values should raise ValueError",
    precondition: "isinstance(args[0], int)",
    mayChange: "args[0] < 0",
    postcondition: "observation['ok'] == (args[0] >= 0)",
    candidatePatches: [
      {
        source: `def require_positive(value):
    if value < 0:
        raise ValueError("negative")
    return value`,
        title: "Raise ValueError"
      }
    ]
  });
  assert.equal(result.certificate.status, "certified");
  assert.equal(result.certificate.selectedPatch.generator, "model");
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
