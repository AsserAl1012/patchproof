# PatchProof

PatchProof is a private AI bug-fixing and patch-verification system. It proposes candidate JavaScript and Python function patches, executes tests in isolated runners, checks bounded behavioral preservation, runs postcondition checks, performs token-aware mutation analysis, and emits replayable validation certificates.

The current build supports both local quick-run mode and self-hosted private SaaS mode with login, organizations, projects, Postgres-backed runs, Redis queued jobs, Docker-capable runner workers, S3/MinIO artifact storage, retention cleanup, audit logs, admin settings, GitHub App slash-command callbacks, optional Ed25519 certificate signatures, and replayable certificates.

## Quick Start

```powershell
npm start
```

Open:

```text
http://127.0.0.1:4173
```

Health check:

```text
http://127.0.0.1:4173/healthz
```

## Scripts

```powershell
npm run check
npm run security:check
npm run production:check
npm test
npm run smoke
npm start
npm run migrate
npm run runner
npm run retention -- --dry-run
npm run runner -- --once
npm run reconcile -- --stale-minutes 30
npm run doctor:production -- --skip-service-health
```

## CLI

```powershell
node bin/patchproof.js scenarios
node bin/patchproof.js init --repo path/to/project
node bin/patchproof.js doctor --repo path/to/project
node bin/patchproof.js run --scenario clamp-range --out certificate.json
node bin/patchproof.js run --input examples/clamp-range.input.json --out certificate.json
node bin/patchproof.js inspect --repo path/to/project
node bin/patchproof.js detect --repo path/to/project --sarif --out patchproof-results.sarif
node bin/patchproof.js targets --repo path/to/project
node bin/patchproof.js test --repo path/to/project --install --build
node bin/patchproof.js model-check --repo path/to/project --target clamp-range
node bin/patchproof.js run --repo path/to/project --target clamp-range --out certificate.json --apply --verify-command
node bin/patchproof.js apply --certificate certificate.json --repo path/to/project --target clamp-range
node bin/patchproof.js verify certificate.json
node bin/patchproof.js serve --port 4173
node bin/patchproof.js migrate
node bin/patchproof.js runner --isolation docker
node bin/patchproof.js retention --dry-run
node bin/patchproof.js reconcile --stale-minutes 30 --apply
node bin/patchproof.js keygen
node bin/patchproof.js doctor --production
```

After publishing to npm, the same commands become:

```powershell
npx patchproof scenarios
npx patchproof init --repo path/to/project
npx patchproof doctor --repo path/to/project
npx patchproof run --scenario clamp-range --out certificate.json
npx patchproof run --input examples/clamp-range.input.json --out certificate.json
npx patchproof inspect --repo path/to/project
npx patchproof detect --repo path/to/project --sarif --out patchproof-results.sarif
npx patchproof targets --repo path/to/project
npx patchproof test --repo path/to/project --install --build
npx patchproof model-check --repo path/to/project --target clamp-range
npx patchproof run --repo path/to/project --target clamp-range --out certificate.json --apply --verify-command
npx patchproof apply --certificate certificate.json --repo path/to/project --target clamp-range
npx patchproof verify certificate.json
npx patchproof serve
npx patchproof keygen
npx patchproof doctor --production
```

## Solo Dev Workflow

```powershell
npx patchproof inspect --repo .
npx patchproof init --repo .
npx patchproof detect --repo . --sarif --out patchproof-results.sarif
npx patchproof repair-repo --repo . --dry-run
npx patchproof repair-repo --repo . --dry-run --finding <fingerprint>
npx patchproof repair-repo --repo . --apply --run-tests
npx patchproof doctor --repo .
npx patchproof run --repo . --target <target-id> --out patchproof-certificate.json
npx patchproof run --repo . --target <target-id> --out patchproof-certificate.json --apply --verify-command
```

`init` creates a starter `patchproof.yml` from checkout metadata. `detect` scans for likely bug signals, maps some failing project-test output back to files, skips obvious generated source, exports JSON or SARIF, and supports `.patchproofignore` suppressions. `repair-repo` previews or applies conservative repository-level static repairs, can be scoped with `--finding`, `--category`, or `--file`, honors `allowedPaths`/`forbiddenPaths`, preserves line endings/BOMs, and can certify supported static repairs with the configured project command. `doctor` validates local setup, configured targets, Python availability when needed, and detected test adapters. `run --apply` writes the certified replacement function back into the target source file only when the certificate is accepted and the source still matches the replay input. `--verify-command` then runs the repository's configured `project.testCommand`; `patchproof test --repo . --install --build` can run configured install/build/test commands directly.

## Private SaaS Flow

1. Open `http://127.0.0.1:4173`.
2. Enter an owner email, password, and organization name.
3. Click `Bootstrap Admin`.
4. Create a project.
5. Select a bundled bug scenario or paste your own function/tests/envelope.
6. Click `Run Project`.
7. The run is queued, claimed by a runner, verified, and stored as hash-checked artifacts.
8. Review the stored run, audit log, runner health, logs, and certificate.

## What It Proves

PatchProof does not claim whole-program correctness. It claims:

