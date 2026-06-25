# Publishing Guide

## Private SaaS Release

1. Run all checks:

```powershell
npm run check
npm run security:check
npm run production:check
npm run release:check
npm test
npm run smoke
npm run integration:services
docker compose config
node bin/patchproof.js doctor --production --skip-service-health
```

On a Windows development machine without host Node/npm, run the service-backed integration through Docker:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\integration-services-docker.ps1
```

`npm run security:check` validates static security invariants such as disabled browser execution, no `unsafe-eval`, Docker default isolation, queue lease/ack/retry/dead-letter behavior, hashed sessions, and signed/provenance release workflow coverage. `npm run production:check` validates `docker compose config`, Compose hardening flags, CI service-backed runner coverage, and OCI/npm publishing gates.

`docker compose config` and `npm run production:check` require `PATCHPROOF_SECRET_KEY` to be set to at least 32 random characters unless the Docker CLI check is intentionally skipped in a containerized validation environment with `PATCHPROOF_SKIP_DOCKER_CLI_CHECK=true`. Generate deployment values with `node bin/patchproof.js keygen` before local release checks or `npx patchproof keygen` after publishing. Set `PATCHPROOF_DOCKER_GID` to the host Docker socket group ID when it is not `0`. If your release policy requires dedicated runner hosts, set `PATCHPROOF_REQUIRE_DEDICATED_RUNNER_HOST=true`; `patchproof doctor --production` must then see `PATCHPROOF_RUNNER_HOST_ISOLATION=dedicated`.

2. Verify package contents:

```powershell
npm pack --dry-run
npm publish --dry-run --access public
```

The release workflow also creates:

- the npm `.tgz` package;
- `sbom.spdx.json`;
- `checksums.txt`;
- a sample replayable certificate;
- a Docker image build validation.

3. Verify the GitHub Action locally through CI or the release workflow. The workflow generates a certificate and verifies it with the repository action:

```yaml
- uses: ./
  with:
    certificate: certificate.json
```

4. Configure npm publishing.

Create an npm automation token for the package owner and store it as the repository secret:

```text
NPM_TOKEN
```

The release workflow publishes with npm provenance when a version tag is pushed. It also uploads release artifacts and attaches them to the GitHub release for tag pushes.

5. Tag a release:

```powershell
git tag v1.0.0
git push origin v1.0.0
```

The tag must match `package.json` exactly. For `1.0.0`, use `v1.0.0`.

6. Manual publish fallback when the workflow is not used:

```powershell
npm publish --access public
```

7. Validate the public install and versioned GitHub Action:

```powershell
npm view patchproof version
npx patchproof version
```

Use the action with an immutable version tag:

```yaml
- uses: AsserAl1012/patchproof@v1.0.0
  with:
    certificate: certificate.json
```

## Recommended Launch Positioning

Use this phrase:

> PatchProof is a self-hosted private SaaS for evidence-backed bug repair. It queues repair/verification jobs, runs them in isolated workers, and stores replayable bounded-evidence certificates.

Avoid claiming:

- full formal verification;
- safety for open hosted arbitrary-code execution;
- whole-repository autonomous repair beyond conservative static rewrites plus project-test certification;
- autonomous production patching.

## Release Checklist

- README has quick start and CLI commands.
- User guide is current.
- Security model is explicit.
- CI is green.
- `npm pack --dry-run` includes only intended files.
- `npm publish --dry-run --access public` succeeds.
- `npm run security:check` passes.
- `npm run production:check` passes.
- `npm run release:check` confirms version metadata is aligned.
- Release workflow uploads npm package, SBOM, checksums, and sample certificate artifacts.
- CI service job passes against Postgres migrations, Redis queue lease/ack behavior, and Docker image build.
- CI service job runs one queued job through Postgres, Redis, MinIO/S3 artifacts, and the Docker runner.
- Examples certify.
- Browser app loads at `http://127.0.0.1:4173`.
- Certificate replay works from CLI.
- `action.yml` can verify a certificate in GitHub Actions with a version tag.
- Local/demo `POST /api/run` works through the isolated hosted runner and is disabled by default when `NODE_ENV=production`.
- Project runs queue and complete through the runner path.
- Account invitation, password reset, and session-revocation APIs work.
- `patchproof test` and `run --apply --verify-command` run the configured repository test command after a certified patch is applied.
- `patchproof detect --sarif --out patchproof-results.sarif` exports repository findings and suppression fingerprints.
- `patchproof repair-repo --dry-run` previews conservative repository-level static repairs.
- `patchproof repair-repo --dry-run --finding <fingerprint>` previews one reviewed finding.
- `patchproof repair-repo --apply --run-tests` can certify supported static repairs with the configured project command.
- `patchproof test --install --build` runs configured install/build/test project commands.
- C/C++ repositories are inspected, statically detected, and eligible for conservative `repair-repo` safety rewrites only for supported local fixed-array destinations; this is not marketed as semantic C/C++ verification.
- Browser Repair Lab model generation is tested with provider setup checks and server-side candidate generation paths.
- Repository repair reports include `semanticClaim: false`, selection filters, skipped repairs, write-policy metadata, and preserved line endings/BOMs.
- Compose includes Postgres, Redis, MinIO, API, and runner services.
- `/readyz` reports backing service readiness.
- GitHub webhook signatures are verified.
- GitHub webhook delivery IDs are deduplicated.
- API keys can create runs but cannot access admin settings.
- `patchproof retention --dry-run` reports retention work.
- GHCR image is published and signed with cosign on tag releases.
- Signed certificate verification is tested when Ed25519 keys are configured.
- `patchproof keygen` emits usable production secret/signing values.
- `patchproof doctor --production` passes on the target self-hosted environment.
- `patchproof reconcile --stale-minutes 30 --apply` is documented for stale job cleanup.
- `/api/v1/openapi.json` is reachable and describes the stable v1 API, including account-operation schemas.
- Queued/running runs can be cancelled through the dashboard or `POST /api/v1/runs/:id/cancel`.

## Roadmap After Release

1. Multi-file repository repair adapters.
2. Full Jest/Vitest/pytest execution and coverage adapters.
3. gVisor/Firecracker runner hardening for public hostile workloads.
4. Hosted version after independent sandbox review.
