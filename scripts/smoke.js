import { examples, runPatchProof } from "../runtime.js";
import { createPatchProofServer } from "../server.js";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

function runExample(example) {
  return runPatchProof({
    source: example.source,
    language: example.language || "javascript",
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

const browserGraph = await collectBrowserImports("app.js");
if (browserGraph.has("engine.js") || browserGraph.has("runtime.js") || browserGraph.has("server.js")) {
  throw new Error(`Browser graph imports Node-only module(s): ${[...browserGraph].join(", ")}`);
}
console.log(`browser: ok ${[...browserGraph].join(", ")}`);

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

async function collectBrowserImports(entry, graph = new Set()) {
  const file = normalize(entry).split("\\").join("/");
  if (graph.has(file)) return graph;
  graph.add(file);
  const source = await readFile(file, "utf8");
  if (/\bfrom\s+["']node:|\bimport\s+["']node:/.test(source)) {
    throw new Error(`${file} imports a Node built-in from the browser module graph.`);
  }
  const imports = [...source.matchAll(/import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith("."));
  for (const specifier of imports) {
    await collectBrowserImports(normalize(join(dirname(file), specifier)).split("\\").join("/"), graph);
  }
  return graph;
}
