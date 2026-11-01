# CyberFlow

Cybersecurity traffic analytics using Hadoop HDFS, Spark, HBase REST, FastAPI,
and a React dashboard.

```text
8 raw CSV files -> HDFS -> Spark -> HBase -> FastAPI -> React
```

## Dataset coverage: why five days?

The project processes all eight CSV files from the CIC-IDS2017 machine-learning
dataset. Those files cover five capture days, 3–7 July 2017. Some days are split
into several CSV files; Spark groups them into one summary per day.

| Capture day | CSV files | Total flows |
| --- | ---: | ---: |
| Monday, 2017-07-03 | 1 | 529,918 |
| Tuesday, 2017-07-04 | 1 | 445,909 |
| Wednesday, 2017-07-05 | 1 | 692,703 |
| Thursday, 2017-07-06 | 2 | 458,968 |
| Friday, 2017-07-07 | 3 | 703,245 |
| **Total** | **8** | **2,830,743** |

Verified locally: the raw HDFS CSV line count, excluding the eight headers,
matches the sum of all five HBase/API summaries: **2,830,743 flows**.
The Spark script reads `hdfs:///cyberflow/raw/*.csv` and aggregates by day.
The dashboard currently requests those five known dates explicitly.

Dataset: [CIC-IDS2017, Canadian Institute for Cybersecurity](https://www.unb.ca/cic/datasets/ids-2017.html).

## Run the API and dashboard

Prerequisites: Docker Desktop, the existing Hadoop/HBase cluster running on the
external Docker network `hadoop`, and HBase REST reachable inside that network at
`http://hadoop-master:8090`. The `cyber_daily` table must already contain the
processed summaries. App startup does not initialize or reload the dataset.

From the repository root in PowerShell:

```powershell
.\start-dashboard.ps1
```

Open:

- Dashboard: http://localhost:3000
- API documentation: http://localhost:8000/docs
- Friday summary: http://localhost:8000/api/summary?day=2017-07-07

The new Compose configuration manages only the API and dashboard.
It joins the existing Hadoop network and binds app ports to localhost.
FastAPI and the dashboard only read HBase data.

## Modules

- `ingestion/`: upload missing raw CSV files into HDFS.
- `spark/processing.scala`: normalize columns, convert feature types, save cleaned
  Parquet, and compute daily, attack-type and destination-port aggregates.
- `backend/`: decode HBase REST Base64 cells and expose validated daily summaries.
- `frontend/`: date selection, daily metrics, weekly charts, CSV export and health
  indicators, using React, Vite and Recharts.
- `docker-compose.yml`: API container.
- `docker-compose.dashboard.yml`: additive dashboard configuration.

The Spark script writes derived outputs in overwrite mode when explicitly run.
Starting the application does not execute ingestion or Spark processing.

## Validation

The implemented test suites contain 24 backend tests and 8 frontend tests.
See the module READMEs for complete setup and verification instructions.

```powershell
docker build --target test -t cyberflow-api-tests ./backend
docker run --rm --network none cyberflow-api-tests
npm --prefix frontend ci
npm --prefix frontend test
npm --prefix frontend run build
```

Raw datasets, local verification artifacts, installed dependencies and compiled
frontend output are excluded from the commit.
