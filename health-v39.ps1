[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://127.0.0.1:3001',
  [int]$TimeoutSeconds = 5,
  [switch]$AllowMirrorFailure
)

$ErrorActionPreference = 'Stop'
$healthUrl = "$($BaseUrl.TrimEnd('/'))/api/health"

try {
  $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec $TimeoutSeconds
} catch {
  [Console]::Error.WriteLine("Health endpoint is unavailable: $healthUrl; $($_.Exception.Message)")
  exit 1
}

$health | ConvertTo-Json -Depth 8

if (!$health.ok -or $health.storage.primary -ne 'db.json') {
  [Console]::Error.WriteLine('The service or db.json primary storage is unhealthy.')
  exit 1
}

$mirror = $health.storage.mysqlMirror
if (!$AllowMirrorFailure -and $mirror.enabled -and (!$mirror.connected -or !$mirror.ok)) {
  [Console]::Error.WriteLine('The service is running, but the MySQL mirror is unhealthy.')
  exit 2
}

exit 0
