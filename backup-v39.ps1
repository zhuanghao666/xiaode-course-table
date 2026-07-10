[CmdletBinding()]
param(
  [string]$DestinationDirectory = (Join-Path $PSScriptRoot 'backups\v39'),
  [string]$Label = 'manual'
)

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'web\backend\data\db.json'
if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw "Primary storage file was not found: $source" }

$raw = [IO.File]::ReadAllText($source, [Text.Encoding]::UTF8)
$null = $raw | ConvertFrom-Json

[IO.Directory]::CreateDirectory($DestinationDirectory) | Out-Null
$safeLabel = ($Label -replace '[^a-zA-Z0-9_-]', '-').Trim('-')
if (!$safeLabel) { $safeLabel = 'manual' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupFile = Join-Path $DestinationDirectory "db-$stamp-$safeLabel.json"
if (Test-Path -LiteralPath $backupFile) {
  $backupFile = Join-Path $DestinationDirectory "db-$stamp-$safeLabel-$([Guid]::NewGuid().ToString('N').Substring(0, 6)).json"
}

[IO.File]::WriteAllText($backupFile, $raw, [Text.UTF8Encoding]::new($false))
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
$backupHash = (Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash
if ($sourceHash -ne $backupHash) {
  Remove-Item -LiteralPath $backupFile -Force -ErrorAction SilentlyContinue
  throw 'Backup hash verification failed; the invalid backup was removed.'
}

$hashFile = "$backupFile.sha256"
[IO.File]::WriteAllText($hashFile, "$backupHash  $([IO.Path]::GetFileName($backupFile))`r`n", [Text.Encoding]::ASCII)

[pscustomobject]@{
  ok = $true
  primary = 'db.json'
  backupFile = $backupFile
  sha256 = $backupHash
  size = (Get-Item -LiteralPath $backupFile).Length
  createdAt = (Get-Date).ToString('o')
} | ConvertTo-Json -Depth 4
