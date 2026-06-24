# Security Policy

## Supported Versions

PatchProof private SaaS v0.4.x is the active self-hosted release line.

## Current Security Posture

PatchProof is intended for private/self-hosted deployments. Browser-side verification is disabled, project runs go through isolated runners, SaaS sessions use same-origin `HttpOnly` cookies, API keys and session tokens are stored as hashes, GitHub webhook deliveries are signature-checked and deduplicated, and certificates can be replayed or optionally issuer-signed with Ed25519 keys.

Do not expose anonymous arbitrary-code execution as a public multi-tenant service until sandboxing and tenant isolation have passed an independent security review.

## Reporting A Vulnerability

For a public repository, enable GitHub Security Advisories and publish a private security contact before broad distribution.

Do not file vulnerabilities containing private exploit details in public issues.
