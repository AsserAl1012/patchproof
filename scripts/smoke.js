import { examples, runPatchProof } from "../engine.js";
import { createPatchProofServer } from "../server.js";

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

for (const example of examples) {
  const result = runExample(example);
  if (!result.selected.accepted) {
    throw new Error(`${example.id} was not certified: ${result.selected.rejectionReasons.join("; ")}`);
  }
  console.log(
    `${example.id}: certified ${result.selected.id}, score=${result.selected.evidenceScore.toFixed(3)}, domain=${result.certificate.behavioralEnvelope.finiteDomainSize}`
  );
}

const server = createPatchProofServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;
try {
  const app = await fetch(`${baseUrl}/`);
  const health = await fetch(`${baseUrl}/healthz`);
  if (app.status !== 200 || health.status !== 200) {
    throw new Error(`HTTP smoke failed: app=${app.status}, health=${health.status}`);
  }
  console.log(`http: ok ${baseUrl}`);
} finally {
  server.close();
}
