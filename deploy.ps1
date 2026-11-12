$destination = Join-Path $PSScriptRoot '..\omnigate\data\apps\mvrarchive'
# Start clean: files deleted from the repo (and a stale omnigate.sig, which an
# unsigned deploy would no longer match) must not linger in the app dir.
if (Test-Path $destination) { Remove-Item $destination -Recurse -Force }
New-Item -ItemType Directory -Path $destination -Force | Out-Null

'index.html', 'omnigate.json', 'README.md', 'styles.css', 'js', 'assets' | ForEach-Object {
    Copy-Item (Join-Path $PSScriptRoot $_) $destination -Recurse -Force
}

Write-Host "[deploy.ps1] Copied web app files to $destination"
