# CyberFlow FastAPI backend

Read-only access to daily metrics in the existing HBase `cyber_daily` table.
No Hadoop setup, Spark job, HDFS write, HBase write, or data migration is run.

## 1. Start

From the BigDataProject repository root in PowerShell:

```powershell
docker network inspect hadoop
docker compose -f docker-compose.yml up -d --build --wait
```

The existing Hadoop cluster and HBase REST server must already be running.
The API joins the external `hadoop` network and reads
`http://hadoop-master:8090/cyber_daily/<day>?v=1` with `Accept: application/json`.
Docker resolves `hadoop-master` inside this network; Windows need not resolve it.
Compose manages only this API, and never creates or removes the Hadoop network.
The host port is bound to localhost. If port 8000 is busy:

```powershell
$env:CYBERFLOW_PORT = '8001'
docker compose -f docker-compose.yml up -d --build --wait
```

## 2. Verify

```powershell
Invoke-RestMethod http://localhost:8000/health
Invoke-RestMethod http://localhost:8000/health/ready
Invoke-RestMethod 'http://localhost:8000/api/summary?day=2017-07-07'
```

Use port 8001 instead if overridden. Expected Friday response:

```json
{"day":"2017-07-07","total_flows":703245,"benign_flows":414322,"attack_flows":288923}
```

Interactive API documentation: http://localhost:8000/docs

`/health` checks API liveness without querying HBase. `/health/ready` reads the
HBase `/version` endpoint; Docker uses this readiness check. This confirms gateway
connectivity; the summary request separately verifies table/row availability.

The summary decoder validates the Base64 row key, column names, and decimal cell
values. It requires all three metrics and checks total = benign + attack.
The latest cell version is requested; duplicate metrics are rejected.
Unknown columns are ignored. Missing values are never replaced with zero.

Errors: 422 invalid/missing date; 404 missing day; 502 malformed data or HBase HTTP
error; 503 connectivity failure; 504 request timeout (5 seconds). Readiness returns
503 for any upstream failure. No raw upstream error body is exposed.

## 3. Run isolated tests

Tests use mocked HTTP responses and never access HBase:

```powershell
docker build --target test -t cyberflow-api-tests ./backend
docker run --rm --network none cyberflow-api-tests
```

Production and test dependencies are pinned. Docker uses Python 3.12 slim.
For local Python 3.12 development, from `backend`:

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements-dev.txt
.\.venv\Scripts\python -m pytest -q
```

To run outside Docker, set `HBASE_REST_URL` to a gateway address reachable from
Windows, then run `python -m uvicorn app.main:app`. The default container hostname
usually is not reachable from the Windows host.

## 4. Inspect or stop only this API

```powershell
docker compose -f docker-compose.yml ps
docker compose -f docker-compose.yml logs --tail 50 api
docker compose -f docker-compose.yml down
```

If readiness fails, check that the REST gateway is still running on port 8090 and
that `hadoop-master` is attached to `hadoop`. A read-only diagnostic:

```powershell
docker exec hadoop-master wget -qO- --header='Accept: application/json' http://hadoop-master:8090/cyber_daily/2017-07-07
```