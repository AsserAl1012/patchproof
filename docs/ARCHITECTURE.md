# PatchProof Architecture

## Components

```text
index.html
  app shell and editor layout

app.js
  SaaS dashboard, auth/project/run UI, worker fallback, result rendering, certificate export

worker.js
  isolated execution boundary for repair and validation

bin/patchproof.js
  CLI for serving the app, running scenarios, migrating Postgres, running workers, and replaying certificates

saas/
  Postgres/JSON store adapters, migrations, Redis/memory queues, artifact storage,
  RBAC, config parser, model provider metadata, runner service, GitHub App utilities

sandbox/hosted-runner.js
  process-isolated API runner with timeout, memory cap, and Node permissions

sandbox/docker-runner.js
  production Docker runner command generation and execution path

engine.js
  candidate generation, tests, finite-domain generation, preservation checks,
  postcondition checks, mutation analysis, certificate construction

server.js
  static server, auth/org/project/run APIs, queue producer, quick-run API, rate limits,
  security headers, health/readiness/metrics endpoints

test/
  automated regression tests
```

## Validation Pipeline

1. Parse executable tests.
2. Compile the original function.
3. Run baseline tests and require observed failing evidence.
4. Generate a finite input domain from test values and boundary expansions.
5. Filter the generated domain through the precondition.
6. Generate candidate patches through a configured model provider before sandbox execution, then add local repair-template candidates when capacity remains.
7. For each candidate:
   - compile candidate;
   - run explicit tests;
   - verify originally failing tests now pass;
   - compare old/new observations outside the may-change predicate;
   - check postcondition across the finite domain;
   - run simple source mutation checks;
   - compute evidence score and rejection reasons.
8. Select the highest-scoring accepted patch, or the highest-scoring rejected candidate if none certify.
9. Emit replayable certificate.

## Private SaaS Runtime

1. The API stores organizations, users, projects, runs, jobs, settings, audit events, and artifact metadata in Postgres.
2. `POST /api/projects/:id/runs` creates a run/job and enqueues the job in Redis.
3. `patchproof runner` claims jobs, records runner heartbeats, updates job phases, and executes the verifier.
4. Production runner mode uses Docker with no network by default, read-only root filesystem, non-root user, tmpfs workspace, CPU/memory/PID/time limits, and cleanup after each job.
5. Certificates, logs, diffs, and runner metadata are uploaded to S3/MinIO or local artifact storage.
6. Certificate download verifies artifact hashes before returning data.

## Why The Design Is Conservative

PatchProof treats candidate generation as untrusted. A patch is only accepted when the verifier can produce bounded evidence. The certificate is intentionally scoped and includes residual risk rather than pretending the whole program is proven correct.

## Model Integration

`saas/model-providers.js` calls OpenAI-compatible, Azure OpenAI, or local chat-completions endpoints. Provider credentials stay in the runner process; only generated source and hashed provenance enter the isolated verifier. Providers return:

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

`patchproof verify certificate.json` reruns the engine against `replay.input` and compares the reproduced claims with the stored certificate.
