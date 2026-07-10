[CmdletBinding()]
param(
  [string]$DestinationDirectory = (Join-Path $PSScriptRoot 'backups'),
  [string]$Label = 'manual',
  [int]$Keep = 20,
  [switch]$IncludeMysql
)

& (Join-Path $PSScriptRoot 'scripts\backup-data.ps1') -BackupRoot $DestinationDirectory -Label $Label -Keep $Keep -IncludeMysql:$IncludeMysql
