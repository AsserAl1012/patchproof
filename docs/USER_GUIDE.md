# PatchProof User Guide

## Language Support

PatchProof supports standalone named JavaScript and Python functions.

Python input uses:

```json
{
  "language": "python",
  "source": "def increment(value):\n    return value",
  "tests": [{ "name": "increments", "args": [1], "expect": 2 }],
  "precondition": "isinstance(args[0], int)",
  "mayChange": "True",
  "postcondition": "result == args[0] + 1"
}
```

Python support currently accepts exactly one named function, JSON-compatible arguments and results, normal built-in exceptions such as `ValueError`, and Python expressions for the behavioral envelope. Imports, decorators, classes, filesystem/network APIs, private attributes, and unsafe dynamic builtins are rejected. Use the CLI or server; browser-side verification is disabled.

## Purpose

PatchProof is a private bug-repair and verification workbench. It does not merely show a code suggestion. It shows candidate patches and a certificate explaining what was tested, what behavior was preserved, and what remains uncertain.

## Running The App

From the project directory:

```powershell
npm start
```

Open:

```text
http://127.0.0.1:4173
```

To verify the build:

```powershell
npm run check
npm test
npm run smoke
```

CLI usage:

```powershell
node bin/patchproof.js scenarios
node bin/patchproof.js init --repo path/to/project
node bin/patchproof.js doctor --repo path/to/project
node bin/patchproof.js run --scenario clamp-range --out certificate.json
node bin/patchproof.js inspect --repo path/to/project
node bin/patchproof.js targets --repo path/to/project
node bin/patchproof.js test --repo path/to/project
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

## Main Screen

### Bug Lab

The left rail contains bundled scenarios. Select a scenario to load a buggy function, tests, and a behavioral envelope.

### Function Under Repair

This editor contains one named JavaScript function:

```js
function clamp(value, min, max) {
  if (value < min) return min;
  if (value > min) return max;
  return value;
}
```

The direct editor expects one named function. Repository targets can also extract common JavaScript/TypeScript declarations, exported functions, const function expressions, arrow functions, object methods, and class methods into a function-level verifier input.

### Executable Tests

Tests are JSON:

```json
[
  { "name": "in range is preserved", "args": [6, 0, 10], "expect": 6 }
]
```

Each test has:

- `name`: human-readable label.
- `args`: array passed to the function.
- `expect`: expected return value.
- `expectError`: optional substring expected in a thrown error.

At least one test must fail before repair. If all tests already pass, PatchProof refuses certification because there is no observed bug evidence.

### Behavioral Envelope

The envelope scopes the proof.

`Precondition` filters generated inputs. Example:

```js
args[1] <= args[2]
```

`May-change predicate` marks inputs where old and new behavior are allowed to differ. Example:

```js
args[0] > args[1] && args[0] < args[2]
```

`Postcondition` defines the intended behavior after repair. Example:

```js
result === Math.min(Math.max(args[0], args[1]), args[2])
```

The expressions can reference:

- `args`: the generated argument array.
- `result`: the patched function return value.
- `observation`: structured execution result.

## Buttons

- `Run PatchProof`: generate and validate candidate patches.
- `Run Project`: queue the current repair input as a durable project run.
- `Apply Patch`: copy the selected candidate source into the editor.
- `Reset Scenario`: restore the selected scenario.
- `Copy Certificate`: copy JSON certificate to clipboard.
- `Download Certificate`: save the certificate as a `.json` file.
- `Saved Runs`: automatically stores recent certificates in local browser storage.
- `Export`: downloads saved run history.
- `Import Certificate`: loads a certificate or exported history file.
- `Cancel Selected Run`: cancels the selected queued/running project run from the operations panel.

## Private SaaS Dashboard

1. Bootstrap the owner account.
2. Create a project for a repository or manual codebase.
3. Optionally link GitHub with installation id and `owner/repo`.
4. Click `Run Project`.
5. The run moves through queued/running/terminal states.
6. Inspect stored logs, runner metadata, audit events, and the certificate.

Production mode stores SaaS state in Postgres, queues jobs in Redis, and stores certificates/logs/diffs in S3-compatible object storage.

Run retention cleanup when you want to enforce configured data-retention windows:

```powershell
node bin/patchproof.js retention --dry-run
node bin/patchproof.js retention
```

Owners/admins can also call `POST /api/admin/retention` with `{ "dryRun": true }`.

Cancel a queued/running run from the dashboard or API:

```text
POST /api/v1/runs/:id/cancel
```

Reconcile stale running jobs after a runner crash:

```powershell
node bin/patchproof.js reconcile --stale-minutes 30 --apply
```

The stable API is available under `/api/v1`; OpenAPI metadata is served at `/api/v1/openapi.json`.

## Reading Results

### Candidate Patches

Each candidate shows:

- accepted or rejected;
- explicit test pass count;
- mutation score;
- evidence score;
- rejection reasons if relevant.

Click any candidate to inspect its diff.

### Certificate

The certificate contains:

- `status`: `certified` or `rejected`;
- `runId`: deterministic hash of source, tests, and envelope;
- `verifierVersion`: PatchProof verifier version;
- `bugEvidence`: failing tests before repair;
- `selectedPatch`: chosen patch and rejection reasons if any;
- `validation`: tests, preservation checks, postcondition checks, bounded proof, mutation score;
- `behavioralEnvelope`: exact proof scope;
- `residualRisk`: limitations for this run.
- `proof`: optional Ed25519 issuer signature metadata when certificate signing is configured.

### Validation Console

The console gives a short run trace:

```text
Baseline: 4/5 tests passed before repair.
Generated finite behavioral envelope with 977 input combinations.
p1: accepted; tests=5/5; preserve_cex=0; post_cex=0; mutation=1.00; score=0.93
Selected p1 with evidence score 0.93.
```

## How To Create Your Own Scenario

1. Pick a deterministic JavaScript function.
2. Write at least one currently failing test.
3. Add passing tests for behavior that must remain stable.
4. Add a precondition to keep generated inputs meaningful.
5. Add a may-change predicate for the bug region.
6. Add a postcondition for intended repaired behavior.
7. Click `Run PatchProof`.
8. Inspect the certificate before applying the patch.

## Repository Targets

PatchProof can map files from a repository checkout into the same function-level input format used by the CLI and web app. The repository adapter reads a source file, extracts one named JavaScript or Python function, and builds verifier input from either JSON PatchProof tests or conservative framework-test extraction.

Inspect a checkout before writing targets:

```powershell
node bin/patchproof.js inspect --repo path/to/project
```

The inspector reports git branch/commit, package manager, detected languages, likely test frameworks, supported framework adapters, test commands, candidate source files, candidate test files, and existing PatchProof targets. Use `--json` for machine-readable output.

Generate a starter config:

```powershell
node bin/patchproof.js init --repo path/to/project
```

Check whether the project is ready:

```powershell
node bin/patchproof.js doctor --repo path/to/project
```

`doctor` validates the PatchProof config, target source/test paths, framework extraction, detected test commands, and Python availability when the project needs Python.

Create `patchproof.yml` in the repository you want to test:

```yaml
version: 1
project:
  language: javascript
  testCommand: npm test
  allowedPaths:
    - src/**
    - tests/**
  forbiddenPaths:
    - .env
    - secrets/**
targets:
  clamp-range:
    source: src/clamp.js
    function: clamp
    tests: tests/clamp.patchproof.json
    bugReport: Upper guard compares value to min instead of max.
    precondition: args[1] <= args[2]
    mayChange: args[0] > args[1] && args[0] < args[2]
    postcondition: result === Math.min(Math.max(args[0], args[1]), args[2])
```

The test file is a JSON array:

```json
[
  { "name": "below min", "args": [-5, 0, 10], "expect": 0 },
  { "name": "above max", "args": [12, 0, 10], "expect": 10 },
  { "name": "in range", "args": [6, 0, 10], "expect": 6 }
]
```

List configured targets:

```powershell
node bin/patchproof.js targets --repo path/to/project
```

Run one target:

```powershell
node bin/patchproof.js run --repo path/to/project --target clamp-range --out certificate.json
```

Apply an accepted certified patch back to the source file:

```powershell
node bin/patchproof.js run --repo path/to/project --target clamp-range --out certificate.json --apply
```

Apply and then run the repository's configured project test command:

```powershell
node bin/patchproof.js run --repo path/to/project --target clamp-range --out certificate.json --apply --verify-command
```

Run the configured project test command directly:

```powershell
node bin/patchproof.js test --repo path/to/project
node bin/patchproof.js test --repo path/to/project --command "npm test"
```

`patchproof test` runs `project.testCommand`, a target-level `testCommand`, or an explicit `--command` from the repository root with `CI=true`. It is intended to validate the real project test suite after PatchProof applies a certified function-level patch.

Or apply a saved certificate:

```powershell
node bin/patchproof.js apply --certificate certificate.json --repo path/to/project --target clamp-range --dry-run
node bin/patchproof.js apply --certificate certificate.json --repo path/to/project --target clamp-range
```

Patch application is deliberately narrow. PatchProof replaces only the configured target function, refuses rejected certificates, and refuses to apply when the current source no longer matches the certificate replay input.

Framework-backed targets can use simple literal assertions from Jest, Vitest, node:test, or pytest:

```yaml
targets:
  clamp-range:
    source: src/clamp.js
    function: clamp
    framework: vitest
    frameworkTests: tests/clamp.test.js
    bugReport: Upper guard compares value to min instead of max.
    precondition: args[1] <= args[2]
    mayChange: args[0] > args[1] && args[0] < args[2]
    postcondition: result === Math.min(Math.max(args[0], args[1]), args[2])
```

Supported assertion shapes include direct literal cases such as:

```js
expect(clamp(6, 0, 10)).toBe(6);
assert.equal(clamp(6, 0, 10), 6);
```

```python
assert clamp(6, 0, 10) == 6
```

JavaScript and Python framework extraction is AST-backed, but intentionally conservative. PatchProof ignores complex framework tests that use variables, mocks, snapshots, async flows, custom matchers, or non-literal expected values. Those tests should be converted to `.patchproof.json` for now.

For Python targets, set `project.language: python` or `language: python` on the target and use Python expressions in the envelope:

```yaml
targets:
  clamp-range:
    language: python
    source: src/ranges.py
    function: clamp
    tests: tests/clamp.patchproof.json
    precondition: args[1] <= args[2]
    mayChange: args[0] > args[1] and args[0] < args[2]
    postcondition: result == min(max(args[0], args[1]), args[2])
```

Path safety is enforced with `allowedPaths` and `forbiddenPaths`. Source and test paths must stay inside the repository root.

## Model Candidates In Local CLI Runs

Local CLI runs use local repair templates by default. To add model-generated candidates, explicitly pass `--model` and configure a provider with CLI flags, environment variables, or `patchproof.yml`:

```powershell
node bin/patchproof.js run --repo . --target clamp-range --model --model-provider openai-compatible --model-base-url https://api.openai.com/v1 --model-name <model> --model-max-prompt-chars 20000
```

Credentials are read from `PATCHPROOF_MODEL_API_KEY` by default, or the env var named by `--model-api-key-env`. Model candidates are still treated as untrusted and must pass the same bounded verifier before they can be certified or applied.

Model settings also support `maxPromptChars`, `maxTokens`, and `maxCandidates`. PatchProof estimates prompt size before the call and refuses prompts above `maxPromptChars` so a repository target cannot accidentally send an unexpectedly large model request.

## What Makes A Strong Certificate

A strong certificate usually has:

- at least one failing test before repair;
- all tests passing after repair;
- a non-trivial finite domain;
- zero preservation counterexamples;
- zero postcondition counterexamples;
- high mutation score;
- clear residual risk.

## Replaying A Certificate

Certificates include `replay.input`, the exact source/tests/envelope snapshot required to rerun validation.

```powershell
node bin/patchproof.js verify certificate.json
```

Verification reproduces the run and compares run id, status, selected patch, evidence score, and finite-domain size. If the certificate includes `proof.signature` and `PATCHPROOF_CERTIFICATE_PUBLIC_KEY_PEM` is configured, verification also checks the issuer signature and payload hash.

To sign newly produced certificates, configure the API and runner with:

```text
PATCHPROOF_CERTIFICATE_PRIVATE_KEY_PEM=<Ed25519 private key PEM>
PATCHPROOF_CERTIFICATE_PUBLIC_KEY_PEM=<Ed25519 public key PEM>
PATCHPROOF_CERTIFICATE_ISSUER=<issuer name>
PATCHPROOF_CERTIFICATE_KEY_ID=<key id>
```

Use `patchproof keygen` to generate a compatible `PATCHPROOF_SECRET_KEY` plus Ed25519 private/public PEM values. Use `patchproof doctor --production` on the deployment host to verify Docker, services, release metadata, and signing-key configuration.

## Security Notes

PatchProof blocks obvious dangerous tokens such as `fetch`, `eval`, `Function`, `Worker`, `localStorage`, and `globalThis`, but token filtering is not a sandbox. Local quick-run mode and CLI runs use isolated runner processes; browser-side verification is disabled. Production project runs should use the queued Docker runner. Responses include `X-Request-ID`; set `PATCHPROOF_ACCESS_LOGS=json` for structured access logs. Do not expose PatchProof as an open hosted arbitrary-code execution service without stronger sandboxing and security review.

## Current Limitations

- No multi-file project repair yet; repository targets still extract one configured function-level target.
- Framework adapters only extract simple literal assertions into PatchProof tests. Use `patchproof test` or `run --apply --verify-command` to execute the repository's own Jest, Vitest, node:test, or pytest command after applying a certified patch.
- Python local repair templates cover common function-level bugs such as wrong upper-bound comparisons, slice/range off-by-one errors, whitespace slugification, missing increments, and returning `list.append(...)`.
- No symbolic solver yet; the bounded proof is finite-domain differential validation with deterministic property-style generated cases.
- Saved certificate history is local-only; project runs are persisted by the SaaS backend.
- No support for async functions, network, filesystem, DOM, or database behavior.
