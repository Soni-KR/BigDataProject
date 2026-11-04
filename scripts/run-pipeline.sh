
#!/usr/bin/env bash

# Active le mode strict de Bash :
# -e : arrête le script si une commande échoue
# -u : génère une erreur si une variable non définie est utilisée
# -o pipefail : détecte les erreurs dans les commandes reliées par un pipe (|)
set -euo pipefail

# Se positionne à la racine du projet 
# Ainsi, les chemins relatifs comme spark/processing.scala restent corrects
cd "$(dirname "$0")/.."

# Récupère le premier argument fourni lors de l'exécution
# Il doit obligatoirement contenir le chemin HDFS de l'exécution
# Exemple : /cyberflow/runs/RUN_001
export CYBERFLOW_RUN_PATH="${1:?Pass a new HDFS run path}"

# Vérifie que le chemin respecte le format attendu :
# /cyberflow/runs/ suivi d'un nom composé de lettres, chiffres, "_" ou "-"
[[ "$CYBERFLOW_RUN_PATH" =~ ^/cyberflow/runs/[A-Za-z0-9_-]+$ ]] || {
  echo "Invalid run path." >&2
  exit 1
}

# Affiche le chemin HDFS utilisé pour cette exécution
echo "CYBERFLOW_RUN_PATH=$CYBERFLOW_RUN_PATH"

# Vérifie l'existence du dossier contenant les données brutes dans HDFS
# Si le dossier n'existe pas, le script s'arrête grâce à set -e
hdfs dfs -test -e /cyberflow/raw

# Vérifie si le deuxième argument est différent de --import-only
# Si c'est le cas, le pipeline Spark complet sera exécuté
if [[ "${2:-}" != "--import-only" ]]; then

  # Définit le dossier de configuration Hadoop
  # Utilise la valeur existante de HADOOP_CONF_DIR si elle est définie,
  # sinon utilise le chemin de configuration Hadoop par défaut
  export HADOOP_CONF_DIR="${HADOOP_CONF_DIR:-/usr/local/hadoop/etc/hadoop}"

  # Vérifie que le dossier de résultats n'existe pas déjà dans HDFS
  # Cela évite d'écraser les résultats d'une exécution précédente
  if hdfs dfs -test -e "$CYBERFLOW_RUN_PATH"; then
    echo "Run path already exists. Use --import-only to reuse a completed run." >&2
    exit 1
  fi

  # Lance le traitement Spark avec Spark Shell sur YARN
  #exécuter Spark : --master yarn : YARN gère les ressources ; --deploy-mode client : le driver reste dans le conteneur où la commande est lancée ; les executors sont lancés par YARN.
  spark-shell \
    --master yarn \
    --deploy-mode client \
    --name CyberFlow \
    --driver-memory 1g \
    --num-executors 2 \
    --executor-memory 1g \
    --executor-cores 1 \
    --conf spark.driver.host=hadoop-master \
    --conf spark.driver.bindAddress=0.0.0.0 \
    -i spark/processing.scala </dev/null
fi

# Lance le script d'importation des résultats dans HBase
# Le script import-hbase.sh vérifie le fichier _SUCCESS de chaque export
# En mode --import-only, le traitement Spark est ignoré et seule cette étape est exécutée.
bash scripts/import-hbase.sh
