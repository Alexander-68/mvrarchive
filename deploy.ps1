$destination = Join-Path $PSScriptRoot '..\omnigate\data\apps\mvrarchive'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
# Unsigned deploy: a leftover signature would no longer match (sign.ps1 re-signs).
Remove-Item (Join-Path $destination 'omnigate.sig') -ErrorAction SilentlyContinue

'index.html', 'omnigate.json', 'README.md', 'styles.css', 'js', 'assets' | ForEach-Object {
    Copy-Item (Join-Path $PSScriptRoot $_) $destination -Recurse -Force
}

Write-Host "[deploy.ps1] Copied web app files to $destination"
