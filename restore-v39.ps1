[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [string]$BackupFile,
  [switch]$Force,
  [int]$Port = 3001
)

$directory = if (Test-Path -LiteralPath $BackupFile -PathType Leaf) { Split-Path -Parent $BackupFile } else { $BackupFile }
& (Join-Path $PSScriptRoot 'scripts\restore-data.ps1') -BackupDirectory $directory -Port $Port -Force:$Force -WhatIf:$WhatIfPreference
