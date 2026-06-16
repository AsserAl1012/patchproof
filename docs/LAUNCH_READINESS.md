# Launch Readiness

Status reviewed against source and configuration on 2026-06-15.

## Implemented In This Pass

- OpenAI-compatible, Azure OpenAI, and local chat-completions candidate generation for queued runs.
- Local CLI model candidate generation behind explicit `--model` or repository config.
- Repository `init`, `doctor`, checkout inspection, simple Jest/Vitest/node:test/pytest assertion extraction, and certified function patch application.
- Provider credentials remain outside the isolated verifier; certificates store hashed provenance.
- Model candidates are included in deterministic replay input and validated like local-template candidates.
- Certificate verification compares the complete deterministic certificate, excluding only generation time.
- Candidate, test, finite-domain, counterexample, mutation, and evidence thresholds are enforced.
- GitHub Action verification no longer requires installing SaaS dependencies and avoids direct input interpolation.
- Production encryption keys reject missing, short, and placeholder values.
- GitHub webhooks fail closed when no signing secret is configured.
- Non-root Docker runners can be given the mounted socket's supplemental group ID.

## P0 Before Public Production

- Do not expose anonymous `POST /api/run` as a hostile multi-tenant service. Complete an independent sandbox review and move public execution to gVisor, Kata, or microVM isolation.
- Replace the Redis `BLPOP` queue with leased jobs, retry limits, heartbeats, and a dead-letter queue. A worker crash can currently lose a claimed job.
- Run end-to-end CI against Postgres, Redis, S3/MinIO, and the Docker runner. Current tests primarily use in-memory/local substitutes.
- Treat Docker socket access as root-equivalent. Use dedicated runner hosts and never co-locate untrusted workloads or control-plane secrets.
- Move Kubernetes secrets out of Helm values into Kubernetes Secrets or an external secret manager.
- Add certificate signing if certificates must prove issuer authenticity outside the originating PatchProof deployment. Replay currently proves reproducibility and detects changed claims, not issuer identity.
- Complete an external security review covering dynamic JavaScript execution, authentication, webhook handling, GitHub App permissions, artifact access, and tenant isolation.

## P1 Product Reliability

- Add idempotency and delivery-ID deduplication for GitHub webhooks.
- Add graceful worker shutdown, job cancellation, retry visibility, and stale-run reconciliation.
- Add user invitations, password reset, session revocation, and optional OIDC/SAML/MFA.
- Add retention workers that enforce configured artifact and audit retention periods.
- Test backup and restore procedures with real Postgres and object storage data.
- Add structured logs, request IDs, traces, model latency/error metrics, and alerting rules.
- Validate provider-specific token fields and support the OpenAI Responses API where required.
- Expand repository adapters from simple literal assertion extraction into full framework execution/coverage adapters before claiming whole-repository repair.
- Change GitHub patch application from committing a `.patch` artifact to applying reviewed file changes once the repository repair workflow is wired into GitHub App runs.

## P1 Release Engineering

- Align `package.json`, Docker/Helm image tags, certificate verifier version, Git tags, and release notes. The repository currently has a `v0.1.0-beta` tag while package metadata is `0.4.0`.
- Add a release workflow that runs tests, creates provenance/SBOMs, signs container images, publishes npm and OCI artifacts, and attaches checksums.
- Add dependency update automation, secret scanning, CodeQL/SAST, container scanning, and license checks.
- Publish immutable container tags and digests; do not deploy mutable local build tags in production.
- Verify npm ownership and enable npm trusted publishing with GitHub OIDC. The `patchproof` package name was unclaimed when checked on 2026-06-15.

## P2 Product Completeness

- Replace the simple source-token denylist with a stronger parser-based policy and hardened execution boundary.
- Broaden Python beyond standalone restricted functions only after dependency isolation and full pytest execution adapters exist. TypeScript still requires its own execution path.
- Add richer generated domains, property-based generators, coverage feedback, and pluggable mutation engines.
- Version the HTTP API and publish an OpenAPI specification.
- Add billing/quotas only after job accounting and abuse controls are reliable.

## Current Publish Position

The npm CLI and private self-hosted beta are publishable with explicit bounded-evidence and named-function JavaScript/Python limitations. A public multi-tenant SaaS should not launch until the P0 isolation, queue reliability, integration testing, secret management, certificate trust, and security-review items are complete.
