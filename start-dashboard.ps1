# Arrêter le script dès qu'une erreur PowerShell survient
$ErrorActionPreference = 'Stop'

# Se placer dans le dossier contenant ce script
Push-Location $PSScriptRoot

try {
    # Construire les images si nécessaire et démarrer les services en arrière-plan
    # --wait attend que les services soient prêts 
    docker compose up -d --build --wait --wait-timeout 90

    # Vérifier si Docker Compose a rencontré une erreur
    if ($LASTEXITCODE -ne 0) {
        throw 'CyberFlow could not start. Inspect the Compose logs.'
    }

    # Récupérer le port du dashboard ou utiliser 3000 par défaut
    $dashboardPort = if ($env:CYBERFLOW_DASHBOARD_PORT) {
        $env:CYBERFLOW_DASHBOARD_PORT
    } else {
        '3000'
    }

    # Afficher l'adresse du dashboard
    Write-Host "CyberFlow dashboard: http://localhost:$dashboardPort"

} finally {
    # Revenir au répertoire initial, même si une erreur survient
    Pop-Location
}
