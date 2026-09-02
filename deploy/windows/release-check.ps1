[CmdletBinding()]
param(
  [string]$RepositoryRoot,
  [string]$TestDatabaseUrl = $env:BUILDPLATFORM_TEST_DATABASE_URL,
  [string]$PostgresContainer = 'buildplatform-postgres-t11',
  [int]$PostgresPort = 54329,
  [string]$PostgresUser = 'buildplatform'
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
  Write-Output (">> " + $Command + ' ' + ($Arguments -join ' '))
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

foreach ($tool in @('node', 'pnpm', 'cargo', 'docker', 'git')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "Required tool is not available: $tool"
  }
}

if (-not $TestDatabaseUrl) {
  $TestDatabaseUrl = "postgresql://buildplatform:buildplatform_dev_only@127.0.0.1:$PostgresPort/buildplatform_test"
}
if ($TestDatabaseUrl -notmatch '/buildplatform_test(?:\?|$)') {
  throw 'Release checks require an isolated buildplatform_test database; buildplatform_dev is forbidden'
}

$hadDatabaseUrl = Test-Path -LiteralPath Env:DATABASE_URL
$previousDatabaseUrl = $env:DATABASE_URL
$packageRoot = Join-Path ([IO.Path]::GetTempPath()) "buildplatform-release-$([guid]::NewGuid().ToString('N'))"

try {
  Push-Location $repo
  $env:DATABASE_URL = $TestDatabaseUrl

  Invoke-Checked 'pnpm' @('install', '--frozen-lockfile')
  Invoke-Checked 'pnpm' @('--filter', '@buildplatform/server', 'run', 'db:generate')
  Invoke-Checked 'pnpm' @('--filter', '@buildplatform/server', 'run', 'db:migrate:deploy')
  Invoke-Checked 'pnpm' @('lint')
  Invoke-Checked 'pnpm' @('type-check')
  Invoke-Checked 'pnpm' @('test')
  Invoke-Checked 'pnpm' @('build')
  Invoke-Checked 'pnpm' @('db:test')

  & (Join-Path $repo 'deploy\windows\e2e.ps1') -RepositoryRoot $repo -PostgresContainer $PostgresContainer -PostgresPort $PostgresPort -PostgresUser $PostgresUser
  if ($LASTEXITCODE -ne 0) { throw "T6.4 E2E failed with exit code $LASTEXITCODE" }
  $env:DATABASE_URL = $TestDatabaseUrl

  Push-Location (Join-Path $repo 'agent')
  try {
    Invoke-Checked 'cargo' @('fmt', '--all', '--', '--check')
    Invoke-Checked 'cargo' @('clippy', '--all-targets', '--all-features', '--', '-D', 'warnings')
    Invoke-Checked 'cargo' @('test', '--all-features')
    Invoke-Checked 'cargo' @('build')
    Invoke-Checked 'cargo' @('build', '--release', '--locked', '--target', 'x86_64-pc-windows-msvc')
  }
  finally {
    Pop-Location
  }

  New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null
  & (Join-Path $repo 'deploy\windows\package-agent.ps1') -OutputDirectory $packageRoot
  if ($LASTEXITCODE -ne 0) { throw "Windows Agent package failed with exit code $LASTEXITCODE" }

  Invoke-Checked 'git' @('diff', '--check')
  Write-Output 'T6.4 release gate PASSED. No commit was created.'
}
catch {
  Write-Error $_
  exit 1
}
finally {
  if (Get-Location | Select-String -SimpleMatch $repo -Quiet) {
    Pop-Location
  }
  if (Test-Path -LiteralPath $packageRoot) {
    Remove-Item -LiteralPath $packageRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($hadDatabaseUrl) {
    $env:DATABASE_URL = $previousDatabaseUrl
  } else {
    Remove-Item -LiteralPath Env:DATABASE_URL -ErrorAction SilentlyContinue
  }
}
