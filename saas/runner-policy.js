export function buildRunnerPolicy({ orgId, projectId, runId, settings = {}, config = {} }) {
  const runner = {
    ...(settings.runner || {}),
    ...(config.runner || {})
  };
  return {
    orgId,
    projectId,
    runId,
    image: process.env.PATCHPROOF_RUNNER_IMAGE || runner.image || "patchproof:1.0.0",
    runtime: process.env.PATCHPROOF_DOCKER_RUNTIME || runner.runtime || "",
    network: runner.network || "disabled",
    timeoutSeconds: Number(runner.timeoutSeconds || 600),
    memoryMb: Number(runner.memoryMb || 2048),
    cpus: Number(runner.cpus || 2),
    readOnlyRootFilesystem: true,
    nonRootUser: true,
    ephemeralWorkspace: true,
    pidsLimit: 256,
    artifactUpload: true
  };
}
