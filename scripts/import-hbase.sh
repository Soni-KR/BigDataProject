
# Importer dans HBase les statistiques déjà calculées par Spark

#!/usr/bin/env bash

# Active le mode strict de Bash :
# -e : arrête le script si une commande échoue
# -u : signale l'utilisation d'une variable non définie
# -o pipefail : détecte les erreurs dans les commandes reliées par un pipe (|)

set -euo pipefail

# Vérifier que CYBERFLOW_RUN_PATH est définie.
# Cette variable contient le chemin HDFS de l'exécution Spark terminée.
: "${CYBERFLOW_RUN_PATH:?Set CYBERFLOW_RUN_PATH to the completed Spark run}"

# Vérifier que chaque export Spark est terminé.
# La présence du fichier _SUCCESS confirme que l'écriture de l'export est achevée.
for name in daily attacks ports manifest; do
  hdfs dfs -test -e "$CYBERFLOW_RUN_PATH/exports/$name/_SUCCESS"
done

# Créer les tables HBase nécessaires si elles n'existent pas déjà.
# le service REST est uniquement nécessaire pour l'API de l'application.
hbase shell -n <<'HBASE'

# Récupérer la liste des tables déjà présentes dans HBase.
tables = list

# Créer la table cyber_daily avec la famille de colonnes "m".
# VERSIONS => 1 : conserver une seule version par cellule.
create 'cyber_daily', {NAME => 'm', VERSIONS => 1} unless tables.include?('cyber_daily')

# Créer la table cyber_attacks si elle n'existe pas.
create 'cyber_attacks', {NAME => 'm', VERSIONS => 1} unless tables.include?('cyber_attacks')

# Créer la table cyber_ports si elle n'existe pas.
create 'cyber_ports', {NAME => 'm', VERSIONS => 1} unless tables.include?('cyber_ports')

# Quitter le shell HBase.
exit
HBASE

# Définir une fonction pour importer un fichier HDFS dans une table HBase.
# Paramètres :
# $1 : nom de la table HBase
# $2 : définition des colonnes à importer
# $3 : nom du dossier d'export dans HDFS
load_table() {

  # Utiliser l'outil ImportTsv pour transférer les données vers HBase.
  hbase org.apache.hadoop.hbase.mapreduce.ImportTsv \
    -Dmapreduce.framework.name=yarn \
    -Dmapreduce.map.speculative=false \
    '-Dimporttsv.separator=|' \
    -Dimporttsv.skip.bad.lines=false \
    "-Dimporttsv.columns=$2" \
    "$1" \
    "$CYBERFLOW_RUN_PATH/exports/$3"
}

# Lire la première ligne de l'export daily depuis HDFS.
# awk -F'|' utilise "|" comme séparateur.
# NF représente le nombre de colonnes de la ligne.
# NR == 1 permet de lire uniquement la première ligne.
fields=$(hdfs dfs -cat "$CYBERFLOW_RUN_PATH/exports/daily/part-*" |
  awk -F'|' 'NR == 1 { print NF }')

# Vérifier que l'export daily contient exactement 5 colonnes.
# Sinon, arrêter l'importation avec un message d'erreur.
[[ "$fields" == 5 ]] || {
  echo "Daily export lacks port statistics; run the full pipeline." >&2
  exit 1
}

# Importer les statistiques quotidiennes dans cyber_daily :
# HBASE_ROW_KEY : clé unique de chaque ligne
# m:total_flows : nombre total de flux
# m:benign_flows : nombre de flux légitimes
# m:attack_flows : nombre de flux malveillants
# m:port_stats : statistiques des ports
load_table cyber_daily \
  'HBASE_ROW_KEY,m:total_flows,m:benign_flows,m:attack_flows,m:port_stats' \
  daily

# Importer les statistiques des attaques dans cyber_attacks :
# HBASE_ROW_KEY : clé de ligne
# m:flow_count : nombre de flux associés à l'attaque
load_table cyber_attacks \
  'HBASE_ROW_KEY,m:flow_count' \
  attacks

# Importer les statistiques des ports dans cyber_ports :
# HBASE_ROW_KEY : clé de ligne
# m:total_flows : nombre total de flux
# m:attack_flows : nombre de flux malveillants
load_table cyber_ports \
  'HBASE_ROW_KEY,m:total_flows,m:attack_flows' \
  ports

# Afficher un message confirmant la fin des importations dans HBase.
echo "HBase imports complete."
