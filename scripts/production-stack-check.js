import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await text("package.json"));
const version = packageJson.version;
const checks = [];

await check("compose file is valid", async () => {
  if (process.env.PATCHPROOF_SKIP_DOCKER_CLI_CHECK === "true") {
    return "skipped by PATCHPROOF_SKIP_DOCKER_CLI_CHECK";
  }
  const result = spawnSync("docker", ["compose", "-f", "compose.yml", "config"], {
    cwd: new URL(".", root),
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      PATCHPROOF_SECRET_KEY: process.env.PATCHPROOF_SECRET_KEY || "production-check-secret-with-32-characters"
    }
  });
  assert(!result.error, result.error?.message || "docker compose did not start");
  if (result.status === 0) return "";
  const output = (result.stderr || result.stdout || "docker compose config failed").trim();
  if (/unknown command|unknown shorthand flag|not a docker command/i.test(output)) {
    const compose = await text("compose.yml");
    for (const service of ["patchproof", "patchproof-runner", "postgres", "redis", "minio", "minio-init"]) {
      serviceBlock(compose, service);
    }
    return "docker compose plugin unavailable; validated required service structure statically";
  }
  assert(false, output);
});

await check("compose uses current immutable PatchProof tag", async () => {
  const compose = await text("compose.yml");
  assert(new RegExp(`image:\\s*patchproof:${escapeRegex(version)}`).test(compose), `compose.yml must use patchproof:${version}`);
  assert(new RegExp(`PATCHPROOF_RUNNER_IMAGE:\\s*patchproof:${escapeRegex(version)}`).test(compose), "runner image env must use the package version");
});

await check("API and runner containers are hardened", async () => {
  const compose = await text("compose.yml");
  for (const service of ["patchproof", "patchproof-runner"]) {
    const block = serviceBlock(compose, service);
    assert(/read_only:\s*true/.test(block), `${service} must use read_only`);
    assert(/no-new-privileges:true/.test(block), `${service} must set no-new-privileges`);
    assert(/cap_drop:\s*\n\s*-\s*ALL/.test(block), `${service} must drop all Linux capabilities`);
    assert(/pids_limit:\s*\d+/.test(block), `${service} must set pids_limit`);
    assert(/mem_limit:\s*\S+/.test(block), `${service} must set mem_limit`);
    assert(/cpus:\s*\S+/.test(block), `${service} must set cpus`);
  }
});

await check("runner is configured for Docker isolation", async () => {
  const compose = await text("compose.yml");
  const runner = serviceBlock(compose, "patchproof-runner");
  assert(/runner",\s*"--isolation",\s*"docker"/.test(runner), "runner command must request docker isolation");
  assert(/PATCHPROOF_RUNNER_ISOLATION:\s*docker/.test(runner), "runner env must default to docker isolation");
  assert(/\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/.test(runner), "runner must mount the Docker socket for container-per-job execution");
  assert(/PATCHPROOF_DOCKER_RUNTIME/.test(runner), "runner should expose PATCHPROOF_DOCKER_RUNTIME for gVisor/Kata hosts");
});

await check("CI runs service-backed Docker runner integration", async () => {
  const ci = await text(".github/workflows/ci.yml");
  assert(/integration-services:/.test(ci), "CI must include the integration-services job");
  assert(/postgres:16/.test(ci), "CI must start Postgres");
  assert(/redis:7/.test(ci), "CI must start Redis");
  assert(/minio\/minio/.test(ci), "CI must start MinIO");
  assert(/npm run integration:services/.test(ci), "CI must run the service-backed Docker runner integration");
});

await check("release workflow publishes signed OCI and npm provenance", async () => {
  const release = await text(".github/workflows/release.yml");
  assert(/docker push/.test(release), "release workflow must push an OCI image");
  assert(/cosign sign/.test(release), "release workflow must sign the OCI image");
  assert(/npm publish --access public --provenance/.test(release), "release workflow must publish npm provenance");
  assert(/softprops\/action-gh-release/.test(release), "release workflow must attach GitHub release artifacts");
});

const failed = checks.filter((item) => item.status === "fail");
for (const item of checks) {
  console.log(`${item.status.toUpperCase()}\t${item.name}${item.message ? `\t${item.message}` : ""}`);
}
if (failed.length) process.exitCode = 1;

async function check(name, run) {
  try {
    const message = await run();
    checks.push({ name, status: "ok", message });
  } catch (error) {
    checks.push({ name, status: "fail", message: error.message });
  }
}

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

function serviceBlock(compose, service) {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${service}:`);
  assert(start !== -1, `compose service ${service} was not found`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index]) || /^volumes:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
