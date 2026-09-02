[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$EnvironmentFile
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$environmentPath = (Resolve-Path -LiteralPath $EnvironmentFile).Path

function Import-EnvironmentFile {
  param([Parameter(Mandatory)][string]$Path)

  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $separator = $trimmed.IndexOf('=')
    if ($separator -le 0) { throw "Invalid environment entry in configuration file" }
    $name = $trimmed.Substring(0, $separator).Trim()
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Invalid environment variable name" }
    $value = $trimmed.Substring($separator + 1).Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    Set-Item -LiteralPath "Env:$name" -Value $value
  }
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory)][string]$Command,
    [Parameter(Mandatory)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

Import-EnvironmentFile $environmentPath
if (-not $env:DATABASE_URL) { throw 'DATABASE_URL is required in the environment file' }

Push-Location $repo
try {
  Invoke-Checked 'pnpm' @('--filter', '@buildplatform/server', 'run', 'db:migrate:deploy')
  & pnpm --filter '@buildplatform/server' run start
  if ($LASTEXITCODE -ne 0) { throw "Server exited with code $LASTEXITCODE" }
}
finally {
  Pop-Location
}
