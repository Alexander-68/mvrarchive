# Signed build + deploy: stage the bundle, sign it with the OmniGate release key,
# verify, zip to mvrarchive.zip and deploy the signed tree (with omnigate.sig).
$ErrorActionPreference = 'Stop'
$og = Join-Path $PSScriptRoot '..\omnigate'
$key = 'C:/Alex/omnigate-signing/release.private.hex'
$stage = Join-Path ([IO.Path]::GetTempPath()) 'mvrarchive-signed'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
'index.html', 'omnigate.json', 'README.md', 'styles.css', 'js', 'assets' | ForEach-Object {
    Copy-Item (Join-Path $PSScriptRoot $_) $stage -Recurse -Force
}
Push-Location $og
try {
    go run ./cmd/omnigate-sign -app -key $key $stage; if ($LASTEXITCODE) { throw 'sign failed' }
    go run ./cmd/omnigate-sign -verify -app $stage; if ($LASTEXITCODE) { throw 'verify failed' }
} finally { Pop-Location }
$zip = Join-Path $PSScriptRoot 'mvrarchive.zip'
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
$dest = Join-Path $og 'data\apps\mvrarchive'
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }  # drop files deleted from the repo
New-Item -ItemType Directory -Path $dest -Force | Out-Null
Copy-Item (Join-Path $stage '*') $dest -Recurse -Force
Write-Host "[sign.ps1] Signed $zip and deployed to $dest"
