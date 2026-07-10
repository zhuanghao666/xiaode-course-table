[CmdletBinding()]
param(
  [switch]$JsonOnly,
  [switch]$SkipInstall,
  [int]$Port = 3001,
  [string]$MysqlHost = '127.0.0.1',
  [int]$MysqlPort = 3306,
  [string]$MysqlUser = 'xiaode',
  [string]$MysqlDatabase = 'xiaode_course_table'
)

$ErrorActionPreference = 'Stop'
$backend = Join-Path $PSScriptRoot 'web\backend'
$environmentNames = @(
  'PORT',
  'XIAODE_STORAGE',
  'MYSQL_HOST',
  'MYSQL_PORT',
  'MYSQL_USER',
  'MYSQL_DATABASE',
  'MYSQL_PASSWORD',
  'MYSQL_CONNECT_TIMEOUT_MS',
  'MYSQL_RETRY_COOLDOWN_MS'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$securePassword = $null
$passwordPtr = [IntPtr]::Zero

try {
  if (!(Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js was not found.' }
  if (!(Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm was not found.' }
  if (!(Test-Path -LiteralPath (Join-Path $backend 'package.json'))) { throw "Invalid backend directory: $backend" }

  Set-Location -LiteralPath $backend
  if (!$SkipInstall) {
    Write-Host '[v39] Installing/checking backend dependencies...'
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
  }

  $env:PORT = [string]$Port
  if ($JsonOnly) {
    $env:XIAODE_STORAGE = 'json'
    Remove-Item Env:MYSQL_PASSWORD -ErrorAction SilentlyContinue
    Write-Host "[v39] Starting in JSON-only mode: http://127.0.0.1:$Port"
  } else {
    $securePassword = Read-Host 'MySQL password (input is hidden and is not saved)' -AsSecureString
    $passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $env:MYSQL_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
    $env:XIAODE_STORAGE = 'mysql'
    $env:MYSQL_HOST = $MysqlHost
    $env:MYSQL_PORT = [string]$MysqlPort
    $env:MYSQL_USER = $MysqlUser
    $env:MYSQL_DATABASE = $MysqlDatabase
    $env:MYSQL_CONNECT_TIMEOUT_MS = '3000'
    $env:MYSQL_RETRY_COOLDOWN_MS = '5000'
    Write-Host "[v39] Starting with db.json primary + MySQL mirror: http://127.0.0.1:$Port"
  }

  & npm start
  if ($LASTEXITCODE -ne 0) { throw "Backend exited with code $LASTEXITCODE" }
} finally {
  if ($passwordPtr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
  }
  $securePassword = $null
  foreach ($name in $environmentNames) {
    $oldValue = $previousEnvironment[$name]
    if ($null -eq $oldValue) {
      [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    } else {
      [Environment]::SetEnvironmentVariable($name, $oldValue, 'Process')
    }
  }
}
