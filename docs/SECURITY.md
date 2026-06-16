# Security Model

PatchProof is publishable as a self-hosted/private SaaS product for teams running it inside their own infrastructure. It is not positioned as an open hosted arbitrary-code execution service for anonymous internet users.

## Current Protections

- Browser-only candidate validation is available only for local/demo fallback mode and requires `PATCHPROOF_ALLOW_BROWSER_EVAL=true`.
- Worker execution has an eight-second UI timeout.
- Local/demo API validation runs in a separate Node process.
- The local/demo runner uses Node permissions with no filesystem write permission and no child-process or worker permission.
- Python runs use a separate isolated process, Python isolated mode, an AST policy, restricted builtins, no imports, and the same request/output/time limits. Docker isolation remains the production boundary because Python does not provide Node-style permission flags.
- Production project runs are queued and handled by a runner service.
- Docker runner mode uses one container per job, no network by default, read-only root filesystem, non-root user, tmpfs workspace, CPU/memory/PID/time limits, and cleanup after completion.
- Certificates, logs, diffs, and runner metadata are stored as hash-checked artifacts.
- `/api/run` enforces JSON-only requests, body-size limits, and per-address token-bucket rate limits.
- Source and envelope expressions reject obvious dangerous tokens such as `fetch`, `eval`, `Function`, `Worker`, `localStorage`, `globalThis`, `process`, and dynamic imports.
- The static server binds to `127.0.0.1` by default.
- The static server sets security headers including CSP without `unsafe-eval` by default, `nosniff`, no-referrer, and frame denial.
- Static file serving blocks path traversal and hidden dot-path access.
- Certificates are replayable through the CLI.
- Private SaaS APIs require bearer-token authentication. Session bearer tokens and API keys are stored server-side as SHA-256 hashes.
- Organization-scoped access is enforced for projects, runs, certificates, settings, and audit logs.
- RBAC roles are enforced for admin/settings/audit/run actions.

## Trust Boundary

PatchProof should be used inside a customer's private infrastructure. Docker isolation is the v1 production boundary. For hostile multi-tenant cloud use, add stronger sandboxing such as gVisor or Firecracker and complete an external security review.

JavaScript source and predicate token filtering is a preflight policy, not a sandbox. It rejects obvious dangerous constructs, but the security boundary must be process/container isolation. Do not rely on denylist filtering alone for untrusted code.

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
