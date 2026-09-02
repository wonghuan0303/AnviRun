[CmdletBinding()]
param(
  [string]$RepositoryRoot,
  [string]$PostgresContainer = 'buildplatform-postgres-t11',
  [int]$PostgresPort = 54329,
  [string]$PostgresUser = 'buildplatform',
  [int]$ServerPort = 0
)

$ErrorActionPreference = 'Stop'
$repo = if ($RepositoryRoot) {
  (Resolve-Path -LiteralPath $RepositoryRoot).Path
} else {
  (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory)][string]$Command,
    [Parameter(Mandatory)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

function New-RandomSecret {
  $bytes = New-Object byte[] 48
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes).Replace('+', 'A').Replace('/', 'B').TrimEnd('=')
}

function Wait-ServerReady {
  param([Parameter(Mandatory)][string]$Url, [Parameter(Mandatory)][System.Diagnostics.Process]$Process)
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($Process.HasExited) { throw 'E2E Server exited before readiness' }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "$Url/health/ready" -TimeoutSec 3
      if ($response.StatusCode -eq 200) { return }
    } catch {
      # Keep polling while the compiled Server starts and opens its port.
    }
    Start-Sleep -Milliseconds 250
  }
  throw 'E2E Server did not become ready'
}

foreach ($tool in @('docker', 'node', 'pnpm', 'git')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "Required tool is not available: $tool"
  }
}

$suffix = [guid]::NewGuid().ToString('N')
$databaseName = "buildplatform_e2e_$suffix"
$runRoot = Join-Path ([IO.Path]::GetTempPath()) "buildplatform-e2e-$suffix"
$workspaceRoot = Join-Path $runRoot 'agent-workspace'
$artifactRoot = Join-Path $runRoot 'artifacts'
$taskLogRoot = Join-Path $runRoot 'task-logs'
$webRoot = Join-Path $runRoot 'web'
$gitFixtureRoot = Join-Path $runRoot 'git-fixture'
$agentConfigPath = Join-Path $runRoot 'build-agent.toml'
$agentLogPath = Join-Path $runRoot 'agent.log'
$serverStdout = Join-Path $runRoot 'server.stdout.log'
$serverStderr = Join-Path $runRoot 'server.stderr.log'
$serverProcess = $null
$databaseCreated = $false
$databaseUrl = $null

if ($ServerPort -le 0) { $ServerPort = 31000 + (Get-Random -Minimum 0 -Maximum 1000) }
if ($ServerPort -gt 65535) { throw 'ServerPort is invalid' }

