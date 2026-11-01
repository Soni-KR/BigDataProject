$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    docker compose up -d --build --wait --wait-timeout 90
    if ($LASTEXITCODE -ne 0) { throw 'CyberFlow could not start. Inspect the Compose logs.' }
    $dashboardPort = if ($env:CYBERFLOW_DASHBOARD_PORT) { $env:CYBERFLOW_DASHBOARD_PORT } else { '3000' }
    Write-Host "CyberFlow dashboard: http://localhost:$dashboardPort"
} finally {
    Pop-Location
}
