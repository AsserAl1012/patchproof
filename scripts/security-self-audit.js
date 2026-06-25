import { readFile } from "node:fs/promises";

const checks = [];

await check("browser worker is disabled", async () => {
  const worker = await text("worker.js");
  assert(!/runPatchProof/.test(worker), "worker.js must not import or run PatchProof directly");
  assert(/disabled/i.test(worker), "worker.js should clearly report disabled browser execution");
});

await check("CSP blocks eval and workers", async () => {
  const server = await text("server.js");
  assert(/worker-src 'none'/.test(server), "CSP must block workers");
  assert(!/unsafe-eval/.test(server), "CSP must not include unsafe-eval");
});

await check("production quick-run is opt-in only", async () => {
  const server = await text("server.js");
  assert(/PATCHPROOF_ENABLE_QUICK_RUN\s*===\s*"true"/.test(server), "quick-run must require explicit env opt-in");
  assert(/NODE_ENV\s*!==\s*"production"/.test(server), "quick-run must be disabled by default in production");
});

await check("runner isolation defaults to Docker", async () => {
  const dockerRunner = await text("sandbox/docker-runner.js");
  assert(/PATCHPROOF_RUNNER_ISOLATION/.test(dockerRunner), "runner isolation env override must exist");
  assert(/\|\|\s*"docker"/.test(dockerRunner), "runner isolation should default to docker");
});

await check("Docker runner keeps restrictive flags", async () => {
  const dockerRunner = await text("sandbox/docker-runner.js");
  for (const pattern of [
    /"--network"/,
    /"none"/,
    /"--read-only"/,
    /"no-new-privileges:true"/,
    /"--cap-drop"/,
    /"ALL"/,
    /"--pids-limit"/,
    /"--user"/
  ]) {
    assert(pattern.test(dockerRunner), `Docker runner is missing ${pattern}`);
  }
});

await check("queue has lease, ack, retry, and dead-letter semantics", async () => {
  const queue = await text("saas/queue.js");
  for (const pattern of [/leaseExpiresAt/, /async ack/, /deadLettered/, /maxAttempts/, /requeueExpired/]) {
    assert(pattern.test(queue), `queue.js is missing ${pattern}`);
  }
});

await check("sessions are hashed server-side", async () => {
  const store = await text("saas/store.js");
  const postgres = await text("saas/postgres-store.js");
  assert(/tokenHash:\s*sha256\(token\)/.test(store), "JSON store should hash session tokens");
  assert(/tokenHash:\s*sha256\(token\)/.test(postgres), "Postgres store should hash session tokens");
  assert(/const \{ token, \.\.\.rest \} = session/.test(store), "JSON store should migrate old raw session tokens out of persisted records");
});

await check("release flow signs OCI images and publishes provenance", async () => {
  const release = await text(".github/workflows/release.yml");
  assert(/cosign sign/.test(release), "release workflow must sign the OCI image");
  assert(/npm publish --access public --provenance/.test(release), "release workflow must publish npm with provenance");
  assert(/npm sbom/.test(release), "release workflow must generate an SBOM");
});

const failed = checks.filter((item) => item.status === "fail");
for (const item of checks) {
  console.log(`${item.status.toUpperCase()}\t${item.name}${item.message ? `\t${item.message}` : ""}`);
}
if (failed.length) process.exitCode = 1;

async function check(name, run) {
  try {
    await run();
    checks.push({ name, status: "ok" });
  } catch (error) {
    checks.push({ name, status: "fail", message: error.message });
  }
}

async function text(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