try {
  New-Item -ItemType Directory -Force -Path $runRoot, $workspaceRoot, $artifactRoot, $taskLogRoot, $webRoot, $gitFixtureRoot | Out-Null

  $dbExistsQuery = "SELECT 1 FROM pg_database WHERE datname = '$databaseName'"
  $dbExistsOutput = & docker exec $PostgresContainer psql -U $PostgresUser -d postgres -tAc $dbExistsQuery
  $dbExists = ($dbExistsOutput -join '').Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Could not query the PostgreSQL container' }
  if ($dbExists) { throw 'Generated E2E database name already exists' }
  Invoke-Checked 'docker' @('exec', $PostgresContainer, 'psql', '-U', $PostgresUser, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', "CREATE DATABASE `"$databaseName`" OWNER `"$PostgresUser`"")
  $databaseCreated = $true

  $databasePassword = if ($env:BUILDPLATFORM_POSTGRES_PASSWORD) { $env:BUILDPLATFORM_POSTGRES_PASSWORD } else { 'buildplatform_dev_only' }
  $encodedPassword = [Uri]::EscapeDataString($databasePassword)
  $databaseUrl = "postgresql://$PostgresUser`:$encodedPassword@127.0.0.1`:$PostgresPort/$databaseName"
  $env:DATABASE_URL = $databaseUrl
  $env:NODE_ENV = 'production'
  $env:ALLOW_INSECURE_HTTP = 'true'
  $env:AUTH_COOKIE_SECURE = 'false'
  $env:AUTH_COOKIE_NAME = 'e2e_refresh'
  $env:AUTH_CSRF_COOKIE_NAME = 'e2e_csrf'
  $env:AUTH_COOKIE_SAME_SITE = 'strict'
  $env:ACCESS_TOKEN_SECRET = New-RandomSecret
  $env:REFRESH_TOKEN_HASH_SECRET = New-RandomSecret
  $env:TOKEN_ISSUER = 'buildplatform-t6-4-e2e'
  $env:TOKEN_AUDIENCE = 'buildplatform-t6-4-e2e-web'
  $env:SERVER_HOST = '127.0.0.1'
  $env:SERVER_PORT = [string]$ServerPort
  $env:TASK_LOG_ROOT = $taskLogRoot
  $env:ARTIFACT_STORAGE_ROOT = $artifactRoot
  $env:WEB_STATIC_ROOT = $webRoot
  $env:E2E_ADMIN_PASSWORD = "E2E administrator password $([guid]::NewGuid().ToString('N'))"

  $webDist = Join-Path $repo 'apps\web\dist'
  if (-not (Test-Path -LiteralPath (Join-Path $webDist 'index.html') -PathType Leaf)) { throw 'Web build output is missing index.html' }
  foreach ($entry in Get-ChildItem -LiteralPath $webDist -Force) {
    Copy-Item -LiteralPath $entry.FullName -Destination $webRoot -Recurse -Force
  }

  Invoke-Checked 'pnpm' @('--filter', '@buildplatform/server', 'run', 'db:migrate:deploy')

  $nodePath = (Get-Command node).Source
  $serverEntry = Join-Path $repo 'apps\server\dist\main.js'
  if (-not (Test-Path -LiteralPath $serverEntry -PathType Leaf)) { throw 'Compiled Server entry is missing' }
  $serverProcess = Start-Process -FilePath $nodePath -ArgumentList @($serverEntry) -WorkingDirectory $repo -RedirectStandardOutput $serverStdout -RedirectStandardError $serverStderr -PassThru -WindowStyle Hidden
  $baseUrl = "http://127.0.0.1:$ServerPort"
  Wait-ServerReady -Url $baseUrl -Process $serverProcess

  $agentExecutable = Join-Path $repo 'agent\target\x86_64-pc-windows-msvc\release\build-agent.exe'
  if (-not (Test-Path -LiteralPath $agentExecutable -PathType Leaf)) { throw 'Windows x64 Agent release executable is missing' }
  $fixtureSource = Join-Path $repo 'deploy\windows\e2e-fixture\build-fixture.mjs'
  $adminCli = Join-Path $repo 'apps\server\dist\cli\init-admin.js'
  foreach ($requiredFile in @($agentExecutable, $fixtureSource, $adminCli)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) { throw "E2E input is missing: $requiredFile" }
  }

  $env:E2E_BASE_URL = $baseUrl
  $env:E2E_DATABASE_URL = $databaseUrl
  $env:E2E_RUN_ROOT = $runRoot
  $env:E2E_FIXTURE_SOURCE = $fixtureSource
  $env:E2E_GIT_FIXTURE = $gitFixtureRoot
  $env:E2E_AGENT_EXECUTABLE = $agentExecutable
  $env:E2E_AGENT_CONFIG = $agentConfigPath
  $env:E2E_AGENT_LOG = $agentLogPath
  $env:E2E_ADMIN_CLI = $adminCli
  $env:E2E_REFRESH_COOKIE_NAME = 'e2e_refresh'
  $env:E2E_CSRF_COOKIE_NAME = 'e2e_csrf'

  Invoke-Checked $nodePath @((Join-Path $repo 'deploy\windows\e2e.mjs'))
  Write-Output 'T6.4 real Server + Rust Agent + PostgreSQL E2E passed.'
}
finally {
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    $serverProcess.WaitForExit(5000)
  }
  if ($databaseCreated -and $databaseName -match '^buildplatform_e2e_[0-9a-f]{32}$' -and $databaseName -ne 'buildplatform_dev') {
    & docker exec $PostgresContainer psql -U $PostgresUser -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS `"$databaseName`" WITH (FORCE)" | Out-Null
  }
  if (Test-Path -LiteralPath $runRoot) {
    Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
