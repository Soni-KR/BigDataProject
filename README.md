# CyberFlow

Network-traffic analytics with HDFS, Spark, HBase, FastAPI and React.

```text
CSV files -> HDFS -> Spark aggregates -> HBase REST -> FastAPI -> React
```

## Setup

Use the existing Hadoop/HBase containers on Docker network `hadoop`. Place the
CIC-IDS2017 CSV files in `/data/cicids` inside `hadoop-master`.

From the repository root in PowerShell:

```powershell
docker cp ./ingestion/ingest_hdfs.sh hadoop-master:/tmp/ingest_hdfs.sh
docker exec hadoop-master bash /tmp/ingest_hdfs.sh
.\run-pipeline.ps1
.\start-dashboard.ps1
```

The pipeline starts HBase REST on port 8090 if needed. Spark 2.2 (client mode)
and HBase imports run on YARN. Each run writes HDFS outputs under
`/cyberflow/runs/` and upserts derived HBase tables. Existing outputs and raw data
are preserved. Imports do not delete obsolete rows; verify after changing inputs.

Open [the dashboard](http://localhost:3000) or [API docs](http://localhost:8000/docs).

## Usage

- `GET /api/summary?day=2017-07-07`
- `GET /api/attacks?day=2017-07-07`
- `GET /api/ports?day=2017-07-07&limit=10` — top destination ports by total flows.
- `GET /health` and `GET /health/ready`

Select a capture day to update the charts. CSV export contains daily summaries.
Port rankings use a precomputed top-50 snapshot in `cyber_daily`; requests do not
scan the detailed port table. Run the pipeline after upgrading to populate it.

To repeat an import from a completed current-version run:

```powershell
.\run-pipeline.ps1 -ImportOnly -RunPath /cyberflow/runs/RUN_ID
```

## Verify

Use the run path printed by the pipeline:

```powershell
docker exec hadoop-master python3 /opt/cyberflow/scripts/verify-pipeline.py /cyberflow/runs/RUN_ID
docker build --target test -t cyberflow-api-tests ./backend
docker run --rm --network none cyberflow-api-tests
npm --prefix frontend ci
npm --prefix frontend test
npm --prefix frontend run build
```

Stop the application with `docker compose down`; Hadoop is managed separately.
Dataset: [CIC-IDS2017](https://www.unb.ca/cic/datasets/ids-2017.html).
