[CmdletBinding()]
param(
  [string]$ServerUrl = 'http://127.0.0.1:3000'
)

$ErrorActionPreference = 'Stop'
$base = $ServerUrl.TrimEnd('/')

function Get-HealthPayload {
  param([Parameter(Mandatory)][string]$Uri)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 10
    return ($response.Content | ConvertFrom-Json)
  }
  catch {
    throw 'Health endpoint request failed'
  }
}

$live = Get-HealthPayload "$base/health/live"
if ($live.status -ne 'ok') { throw 'Liveness check failed' }
Write-Output 'live: ok'

$ready = Get-HealthPayload "$base/health/ready"
if ($ready.status -ne 'ok') { throw 'Readiness check failed' }
Write-Output 'ready: ok'
