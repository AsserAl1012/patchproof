import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createInputFromExample as createJavaScriptInputFromExample,
  examples as javaScriptExamples,
  runPatchProof as runJavaScriptPatchProof,
  verifyCertificate as verifyJavaScriptCertificate
} from "./engine.js";
import { pythonExamples } from "./python-examples.js";

const here = dirname(fileURLToPath(import.meta.url));
const pythonRunner = resolve(here, "sandbox", "python-runner.py");

export const examples = [...javaScriptExamples, ...pythonExamples];
export { pythonExamples };

export function createInputFromExample(example) {
  return {
    ...createJavaScriptInputFromExample(example),
    language: example.language || "javascript"
  };
}

export function runPatchProof(input) {
  return languageOf(input) === "python"
    ? runPythonOperation("run", input)
    : runJavaScriptPatchProof(input);
}

export function verifyCertificate(certificate) {
  return certificate?.target?.language === "python" || certificate?.replay?.input?.language === "python"
    ? runPythonOperation("verify", certificate)
    : verifyJavaScriptCertificate(certificate);
}

export function languageOf(input) {
  const language = String(input?.language || input?.target?.language || "javascript").toLowerCase();
  if (language === "js") return "javascript";
  if (language === "py") return "python";
  if (!["javascript", "python"].includes(language)) {
    throw new Error(`Unsupported language '${language}'. PatchProof supports javascript and python.`);
  }
  return language;
}

function runPythonOperation(operation, value) {
  const executable = process.env.PATCHPROOF_PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
  const child = spawnSync(executable, ["-I", "-S", pythonRunner], {
    cwd: here,
    input: JSON.stringify({ operation, value }),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
    timeout: Number(value?.limits?.timeoutMs || 15000)
  });
  if (child.error) {
    if (child.error.code === "ENOENT") {
      throw new Error(`Python runtime '${executable}' was not found. Install Python 3.11+ or set PATCHPROOF_PYTHON_BIN.`);
    }
    throw new Error(`Python verifier failed to start: ${child.error.message}`);
  }
  if (child.status !== 0 && !child.stdout) {
    throw new Error(`Python verifier exited with code ${child.status}: ${String(child.stderr || "").trim()}`);
  }
  let payload;
  try {
    payload = JSON.parse(child.stdout || "{}");
  } catch {
    throw new Error(`Python verifier returned invalid JSON: ${String(child.stderr || child.stdout || "").trim()}`);
  }
  if (!payload.ok) throw new Error(payload.error?.message || "Python verifier failed.");
  return payload.result;
}
