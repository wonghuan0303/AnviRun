[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$outputRoot = (New-Item -ItemType Directory -Force -Path $OutputDirectory).FullName
foreach ($tool in @('cargo')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Required tool is not available: $tool" }
}

$cargoToml = Get-Content -Raw -LiteralPath (Join-Path $repo 'agent\Cargo.toml')
$versionMatch = [regex]::Match($cargoToml, '(?s)\[workspace\.package\].*?version\s*=\s*"([^"]+)"')
if (-not $versionMatch.Success) { throw 'Unable to determine Agent version' }
$version = $versionMatch.Groups[1].Value
$target = 'x86_64-pc-windows-msvc'
$agentSource = Join-Path $repo "agent\target\$target\release\build-agent.exe"
$exampleSource = Join-Path $repo 'agent\build-agent.toml.example'

function Invoke-Checked {
  param(
    [Parameter(Mandatory)][string]$Command,
    [Parameter(Mandatory)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

$stage = Join-Path ([IO.Path]::GetTempPath()) "buildplatform-agent-$([guid]::NewGuid().ToString('N'))"
$zipName = "build-agent-$version-windows-x64.zip"
$zipPath = Join-Path $outputRoot $zipName
$hashPath = "$zipPath.sha256"
if ((Test-Path -LiteralPath $zipPath) -or (Test-Path -LiteralPath $hashPath)) {
  throw 'Release package already exists; choose another output directory'
}

try {
  Invoke-Checked 'cargo' @('build', '--release', '--locked', '--target', $target, '--manifest-path', (Join-Path $repo 'agent\Cargo.toml'))
  if (-not (Test-Path -LiteralPath $agentSource -PathType Leaf)) { throw 'Windows Agent executable was not produced' }
  if (-not (Test-Path -LiteralPath $exampleSource -PathType Leaf)) { throw 'Agent configuration example is missing' }

  New-Item -ItemType Directory -Path $stage | Out-Null
  Copy-Item -LiteralPath $agentSource -Destination (Join-Path $stage 'build-agent.exe')
  Copy-Item -LiteralPath $exampleSource -Destination (Join-Path $stage 'build-agent.toml.example')
  @'
AnvilRun Agent Windows x64

Copy build-agent.toml.example to build-agent.toml and replace the one-time
registration token. Run build-agent.exe --config build-agent.toml in the
foreground. Do not put a token in command-line arguments or logs.
'@ | Set-Content -LiteralPath (Join-Path $stage 'README.txt') -Encoding utf8
  $version | Set-Content -LiteralPath (Join-Path $stage 'VERSION') -Encoding ascii

  & (Join-Path $stage 'build-agent.exe') '--version' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Packaged Agent version smoke test failed' }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal
  $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $zipName" | Set-Content -LiteralPath $hashPath -Encoding ascii
  Write-Output "Agent package created: $zipPath"
}
finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
