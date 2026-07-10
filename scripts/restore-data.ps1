[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [Parameter(Mandatory = $true)]
  [string]$BackupDirectory,
  [int]$Port = 3001,
  [switch]$Force,
  [string]$BackupRoot = (Join-Path (Join-Path $PSScriptRoot '..') 'backups')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$owner = Get-XiaodePortOwner -Port $Port
if ($owner) {
  $owner | Format-List | Out-Host
  throw "Port $Port is listening. Stop the backend before restoring db.json."
}

$resolvedDirectory = (Resolve-Path -LiteralPath $BackupDirectory -ErrorAction Stop).Path
$manifestFile = Join-Path $resolvedDirectory 'manifest.json'
$backupFile = Join-Path $resolvedDirectory 'db.json'
if (!(Test-Path -LiteralPath $manifestFile -PathType Leaf)) { throw "manifest.json is missing: $manifestFile" }
if (!(Test-Path -LiteralPath $backupFile -PathType Leaf)) { throw "db.json is missing: $backupFile" }

$manifest = [IO.File]::ReadAllText($manifestFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
$expectedHash = [string]$manifest.files.dbJson.sha256
if ([string]::IsNullOrWhiteSpace($expectedHash)) { throw 'manifest.json does not contain files.dbJson.sha256.' }
$actualHash = (Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) { throw 'Backup db.json SHA-256 does not match manifest.json.' }
$backupRaw = [IO.File]::ReadAllText($backupFile, [Text.Encoding]::UTF8)
$null = $backupRaw | ConvertFrom-Json

$projectRoot = Get-XiaodeProjectRoot
$dataFile = Join-Path $projectRoot 'web\backend\data\db.json'
$plan = [pscustomobject]@{
  action = 'restore-db-json'
  source = $backupFile
  destination = $dataFile
  sha256 = $actualHash
  servicePort = $Port
  mysqlRequired = $false
}

if (!$PSCmdlet.ShouldProcess($dataFile, "Restore from $resolvedDirectory")) {
  $plan | Format-List | Out-Host
  $plan
  return
}

if (!$Force) {
  $answer = Read-Host 'Type RESTORE to replace the current db.json'
  if ($answer -cne 'RESTORE') { throw 'Restore cancelled.' }
}

$safetyBackup = & (Join-Path $PSScriptRoot 'backup-data.ps1') -BackupRoot $BackupRoot -Label 'pre-restore'
$tempFile = "$dataFile.$PID.restore.tmp"
$replaceBackup = "$dataFile.$PID.replaced.bak"
try {
  [IO.File]::WriteAllText($tempFile, $backupRaw, [Text.UTF8Encoding]::new($false))
  if ((Get-FileHash -LiteralPath $tempFile -Algorithm SHA256).Hash -ne $expectedHash) {
    throw 'Restore temporary file failed SHA-256 verification.'
  }
  if (Test-Path -LiteralPath $dataFile) {
    [IO.File]::Replace($tempFile, $dataFile, $replaceBackup, $true)
  } else {
    Move-Item -LiteralPath $tempFile -Destination $dataFile
  }
} finally {
  Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $replaceBackup -Force -ErrorAction SilentlyContinue
}

$restoredHash = (Get-FileHash -LiteralPath $dataFile -Algorithm SHA256).Hash
if ($restoredHash -ne $expectedHash) { throw 'Restored db.json failed SHA-256 verification.' }
$null = [IO.File]::ReadAllText($dataFile, [Text.Encoding]::UTF8) | ConvertFrom-Json

$result = [pscustomobject]@{
  ok = $true
  primary = 'db.json'
  restoredFrom = $resolvedDirectory
  restoredSha256 = $restoredHash
  safetyBackup = $safetyBackup.backupDirectory
  mysqlRequired = $false
  message = 'Restore complete. Restart the backend to refresh the MySQL mirror.'
}
$result | Format-List | Out-Host
$result
