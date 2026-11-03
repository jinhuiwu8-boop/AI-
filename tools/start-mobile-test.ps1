$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$nodeBinary = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $nodeBinary)) { $nodeBinary = (Get-Command node -ErrorAction Stop).Source }
Push-Location -LiteralPath $projectDirectory
try { & $nodeBinary 'src/server.mjs' '--mobile-test' }
finally { Pop-Location }
