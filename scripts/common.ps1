Set-StrictMode -Version 2.0

function Get-XiaodeProjectRoot {
  return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}

function Get-XiaodeBackendPath {
  return Join-Path (Get-XiaodeProjectRoot) 'web\backend'
}

function Assert-XiaodeRuntime {
  $backend = Get-XiaodeBackendPath
  if (!(Test-Path -LiteralPath (Join-Path $backend 'package.json') -PathType Leaf)) {
    throw "Backend directory is invalid: $backend"
  }
  if (!(Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js was not found in PATH.' }
  if (!(Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm was not found in PATH.' }
  return $backend
}

function Get-XiaodePortOwner {
  param([int]$Port)
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (!$connection) { return $null }
  $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
  return [pscustomobject]@{
    Port = $Port
    ProcessId = $connection.OwningProcess
    ProcessName = if ($process) { $process.ProcessName } else { 'unknown' }
    Path = if ($process) { $process.Path } else { $null }
  }
}

function Assert-XiaodePortAvailable {
  param([int]$Port)
  $owner = Get-XiaodePortOwner -Port $Port
  if (!$owner) { return }
  $owner | Format-List | Out-Host
  throw "Port $Port is already in use. Stop or choose the owning process yourself; this script will not terminate it."
}

function Get-XiaodeEnvironmentSnapshot {
  param([string[]]$Names)
  $snapshot = @{}
  foreach ($name in $Names) {
    $snapshot[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  return $snapshot
}

function Restore-XiaodeEnvironment {
  param([hashtable]$Snapshot)
  foreach ($entry in $Snapshot.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
  }
}

function Write-XiaodeUtf8Json {
  param([Parameter(Mandatory = $true)]$Value, [Parameter(Mandatory = $true)][string]$Path)
  $json = $Value | ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText($Path, $json + "`r`n", [Text.UTF8Encoding]::new($false))
}

function Find-XiaodeMysqlTool {
  param([Parameter(Mandatory = $true)][string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $candidates = @(
    "D:\MySQL\MySQL Server 8.0\bin\$Name.exe",
    "C:\Program Files\MySQL\MySQL Server 8.0\bin\$Name.exe",
    "C:\xampp\mysql\bin\$Name.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  return $null
}
