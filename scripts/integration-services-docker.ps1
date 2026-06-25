param(
  [string]$ProjectName = "patchproof-validation",
  [string]$RunnerImage = "patchproof:ci",
  [switch]$KeepServices
)

$ErrorActionPreference = "Stop"

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Command
  )
  Write-Host "==> $Name"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$networkName = "${ProjectName}_default"
$env:PATCHPROOF_SECRET_KEY = if ($env:PATCHPROOF_SECRET_KEY) { $env:PATCHPROOF_SECRET_KEY } else { "docker-validation-secret-key-32-bytes-minimum" }

try {
  Invoke-Step "Reset old validation services" {
    docker compose -p $ProjectName -f (Join-Path $repoRoot "compose.yml") down --volumes --remove-orphans
  }

  Invoke-Step "Build $RunnerImage" {
    docker build -t $RunnerImage $repoRoot
  }

  Invoke-Step "Start Postgres, Redis, and MinIO" {
    docker compose -p $ProjectName -f (Join-Path $repoRoot "compose.yml") up -d postgres redis minio minio-init
  }

  Invoke-Step "Wait for MinIO bucket initialization" {
    docker compose -p $ProjectName -f (Join-Path $repoRoot "compose.yml") up minio-init
  }

  Invoke-Step "Run service-backed integration in containerized Node/npm" {
    docker run --rm `
      --user 0:0 `
      --network $networkName `
      -v "${repoRoot}:/work" `
      -v "/var/run/docker.sock:/var/run/docker.sock" `
      -w /work `
      -e DATABASE_URL="postgres://patchproof:patchproof@postgres:5432/patchproof" `
      -e REDIS_URL="redis://redis:6379" `
      -e PATCHPROOF_REDIS_URL="redis://redis:6379" `
      -e PATCHPROOF_S3_ENDPOINT="http://minio:9000" `
      -e PATCHPROOF_S3_BUCKET="patchproof" `
      -e PATCHPROOF_S3_ACCESS_KEY_ID="patchproof" `
      -e PATCHPROOF_S3_SECRET_ACCESS_KEY="patchproof-password" `
      -e PATCHPROOF_S3_FORCE_PATH_STYLE="true" `
      -e PATCHPROOF_RUNNER_IMAGE=$RunnerImage `
      $RunnerImage `
      sh -lc "npm ci --no-audit --no-fund && npm run migrate && npm run integration:services"
  }
} finally {
  if (-not $KeepServices) {
    Invoke-Step "Stop validation services" {
      docker compose -p $ProjectName -f (Join-Path $repoRoot "compose.yml") down --volumes --remove-orphans
    }
  }
}
