[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://localhost:3001',
  [int]$TimeoutSeconds = 5,
  [switch]$AsJson
)

$ErrorActionPreference = 'Stop'
$url = "$($BaseUrl.TrimEnd('/'))/api/health"

try {
  $health = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec $TimeoutSeconds
} catch {
  [Console]::Error.WriteLine("[OFFLINE] Cannot reach $url")
  [Console]::Error.WriteLine("Start it with .\scripts\start-web-json.ps1 or .\scripts\start-web-mysql.ps1")
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}

if ($AsJson) {
  $health | ConvertTo-Json -Depth 10
}

$mirror = $health.storage.mysqlMirror
$counts = $health.storage.primaryCounts
$migration = $mirror.migration
$primaryOk = $health.ok -and $health.storage.primary -eq 'db.json'
$degraded = $mirror.enabled -and (!$mirror.connected -or !$mirror.ok)
$status = if (!$primaryOk) { 'UNHEALTHY' } elseif ($degraded) { 'DEGRADED' } else { 'HEALTHY' }

Write-Host "[$status] serviceOnline=true"
Write-Host "version=$($health.version)"
Write-Host "primary=$($health.storage.primary)"
Write-Host "mysql.enabled=$($mirror.enabled)"
Write-Host "mysql.connected=$($mirror.connected)"
Write-Host "mysql.lastSyncOk=$($mirror.ok)"
Write-Host "mysql.lastAttemptAt=$($mirror.lastAttemptAt)"
Write-Host "mysql.lastSyncedAt=$($mirror.lastSyncedAt)"
Write-Host "mysql.lastError=$($mirror.lastError)"
Write-Host "counts.users=$($counts.users)"
Write-Host "counts.accounts=$($counts.accounts)"
Write-Host "counts.courses=$($counts.courses)"
Write-Host "counts.settings=$($counts.settings)"
Write-Host "counts.reminders=$($counts.reminders)"
Write-Host "accountMigration.warningCount=$(@($health.storage.primaryMigrationWarnings).Count)"
Write-Host "appState.migration=$($migration.appState)"
Write-Host "appState.legacyTable=$($migration.legacyTable)"
Write-Host "appState.legacyTables=$(@($migration.legacyTables) -join ',')"
Write-Host "message=$($mirror.message)"

if (!$primaryOk) {
  [Console]::Error.WriteLine('The service is online but db.json is not a healthy primary store.')
  exit 2
}
if ($degraded) {
  Write-Warning 'MySQL mirror is degraded. The primary JSON service is still operational.'
}
exit 0
