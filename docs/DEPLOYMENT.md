# Hosted Deployment

PatchProof includes a local/demo hosted API path:

```text
POST /api/run
```

The server runs validation in a separate Node process with:

- Node permission mode;
- no filesystem write permission;
- no child-process permission;
- no worker permission;
- lower memory limit;
- wall-clock timeout;
- request-size limit;
- per-address rate limiting.

This endpoint is enabled for local/demo mode and disabled automatically when `NODE_ENV=production` unless `PATCHPROOF_ENABLE_QUICK_RUN=true` is set explicitly. Production self-hosted deployments should use authenticated projects, queued jobs, and Docker runners. It is still not a substitute for a professional security review before broad hosted arbitrary-code exposure.

Private SaaS mode adds authenticated organizations, invitations, password reset tokens, session revocation, projects, persistent runs, queued jobs, audit events, admin settings, GitHub integration, artifact storage, and runner health APIs. Production mode uses Postgres, Redis, and S3/MinIO. JSON storage remains available only for local/demo usage.

Operational hardening now includes request IDs, optional JSON access logs, Prometheus metrics for run/job/model activity, webhook delivery deduplication, graceful runner shutdown, run cancellation, stale-run reconciliation, and explicit retention cleanup for expired sessions, artifacts, audit events, and webhook delivery records.

Generate deployment secrets before first boot:

```powershell
npx patchproof keygen --issuer your-org --key-id 2026-rotation-1
```

Validate the configured host before launch:

```powershell
npm run security:check
npm run production:check
npx patchproof doctor --production
```

If runner hosts must be dedicated by policy, set:

```text
PATCHPROOF_REQUIRE_DEDICATED_RUNNER_HOST=true
PATCHPROOF_RUNNER_HOST_ISOLATION=dedicated
```

With that requirement enabled, `patchproof doctor --production` fails until the dedicated-host declaration is present.

## Local Container Run

```powershell
docker compose up --build
```

Open:

```text
http://127.0.0.1:4173
```

Compose starts:

- `patchproof`: API and web app;
- `patchproof-runner`: Redis worker with Docker isolation;
- `postgres`: durable SaaS state;
- `redis`: job queue;
- `minio`: S3-compatible artifact storage;
- `minio-init`: bucket bootstrap.

## Reverse Proxy Recommendations

Put PatchProof behind a reverse proxy that adds:

- TLS;
- request body limit at or below 64 KB;
- IP/user rate limiting;
- access logs;
- WAF or bot filtering if exposed publicly;
- no request buffering of huge bodies;
- security monitoring.

## Required Production Controls

Before public internet exposure:

- run as non-root;
- use read-only filesystem;
- disable outbound network at container or firewall level;
- set memory and CPU limits;
- cap processes/PIDs;
- rotate logs;
- publish a security contact;
- keep dependencies and Node patched.

The included `compose.yml` gives a reasonable local baseline for these controls.

## Backing Services

The compose stack includes PostgreSQL 16, Redis 7, and MinIO. `/readyz` checks all three backing services. `/healthz` is a liveness check and does not require backing services.

Run migrations manually when needed:

```powershell
npm run migrate
```

Run a standalone worker:

```powershell
npm run runner -- --isolation docker
```

For runner hosts with gVisor or Kata installed, select the hardened Docker runtime used for each job container:

```powershell
$env:PATCHPROOF_DOCKER_RUNTIME="runsc" # or "kata"
npm run runner -- --isolation docker
```

This adds Docker's `--runtime` flag in addition to the default no-network/read-only/non-root/no-new-privileges/cap-drop/PID/memory/CPU limits. The runtime must already be installed and configured on the runner host.

Treat Docker socket access as root-equivalent. Use dedicated runner hosts or VMs, keep control-plane secrets off those hosts, and do not co-locate unrelated untrusted workloads.

Run retention cleanup:

```powershell
npm run retention -- --dry-run
npm run retention
```

Reconcile stale running jobs after a runner crash:

```powershell
node bin/patchproof.js reconcile --stale-minutes 30 --apply
```

The stable v1 API is exposed under `/api/v1`. The OpenAPI document is available at `/api/v1/openapi.json`.

Set `PATCHPROOF_ACCESS_LOGS=json` when your log collector expects structured access records. Responses include `X-Request-ID`; preserve or inject that header at the reverse proxy so API logs and proxy logs can be correlated.

For issuer-signed certificates, configure Ed25519 PEM keys in the API and runner environment:

```text
PATCHPROOF_CERTIFICATE_PRIVATE_KEY_PEM=...
PATCHPROOF_CERTIFICATE_PUBLIC_KEY_PEM=...
PATCHPROOF_CERTIFICATE_ISSUER=...
PATCHPROOF_CERTIFICATE_KEY_ID=...
```

## Bind Host

Local CLI defaults to:

```text
HOST=127.0.0.1
```

Container deployment uses:

```text
HOST=0.0.0.0
```

Keep the container port bound to `127.0.0.1` on the host unless a reverse proxy is in front of it.
