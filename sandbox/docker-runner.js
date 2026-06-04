import { spawn } from "node:child_process";
import { runPatchProofIsolated } from "./hosted-runner.js";

export async function runPatchProofInRunner(input, policy = {}, options = {}) {
  const isolation = options.isolation || process.env.PATCHPROOF_RUNNER_ISOLATION || "process";
  if (isolation === "docker") {
    return runPatchProofInDocker(input, policy, options);
  }
  return runPatchProofIsolated(input, {
    limits: {
      timeoutMs: Number(policy.timeoutSeconds || 600) * 1000,
      maxInputBytes: options.maxInputBytes
    }
  });
}

export function dockerArgsForPolicy(policy = {}) {
  const image = policy.image || process.env.PATCHPROOF_RUNNER_IMAGE || "patchproof:0.4.0";
  return [
    "run",
    "--rm",
    "-i",
    "--network",
    policy.network === "allow-install" ? "bridge" : "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=128m",
    "--user",
    "10001:10001",
    "--memory",
    `${Number(policy.memoryMb || 2048)}m`,
    "--cpus",
    String(Number(policy.cpus || 2)),
    "--pids-limit",
    String(Number(policy.pidsLimit || 256)),
    "--workdir",
    "/app",
    image,
    "node",
    "--permission",
    "--allow-fs-read=/app",
    "--max-old-space-size=128",
    "sandbox/runner-child.js"
  ];
}

function runPatchProofInDocker(input, policy = {}, options = {}) {
  const args = dockerArgsForPolicy(policy);
  const timeoutMs = Number(policy.timeoutSeconds || 600) * 1000;
  const serialized = JSON.stringify(input || {});
  const maxOutputBytes = Number(options.maxOutputBytes || 1024 * 1024);

  return new Promise((resolveResult) => {
    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const startedAt = Date.now();

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolveResult({
        ok: false,
        statusCode: 408,
        error: { message: "Docker runner timed out." },
        resourceUsage: { durationMs: Date.now() - startedAt }
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolveResult({
          ok: false,
          statusCode: 502,
          error: { message: "Docker runner produced too much output." },
          resourceUsage: { durationMs: Date.now() - startedAt }
        });
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        ok: false,
        statusCode: 500,
        error: { message: error.message },
        resourceUsage: { durationMs: Date.now() - startedAt }
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolveResult({
          ok: false,
          statusCode: 500,
          error: { message: `Docker runner exited with code ${code}.`, stderr: stderr.trim() },
          resourceUsage: { durationMs: Date.now() - startedAt }
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "{}");
        parsed.resourceUsage = { ...(parsed.resourceUsage || {}), durationMs: Date.now() - startedAt };
        resolveResult(parsed);
      } catch {
        resolveResult({
          ok: false,
          statusCode: 502,
          error: { message: "Docker runner returned invalid JSON.", stderr: stderr.trim() },
          resourceUsage: { durationMs: Date.now() - startedAt }
        });
      }
    });
    child.stdin.end(serialized);
  });
}
