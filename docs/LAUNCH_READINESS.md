# Launch Readiness

Status reviewed against source and configuration on 2026-06-24.

## Implemented In This Pass

- OpenAI-compatible, Azure OpenAI, and local chat-completions candidate generation for queued runs.
- Local CLI model candidate generation behind explicit `--model` or repository config.
- Repository `init`, `doctor`, checkout inspection, AST-backed JavaScript/TypeScript source extraction, AST-backed simple Jest/Vitest/node:test/pytest assertion extraction, and certified function patch application.
- Provider credentials remain outside the isolated verifier; certificates store hashed provenance.
- Model generation reports prompt/response size metadata and enforces `maxPromptChars`.
- Expanded Python local repair operators for common string, collection, range, and exception-oriented function bugs.
- Model candidates are included in deterministic replay input and validated like local-template candidates.
- Certificate verification compares the complete deterministic certificate, excluding only generation time.
- Candidate, test, finite-domain, generated property-case, counterexample, token-aware mutation, and evidence thresholds are enforced.
- GitHub Action verification no longer requires installing SaaS dependencies and avoids direct input interpolation.
- Production encryption keys reject missing, short, and placeholder values.
- GitHub webhooks fail closed when no signing secret is configured.
- Non-root Docker runners can be given the mounted socket's supplemental group ID.
- Queued runner failure handling preserves the original error and marks the payload run failed even when run-detail lookup fails.
- Queued runners default to Docker isolation; the local inline demo path explicitly opts into process isolation.
- The default Docker runner image tag, package version, and health endpoint version are aligned at `0.4.1`.
- Session bearer tokens are stored as server-side hashes in JSON and Postgres stores.
- Browser SaaS sessions use same-origin `HttpOnly` `SameSite=Strict` cookies while API keys still support bearer-token automation.
- Browser-worker verification has been removed; UI runs go through the server/CLI isolated runners.
- The server CSP removes `unsafe-eval` and sets `worker-src 'none'`.
- Redis and memory queues use leased jobs, acknowledgements, expired-lease recovery, retry limits, and dead-letter tracking.
- Optional Ed25519 certificate issuer signatures are supported for JavaScript and Python certificates.
- GitHub webhook delivery IDs are persisted and deduplicated before run creation.
- Runner loops handle graceful `SIGINT`/`SIGTERM` shutdown between jobs.
- Retention cleanup removes expired sessions, artifacts, audit events, and old webhook delivery records.
- HTTP responses include request IDs and optional JSON access logs can be enabled with `PATCHPROOF_ACCESS_LOGS=json`.
- CI now includes a service-backed integration job for Postgres migrations, Redis queue lease/ack behavior, and Docker image build validation.
- CI now runs one queued job end-to-end through Postgres, Redis, MinIO/S3 artifacts, and Docker runner execution.
- Docker runner supports hardened runtime selection through `PATCHPROOF_DOCKER_RUNTIME=runsc` or `kata` on hosts that provide those runtimes.
- Release workflow now builds the Docker image, creates npm package artifacts, generates SBOM/checksums, uploads release artifacts, publishes/signs a GHCR OCI image on tag releases, and publishes npm with provenance when configured.
- A security review handoff package is available in `docs/SECURITY_REVIEW_PACKAGE.md`.

## P0 Before Public Production

- Do not expose anonymous `POST /api/run` as a hostile multi-tenant service. Complete an independent sandbox review and move public execution to gVisor, Kata, or microVM isolation.
- Run the service-backed integration job on every protected branch and release tag; monitor flakes before public launch.
- Treat Docker socket access as root-equivalent. Use dedicated runner hosts and never co-locate untrusted workloads or control-plane secrets.
- Move Kubernetes secrets out of Helm values into Kubernetes Secrets or an external secret manager.
- Configure and rotate Ed25519 certificate signing keys if certificates must prove issuer authenticity outside the originating PatchProof deployment.
- Complete an external security review covering dynamic JavaScript execution, authentication, webhook handling, GitHub App permissions, artifact access, and tenant isolation.

## P1 Product Reliability

- Add job cancellation, retry visibility, and stale-run reconciliation.
- Add user invitations, password reset, session revocation, and optional OIDC/SAML/MFA.
- Schedule retention workers in deployment environments and test deletion against production object storage.
- Test backup and restore procedures with real Postgres and object storage data.
- Add traces, model latency/error metrics, and alerting rules.
- Validate provider-specific token fields and support the OpenAI Responses API where required.
- Expand repository adapters from simple literal assertion extraction into full framework execution/coverage adapters before claiming whole-repository repair.
- Change GitHub patch application from committing a `.patch` artifact to applying reviewed file changes once the repository repair workflow is wired into GitHub App runs.

## P1 Release Engineering

- Align git tags/release notes with the `0.4.1` package, Docker/Helm image tags, and certificate verifier version.
- Add multi-architecture OCI images if needed for ARM runner hosts.
- Add dependency update automation, secret scanning, CodeQL/SAST, container scanning, and license checks.
- Publish immutable container tags and digests; do not deploy mutable local build tags in production.
- Verify npm ownership and enable npm trusted publishing with GitHub OIDC. The `patchproof` package name was unclaimed when checked on 2026-06-15.

## P2 Product Completeness

- Replace the simple source-token denylist with a stronger parser-based policy and hardened execution boundary.
- Broaden Python beyond standalone restricted functions only after dependency isolation and full pytest execution adapters exist. TypeScript repository targets are normalized into JavaScript verifier input for function-level targets; a native TypeScript verifier remains future work.
- Add coverage feedback and pluggable mutation engines for broader assurance beyond the current deterministic property cases and token-aware mutation.
- Version the HTTP API and publish an OpenAPI specification.
- Add billing/quotas only after job accounting and abuse controls are reliable.

## Current Publish Position

The npm CLI and private self-hosted beta are publishable with explicit bounded-evidence and function-level JavaScript/Python limitations. A public multi-tenant SaaS should not launch until the P0 isolation review, secret management, certificate-key operations, and external security-review items are complete.
