$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$bundledNode = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $bundledNode)) { $bundledNode = (Get-Command node -ErrorAction Stop).Source }
Push-Location -LiteralPath $projectDirectory
try { & $bundledNode 'src/server.mjs' }
finally { Pop-Location }
