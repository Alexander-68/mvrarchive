#Requires -Version 7.0
# Signed build + deploy: build the bundle, stage it, sign it with the OmniGate
# release key, verify, re-zip to mvrarchive.zip and deploy the signed tree (with omnigate.sig).
$ErrorActionPreference = 'Stop'
$og = Join-Path $PSScriptRoot '..\omnigate'
$key = $env:OMNIGATE_SIGNING_KEY ?? 'C:/Alex/omnigate-signing/release.private.hex'
if (-not (Test-Path -LiteralPath $key)) { throw "Signing key not found: $key (set OMNIGATE_SIGNING_KEY)" }
$zip = Join-Path $PSScriptRoot 'mvrarchive.zip'
node (Join-Path $PSScriptRoot 'build.js'); if ($LASTEXITCODE) { throw 'build failed' }
# Per-run staging dir: nothing else can pre-seed or swap what gets signed.
$stage = Join-Path ([IO.Path]::GetTempPath()) ('mvrarchive-signed-' + [guid]::NewGuid().ToString('N'))
try {
    Expand-Archive $zip $stage
    Push-Location $og
    try {
        go run ./cmd/omnigate-sign -app -key $key $stage; if ($LASTEXITCODE) { throw 'sign failed' }
        go run ./cmd/omnigate-sign -verify -app $stage; if ($LASTEXITCODE) { throw 'verify failed' }
    } finally { Pop-Location }
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
    $dest = Join-Path $og 'data\apps\mvrarchive'
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }  # drop files deleted from the repo
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-Item (Join-Path $stage '*') $dest -Recurse -Force
} finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host "[sign.ps1] Signed $zip and deployed to $dest"
