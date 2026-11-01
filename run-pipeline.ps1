param([switch]$ImportOnly, [string]$RunPath)
$ErrorActionPreference = 'Stop'
if ($ImportOnly -and -not $RunPath) { throw 'ImportOnly requires the completed RunPath.' }
if (-not $RunPath) { $RunPath = '/cyberflow/runs/' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ') }
if ($RunPath -notmatch '^/cyberflow/runs/[A-Za-z0-9_-]+$') { throw 'RunPath must be a directory under /cyberflow/runs/.' }
Push-Location $PSScriptRoot
try {
    docker exec hadoop-master mkdir -p /opt/cyberflow/spark /opt/cyberflow/scripts
    if ($LASTEXITCODE -ne 0) { throw 'Cannot access hadoop-master.' }
    docker cp ./spark/. hadoop-master:/opt/cyberflow/spark/
    if ($LASTEXITCODE -ne 0) { throw 'Cannot copy Spark source.' }
    docker cp ./scripts/. hadoop-master:/opt/cyberflow/scripts/
    if ($LASTEXITCODE -ne 0) { throw 'Cannot copy pipeline scripts.' }
    $pipelineArgs = @('exec', 'hadoop-master', 'bash', '/opt/cyberflow/scripts/run-pipeline.sh', $RunPath)
    if ($ImportOnly) { $pipelineArgs += '--import-only' }
    & docker @pipelineArgs
    if ($LASTEXITCODE -ne 0) { throw 'Pipeline failed; inspect the output above.' }
} finally {
    Pop-Location
}
