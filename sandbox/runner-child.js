import { stdin, stdout } from "node:process";
import { runPatchProof, verifyCertificate } from "../runtime.js";

let input = "";

stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  input += chunk;
});

stdin.on("end", () => {
  try {
    const request = JSON.parse(input || "{}");
    const result = request?.operation === "verify"
      ? verifyCertificate(request.value)
      : runPatchProof({
          ...(request?.operation === "run" ? request.value : request),
          executionMode: "isolated-node-permission-runner"
        });
    stdout.write(
      JSON.stringify({
        ok: true,
        result
      })
    );
  } catch (error) {
    stdout.write(
      JSON.stringify({
        ok: false,
        error: {
          message: error.message || "Unknown sandbox error",
          stack: error.stack || ""
        }
      })
    );
  }
});
