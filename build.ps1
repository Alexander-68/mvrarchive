# Build bundle for OmniGate: one build path (build.js syncs the version and
# writes forward-slash zip entry names).
node (Join-Path $PSScriptRoot 'build.js'); if ($LASTEXITCODE) { throw 'build failed' }
