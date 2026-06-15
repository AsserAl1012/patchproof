import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const childPath = resolve(here, "runner-child.js");
const pythonChildPath = resolve(here, "python-runner.py");

export const HOSTED_LIMITS = Object.freeze({
  timeoutMs: 8000,
  maxOutputBytes: 1024 * 1024,
  maxInputBytes: 64 * 1024
});

export function runPatchProofIsolated(input, options = {}) {
  const limits = {
    ...HOSTED_LIMITS,
    ...(options.limits || {})
  };
  const serialized = JSON.stringify(input || {});
  if (Buffer.byteLength(serialized) > limits.maxInputBytes) {
    return Promise.resolve({
      ok: false,
      statusCode: 413,
      error: {
        message: `Request exceeds ${limits.maxInputBytes} bytes.`
      }
    });
  }

  return new Promise((resolveResult) => {
    const language = String(input?.language || "javascript").toLowerCase();
    const python = language === "python";
    const executable = python
      ? process.env.PATCHPROOF_PYTHON_BIN || (process.platform === "win32" ? "python" : "python3")
      : process.execPath;
    const args = python
      ? ["-I", "-S", pythonChildPath]
      : [
          "--permission",
          `--allow-fs-read=${projectRoot}`,
          "--max-old-space-size=128",
          childPath
        ];
    const child = spawn(
      executable,
      args,
      {
        cwd: projectRoot,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolveResult({
        ok: false,
        statusCode: 408,
        error: {
          message: "Validation timed out in isolated runner."
        }
      });
    }, limits.timeoutMs);

    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > limits.maxOutputBytes && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolveResult({
          ok: false,
          statusCode: 502,
          error: {
            message: "Isolated runner produced too much output."
          }
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
        error: {
          message: error.message
        }
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
          error: {
            message: `Isolated runner exited with code ${code}.`,
            stderr: stderr.trim()
          }
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "{}");
        if (parsed && parsed.ok === false && parsed.error) {
          delete parsed.error.stack;
        }
        resolveResult(parsed);
      } catch {
        resolveResult({
          ok: false,
          statusCode: 502,
          error: {
            message: "Isolated runner returned invalid JSON.",
            stderr: stderr.trim()
          }
        });
      }
    });

    child.stdin.end(
      python
        ? JSON.stringify({
            operation: "run",
            value: { ...input, executionMode: "isolated-python-process-runner" }
          })
        : serialized
    );
  });
}
