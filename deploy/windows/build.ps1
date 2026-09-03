[CmdletBinding()]
param(
  [string]$RepositoryRoot
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
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

foreach ($tool in @('node', 'pnpm', 'cargo')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "Required tool is not available: $tool"
  }
}

Push-Location $repo
try {
  Write-Output 'Checking tool versions...'
  Invoke-Checked 'node' @('--version')
  Invoke-Checked 'pnpm' @('--version')
  Invoke-Checked 'cargo' @('--version')

  Invoke-Checked 'pnpm' @('install', '--frozen-lockfile')
  Invoke-Checked 'pnpm' @('run', 'contracts:build')
  Invoke-Checked 'pnpm' @('--filter', '@anvilrun/server', 'run', 'build')
  Invoke-Checked 'pnpm' @('--filter', '@anvilrun/web', 'run', 'build')
  Invoke-Checked 'cargo' @('build', '--release', '--locked', '--manifest-path', 'agent/Cargo.toml')
  Write-Output 'Build completed.'
}
finally {
  Pop-Location
}
