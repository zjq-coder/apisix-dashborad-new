$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
if (Test-Path -LiteralPath $envPath) { Write-Host '.env already exists; left unchanged.'; exit 0 }
function New-RandomHex([int]$Length) {
  $bytes = New-Object byte[] $Length
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}
$values = @(
  'DASHBOARD_USERNAME=admin'
  "DASHBOARD_PASSWORD=$(New-RandomHex 12)"
  "DASHBOARD_ENCRYPTION_KEY=$(New-RandomHex 32)"
  "POSTGRES_PASSWORD=$(New-RandomHex 20)"
  "APISIX_ADMIN_KEY=$(New-RandomHex 24)"
)
[System.IO.File]::WriteAllLines($envPath, $values, (New-Object System.Text.UTF8Encoding($false)))
Write-Host 'Created .env with unique local credentials. Keep this file private.'
