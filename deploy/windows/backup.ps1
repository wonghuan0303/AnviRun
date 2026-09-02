[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$OutputDirectory,
  [string]$PostgresContainer = 'buildplatform-postgres-t11',
  [string]$DatabaseName = 'buildplatform_dev',
  [string]$DatabaseUser = 'buildplatform',
  [Parameter(Mandatory)][string]$ArtifactDirectory,
  [Parameter(Mandatory)][string]$TaskLogDirectory
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$outputRoot = (New-Item -ItemType Directory -Force -Path $OutputDirectory).FullName
$artifactRoot = (Resolve-Path -LiteralPath $ArtifactDirectory).Path
$taskLogRoot = (Resolve-Path -LiteralPath $TaskLogDirectory).Path
if (-not (Test-Path -LiteralPath $artifactRoot -PathType Container)) { throw 'Artifact directory is not available' }
if (-not (Test-Path -LiteralPath $taskLogRoot -PathType Container)) { throw 'Task log directory is not available' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'docker is not available' }
$tarCommand = Get-Command tar.exe -ErrorAction SilentlyContinue
if (-not $tarCommand) { throw 'Windows tar.exe is required for large data backups' }
$tarPath = $tarCommand.Source

$runningOutput = & docker inspect -f '{{.State.Running}}' $PostgresContainer 2>$null
$running = (@($runningOutput) -join '').Trim()
if ($running -ne 'true') { throw 'PostgreSQL Docker container is not running' }

function Invoke-Checked {
  param(
    [Parameter(Mandatory)][string]$Command,
    [Parameter(Mandatory)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$backupDirectory = Join-Path $outputRoot "buildplatform-backup-$stamp-$([guid]::NewGuid().ToString('N'))"
$remoteDump = "/tmp/buildplatform-pg-$([guid]::NewGuid().ToString('N')).dump"
$dbFileName = 'database.dump'
$artifactFileName = 'artifacts.tar.gz'
$taskLogFileName = 'task-logs.tar.gz'
$databaseFile = Join-Path $backupDirectory $dbFileName
$artifactFile = Join-Path $backupDirectory $artifactFileName
$taskLogFile = Join-Path $backupDirectory $taskLogFileName
$manifestFile = Join-Path $backupDirectory 'manifest.json'

try {
  New-Item -ItemType Directory -Path $backupDirectory | Out-Null
  Invoke-Checked 'docker' @('exec', $PostgresContainer, 'pg_dump', '--format=custom', '--no-owner', "--file=$remoteDump", "--dbname=$DatabaseName", "--username=$DatabaseUser")
  Invoke-Checked 'docker' @('cp', "$PostgresContainer`:$remoteDump", $databaseFile)

  # Windows tar preserves hidden files, empty directories, and relative paths without
  # loading the source tree into PowerShell memory.
  Invoke-Checked $tarPath @('-C', $artifactRoot, '-czf', $artifactFile, '.')
  Invoke-Checked $tarPath @('-C', $taskLogRoot, '-czf', $taskLogFile, '.')

  $gitCommit = $null
  if (Get-Command git -ErrorAction SilentlyContinue) {
    $candidate = (& git -C $repo rev-parse HEAD 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -eq 0 -and $candidate) { $gitCommit = $candidate.Trim() }
  }

  $manifest = [ordered]@{
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    databaseName = $DatabaseName
    databaseBackupFile = $dbFileName
    artifactArchiveFile = $artifactFileName
    taskLogArchiveFile = $taskLogFileName
    gitCommit = $gitCommit
    files = [ordered]@{
      database = (Get-FileHash -LiteralPath $databaseFile -Algorithm SHA256).Hash
      artifacts = (Get-FileHash -LiteralPath $artifactFile -Algorithm SHA256).Hash
      taskLogs = (Get-FileHash -LiteralPath $taskLogFile -Algorithm SHA256).Hash
    }
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestFile -Encoding utf8
  Write-Output "Backup created: $backupDirectory"
}
catch {
  if (Test-Path -LiteralPath $backupDirectory) {
    Remove-Item -LiteralPath $backupDirectory -Recurse -Force
  }
  throw
}
finally {
  & docker exec $PostgresContainer rm -f $remoteDump 2>$null | Out-Null
}
