param(
  [string]$Version = 'w2-local-v0.2',
  [string]$EvidencePath = 'docs/开发执行/W2/验证'
)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies'
$nodeBinary = Join-Path $runtimeDirectory 'node\bin\node.exe'
$pythonBinary = Join-Path $runtimeDirectory 'python\python.exe'
$evidenceDirectory = [IO.Path]::GetFullPath((Join-Path $projectDirectory $EvidencePath))
if (-not $evidenceDirectory.StartsWith($projectDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'EvidencePath must stay inside this project.'
}
New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
Push-Location -LiteralPath $projectDirectory
try {
  & $nodeBinary --test 2>&1 | Tee-Object -FilePath (Join-Path $evidenceDirectory 'node-tests.txt')
  $nodeExitCode = $LASTEXITCODE
  & $pythonBinary -B -m unittest discover -s test/edge -p 'test_*.py' -v 2>&1 | Tee-Object -FilePath (Join-Path $evidenceDirectory 'edge-tests.txt')
  $pythonExitCode = $LASTEXITCODE
  $pdfExitCode = 0
  if (Test-Path -LiteralPath (Join-Path $projectDirectory 'test/acceptance-w2/test_pdf_boundaries.py')) {
    & $pythonBinary -B -m unittest discover -s test/acceptance-w2 -p 'test_*.py' -v 2>&1 | Tee-Object -FilePath (Join-Path $evidenceDirectory 'pdf-tests.txt')
    $pdfExitCode = $LASTEXITCODE
  }
  $checkResult = [ordered]@{
    version = $Version
    recordedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    userTimezone = 'Asia/Shanghai'
    nodeExitCode = $nodeExitCode
    pythonExitCode = $pythonExitCode
    pdfExitCode = $pdfExitCode
    nodeCommand = 'node --test'
    pythonCommand = 'python -B -m unittest discover -s test/edge -p test_*.py -v'
    pdfCommand = 'python -B -m unittest discover -s test/acceptance-w2 -p test_*.py -v (when present)'
    scope = 'Local synthetic module and HTTP verification; no production, APK, Jetson model or physical printer acceptance.'
  }
  [IO.File]::WriteAllText((Join-Path $evidenceDirectory '自动验证结果.json'), ($checkResult | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  if ($nodeExitCode -ne 0 -or $pythonExitCode -ne 0 -or $pdfExitCode -ne 0) { throw 'Local verification failed; inspect saved evidence.' }
}
finally { Pop-Location }
