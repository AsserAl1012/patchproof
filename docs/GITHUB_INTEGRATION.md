# GitHub Integration

PatchProof includes a webhook endpoint:

```text
POST /api/integrations/github/webhook
```

Supported slash commands:

- `/patchproof verify`
- `/patchproof fix`
- `/patchproof explain`

Set the webhook secret with:

```text
PATCHPROOF_GITHUB_WEBHOOK_SECRET
```

Configure credentials with one of:

```text
PATCHPROOF_GITHUB_TOKEN
```

or GitHub App installation auth:

```text
PATCHPROOF_GITHUB_APP_ID
PATCHPROOF_GITHUB_PRIVATE_KEY
PATCHPROOF_GITHUB_WEBHOOK_SECRET
PATCHPROOF_PUBLIC_BASE_URL
```

Link a project to a repository from the dashboard or API:

```text
POST /api/projects/:id/integrations/github
```

Body:

```json
{
  "installationId": "12345",
  "fullName": "owner/repo"
}
```

When a mapped PR or issue receives a slash command, PatchProof:

1. verifies the webhook signature;
2. records the GitHub delivery ID and ignores duplicate deliveries;
3. maps the installation/repo to a project;
4. creates a queued run;
5. posts a queued comment when credentials are configured;
6. posts a completion comment after the runner stores the certificate.

Delivery dedupe records are retained for 30 days and are cleaned by `patchproof retention`.

Optional patch PR creation is controlled by the org/project GitHub apply-patch policy. When a caller supplies reviewed repository file updates to `POST /api/v1/runs/:id/apply-patch` with `mode: "github-pr"`, PatchProof opens a controlled branch and commits those file contents directly. If no reviewed file updates are supplied, it falls back to committing the generated `.patch` artifact under `patchproof-patches/`.
