# Security Review Package

This document is the handoff package for an independent security review before PatchProof is exposed as a public multi-tenant service.

## Review Goal

Determine whether PatchProof can safely process untrusted user-submitted JavaScript/Python function repair jobs in a hosted environment, and identify any required mitigations before public launch.

## Current Trust Boundaries

- Browser-side verification is disabled.
- API quick runs use isolated child processes and are intended for local/demo use.
- Production project runs are queued and processed by runner workers.
- Docker runner jobs use one container per job, no network by default, read-only filesystem, non-root user, tmpfs workspace, CPU/memory/PID/time limits, `no-new-privileges`, dropped capabilities, and optional hardened Docker runtime selection through `PATCHPROOF_DOCKER_RUNTIME`.
- Stronger runtimes such as gVisor `runsc` or Kata can be selected when installed on runner hosts.
- Certificates are replay-verifiable and can be issuer-signed with Ed25519.
- SaaS state is stored in Postgres, jobs in Redis, artifacts in S3/MinIO.

## Reviewer Scope

Review at least:

- dynamic JavaScript execution in `engine.js` and isolated runner paths;
- Python AST policy and restricted execution in `sandbox/python-runner.py`;
- Docker runner command construction in `sandbox/docker-runner.js`;
- queue lease/ack/retry/dead-letter behavior in `saas/queue.js`;
- artifact hash validation and retention deletion in `saas/artifacts.js` and `saas/retention.js`;
- authentication, session cookies, API keys, and RBAC in `server.js`, `saas/store.js`, and `saas/postgres-store.js`;
- GitHub webhook signature verification and delivery dedupe;
- GitHub App permissions and patch PR behavior;
- secret handling and encrypted settings;
- tenant isolation across org/project/run/artifact APIs;
- deployment manifests, Dockerfile, Compose, Helm values, and CI release workflow.

## Abuse Cases To Test

- container escape attempts from JavaScript and Python submissions;
- prototype/constructor escapes against JavaScript predicate/source filtering;
- Python dunder/private attribute, import, eval, and introspection escapes;
- attempts to read environment variables, mounted files, Docker socket, or metadata endpoints;
- CPU, memory, output, process, and wall-clock exhaustion;
- artifact path traversal or hash mismatch;
- cross-tenant project/run/certificate access;
- replay/certificate signature tampering;
- webhook replay and duplicate delivery handling;
- unauthorized settings/API-key/GitHub integration changes.

## Required Evidence

Before public launch, collect:

- passing unit tests and smoke tests;
- passing `npm run integration:services` against Postgres, Redis, MinIO, and Docker;
- Docker runner image digest and cosign signature;
- SBOM and checksums attached to the release;
- production deployment diagram;
- runner host hardening notes, including whether `PATCHPROOF_DOCKER_RUNTIME=runsc` or `kata` is used;
- secrets management plan;
- backup/restore test results;
- vulnerability report with severity, exploitability, and remediation status.

## Launch Gate

Do not expose public anonymous arbitrary-code execution until:

- high/critical sandbox, tenant-isolation, auth, artifact, and webhook findings are fixed;
- runner hosts are isolated from the control plane and do not expose secrets to untrusted jobs;
- Docker socket access is removed, isolated to disposable runner hosts, or replaced with a safer runner control plane;
- runtime isolation has been validated by the external reviewer;
- alerting and incident response paths are documented.

## Reviewer Output

Request a report containing:

- executive summary;
- scope and methodology;
- environment tested;
- findings with severity and reproduction steps;
- fixed/accepted/deferred status;
- final launch recommendation.
