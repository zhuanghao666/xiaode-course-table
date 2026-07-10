[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BackupFile,
  [switch]$Force,
  [string]$SafetyBackupDirectory = (Join-Path $PSScriptRoot 'backups\v39\pre-restore')
)

$ErrorActionPreference = 'Stop'
$dataFile = Join-Path $PSScriptRoot 'web\backend\data\db.json'
$resolvedBackup = (Resolve-Path -LiteralPath $BackupFile -ErrorAction Stop).Path
if ([IO.Path]::GetFullPath($resolvedBackup) -eq [IO.Path]::GetFullPath($dataFile)) {
  throw 'The backup file cannot be the active db.json file.'
}

$backupRaw = [IO.File]::ReadAllText($resolvedBackup, [Text.Encoding]::UTF8)
$null = $backupRaw | ConvertFrom-Json
$backupHash = (Get-FileHash -LiteralPath $resolvedBackup -Algorithm SHA256).Hash
$hashFile = "$resolvedBackup.sha256"
if (Test-Path -LiteralPath $hashFile) {
  $expectedHash = ([IO.File]::ReadAllText($hashFile).Trim() -split '\s+')[0]
  if ($expectedHash -and $expectedHash -ne $backupHash) { throw 'Backup SHA-256 verification failed.' }
}

if (!$Force) {
  $answer = Read-Host 'This replaces db.json. Type RESTORE to continue'
  if ($answer -cne 'RESTORE') { throw 'Restore cancelled.' }
}

[IO.Directory]::CreateDirectory($SafetyBackupDirectory) | Out-Null
$safetyBackup = $null
if (Test-Path -LiteralPath $dataFile -PathType Leaf) {
  $currentRaw = [IO.File]::ReadAllText($dataFile, [Text.Encoding]::UTF8)
  $null = $currentRaw | ConvertFrom-Json
  $safetyBackup = Join-Path $SafetyBackupDirectory "db-before-restore-$(Get-Date -Format 'yyyyMMdd-HHmmss').json"
  [IO.File]::WriteAllText($safetyBackup, $currentRaw, [Text.UTF8Encoding]::new($false))
}

$tempFile = "$dataFile.$PID.restore.tmp"
$replaceBackup = "$dataFile.$PID.replaced.bak"
try {
  [IO.File]::WriteAllText($tempFile, $backupRaw, [Text.UTF8Encoding]::new($false))
  if ((Get-FileHash -LiteralPath $tempFile -Algorithm SHA256).Hash -ne $backupHash) {
    throw 'Restore temporary-file hash verification failed.'
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
if ($restoredHash -ne $backupHash) { throw 'Post-restore SHA-256 verification failed.' }

[pscustomobject]@{
  ok = $true
  primary = 'db.json'
  restoredFrom = $resolvedBackup
  restoredSha256 = $restoredHash
  safetyBackup = $safetyBackup
  message = 'Restore complete. Restart the backend to mirror this JSON snapshot to MySQL.'
} | ConvertTo-Json -Depth 4
