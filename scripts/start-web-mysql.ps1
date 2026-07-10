[CmdletBinding()]
param(
  [int]$Port = 3001,
  [string]$MysqlHost = '127.0.0.1',
  [int]$MysqlPort = 3306,
  [string]$MysqlUser = 'xiaode',
  [string]$MysqlDatabase = 'xiaode_course_table',
  [int]$ConnectTimeoutMs = 3000,
  [int]$RetryCooldownMs = 5000,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$names = @('PORT', 'XIAODE_STORAGE', 'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_DATABASE', 'MYSQL_PASSWORD', 'MYSQL_CONNECT_TIMEOUT_MS', 'MYSQL_RETRY_COOLDOWN_MS')
$snapshot = Get-XiaodeEnvironmentSnapshot -Names $names
$securePassword = $null
$passwordPtr = [IntPtr]::Zero

try {
  $backend = Assert-XiaodeRuntime
  Assert-XiaodePortAvailable -Port $Port
  Set-Location -LiteralPath $backend

  if (!$SkipInstall) {
    Write-Host '[v39] Installing/checking backend dependencies...'
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
  }

  $securePassword = Read-Host 'MySQL password (input is hidden and is not saved)' -AsSecureString
  $passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)

  $env:PORT = [string]$Port
  $env:XIAODE_STORAGE = 'mysql'
  $env:MYSQL_HOST = $MysqlHost
  $env:MYSQL_PORT = [string]$MysqlPort
  $env:MYSQL_USER = $MysqlUser
  $env:MYSQL_DATABASE = $MysqlDatabase
  $env:MYSQL_CONNECT_TIMEOUT_MS = [string]$ConnectTimeoutMs
  $env:MYSQL_RETRY_COOLDOWN_MS = [string]$RetryCooldownMs
  $env:MYSQL_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)

  Write-Host "[v39] Foreground server: http://localhost:$Port"
  Write-Host '[v39] Keeping this window occupied while Node is running is expected.'
  & npm start
  if ($LASTEXITCODE -ne 0) { throw "Backend exited with code $LASTEXITCODE" }
} finally {
  Remove-Item Env:MYSQL_PASSWORD -ErrorAction SilentlyContinue
  if ($passwordPtr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
  }
  $securePassword = $null
  Restore-XiaodeEnvironment -Snapshot $snapshot
}
