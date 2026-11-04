#!/bin/bash

# Arrêter immédiatement le script si une commande échoue
set -e

# Créer le répertoire /cyberflow/raw dans HDFS, -p évite une erreur si le répertoire existe déjà
hdfs dfs -mkdir -p /cyberflow/raw

# Parcourir tous les fichiers CSV présents dans /data/cicids/ en local
for file in /data/cicids/*.csv; do

    # Récupérer uniquement le nom du fichier, sans son chemin
    name=$(basename "$file")

    # Vérifier si le fichier existe déjà dans HDFS
    if hdfs dfs -test -e "/cyberflow/raw/$name"; then

        echo "Already exists: $name"

    else

        # Copier le fichier CSV local vers le répertoire HDFS
        hdfs dfs -put "$file" /cyberflow/raw/
        echo "Uploaded: $name"

    fi
done

# Afficher la liste des fichiers présents dans HDFS
# -h affiche les tailles dans un format lisible (KB, MB, GB)
hdfs dfs -ls -h /cyberflow/raw/

# Vérifier l'état des fichiers dans HDFS :
# -files affiche les fichiers
# -blocks affiche les blocs HDFS associés à chaque fichier
hdfs fsck /cyberflow/raw/ -files -blocks
