# Sign the Firefox build for self-distribution.
#
# Prompts for the AMO secret instead of taking it as an argument. A secret
# passed on a command line lands in PSReadLine history; one written into a file
# eventually gets committed. This keeps it in process memory only, so the script
# itself is safe to commit and hand to a teammate.
#
#   .\scripts\sign-firefox.ps1
#
# Credentials come from https://addons.mozilla.org/en-US/developers/addon/api/key/
# The JWT secret is shown exactly once - revoke and regenerate if you lose it.

[CmdletBinding()]
param(
  # Not a secret: it names the account but is useless on its own.
  [string]$Issuer = 'user:20162146:3',

  # 'unlisted' = automated signing in minutes, you host the .xpi yourself.
  # 'listed'   = public addons.mozilla.org page, human review, days to weeks.
  [ValidateSet('unlisted', 'listed')]
  [string]$Channel = 'unlisted'
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

Write-Host ''
Write-Host 'Signing READIT for Firefox' -ForegroundColor Cyan
Write-Host "  issuer  : $Issuer"
Write-Host "  channel : $Channel"

$manifestPath = 'public/manifest.json'
$version = (Get-Content $manifestPath -Raw | ConvertFrom-Json).version
Write-Host "  version : $version"
Write-Host ''
Write-Host 'AMO rejects a version it has already accepted. If this fails with a' -ForegroundColor DarkGray
Write-Host "version conflict, bump 'version' in $manifestPath and re-run." -ForegroundColor DarkGray
Write-Host ''

$secure = Read-Host -Prompt 'Paste your AMO JWT secret (input hidden)' -AsSecureString
$plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
)

if ([string]::IsNullOrWhiteSpace($plain)) {
  Write-Host 'No secret entered. Aborting.' -ForegroundColor Red
  exit 1
}

try {
  # web-ext picks these up on its own, so the secret never becomes an argv entry
  # that a process listing or history file could capture.
  $env:WEB_EXT_API_KEY = $Issuer
  $env:WEB_EXT_API_SECRET = $plain

  Write-Host 'Building...' -ForegroundColor Cyan
  npm run build:firefox
  if ($LASTEXITCODE -ne 0) { throw "build:firefox failed ($LASTEXITCODE)" }

  Write-Host ''
  Write-Host 'Uploading to AMO for signing (usually a few minutes)...' -ForegroundColor Cyan
  npx --yes web-ext@latest sign `
    --source-dir dist-firefox `
    --artifacts-dir web-ext-artifacts `
    --channel $Channel
  if ($LASTEXITCODE -ne 0) { throw "web-ext sign failed ($LASTEXITCODE)" }

  Write-Host ''
  Write-Host 'Signed. Artifacts:' -ForegroundColor Green
  Get-ChildItem web-ext-artifacts -Filter *.xpi | ForEach-Object {
    '  {0}  ({1:N0} KB)' -f $_.Name, ($_.Length / 1KB)
  }
}
finally {
  # Clear the secret from this process even if the build threw.
  $plain = $null
  $env:WEB_EXT_API_SECRET = $null
  $env:WEB_EXT_API_KEY = $null
  [GC]::Collect()
}
