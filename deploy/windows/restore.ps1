[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BackupDirectory,
  [Parameter(Mandatory)][string]$TargetDatabaseName,
  [Parameter(Mandatory)][string]$TargetArtifactDirectory,
  [Parameter(Mandatory)][string]$TargetTaskLogDirectory,
  [string]$PostgresContainer = 'buildplatform-postgres-t11',
  [string]$DatabaseUser = 'buildplatform'
)

$ErrorActionPreference = 'Stop'
$backupRoot = (Resolve-Path -LiteralPath $BackupDirectory).Path
$manifestPath = Join-Path $backupRoot 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'manifest.json is missing' }
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($TargetDatabaseName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw 'TargetDatabaseName is invalid' }
if ($DatabaseUser -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw 'DatabaseUser is invalid' }
if ($TargetDatabaseName -ieq 'buildplatform_dev') {
  throw 'Restoring into buildplatform_dev is not allowed by this script'
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory)][string]$Command,
    [Parameter(Mandatory)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

$tarCommand = Get-Command tar.exe -ErrorAction SilentlyContinue
if (-not $tarCommand) { throw 'Windows tar.exe is required for restore' }
$tarPath = $tarCommand.Source

function Assert-SafeArchivePath {
  param([Parameter(Mandatory)][string]$Name)
  if ([string]::IsNullOrWhiteSpace($Name)) { throw 'Archive contains an empty path' }
  foreach ($character in $Name.ToCharArray()) {
    if ([char]::IsControl($character)) { throw 'Archive contains a control character in a path' }
  }
  $normalized = $Name.Replace('\', '/')
  if ($normalized.StartsWith('/') -or $normalized.StartsWith('//') -or
      $normalized -match '^[A-Za-z]:') {
    throw 'Archive contains an absolute or drive-qualified path'
  }
  $segments = $normalized.Split('/', [StringSplitOptions]::RemoveEmptyEntries)
  if ($segments | Where-Object { $_ -eq '..' }) {
    throw 'Archive contains a parent traversal path'
  }
}

function Get-ManifestFile {
  param([Parameter(Mandatory)][string]$Name)
  Assert-SafeArchivePath $Name
  if ([IO.Path]::GetFileName($Name) -ne $Name -or [string]::IsNullOrWhiteSpace($Name)) {
    throw 'Backup manifest contains an invalid file name'
  }
  $path = Join-Path $backupRoot $Name
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Backup file is missing' }
  $resolved = (Resolve-Path -LiteralPath $path).Path
  $rootWithSeparator = $backupRoot.TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($rootWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Backup manifest file escapes the backup directory'
  }
  return $resolved
}

function Assert-Hash {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Expected
  )
  if ($Expected -notmatch '^[0-9a-fA-F]{64}$') { throw 'Backup manifest contains an invalid hash' }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  if ($actual -ne $Expected.ToUpperInvariant()) { throw 'Backup file hash verification failed' }
}

function Get-ValidatedEmptyTarget {
  param([Parameter(Mandatory)][string]$Path)
  $full = [IO.Path]::GetFullPath($Path)
  if (Test-Path -LiteralPath $full) {
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw 'Restore target is not a directory' }
    $item = Get-Item -Force -LiteralPath $full
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Restore target cannot be a reparse point'
    }
    if (@(Get-ChildItem -Force -LiteralPath $full).Count -ne 0) { throw 'Restore target must be empty' }
    return [pscustomobject]@{ Path = $full; Created = $false }
  }
  return [pscustomobject]@{ Path = $full; Created = $true }
}

function Assert-ArchiveSafety {
  param([Parameter(Mandatory)][string]$Archive)
  $listing = @(& $tarPath '-tf' $Archive 2>$null)
  $listingExitCode = $LASTEXITCODE
  if ($listingExitCode -ne 0) { throw 'Unable to inspect backup archive' }
  foreach ($entry in $listing) {
    Assert-SafeArchivePath ([string]$entry)
  }

  # tar verbose listings begin with the entry type. Reject links before extraction;
  # these backups contain ordinary files and directories only.
  $verboseListing = @(& $tarPath '-tvf' $Archive 2>$null)
  $verboseExitCode = $LASTEXITCODE
  if ($verboseExitCode -ne 0) { throw 'Unable to inspect backup archive entry types' }
  foreach ($line in $verboseListing) {
    if ($line.Length -gt 0 -and $line[0] -in @('l', 'h')) {
      throw 'Archive links are not accepted during restore'
    }
  }
}

function Assert-ExtractedTreeSafety {
  param([Parameter(Mandatory)][string]$Root)
  $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  foreach ($entry in @(Get-ChildItem -Force -Recurse -LiteralPath $Root)) {
    $resolvedEntry = [IO.Path]::GetFullPath($entry.FullName)
    if (-not $resolvedEntry.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Extracted archive entry escapes the temporary directory'
    }
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Extracted archive links or reparse points are not accepted'
    }
  }
}

function Expand-ArchiveToTemporary {
  param([Parameter(Mandatory)][string]$Archive)
  $temporary = Join-Path ([IO.Path]::GetTempPath()) "buildplatform-restore-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $temporary | Out-Null
  try {
    Assert-ArchiveSafety $Archive
    Invoke-Checked $tarPath @('-xzf', $Archive, '-C', $temporary)
    Assert-ExtractedTreeSafety $temporary
    return $temporary
  }
  catch {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    throw
  }
}

