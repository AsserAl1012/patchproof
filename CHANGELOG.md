# Changelog

## 1.0.0 - 2026-06-24

PatchProof 1.0.0 is the first self-hosted v1 release line.

### Added

- JavaScript, TypeScript-normalized, and Python function-level PatchProof runs.
- Repository inspection, target initialization, repository doctor checks, and certified function patch application.
- CLI, browser UI, self-hosted API, queued runners, Postgres state, Redis queueing, S3/MinIO artifacts, and GitHub App webhook workflows.
- Docker runner isolation by default for queued jobs, including optional `PATCHPROOF_DOCKER_RUNTIME=runsc|kata`.
- OpenAI-compatible, Azure OpenAI, and local chat-completions model candidate generation, plus deterministic local repair templates.
- Replayable bounded-evidence certificates with optional Ed25519 issuer signatures.
- Leased queues with acknowledgement, retry, expired-lease recovery, and dead-letter tracking.
- Run cancellation, stale-run reconciliation, retention cleanup, request IDs, JSON access logs, and Prometheus metrics.
- `/api/v1` stable API aliases and `/api/v1/openapi.json`.
- `patchproof keygen`, `patchproof doctor --production`, and `patchproof reconcile` production operations commands.
- Release workflow support for npm provenance, SBOM, checksums, GitHub release artifacts, GHCR image publishing, and OCI signing.

### Security

- Browser-side dynamic verification is disabled; browser project runs use server/runner isolation.
- SaaS sessions use same-origin `HttpOnly` cookies and server-side token hashes.
- API keys are hashed at rest.
- GitHub webhook signatures fail closed and delivery IDs are deduplicated.
- Certificate signing keys can be generated and validated through CLI operations commands.

### Boundaries

- PatchProof v1 is a private/self-hosted system, not a public hostile multi-tenant arbitrary-code service.
- Certificates are bounded evidence over explicit tests, generated finite domains, behavioral preservation predicates, postconditions, and mutation checks. They are not whole-program formal proofs.
- Repository adapters remain function-level and intentionally conservative.
- Python support is restricted to standalone named functions with JSON-compatible inputs/results.
