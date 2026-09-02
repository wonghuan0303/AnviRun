[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ConfigPath,
  [string]$AgentExecutable
)

$ErrorActionPreference = 'Stop'
$config = (Resolve-Path -LiteralPath $ConfigPath).Path
if (-not $AgentExecutable) {
  $AgentExecutable = Join-Path $PSScriptRoot '..\..\agent\target\release\build-agent.exe'
}
$executable = (Resolve-Path -LiteralPath $AgentExecutable).Path
if ([IO.Path]::GetExtension($executable).ToLowerInvariant() -ne '.exe') {
  throw 'AgentExecutable must point to build-agent.exe'
}

Push-Location (Split-Path -Parent $executable)
try {
  & $executable '--config' $config
  if ($LASTEXITCODE -ne 0) { throw "Agent exited with code $LASTEXITCODE" }
}
finally {
  Pop-Location
}
