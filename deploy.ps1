$destination = Join-Path $PSScriptRoot '..\omnigate\data\apps\mvrarchive'
New-Item -ItemType Directory -Path $destination -Force | Out-Null

'index.html', 'styles.css', 'js', 'assets' | ForEach-Object {
    Copy-Item (Join-Path $PSScriptRoot $_) $destination -Recurse -Force
}

Write-Host "[deploy.ps1] Copied web app files to $destination"
