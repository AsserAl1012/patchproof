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
2. maps the installation/repo to a project;
3. creates a queued run;
4. posts a queued comment when credentials are configured;
5. posts a completion comment after the runner stores the certificate.

Optional patch PR creation is controlled by the org/project GitHub apply-patch policy. The current engine emits function-level diffs, so PatchProof opens a controlled branch containing the generated patch artifact unless a project-specific source-file workflow is added.
