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

if ($JsonOnly) {
  & (Join-Path $PSScriptRoot 'scripts\start-web-json.ps1') -Port $Port -SkipInstall:$SkipInstall
} else {
  & (Join-Path $PSScriptRoot 'scripts\start-web-mysql.ps1') -Port $Port -MysqlHost $MysqlHost -MysqlPort $MysqlPort -MysqlUser $MysqlUser -MysqlDatabase $MysqlDatabase -SkipInstall:$SkipInstall
}
