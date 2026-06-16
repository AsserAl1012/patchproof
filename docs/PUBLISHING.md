# Publishing Guide

## Private SaaS Release

1. Run all checks:

```powershell
npm run check
npm run release:check
npm test
npm run smoke
docker compose config
```

`docker compose config` requires `PATCHPROOF_SECRET_KEY` to be set to at least 32 random characters. Set `PATCHPROOF_DOCKER_GID` to the host Docker socket group ID when it is not `0`.

2. Verify package contents:

```powershell
npm pack --dry-run
npm publish --dry-run --access public
```

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

The release workflow publishes with npm provenance when a version tag is pushed.

5. Tag a release:

```powershell
git tag v0.4.0
git push origin v0.4.0
```

The tag must match `package.json` exactly. For `0.4.0`, use `v0.4.0`.

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
- uses: AsserAl1012/patchproof@v0.4.0
  with:
    certificate: certificate.json
```

## Recommended Launch Positioning

Use this phrase:

> PatchProof is a self-hosted private SaaS for evidence-backed bug repair. It queues repair/verification jobs, runs them in isolated workers, and stores replayable bounded-evidence certificates.

Avoid claiming:

- full formal verification;
- safety for open hosted arbitrary-code execution;
- whole-repository autonomous repair;
- autonomous production patching.

## Release Checklist

- README has quick start and CLI commands.
- User guide is current.
- Security model is explicit.
- CI is green.
- `npm pack --dry-run` includes only intended files.
- `npm publish --dry-run --access public` succeeds.
- `npm run release:check` confirms version metadata is aligned.
- Examples certify.
- Browser app loads at `http://127.0.0.1:4173`.
- Certificate replay works from CLI.
- `action.yml` can verify a certificate in GitHub Actions with a version tag.
- `POST /api/run` works through the isolated hosted runner.
- Project runs queue and complete through the runner path.
- Compose includes Postgres, Redis, MinIO, API, and runner services.
- `/readyz` reports backing service readiness.
- GitHub webhook signatures are verified.
- API keys can create runs but cannot access admin settings.

## Roadmap After Release

1. Multi-file repository repair adapters.
2. Jest/Vitest/pytest integration.
3. gVisor/Firecracker runner hardening.
4. Hosted version after sandbox review.
