#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export CYBERFLOW_RUN_PATH="${1:?Pass a new HDFS run path}"
[[ "$CYBERFLOW_RUN_PATH" =~ ^/cyberflow/runs/[A-Za-z0-9_-]+$ ]] || { echo "Invalid run path." >&2; exit 1; }
echo "CYBERFLOW_RUN_PATH=$CYBERFLOW_RUN_PATH"
hdfs dfs -test -e '/cyberflow/raw'
if ! wget -qO- http://localhost:8090/version >/dev/null; then
  /usr/local/hbase/bin/hbase-daemon.sh start rest -p 8090
fi
ready=0
for attempt in {1..30}; do
  if wget -qO- http://localhost:8090/version >/dev/null; then ready=1; break; fi
  sleep 1
done
test "$ready" -eq 1 || { echo "HBase REST is unavailable on port 8090." >&2; exit 1; }

if [[ "${2:-}" != "--import-only" ]]; then
  if hdfs dfs -test -e "$CYBERFLOW_RUN_PATH"; then
    echo "Run path already exists. Use --import-only to reuse a completed run." >&2
    exit 1
  fi
  log=$(mktemp /tmp/cyberflow-spark.XXXXXX)
  trap 'rm -f "$log"' EXIT
  export HADOOP_CONF_DIR="${HADOOP_CONF_DIR:-/usr/local/hadoop/etc/hadoop}"
  spark-shell --master yarn --deploy-mode client --name CyberFlow \
    --driver-memory 1g --num-executors 2 --executor-memory 1g --executor-cores 1 \
    --conf spark.driver.host=hadoop-master --conf spark.driver.bindAddress=0.0.0.0 \
    -i spark/processing.scala </dev/null 2>&1 | tee "$log"
  grep -q '^CYBERFLOW_PROCESSING_COMPLETE$' "$log" || { echo "Spark processing did not complete." >&2; exit 1; }
fi
bash scripts/import-hbase.sh
