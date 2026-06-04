import { runPatchProof } from "./engine.js";

self.onmessage = (event) => {
  try {
    const result = runPatchProof({
      ...event.data,
      executionMode: "browser-worker"
    });
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: {
        message: error.message || "Unknown PatchProof error",
        stack: error.stack || ""
      }
    });
  }
};
