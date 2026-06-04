import { stdin, stdout } from "node:process";
import { runPatchProof } from "../engine.js";

let input = "";

stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  input += chunk;
});

stdin.on("end", () => {
  try {
    const payload = {
      ...JSON.parse(input || "{}"),
      executionMode: "isolated-node-permission-runner"
    };
    const result = runPatchProof(payload);
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
