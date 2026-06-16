# PatchProof

PatchProof is a private AI bug-fixing and patch-verification system. It proposes candidate JavaScript and Python function patches, executes tests, checks bounded behavioral preservation, runs postcondition checks, performs simple mutation analysis, and emits replayable validation certificates.

The current build supports both local quick-run mode and self-hosted private SaaS mode with login, organizations, projects, Postgres-backed runs, Redis queued jobs, Docker-capable runner workers, S3/MinIO artifact storage, audit logs, admin settings, GitHub App slash-command callbacks, and replayable certificates.

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
npm test
npm run smoke
npm start
npm run migrate
npm run runner
```

## CLI

```powershell
node bin/patchproof.js scenarios
node bin/patchproof.js run --scenario clamp-range --out certificate.json
node bin/patchproof.js run --input examples/clamp-range.input.json --out certificate.json
node bin/patchproof.js targets --repo path/to/project
node bin/patchproof.js run --repo path/to/project --target clamp-range --out certificate.json
node bin/patchproof.js verify certificate.json
node bin/patchproof.js serve --port 4173
node bin/patchproof.js migrate
node bin/patchproof.js runner --isolation docker
```

After publishing to npm, the same commands become:

```powershell
npx patchproof scenarios
npx patchproof run --scenario clamp-range --out certificate.json
npx patchproof run --input examples/clamp-range.input.json --out certificate.json
npx patchproof targets --repo path/to/project
npx patchproof run --repo path/to/project --target clamp-range --out certificate.json
npx patchproof verify certificate.json
npx patchproof serve
```

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

- JavaScript: functions declared as `function name(...) { ... }`
- Python: one named `def` function with JSON-compatible inputs/results; imports and unsafe builtins are rejected
- Test format: JSON array with `name`, `args`, and `expect`
- Envelope format: JavaScript expressions for JavaScript runs and Python expressions for Python runs
- Repository adapter: `patchproof.yml` can map source/test files into function-level PatchProof targets
- Proof mode: finite-domain bounded equivalence, not whole-program formal verification
- Production storage: Postgres for SaaS state, Redis for queueing, S3/MinIO for artifacts
- Isolation: production runner supports Docker one-container-per-job isolation; local quick-run keeps the Node permission runner
- Repair model: language-specific local repair templates, plus configured OpenAI-compatible, Azure OpenAI, or local chat-completions candidate generation in queued SaaS runs

Python runs require Python 3.11+ and execute through the CLI or PatchProof server. Browser-worker fallback remains JavaScript-only. Set `PATCHPROOF_PYTHON_BIN` when Python is not available as `python` on Windows or `python3` on Unix.

See [docs/USER_GUIDE.md](docs/USER_GUIDE.md) for the full manual, [docs/SECURITY.md](docs/SECURITY.md) for the security model, [docs/PUBLISHING.md](docs/PUBLISHING.md) for release steps, and [docs/LAUNCH_READINESS.md](docs/LAUNCH_READINESS.md) for the production gap analysis.

## Production Private SaaS

The browser app uses authenticated SaaS APIs for project runs and keeps `POST /api/run` as a local/demo quick-run endpoint. Production project runs are queued in Redis, executed by `patchproof runner`, and stored as hash-checked artifacts. `docker compose up --build` starts Postgres, Redis, MinIO, the API, and the runner.

For deployment notes, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md), and [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md).
