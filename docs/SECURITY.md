# Security Model

PatchProof is publishable as a self-hosted/private SaaS product for teams running it inside their own infrastructure. It is not positioned as an open hosted arbitrary-code execution service for anonymous internet users.

## Current Protections

- Browser-side candidate validation is disabled. The UI must call the server or use the CLI.
- CLI and local/demo API validation run in a separate Node process.
- The local/demo runner uses Node permissions with no filesystem write permission and no child-process or worker permission.
- Python runs use a separate isolated process, Python isolated mode, an AST policy, restricted builtins, no imports, and the same request/output/time limits. Docker isolation remains the production boundary because Python does not provide Node-style permission flags.
- Production project runs are queued with leases, acknowledgements, retry limits, expired-lease recovery, and dead-letter tracking.
- Docker runner mode uses one container per job, no network by default, read-only root filesystem, non-root user, tmpfs workspace, CPU/memory/PID/time limits, and cleanup after completion.
- Docker runner jobs add `no-new-privileges`, drop Linux capabilities, disable IPC sharing, and can select a host-provided hardened runtime such as gVisor `runsc` or Kata with `PATCHPROOF_DOCKER_RUNTIME`.
- `patchproof doctor --production` can enforce dedicated runner-host declarations with `PATCHPROOF_REQUIRE_DEDICATED_RUNNER_HOST=true`; this fails production checks unless `PATCHPROOF_RUNNER_HOST_ISOLATION=dedicated` is set.
- Certificates, logs, diffs, and runner metadata are stored as hash-checked artifacts.
- Certificates are always replay-verifiable. Deployments can additionally sign certificates with Ed25519 issuer signatures; verification checks the signature when `PATCHPROOF_CERTIFICATE_PUBLIC_KEY_PEM` is configured.
- `/api/run` enforces JSON-only requests, body-size limits, and per-address token-bucket rate limits. It is disabled by default when `NODE_ENV=production` unless `PATCHPROOF_ENABLE_QUICK_RUN=true` is set explicitly.
- Source and envelope expressions reject obvious dangerous tokens such as `fetch`, `eval`, `Function`, `Worker`, `localStorage`, `globalThis`, `process`, and dynamic imports.
- Repository repair writes honor configured `allowedPaths` and `forbiddenPaths`, preserve line endings/BOMs, and expose selection filters so operators can scope repairs to reviewed findings.
- C/C++ static repairs intentionally skip pointer destinations and only rewrite supported string APIs when the destination is detected as a local fixed array.
- The static server binds to `127.0.0.1` by default.
- The static server sets security headers including CSP without `unsafe-eval`, `worker-src 'none'`, `nosniff`, no-referrer, and frame denial.
- Static file serving blocks path traversal and hidden dot-path access.
- Certificates are replayable through the CLI.
- Private SaaS APIs accept API bearer tokens. Browser sessions use same-origin `HttpOnly` `SameSite=Strict` cookies. Session bearer tokens, invitation tokens, password reset tokens, and API keys are stored server-side as SHA-256 hashes.
- Owners/admins can issue one-time invitations and password reset tokens and revoke organization browser sessions. Users can list and revoke their own browser sessions. Password reset completion invalidates existing sessions for that user.
- Organization-scoped access is enforced for projects, runs, certificates, settings, and audit logs.
- RBAC roles are enforced for admin/settings/audit/run actions.
- GitHub webhook signatures are verified and delivery IDs are deduplicated before creating runs.
- Responses include `X-Request-ID`; optional `PATCHPROOF_ACCESS_LOGS=json` emits structured access logs.
- `patchproof retention` removes expired sessions, artifact metadata/files, audit events, and old webhook delivery records according to configured retention windows.
- Queued/running project runs can be cancelled, and `patchproof reconcile` marks stale running jobs failed after runner crashes.
- `patchproof keygen` generates production encryption and certificate signing material; `patchproof doctor --production` validates required self-hosted controls before launch.
- `npm run security:check` verifies static security invariants such as disabled browser execution, no `unsafe-eval`, Docker default runner isolation, queue lease/ack/retry/dead-letter behavior, hashed sessions, and signed/provenance release workflow coverage.
- `npm run production:check` validates Docker Compose configuration, container hardening flags, CI service-backed runner coverage, and release publishing gates.

## Trust Boundary

PatchProof should be used inside a customer's private infrastructure. Docker isolation is the v1 production boundary. For hostile multi-tenant cloud use, add stronger sandboxing such as gVisor or Firecracker and complete an external security review.

JavaScript source and predicate token filtering is a preflight policy, not a sandbox. It rejects obvious dangerous constructs, but the security boundary is process/container isolation. Do not run untrusted JavaScript through `engine.js` directly in an application process.

## Not Yet Safe For Hosted Public Execution

Before broad hosted SaaS exposure, add or verify:

- microVM or hardened container isolation;
- network disabled by default;
- CPU, memory, process, and wall-clock limits;
- filesystem isolation;
- per-run audit logs;
- rate limits and abuse detection;
- dependency allowlists;
- secrets scanning;
- independent security review.

## Reporting Security Issues

For a public repository, add a private security contact in GitHub Security Advisories before launch.
