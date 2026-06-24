# PatchProof Architecture

## Components

```text
index.html
  app shell and editor layout

app.js
  SaaS dashboard, cookie-auth/project/run UI, server-backed verification calls,
  result rendering, certificate export

worker.js
  disabled browser-worker stub; browser-side verification is intentionally off

bin/patchproof.js
  CLI for serving the app, initializing/checking repositories, running scenarios,
  applying certified target patches, migrating Postgres, running workers, and
  replaying certificates. Production operations commands generate secrets,
  validate deployed dependencies, run retention, and reconcile stale jobs.

repository-adapter.js
  Inspects repository checkouts, detects package/test metadata, reads patchproof.yml
  targets, uses AST parsing for JavaScript/TypeScript function extraction and
  simple framework assertions, reads JSON PatchProof tests, applies certified
  function replacements, and builds verifier inputs

saas/
  Postgres/JSON store adapters, migrations, Redis/memory queues, artifact storage,
  RBAC, config parser, model provider metadata, runner service, GitHub App utilities

sandbox/hosted-runner.js
  process-isolated API runner with timeout, memory cap, and Node permissions

sandbox/docker-runner.js
  production Docker runner command generation and execution path

engine.js
  candidate generation, tests, deterministic finite-domain and property-case
  generation, preservation checks, postcondition checks, token-aware mutation
  analysis, certificate construction

server.js
  static server, auth/org/project/run APIs, versioned /api/v1 aliases, OpenAPI
  document, queue producer, quick-run API, rate limits, security headers,
  request IDs, health/readiness/metrics endpoints

saas/retention.js
  retention planner/executor for expired sessions, artifacts, audit events, and
  GitHub delivery dedupe records

test/
  automated regression tests
```

## Validation Pipeline

1. Optionally build input from a repository target: source file plus JSON PatchProof tests or simple Jest/Vitest/node:test/pytest literal assertions.
2. Parse executable tests.
3. Dispatch by language: JavaScript uses the Node verifier and Python uses the restricted Python process verifier.
4. Run baseline tests and require observed failing evidence.
5. Generate a finite input domain from test values, boundary expansions, and seeded property-style cases.
6. Filter the generated domain through the precondition.
7. Generate candidate patches through an explicitly configured model provider before sandbox execution, then add local repair-template candidates when capacity remains.
8. For each candidate:
   - compile candidate;
   - run explicit tests;
   - verify originally failing tests now pass;
   - compare old/new observations outside the may-change predicate;
   - check postcondition across the finite domain;
   - run token-aware source mutation checks;
   - compute evidence score and rejection reasons.
9. Select the highest-scoring accepted patch, or the highest-scoring rejected candidate if none certify.
10. Emit replayable certificate.
11. Optionally attach an Ed25519 issuer signature when certificate signing keys are configured.

## Private SaaS Runtime

1. The API stores organizations, users, projects, runs, jobs, settings, audit events, and artifact metadata in Postgres.
2. `POST /api/projects/:id/runs` creates a run/job and enqueues the job in Redis.
3. `patchproof runner` claims leased jobs, records runner heartbeats, updates job phases, executes the verifier, ACKs completed jobs, retries retryable failures, and dead-letters exhausted jobs.
4. Production runner mode uses Docker with no network by default, read-only root filesystem, non-root user, tmpfs workspace, CPU/memory/PID/time limits, and cleanup after each job.
5. Certificates, logs, diffs, and runner metadata are uploaded to S3/MinIO or local artifact storage.
6. Certificate download verifies artifact hashes before returning data.
7. Queued/running jobs can be cancelled before completion; cancelled queue payloads are acknowledged rather than retried.
8. `patchproof retention` deletes expired artifact objects/metadata, sessions, audit events, and old GitHub delivery records.
9. `patchproof reconcile` marks stale running jobs failed after unclean runner shutdowns.
10. Runner loops handle `SIGINT`/`SIGTERM` by stopping after the current job and recording a stopping heartbeat.

## Why The Design Is Conservative

PatchProof treats candidate generation as untrusted. A patch is only accepted when the verifier can produce bounded evidence. The certificate is intentionally scoped and includes residual risk rather than pretending the whole program is proven correct.

## Model Integration

`saas/model-providers.js` calls OpenAI-compatible, Azure OpenAI, or local chat-completions endpoints for JavaScript or Python. Provider credentials stay in the runner process; only generated source and hashed provenance enter the isolated verifier. Prompt size is estimated before the call and bounded by `maxPromptChars`; generation results include prompt/response size metadata for observability. Providers return:

```json
{
  "title": "Patch title",
  "source": "function ...",
  "rationale": "Why this candidate was proposed"
}
```

The verifier computes diffs, treats generated code as untrusted, and remains the authority.

## Certificate Replay

Certificates include:

- deterministic `runId`;
- verifier version;
- exact replay input;
- selected patch metadata;
- validation counters;
- residual risk.
- optional `proof` metadata with Ed25519 issuer signature, issuer, key ID, signed time, and payload hash.

`patchproof verify certificate.json` reruns the engine against `replay.input` and compares the reproduced claims with the stored certificate.
If the certificate includes a signature and the public key is configured, verification also checks payload hash and signature validity. Unsigned historical certificates continue to verify by replay.