function Move-StagedTree {
  param(
    [Parameter(Mandatory)][string]$Stage,
    [Parameter(Mandatory)][pscustomobject]$Target
  )
  $moved = [Collections.Generic.List[string]]::new()
  $createdNow = $false
  try {
    if ($Target.Created) {
      New-Item -ItemType Directory -Force -Path $Target.Path | Out-Null
      $createdNow = $true
    }
    foreach ($entry in @(Get-ChildItem -Force -LiteralPath $Stage)) {
      $destination = Join-Path $Target.Path $entry.Name
      Move-Item -LiteralPath $entry.FullName -Destination $Target.Path
      [void]$moved.Add($destination)
    }
    return [pscustomobject]@{ Target = $Target; Moved = @($moved); CreatedNow = $createdNow }
  }
  catch {
    foreach ($path in @($moved)) {
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
    if ($createdNow -and (Test-Path -LiteralPath $Target.Path) -and
        @(Get-ChildItem -Force -LiteralPath $Target.Path).Count -eq 0) {
      Remove-Item -LiteralPath $Target.Path -Force
    }
    throw
  }
}

function Undo-MovedTree {
  param([Parameter(Mandatory)][pscustomobject]$Record)
  foreach ($path in @($Record.Moved)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
  }
  if ($Record.CreatedNow -and (Test-Path -LiteralPath $Record.Target.Path) -and
      @(Get-ChildItem -Force -LiteralPath $Record.Target.Path).Count -eq 0) {
    Remove-Item -LiteralPath $Record.Target.Path -Force
  }
}

$databaseFile = Get-ManifestFile $manifest.databaseBackupFile
$artifactFile = Get-ManifestFile $manifest.artifactArchiveFile
$taskLogFile = Get-ManifestFile $manifest.taskLogArchiveFile
Assert-Hash $databaseFile $manifest.files.database
Assert-Hash $artifactFile $manifest.files.artifacts
Assert-Hash $taskLogFile $manifest.files.taskLogs
# Inspect every archive before creating the target database or writing target directories.
Assert-ArchiveSafety $artifactFile
Assert-ArchiveSafety $taskLogFile
$artifactTarget = Get-ValidatedEmptyTarget $TargetArtifactDirectory
$taskLogTarget = Get-ValidatedEmptyTarget $TargetTaskLogDirectory
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'docker is not available' }
$runningOutput = & docker inspect -f '{{.State.Running}}' $PostgresContainer 2>$null
$running = (@($runningOutput) -join '').Trim()
if ($running -ne 'true') { throw 'PostgreSQL Docker container is not running' }

$remoteDump = "/tmp/buildplatform-restore-$([guid]::NewGuid().ToString('N')).dump"
$tempDirectories = [Collections.Generic.List[string]]::new()
$moveRecords = [Collections.Generic.List[object]]::new()
$databaseCreated = $false
try {
  $databaseOutput = & docker exec $PostgresContainer psql -U $DatabaseUser -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$TargetDatabaseName'" 2>$null
  $databaseExists = (@($databaseOutput) -join '').Trim()
  if ($databaseExists -eq '1') { throw 'Target database already exists; choose a new database name' }

  $createSql = "CREATE DATABASE `"$TargetDatabaseName`" OWNER `"$DatabaseUser`""
  Invoke-Checked 'docker' @('exec', $PostgresContainer, 'psql', '-U', $DatabaseUser, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', $createSql)
  $databaseCreated = $true
  Invoke-Checked 'docker' @('cp', $databaseFile, "$PostgresContainer`:$remoteDump")
  Invoke-Checked 'docker' @('exec', $PostgresContainer, 'pg_restore', '--exit-on-error', '--no-owner', '--username', $DatabaseUser, '--dbname', $TargetDatabaseName, $remoteDump)

  $artifactStage = Expand-ArchiveToTemporary $artifactFile
  [void]$tempDirectories.Add($artifactStage)
  $taskLogStage = Expand-ArchiveToTemporary $taskLogFile
  [void]$tempDirectories.Add($taskLogStage)
  [void]$moveRecords.Add((Move-StagedTree $artifactStage $artifactTarget))
  [void]$moveRecords.Add((Move-StagedTree $taskLogStage $taskLogTarget))

  Write-Output "Restore completed: database=$TargetDatabaseName"
}
catch {
  foreach ($record in @($moveRecords)) {
    try { Undo-MovedTree $record } catch { Write-Warning 'Failed to roll back restored files' }
  }
  if ($databaseCreated) {
    try {
      Invoke-Checked 'docker' @('exec', $PostgresContainer, 'psql', '-U', $DatabaseUser, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', "DROP DATABASE `"$TargetDatabaseName`"")
    }
    catch {
      Write-Warning 'Failed to remove the isolated database created by this restore attempt'
    }
  }
  throw
}
finally {
  & docker exec $PostgresContainer rm -f $remoteDump 2>$null | Out-Null
  foreach ($temporary in @($tempDirectories)) {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
  }
}
