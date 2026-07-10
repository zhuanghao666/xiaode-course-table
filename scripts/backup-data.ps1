[CmdletBinding()]
param(
  [string]$BackupRoot = (Join-Path (Join-Path $PSScriptRoot '..') 'backups'),
  [string]$BaseUrl = 'http://localhost:3001',
  [int]$Keep = 20,
  [string]$Label = 'manual',
  [switch]$IncludeMysql,
  [string]$MysqlHost = '127.0.0.1',
  [int]$MysqlPort = 3306,
  [string]$MysqlUser = 'xiaode',
  [string]$MysqlDatabase = 'xiaode_course_table'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

if ($Keep -lt 1) { throw 'Keep must be at least 1.' }
$projectRoot = Get-XiaodeProjectRoot
$source = Join-Path $projectRoot 'web\backend\data\db.json'
if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw "db.json was not found: $source" }

$sourceRaw = [IO.File]::ReadAllText($source, [Text.Encoding]::UTF8)
$null = $sourceRaw | ConvertFrom-Json
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash

$resolvedBackupRoot = [IO.Path]::GetFullPath($BackupRoot)
[IO.Directory]::CreateDirectory($resolvedBackupRoot) | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDirectory = Join-Path $resolvedBackupRoot $stamp
$suffix = 1
while (Test-Path -LiteralPath $backupDirectory) {
  $backupDirectory = Join-Path $resolvedBackupRoot "$stamp-$suffix"
  $suffix += 1
}
[IO.Directory]::CreateDirectory($backupDirectory) | Out-Null

$backupFile = Join-Path $backupDirectory 'db.json'
[IO.File]::WriteAllText($backupFile, $sourceRaw, [Text.UTF8Encoding]::new($false))
$backupHash = (Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash
if ($sourceHash -ne $backupHash) {
  throw 'Copied db.json failed SHA-256 verification.'
}

$healthSummary = [ordered]@{ online = $false }
try {
  $health = Invoke-RestMethod -Uri "$($BaseUrl.TrimEnd('/'))/api/health" -TimeoutSec 3
  $healthSummary = [ordered]@{
    online = $true
    ok = [bool]$health.ok
    version = $health.version
    primary = $health.storage.primary
    primaryCounts = $health.storage.primaryCounts
    mysqlMirror = $health.storage.mysqlMirror
  }
} catch {
  $healthSummary = [ordered]@{
    online = $false
    message = $_.Exception.Message
  }
}

$versionFile = Join-Path $projectRoot 'VERSION'
$appVersion = if (Test-Path -LiteralPath $versionFile) {
  [IO.File]::ReadAllText($versionFile, [Text.Encoding]::UTF8).Trim()
} elseif ($healthSummary.version) {
  [string]$healthSummary.version
} else {
  'v39'
}

$mysqlDump = [ordered]@{
  requested = [bool]$IncludeMysql
  created = $false
  file = $null
  sha256 = $null
  size = $null
  message = if ($IncludeMysql) { 'not attempted' } else { 'not requested' }
}

if ($IncludeMysql) {
  $dumpTool = Find-XiaodeMysqlTool -Name 'mysqldump'
  if (!$dumpTool) {
    $mysqlDump.message = 'mysqldump.exe was not found; JSON backup is valid.'
    Write-Warning $mysqlDump.message
  } else {
    $securePassword = $null
    $passwordPtr = [IntPtr]::Zero
    $oldMysqlPwd = [Environment]::GetEnvironmentVariable('MYSQL_PWD', 'Process')
    $dumpFile = Join-Path $backupDirectory 'mysql-mirror.sql'
    $errorFile = Join-Path $backupDirectory 'mysqldump.stderr.tmp'
    try {
      $securePassword = Read-Host 'MySQL password for optional dump (input is hidden and is not saved)' -AsSecureString
      $passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
      $env:MYSQL_PWD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
      $dumpArgs = @(
        '--single-transaction', '--routines', '--events', '--triggers', '--default-character-set=utf8mb4',
        "--host=$MysqlHost", "--port=$MysqlPort", "--user=$MysqlUser", '--databases', $MysqlDatabase
      )
      $process = Start-Process -FilePath $dumpTool -ArgumentList $dumpArgs -RedirectStandardOutput $dumpFile -RedirectStandardError $errorFile -WindowStyle Hidden -Wait -PassThru
      if ($process.ExitCode -eq 0 -and (Test-Path -LiteralPath $dumpFile) -and (Get-Item -LiteralPath $dumpFile).Length -gt 0) {
        $mysqlDump.created = $true
        $mysqlDump.file = 'mysql-mirror.sql'
        $mysqlDump.sha256 = (Get-FileHash -LiteralPath $dumpFile -Algorithm SHA256).Hash
        $mysqlDump.size = (Get-Item -LiteralPath $dumpFile).Length
        $mysqlDump.message = 'MySQL mirror dump created.'
      } else {
        $mysqlDump.message = 'mysqldump failed; JSON backup is still valid.'
        Remove-Item -LiteralPath $dumpFile -Force -ErrorAction SilentlyContinue
        Write-Warning $mysqlDump.message
      }
    } finally {
      Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue
      [Environment]::SetEnvironmentVariable('MYSQL_PWD', $oldMysqlPwd, 'Process')
      if ($passwordPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr) }
      $securePassword = $null
    }
  }
}

$manifest = [ordered]@{
  schemaVersion = 1
  createdAt = (Get-Date).ToString('o')
  appVersion = $appVersion
  label = $Label
  sourceFile = [IO.Path]::GetFullPath($source)
  files = [ordered]@{
    dbJson = [ordered]@{
      name = 'db.json'
      sha256 = $backupHash
      size = (Get-Item -LiteralPath $backupFile).Length
    }
    mysql = $mysqlDump
  }
  health = $healthSummary
}
Write-XiaodeUtf8Json -Value $manifest -Path (Join-Path $backupDirectory 'manifest.json')

$directories = @(Get-ChildItem -LiteralPath $resolvedBackupRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^\d{8}-\d{6}(?:-\d+)?$' } |
  Sort-Object Name -Descending)
$expired = @($directories | Select-Object -Skip $Keep)
foreach ($directory in $expired) {
  $candidate = [IO.Path]::GetFullPath($directory.FullName)
  $prefix = $resolvedBackupRoot.TrimEnd('\') + '\'
  if (!$candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe retention path: $candidate"
  }
  Remove-Item -LiteralPath $candidate -Recurse -Force
}

$result = [pscustomobject]@{
  ok = $true
  primary = 'db.json'
  backupDirectory = $backupDirectory
  manifest = (Join-Path $backupDirectory 'manifest.json')
  sha256 = $backupHash
  mysqlDumpCreated = [bool]$mysqlDump.created
  retained = [Math]::Min($directories.Count, $Keep)
}
$result | Format-List | Out-Host
$result
