# Build bundle for OmniGate
$dest = Join-Path $PSScriptRoot "mvrarchive.zip"
if (Test-Path $dest) { Remove-Item $dest -Force }
Compress-Archive -Path (Join-Path $PSScriptRoot "index.html"), (Join-Path $PSScriptRoot "styles.css"), (Join-Path $PSScriptRoot "js"), (Join-Path $PSScriptRoot "assets") -DestinationPath $dest -Force
Write-Host "[build.ps1] Created $dest"
