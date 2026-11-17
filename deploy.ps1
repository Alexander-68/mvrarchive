$ErrorActionPreference = 'Stop'  # a locked file must fail the deploy, not report success
# Build (syncs the version, zips the bundle), then deploy exactly what was zipped.
node (Join-Path $PSScriptRoot 'build.js'); if ($LASTEXITCODE) { throw 'build failed' }
$destination = Join-Path $PSScriptRoot '..\omnigate\data\apps\mvrarchive'
# Start clean: files deleted from the repo (and a stale omnigate.sig, which an
# unsigned deploy would no longer match) must not linger in the app dir.
if (Test-Path $destination) { Remove-Item $destination -Recurse -Force }
Expand-Archive (Join-Path $PSScriptRoot 'mvrarchive.zip') $destination

Write-Host "[deploy.ps1] Deployed web app files to $destination"
