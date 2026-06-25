# Launch Readiness

Status reviewed against source and configuration on 2026-06-24.

## Implemented In This Pass

- OpenAI-compatible, Azure OpenAI, and local chat-completions candidate generation for queued runs.
- Local CLI model candidate generation behind explicit `--model` or repository config.
- Repository `init`, `doctor`, checkout inspection, bug-signal detection, generated-file noise reduction, project-test failure mapping, JSON/SARIF export, suppression rules, AST-backed JavaScript/TypeScript source extraction, AST-backed simple Jest/Vitest/node:test/pytest assertion extraction, and certified function patch application.
- Provider credentials remain outside the isolated verifier; certificates store hashed provenance.
- Model generation reports prompt/response size metadata and enforces `maxPromptChars`.
- The browser Repair Lab can opt into server-side model candidate generation before bounded validation.
- Expanded Python local repair operators for common string, collection, range, exception-oriented, and mutable-default function bugs.
- Model candidates are included in deterministic replay input and validated like local-template candidates.
- Certificate verification compares the complete deterministic certificate, excluding only generation time.
- Candidate, test, finite-domain, generated property-case, counterexample, token-aware mutation, and evidence thresholds are enforced.
- GitHub Action verification no longer requires installing SaaS dependencies and avoids direct input interpolation.
- Production encryption keys reject missing, short, and placeholder values.
- GitHub webhooks fail closed when no signing secret is configured.
- Non-root Docker runners can be given the mounted socket's supplemental group ID.
- Queued runner failure handling preserves the original error and marks the payload run failed even when run-detail lookup fails.
- Queued runners default to Docker isolation; the local inline demo path explicitly opts into process isolation.
- The default Docker runner image tag, package version, and health endpoint version are aligned at `1.0.0`.
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
- `npm run security:check` and `npm run production:check` provide repeatable release gates for security invariants, Compose hardening, service-backed CI coverage, and publishing controls.
- A security review handoff package is available in `docs/SECURITY_REVIEW_PACKAGE.md`.
- `patchproof keygen` generates production encryption and Ed25519 certificate signing values.
- `patchproof doctor --production` validates release metadata, Docker, runner image, hardened runtime availability, production secrets, Postgres, Redis, S3/MinIO, and signing-key configuration.
- Queued/running runs can be cancelled through the dashboard and `POST /api/v1/runs/:id/cancel`.
- `patchproof reconcile` and `POST /api/v1/admin/reconcile` plan/apply stale-running-job cleanup after runner crashes.
- The HTTP API is versioned under `/api/v1` and publishes OpenAPI metadata at `/api/v1/openapi.json`.
- Anonymous `POST /api/run` is disabled by default when `NODE_ENV=production`; explicit opt-in requires `PATCHPROOF_ENABLE_QUICK_RUN=true`.
- Owner/admin APIs support user invitations, one-time password reset tokens, organization session listing, and session revocation. Users can list/revoke their own browser sessions.
- Prometheus metrics now include job status counts, average run/job duration, and model-call/error counters.
- Repository workflows can run configured install/build/test commands with `patchproof test --install --build` or after apply with `run --apply --verify-command`.
- C/C++ repositories can be inspected for CMake/Make/CTest/GTest/Catch2/doctest metadata and scanned for risky static bug patterns. `patchproof repair-repo` can preview/apply conservative one-line C/C++ safety rewrites for known local fixed-array destinations and mark the repository repair certified only when the configured project command passes. Pointer destinations are skipped. C/C++ semantic repair/certification remains future work.
- Repository repair reports now include static-repair mode, `semanticClaim: false`, selection filters, skipped repairs, and write-policy metadata; writes honor configured path policy and preserve line endings/BOMs.
- GitHub apply-patch can create PRs with reviewed file contents and falls back to `.patch` artifacts only when file contents are not supplied.
- Release verification checks the Docker runner policy image tag in addition to package, server, compose, Helm, and publishing metadata.

## P0 Before Public Hosted Production

- Do not expose anonymous quick-run execution as a hostile multi-tenant service. Keep production quick-run disabled unless it is protected by private network controls, and complete an independent sandbox review before public exposure.
- Run the service-backed integration job on every protected branch and release tag; monitor flakes before public launch.
- Treat Docker socket access as root-equivalent. Use dedicated runner hosts and never co-locate untrusted workloads or control-plane secrets. Set `PATCHPROOF_REQUIRE_DEDICATED_RUNNER_HOST=true` in environments where that policy must be enforced by `patchproof doctor --production`.
- Move Kubernetes secrets out of Helm values into Kubernetes Secrets or an external secret manager.
- Configure and rotate Ed25519 certificate signing keys if certificates must prove issuer authenticity outside the originating PatchProof deployment.
- Complete an external security review covering dynamic JavaScript execution, authentication, webhook handling, GitHub App permissions, artifact access, and tenant isolation.

## P1 Product Reliability

- Add optional OIDC/SAML/MFA for organizations that do not want local password accounts.
- Schedule retention workers in deployment environments and test deletion against production object storage.
- Test backup and restore procedures with real Postgres and object storage data.
- Add distributed traces and alerting rules.
- Validate provider-specific token fields and support the OpenAI Responses API where required.
- Expand repository repair from static one-line rewrites into full framework coverage adapters and multi-file behavioral analysis before claiming autonomous whole-application repair.

## P1 Release Engineering

- Add multi-architecture OCI images if needed for ARM runner hosts.
- Add dependency update automation, secret scanning, CodeQL/SAST, container scanning, and license checks.
- Publish immutable container tags and digests; do not deploy mutable local build tags in production.
- Verify npm ownership and enable npm trusted publishing with GitHub OIDC. The `patchproof` package name was unclaimed when checked on 2026-06-15.

## P2 Product Completeness

- Replace the simple source-token denylist with a stronger parser-based policy and hardened execution boundary.
- Broaden Python beyond standalone restricted functions only after dependency isolation and full pytest execution adapters exist. Current pytest extraction supports common parametrization, fixtures, local constants, and simple lookups, but not arbitrary pytest runtime behavior. TypeScript repository targets are normalized into JavaScript verifier input for function-level targets; a native TypeScript verifier remains future work.
- Add coverage feedback and pluggable mutation engines for broader assurance beyond the current deterministic property cases and token-aware mutation.
- Add billing/quotas only after job accounting and abuse controls are reliable.

## Current Publish Position

PatchProof is publishable as a self-hosted v1 system for private deployments with explicit bounded-evidence and function-level JavaScript/Python limitations. Public hostile multi-tenant hosting remains blocked on the P0 external sandbox and tenant-isolation review.