- the original test evidence failed before repair;
- the selected patch fixes that failing evidence;
- all explicit tests pass after repair;
- generated finite-domain inputs outside the `may-change` predicate preserve old behavior;
- the postcondition holds across the finite generated domain;
- simple mutation variants are mostly rejected by the validation envelope.

Every accepted patch includes a JSON certificate with the exact claim and residual risk.

## Prototype Boundaries

- JavaScript/TypeScript repository targets: AST-backed extraction for function declarations, exported functions, const function expressions, arrow functions, object methods, class methods, and TypeScript function signatures normalized into verifier JavaScript
- Python: one named `def` function with JSON-compatible inputs/results; imports, classes, decorators, dynamic builtins, and private attributes are rejected, while normal built-in exceptions such as `ValueError` can be raised
- Test format: JSON array with `name`, `args`, and `expect`, plus conservative AST-backed extraction from simple Jest, Vitest, node:test, and pytest literal assertions, including common pytest parametrization, fixtures, local constants, simple dictionary/list lookups, and exact boolean JS matchers such as `toBeTruthy`, `toBeFalsy`, and boolean `.not.toBe(...)`
- Envelope format: JavaScript expressions for JavaScript runs and Python expressions for Python runs
- Repository adapter: `patchproof inspect`, `init`, `detect`, and `doctor` profile a checkout; `patchproof.yml` maps source/test files or simple framework assertions into function-level PatchProof targets
- Repository detection: static JavaScript/Python/C/C++ bug-signal scanning, generated-file noise reduction, dependency/test metadata hints, optional project test execution with simple failure-to-file mapping, JSON/SARIF export, and readable suppression rules
- C/C++: repository inspection detects CMake/Make/CTest/GTest/Catch2/doctest metadata and risky C/C++ patterns; `repair-repo` supports conservative one-line safety repairs such as `gets`, `strcpy`, `strcat`, and `sprintf` only when the destination is a known local fixed array, with certification limited to the configured project test command
- Proof mode: finite-domain bounded equivalence with boundary cases, seeded generated property-style cases, and token-aware mutation checks; not whole-program formal verification
- Production storage: Postgres for SaaS state, Redis for queueing, S3/MinIO for artifacts
- Isolation: production runner supports Docker one-container-per-job isolation; CLI and local quick-run use isolated runner processes; browser-side verification is disabled
- Certificate trust: replay verification is always available; deployments can also sign certificates with Ed25519 using `PATCHPROOF_CERTIFICATE_PRIVATE_KEY_PEM` and verify with `PATCHPROOF_CERTIFICATE_PUBLIC_KEY_PEM`
- Operations: GitHub webhook delivery IDs are deduplicated, runner shutdown is graceful between jobs, request IDs are emitted on responses, runs can be cancelled, stale runs can be reconciled, and retention cleanup can remove expired sessions, artifacts, audit events, and webhook delivery records
- Repair model: language-specific local repair templates, plus explicitly configured OpenAI-compatible, Azure OpenAI, or local chat-completions candidate generation in CLI, SaaS, and server-backed browser Repair Lab runs with prompt-size controls and usage estimates

Python runs require Python 3.11+ and execute through the CLI or PatchProof server. Set `PATCHPROOF_PYTHON_BIN` when Python is not available as `python` on Windows or `python3` on Unix.

See [docs/USER_GUIDE.md](docs/USER_GUIDE.md) for the full manual, [docs/SECURITY.md](docs/SECURITY.md) for the security model, [docs/PUBLISHING.md](docs/PUBLISHING.md) for release steps, and [docs/LAUNCH_READINESS.md](docs/LAUNCH_READINESS.md) for the production gap analysis.

## Production Private SaaS

The browser app uses authenticated SaaS APIs with same-origin HttpOnly session cookies for project runs and keeps `POST /api/run` as a local/demo quick-run endpoint. That quick-run endpoint is disabled by default in production unless `PATCHPROOF_ENABLE_QUICK_RUN=true` is set explicitly. Production project runs are queued with leases, acknowledgements, retries, and dead-letter tracking, executed by `patchproof runner`, and stored as hash-checked artifacts. `PATCHPROOF_DOCKER_RUNTIME=runsc` or `kata` can select a hardened Docker runtime on runner hosts that support it. Admin APIs support invitations, password reset tokens, and browser-session revocation. `patchproof retention` enforces configured retention windows. `docker compose up --build` starts Postgres, Redis, MinIO, the API, and the runner.

Before deploying a self-hosted v1 instance, run `patchproof keygen` to generate the encryption/signing environment values, then run `npm run security:check`, `npm run production:check`, and `patchproof doctor --production` from the configured host to validate security invariants, Compose hardening, Docker, runner image, Postgres, Redis, S3/MinIO, signing keys, and release metadata. Set `PATCHPROOF_REQUIRE_DEDICATED_RUNNER_HOST=true` when your deployment policy requires dedicated runner hosts; production doctor will then fail unless `PATCHPROOF_RUNNER_HOST_ISOLATION=dedicated` is declared. Operators can cancel queued/running jobs from the dashboard or API, and `patchproof reconcile --stale-minutes 30 --apply` marks stale running jobs failed after runner crashes. The stable HTTP API is available under `/api/v1`, with OpenAPI metadata at `/api/v1/openapi.json`.

For deployment notes, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md), and [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md).
