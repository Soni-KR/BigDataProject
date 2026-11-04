#copier les fichiers CSV du dataset CIC-IDS2017 dans HDFS

#!/bin/bash
set -e
hdfs dfs -mkdir -p /cyberflow/raw
for file in /data/cicids/*.csv; do
    name=$(basename "$file")
    if hdfs dfs -test -e "/cyberflow/raw/$name"; then
        echo "Already exists: $name"
    else
        hdfs dfs -put "$file" /cyberflow/raw/
        echo "Uploaded: $name"
    fi
done
hdfs dfs -ls -h /cyberflow/raw/
hdfs fsck /cyberflow/raw/ -files -blocks
