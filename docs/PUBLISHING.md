# Publishing Guide

## Private SaaS Release

1. Run all checks:

```powershell
npm run check
npm test
npm run smoke
docker compose config
```

`docker compose config` requires `PATCHPROOF_SECRET_KEY` to be set to at least 32 random characters. Set `PATCHPROOF_DOCKER_GID` to the host Docker socket group ID when it is not `0`.

2. Verify package contents:

```powershell
npm pack --dry-run
```

3. Tag a release:

```powershell
git tag v0.4.0
git push origin v0.4.0
```

4. Publish when ready:

```powershell
npm publish --access public
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
- Examples certify.
- Browser app loads at `http://127.0.0.1:4173`.
- Certificate replay works from CLI.
- `action.yml` can verify a certificate in GitHub Actions.
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
