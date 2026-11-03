#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CYBERFLOW_RUN_PATH="${1:?Pass a new HDFS run path}"
[[ "$CYBERFLOW_RUN_PATH" =~ ^/cyberflow/runs/[A-Za-z0-9_-]+$ ]] || { echo "Invalid run path." >&2; exit 1; }
echo "CYBERFLOW_RUN_PATH=$CYBERFLOW_RUN_PATH"
hdfs dfs -test -e /cyberflow/raw
if [[ "${2:-}" != "--import-only" ]]; then
  if hdfs dfs -test -e "$CYBERFLOW_RUN_PATH"; then
    echo "Run path already exists. Use --import-only to reuse a completed run." >&2
    exit 1
  fi
  export HADOOP_CONF_DIR="${HADOOP_CONF_DIR:-/usr/local/hadoop/etc/hadoop}"
  spark-shell --master yarn --deploy-mode client --name CyberFlow --driver-memory 1g --num-executors 2 --executor-memory 1g --executor-cores 1 --conf spark.driver.host=hadoop-master --conf spark.driver.bindAddress=0.0.0.0 -i spark/processing.scala </dev/null
fi
# Import checks every export's _SUCCESS, including the manifest written last.
bash scripts/import-hbase.sh
