[CmdletBinding()]
param(
  [int]$Port = 3001,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$names = @('PORT', 'XIAODE_STORAGE', 'MYSQL_PASSWORD')
$snapshot = Get-XiaodeEnvironmentSnapshot -Names $names

try {
  $backend = Assert-XiaodeRuntime
  Assert-XiaodePortAvailable -Port $Port
  Set-Location -LiteralPath $backend

  if (!$SkipInstall) {
    Write-Host '[v39] Installing/checking backend dependencies...'
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
  }

  $env:PORT = [string]$Port
  $env:XIAODE_STORAGE = 'json'
  Remove-Item Env:MYSQL_PASSWORD -ErrorAction SilentlyContinue
  Write-Host "[v39] JSON primary only: http://localhost:$Port"
  Write-Host '[v39] Keeping this window occupied while Node is running is expected.'
  & npm start
  if ($LASTEXITCODE -ne 0) { throw "Backend exited with code $LASTEXITCODE" }
} finally {
  Restore-XiaodeEnvironment -Snapshot $snapshot
}
