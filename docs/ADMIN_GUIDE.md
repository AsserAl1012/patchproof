# Admin Guide

## Bootstrap

1. Start PatchProof.
2. Open `http://127.0.0.1:4173`.
3. Enter owner email, password, and organization name.
4. Click `Bootstrap Admin`.

Bootstrap can run only once per store.

Production mode uses:

```text
PATCHPROOF_STORE_DRIVER=postgres
DATABASE_URL=postgres://...
PATCHPROOF_QUEUE_DRIVER=redis
REDIS_URL=redis://...
PATCHPROOF_ARTIFACT_DRIVER=s3
PATCHPROOF_SECRET_KEY=<random secret for encrypted settings>
```

Run migrations explicitly with:

```powershell
npm run migrate
```

## Roles

- `owner`: full control.
- `admin`: org, project, integration, runner, and settings control.
- `developer`: create runs and download certificates.
- `reviewer`: inspect runs and request patch application.
- `auditor`: read-only run/certificate/audit access.

## API Keys

Owners/admins can create API keys through:

```text
POST /api/admin/api-keys
GET /api/admin/api-keys
DELETE /api/admin/api-keys/:id
```

API keys may use `developer`, `reviewer`, or `auditor` roles. A developer key can create runs and download certificates but cannot read or change admin settings.

## Projects

Create one project per repository or manually uploaded codebase. Each project may include a `patchproof.yml` policy.

## Settings

Admin settings include:

- model provider metadata;
- runner CPU/memory/network policy;
- artifact retention;
- audit retention.

Production stores settings in Postgres. JSON storage remains available only for local/demo usage with `PATCHPROOF_STORE_DRIVER=json`.

GitHub settings include:

- App ID or token;
- private key;
- webhook secret;
- allowed repositories;
- apply-patch policy.

## Operations

Use:

```text
/healthz
/readyz
/metrics
```

The dashboard exposes runner health, settings, and audit logs for owners/admins.

Run workers with:

```powershell
npm run runner -- --isolation docker
```

Docker Compose starts a dedicated `patchproof-runner` service automatically.
