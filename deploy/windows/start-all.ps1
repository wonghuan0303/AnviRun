[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$EnvironmentFile,
  [Parameter(Mandatory)][string]$ConfigPath,
  [string]$AgentExecutable,
  [string]$ServerUrl = 'http://127.0.0.1:3000'
)

$ErrorActionPreference = 'Stop'
$environmentPath = (Resolve-Path -LiteralPath $EnvironmentFile).Path
$config = (Resolve-Path -LiteralPath $ConfigPath).Path
$serverScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-server.ps1')).Path
$agentScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-agent.ps1')).Path
$healthScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'check-health.ps1')).Path
$pwsh = (Get-Command 'pwsh' -ErrorAction Stop).Source

function Start-DeploymentProcess {
  param([Parameter(Mandatory)][string[]]$Arguments)

  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $pwsh
  $info.UseShellExecute = $false
  foreach ($argument in $Arguments) { [void]$info.ArgumentList.Add($argument) }
  return [Diagnostics.Process]::Start($info)
}

$server = $null
$agent = $null
try {
  $server = Start-DeploymentProcess @('-NoProfile', '-File', $serverScript, '-EnvironmentFile', $environmentPath)

  $ready = $false
  foreach ($attempt in 1..30) {
    if ($server.HasExited) { throw "Server exited with code $($server.ExitCode)" }
    try {
      & $healthScript -ServerUrl $ServerUrl *> $null
      $ready = $true
      break
    }
    catch {
      Start-Sleep -Seconds 1
    }
  }
  if (-not $ready) { throw 'Server did not become ready within 30 seconds' }

  $agentArguments = @('-NoProfile', '-File', $agentScript, '-ConfigPath', $config)
  if ($AgentExecutable) {
    $agentArguments += @('-AgentExecutable', (Resolve-Path -LiteralPath $AgentExecutable).Path)
  }
  $agent = Start-DeploymentProcess $agentArguments
  Write-Output 'Server and Agent started. Press Ctrl+C to stop both.'

  while (-not $server.HasExited -and -not $agent.HasExited) {
    Start-Sleep -Seconds 1
  }
  if ($server.HasExited) { throw "Server exited with code $($server.ExitCode)" }
  throw "Agent exited with code $($agent.ExitCode)"
}
finally {
  foreach ($process in @($agent, $server)) {
    if ($process -and -not $process.HasExited) {
      $process.Kill($true)
      $process.WaitForExit()
    }
  }
}
