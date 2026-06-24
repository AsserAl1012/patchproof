# Backup And Restore

## Production Postgres

For production deployments:

```bash
pg_dump "$DATABASE_URL" > patchproof.sql
psql "$DATABASE_URL" < patchproof.sql
```

Back up before every upgrade.

Postgres also stores GitHub delivery dedupe records and certificate metadata. These records are not enough to restore artifact bytes by themselves; back up object storage together with Postgres.

## Local JSON Store

Local/demo mode can write state to:

```text
./data/patchproof-store.json
```

or the path set by:

```text
PATCHPROOF_STORE_PATH
```

Back up this file while the service is stopped, or copy it from a filesystem snapshot.

## Object Storage

If using S3/MinIO for artifacts, back up:

- certificates;
- diffs;
- run logs;
- uploaded repo snapshots;
- generated patches.

Retention cleanup deletes expired artifact objects and metadata. Confirm retention windows before restore testing so expected historical artifacts have not already been removed.

## Restore Smoke Test

After restore:

1. Start PatchProof.
2. Login as owner.
3. Open a previous run.
4. Download its certificate.
5. Run `patchproof verify certificate.json`.
6. If certificate signing is enabled, verify with `PATCHPROOF_CERTIFICATE_PUBLIC_KEY_PEM` configured.
