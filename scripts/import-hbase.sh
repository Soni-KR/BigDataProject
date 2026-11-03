#!/usr/bin/env bash
set -euo pipefail
: "${CYBERFLOW_RUN_PATH:?Set CYBERFLOW_RUN_PATH to the completed Spark run}"
for name in daily attacks ports manifest; do
  hdfs dfs -test -e "$CYBERFLOW_RUN_PATH/exports/$name/_SUCCESS"
done
# Create missing derived tables; existing records are updated without truncation.
for table in cyber_daily cyber_attacks cyber_ports; do
  if ! wget -qO- "http://localhost:8090/$table/schema" >/dev/null; then
    printf "create '%s', {NAME => 'm', VERSIONS => 1}\\nexit\\n" "$table" | hbase shell -n
  fi
done
load_table() {
  hbase org.apache.hadoop.hbase.mapreduce.ImportTsv -Dmapreduce.framework.name=yarn -Dmapreduce.map.speculative=false '-Dimporttsv.separator=|' -Dimporttsv.skip.bad.lines=false "-Dimporttsv.columns=$2" "$1" "$CYBERFLOW_RUN_PATH/exports/$3"
}
fields=$(hdfs dfs -cat "$CYBERFLOW_RUN_PATH/exports/daily/part-*" | awk -F'|' 'NR == 1 { print NF }')
[[ "$fields" == 5 ]] || { echo "Daily export lacks port statistics; run the full pipeline." >&2; exit 1; }
load_table cyber_daily 'HBASE_ROW_KEY,m:total_flows,m:benign_flows,m:attack_flows,m:port_stats' daily
load_table cyber_attacks 'HBASE_ROW_KEY,m:flow_count' attacks
load_table cyber_ports 'HBASE_ROW_KEY,m:total_flows,m:attack_flows' ports
echo "HBase imports complete."
