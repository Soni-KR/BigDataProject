
# Déclare les paramètres du script :
# -ImportOnly : permet d'exécuter uniquement l'importation des données dans HBase
# -RunPath    : chemin du dossier contenant les résultats d'une exécution précédente
param(
    [switch]$ImportOnly,
    [string]$RunPath
)

# Configure PowerShell pour arrêter le script lorsqu'une erreur survient
$ErrorActionPreference = 'Stop'

# Si le mode ImportOnly est activé, RunPath doit obligatoirement être fourni
if ($ImportOnly -and -not $RunPath) {
    throw 'ImportOnly requires the completed RunPath.'
}

# Si aucun RunPath n'est fourni, génère un chemin unique basé sur la date et l'heure UTC
# Exemple : /cyberflow/runs/20261104T191500123Z
if (-not $RunPath) {
    $RunPath = '/cyberflow/runs/' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
}

# Vérifie que RunPath respecte le format attendu :
# /cyberflow/runs/ suivi d'un nom composé de lettres, chiffres, "_" ou "-"
if ($RunPath -notmatch '^/cyberflow/runs/[A-Za-z0-9_-]+$') {
    throw 'RunPath must be a directory under /cyberflow/runs/.'
}

# Se positionne dans le dossier où se trouve ce script
# $PSScriptRoot contient le chemin du dossier du script
Push-Location $PSScriptRoot

try {
    # Crée les dossiers Spark et scripts dans le conteneur hadoop-master
    # -p évite une erreur si les dossiers existent déjà
    docker exec hadoop-master mkdir -p /opt/cyberflow/spark /opt/cyberflow/scripts

    # Vérifie si la commande Docker précédente a réussi
    if ($LASTEXITCODE -ne 0) {
        throw 'Cannot access hadoop-master.'
    }

    # Copie les fichiers du dossier local ./spark vers le conteneur
    # Le contenu est copié dans /opt/cyberflow/spark/
    docker cp ./spark/. hadoop-master:/opt/cyberflow/spark/

    # Vérifie si la copie des fichiers Spark a réussi
    if ($LASTEXITCODE -ne 0) {
        throw 'Cannot copy Spark source.'
    }

    # Copie les scripts locaux vers le conteneur hadoop-master
    docker cp ./scripts/. hadoop-master:/opt/cyberflow/scripts/

    # Vérifie si la copie des scripts a réussi
    if ($LASTEXITCODE -ne 0) {
        throw 'Cannot copy pipeline scripts.'
    }

    # Prépare les arguments de la commande qui exécutera le pipeline dans le conteneur
    # docker exec : exécute une commande dans un conteneur déjà démarré
    # bash       : utilise le shell Linux
    # run-pipeline.sh : script principal du pipeline
    $pipelineArgs = @(
        'exec',
        'hadoop-master',
        'bash',
        '/opt/cyberflow/scripts/run-pipeline.sh',
        $RunPath
    )

    # Si le mode ImportOnly est activé, ajoute l'option --import-only
    # Le pipeline exécutera uniquement l'étape d'importation
    if ($ImportOnly) {
        $pipelineArgs += '--import-only'
    }

    # Exécute la commande Docker avec les arguments préparés
    & docker @pipelineArgs

    # Vérifie si l'exécution du pipeline s'est terminée sans erreur
    if ($LASTEXITCODE -ne 0) {
        throw 'Pipeline failed; inspect the output above.'
    }

} finally {
    # Revient au dossier de travail précédent, même si une erreur survient
    Pop-Location
}
