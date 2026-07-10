[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://localhost:3001',
  [int]$TimeoutSeconds = 5,
  [switch]$AllowMirrorFailure
)

& (Join-Path $PSScriptRoot 'scripts\check-storage.ps1') -BaseUrl $BaseUrl -TimeoutSeconds $TimeoutSeconds
